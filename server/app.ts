import express, { type Request, type Response, type NextFunction } from 'express';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { AdminData, Model, Prompt, PublicData, Schedule } from '../shared/types.ts';
import { REASONING_EFFORTS } from '../shared/reasoning.ts';
import { runResultTime } from '../shared/run-time.ts';
import { groupResultRuns, paginateResultGroups, resultBatchTimes, runBatchKey } from '../shared/result-groups.ts';
import { Store, providerDto, runDto, type StoredProvider, type StoredRun } from './store.ts';
import { RunQueue, QueueError } from './queue.ts';
import { seedData } from './seed.ts';
import { Scheduler, SchedulerError } from './scheduler.ts';
import { ArtifactStore, ArtifactWriteError, type ArtifactRepository } from './artifacts.ts';
import { discoverModels, ModelDiscoveryError } from './upstream.ts';
import { restoreArtifactsFromHandoff } from './handoff.ts';
import { ConfigBackupError, exportConfig, previewConfig, importConfig } from './config-backup.ts';
import { CONFIG_BACKUP_MAX_BYTES } from '../shared/config-backup.ts';
import { MAX_AUTO_RETRIES } from '../shared/retries.ts';
import { MIN_REQUEST_TIMEOUT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS } from '../shared/timeouts.ts';
import { ReasoningHistoryService } from './reasoning-history.ts';
import { publicResultRuns } from './public-results.ts';
import { nextScheduleRunAt, normalizeScheduleTiming, previewCron, ScheduleTimingError } from './schedule-time.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const COOKIE_NAME = 'model_lab_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const baseUrl = z.string().trim().min(1).max(2048).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}, 'API 地址必须是 http/https，且不包含用户名、密码、查询参数或片段。').transform(value => value.replace(/\/+$/, ''));
const providerInput = z.object({
  name: z.string().trim().min(1).max(100), baseUrl, protocol: z.enum(['chat-completions', 'responses']),
  enabled: z.boolean().default(true), retentionDays: z.number().int().min(1).max(3650).nullable().default(null), apiKey: z.string().trim().max(8192).optional().default(''),
});
const modelInput = z.object({
  providerId: z.string().min(1).max(100), name: z.string().trim().min(1).max(120), modelId: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  maxTokens: z.number().int().min(1).max(131072).default(8192), reasoningEffort: z.enum(REASONING_EFFORTS).default('medium'),
});
const promptInput = z.object({
  title: z.string().trim().min(1).max(120), description: z.string().max(1000).default(''),
  category: z.enum(['visual', 'reasoning', 'text']), content: z.string().min(1).max(100000).refine(value => value.trim().length > 0, '提示词不能为空。'),
  referenceAnswer: z.string().max(20000).default(''), rubric: z.string().max(20000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(15).default([]), enabled: z.boolean().default(true),
});
const scheduleInput = z.object({
  name: z.string().trim().min(1).max(120),
  promptIds: z.array(z.string().min(1).max(100)).min(1).max(50),
  modelIds: z.array(z.string().min(1).max(100)).min(1).max(50),
  intervalMinutes: z.number().int().min(1).max(43200).optional(),
  scheduleType: z.enum(['interval', 'cron']).optional(), cronExpression: z.string().trim().max(200).optional(), timezone: z.string().trim().max(100).optional(),
  enabled: z.boolean().default(true),
});
const batchInput = z.object({
  promptIds: z.array(z.string().min(1).max(100)).min(1).max(50),
  modelIds: z.array(z.string().min(1).max(100)).min(1).max(50), repeats: z.number().int().min(1).max(10).default(1),
});
const publicRunsQuery = z.object({
  providerId: z.string().max(100).optional(), category: z.enum(['visual', 'reasoning', 'text']).optional(),
  source: z.enum(['api', 'sample']).optional(), q: z.string().trim().max(200).optional(),
  sort: z.enum(['grouped', 'newest', 'oldest', 'latency']).default('grouped'),
  page: z.coerce.number().int().min(0).max(10000000).optional(),
  offset: z.coerce.number().int().min(0).max(10000000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(12),
});
const runProviderId = (run: StoredRun) => run.providerId || run.execution?.providerId || '';
const matchesRunSearch = (run: StoredRun, q?: string) => !q || [run.promptTitle, run.providerName, run.modelName, run.modelSlug]
  .join(' ').toLocaleLowerCase().includes(q.toLocaleLowerCase());
const creationTime = (run: StoredRun) => Number.isFinite(Date.parse(run.createdAt)) ? Date.parse(run.createdAt) : 0;
const newestFirst = (a: StoredRun, b: StoredRun) => runResultTime(b) - runResultTime(a)
  || creationTime(b) - creationTime(a) || b.id.localeCompare(a.id);
function cookieToken(request: Request): string {
  const item = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE_NAME + '='));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(COOKIE_NAME.length + 1)); } catch { return ''; }
}
export interface AppOptions {
  dataDir?: string; adminToken?: string; seed?: boolean; requestTimeoutMs?: number;
  concurrency?: number; distDir?: string;
  schedulerIntervalMs?: number; cleanupIntervalMs?: number; now?: () => number;
  retryBaseDelayMs?: number;
  upstreamFetch?: typeof fetch;
  store?: Store;
  artifacts?: ArtifactRepository;
  queue?: AppQueue;
  /** Origins come from trusted Worker configuration, never forwarding headers. */
  cloud?: { origin: string; additionalOrigins?: string[] };
  autoStartScheduler?: boolean;
  initializeArtifacts?: boolean;
  serveStatic?: boolean;
}
export type AppQueue = Pick<RunQueue, 'create' | 'enqueue' | 'cancel' | 'retry' | 'size' | 'close'>;

function configuredCloudOrigin(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.hostname.includes('*') || (value !== parsed.origin && value !== `${parsed.origin}/`)) {
    throw new Error('Cloudflare origin 必须是完整的 http/https 源地址，不包含路径、凭据或查询参数。');
  }
  return parsed.origin;
}

export function createApp(options: AppOptions = {}) {
  const cloudOrigin = options.cloud ? configuredCloudOrigin(options.cloud.origin) : undefined;
  const cloudOrigins = new Set(cloudOrigin ? [cloudOrigin, ...(options.cloud?.additionalOrigins ?? []).map(configuredCloudOrigin)] : []);
  const isCloud = cloudOrigin !== undefined;
  if (isCloud && (!options.store || !options.artifacts || !options.queue)) {
    throw new Error('Cloudflare 运行方式必须注入持久化 Store、云端结果存储和任务队列。');
  }
  const clock = options.now || Date.now;
  const now = () => new Date(clock()).toISOString();
  // Keep Node-only paths behind the non-injected branch. A Durable Object must
  // never construct file storage or discover paths in its virtual filesystem.
  const store = options.store ?? new Store(options.dataDir ?? process.env.DATA_DIR ?? resolve(process.cwd(), '.data'), options.adminToken ?? process.env.ADMIN_TOKEN);
  if (!isCloud && options.seed !== false) seedData(store);
  const configuredTimeout = options.requestTimeoutMs ?? (!isCloud && process.env.REQUEST_TIMEOUT_MS ? Number(process.env.REQUEST_TIMEOUT_MS) : undefined);
  // An explicit Node/test override remains supported; otherwise each new run
  // snapshots the current administrator setting rather than a startup default.
  const timeoutMs = typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : undefined;
  const concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2));
  const artifacts = options.artifacts ?? new ArtifactStore(store);
  const reasoningHistory = new ReasoningHistoryService(store, artifacts, clock);
  const initializeArtifacts = async () => {
    let migrated = false;
    for (const run of store.all<StoredRun>('runs')) {
      if (run.source === 'sample') {
        const sampleFile = run.id === 'sample-pelican' ? 'pelican.html' : run.id === 'sample-candy' ? 'reasoning.txt' : '';
        const samplePath = resolve(process.cwd(), 'samples', sampleFile);
        if (sampleFile && existsSync(samplePath)) {
          const output = readFileSync(samplePath, 'utf8');
          const payload = { output, html: run.category === 'visual' ? output : '', reasoning: '' };
          const artifact = artifacts.putMemory(run.id, payload);
          store.put('runs', { ...run, artifact, artifactAvailable: true, artifactStorage: 'memory', hasHtml: Boolean(payload.html), artifactExpiresAt: null });
        }
      } else if (run.output || run.html || run.reasoning) {
        const payload = { output: run.output, html: run.html, reasoning: run.reasoning };
        let artifact; const pendingArtifactDeletes = [...(run.pendingArtifactDeletes || [])];
        try { artifact = await artifacts.put(run.id, payload); }
        catch (error) { if (error instanceof ArtifactWriteError) pendingArtifactDeletes.push(error.ref); artifact = artifacts.putMemory(run.id, payload); }
        store.put('runs', { ...run, artifact, pendingArtifactDeletes, artifactAvailable: true, artifactStorage: artifact.storage, hasHtml: Boolean(payload.html) });
        artifacts.ack(artifact); for (const pending of pendingArtifactDeletes) artifacts.ack(pending);
      }
      if (run.output || run.html || run.reasoning) migrated = true;
    }
    restoreArtifactsFromHandoff(store, artifacts as ArtifactStore);
    // Remove old body bytes from SQLite free pages and WAL after a legacy-data migration.
    if (migrated) store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  };
  const ready = !isCloud && options.initializeArtifacts !== false ? initializeArtifacts() : Promise.resolve();
  const queue: AppQueue = options.queue ?? new RunQueue(store, timeoutMs, concurrency, clock, artifacts, options.retryBaseDelayMs, options.upstreamFetch);
  let closed = false;
  const deleteRunArtifacts = async (id: string) => {
    const run = store.get<StoredRun>('runs', id);
    if (!run) return;
    for (const ref of [...(run.pendingArtifactDeletes || []), ...(run.artifact ? [run.artifact] : [])]) await artifacts.delete(ref);
  };
  const cleanupPendingArtifacts = async (id: string) => {
    const snapshot = store.get<StoredRun>('runs', id);
    for (const ref of snapshot?.pendingArtifactDeletes || []) {
      try { await artifacts.delete(ref); }
      catch {
        const current = store.get<StoredRun>('runs', id);
        if (current) store.put('runs', { ...current, cleanupError: '残留正文删除失败，系统将在下一轮自动重试。' });
        throw new Error('Artifact cleanup failed');
      }
      const current = store.get<StoredRun>('runs', id);
      if (current) {
        const remaining = current.pendingArtifactDeletes?.filter(item => !(item.storage === ref.storage && item.key === ref.key && item.configId === ref.configId)) || [];
        store.put('runs', { ...current, pendingArtifactDeletes: remaining, cleanupError: remaining.length ? current.cleanupError : '' });
      }
    }
  };
  const scheduler = new Scheduler(store, queue as RunQueue, { now: clock, schedulerIntervalMs: options.schedulerIntervalMs, cleanupIntervalMs: options.cleanupIntervalMs,
    removeArtifact: deleteRunArtifacts, cleanupPendingArtifacts, cleanupOrphanArtifacts: async () => {
      // Recheck references for each object: uploads can finish while earlier
      // journal entries are awaiting a remote DELETE.
      await artifacts.cleanupPending(ref => store.all<StoredRun>('runs').some(run =>
        [...(run.pendingArtifactDeletes || []), ...(run.artifact ? [run.artifact] : [])].some(current =>
          current.storage === ref.storage && current.configId === ref.configId && current.key === ref.key)));
    } });
  // Durable Object alarms call tick/cleanup explicitly. Timers are only used
  // by the default Node runtime, after its artifact migration has completed.
  if (!isCloud && options.autoStartScheduler !== false) {
    void ready.then(() => { if (!closed) scheduler.start(); }).catch(() => undefined);
  }
  type RetentionProjection = { providerDays: Map<string, number | null | undefined>; defaultDays: number };
  const dto = (run: StoredRun, retention?: RetentionProjection) => {
    const safe = runDto(run);
    const availability = run.artifact ? artifacts.availability(run.artifact) : false;
    const retentionDays = retention
      ? retention.providerDays.get(safe.providerId || '') ?? retention.defaultDays
      : store.get<StoredProvider>('providers', safe.providerId || '')?.retentionDays ?? store.settings().retentionDays;
    const expiresAt = new Date(Date.parse(run.finishedAt || '') + retentionDays * 86400000);
    return { ...safe, artifactAvailable: availability ?? run.artifactAvailable ?? true,
      artifactStorage: run.artifact?.storage || run.artifactStorage,
      artifactExpiresAt: run.source === 'sample' || !Number.isFinite(expiresAt.getTime()) ? null : expiresAt.toISOString() };
  };
  // Each response resolves retention once. Never retain this map across requests:
  // editing global or provider retention must affect the next read immediately.
  const dtoList = (runs: StoredRun[], providers?: StoredProvider[], settings?: { retentionDays: number }) => {
    if (!runs.length) return [];
    const retention: RetentionProjection = {
      providerDays: new Map((providers ?? store.all<StoredProvider>('providers')).map(provider => [provider.id, provider.retentionDays])),
      defaultDays: (settings ?? store.settings()).retentionDays,
    };
    return runs.map(run => dto(run, retention));
  };
  const hydrate = async (run: StoredRun) => {
    let payload = null;
    if (run.artifact) {
      try { payload = await artifacts.get(run.artifact); }
      catch {
        const current = store.get<StoredRun>('runs', run.id);
        if (!current) throw new HttpError(404, '测试结果不存在。');
        throw new HttpError(502, '结果存储暂时不可用，请稍后重试或检查对象存储配置。');
      }
    }
    // Object reads are asynchronous. Update only the current record so a
    // concurrent deletion cannot be reverted or revived.
    let current = store.get<StoredRun>('runs', run.id);
    if (!current) throw new HttpError(404, '测试结果不存在。');
    if (run.artifact && current.artifact?.key === run.artifact.key && current.artifact.configId === run.artifact.configId) {
      const available = Boolean(payload);
      if (current.artifactAvailable !== available) {
        current = { ...current, artifactAvailable: available };
        store.put('runs', current);
      }
    } else if (current.artifact?.key !== run.artifact?.key) payload = null;
    const safe = dto(current);
    return payload ? { ...safe, ...payload, artifactAvailable: true } : { ...safe, artifactAvailable: false };
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store');
    next();
  });
  const parseJson = express.json({ limit: '1mb' });
  const isConfigRequest = (request: Request) => request.path === '/api/admin/config' || request.path.startsWith('/api/admin/config/');
  // Large encrypted backups are parsed only after the administrator session and Origin checks.
  app.use((request, response, next) => isConfigRequest(request) ? next() : parseJson(request, response, next));
  app.use(async (_request, _response, next) => { try { await ready; next(); } catch { next(new HttpError(503, '结果存储初始化失败，请检查服务配置。')); } });
  const originAllowed = (request: Request) => {
    const origin = request.headers.origin;
    if (!origin || origin === 'null') return false;
    try {
      const parsed = new URL(origin);
      if (isCloud) return cloudOrigins.has(parsed.origin) && origin === parsed.origin;
      const host = new URL(`${request.protocol}://${request.get('host')}`);
      if (parsed.origin === host.origin) return true;
      if (process.env.APP_ORIGIN && parsed.origin === new URL(process.env.APP_ORIGIN).origin) return true;
      // Vite forwards API requests to 3000 during local development.
      return process.env.NODE_ENV !== 'production' && parsed.hostname === host.hostname && parsed.port === '5173' && parsed.protocol === host.protocol;
    } catch { return false; }
  };
  app.use('/api', (request, _response, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !originAllowed(request)) return next(new HttpError(403, '请求来源校验失败，请从本站页面操作。'));
    next();
  });
  const authenticated = (request: Request) => {
    const token = cookieToken(request);
    if (!token || token.length > 256) return false;
    const row = store.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash(token));
    return Boolean(row && Number(row.expires_at) > (isCloud ? clock() : Date.now()));
  };
  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.get('/api/auth/session', (request, response) => response.json({ authenticated: authenticated(request) }));
  const attempts = new Map<string, { count: number; resetAt: number }>();
  if (isCloud) store.db.exec('CREATE TABLE IF NOT EXISTS login_attempts (ip_hash TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
  app.post('/api/auth/login', (request, response) => {
    const token = z.object({ token: z.string().min(1).max(1024) }).parse(request.body).token;
    // The outer Worker strips the client's version of this header and supplies
    // Cloudflare's verified client address before forwarding to the private DO.
    const connectingIp = request.headers['cf-connecting-ip'];
    const ip = isCloud ? (typeof connectingIp === 'string' && connectingIp.length <= 128 ? connectingIp.trim() || 'unknown' : 'unknown') : request.ip || 'unknown';
    const time = isCloud ? clock() : Date.now();
    const ipHash = hash(ip);
    let attempt: { count: number; resetAt: number };
    if (isCloud) {
      store.db.prepare('DELETE FROM login_attempts WHERE reset_at <= ?').run(time);
      const row = store.db.prepare('SELECT attempt_count, reset_at FROM login_attempts WHERE ip_hash = ?').get(ipHash);
      attempt = row ? { count: Number(row.attempt_count), resetAt: Number(row.reset_at) } : { count: 0, resetAt: time + 15 * 60 * 1000 };
    } else {
      for (const [key, value] of attempts) if (value.resetAt <= time) attempts.delete(key);
      attempt = attempts.get(ip) || { count: 0, resetAt: time + 15 * 60 * 1000 };
    }
    if (attempt.count >= 10) { response.setHeader('Retry-After', String(Math.ceil((attempt.resetAt - time) / 1000))); throw new HttpError(429, '登录尝试过于频繁，请稍后重试。'); }
    if (!timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(store.adminToken)))) {
      attempt.count++;
      if (isCloud) store.db.prepare('INSERT INTO login_attempts(ip_hash, attempt_count, reset_at) VALUES (?, ?, ?) ON CONFLICT(ip_hash) DO UPDATE SET attempt_count = excluded.attempt_count, reset_at = excluded.reset_at').run(ipHash, attempt.count, attempt.resetAt);
      else attempts.set(ip, attempt);
      throw new HttpError(401, '管理口令不正确。');
    }
    if (isCloud) store.db.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').run(ipHash);
    else attempts.delete(ip);
    const previous = cookieToken(request);
    if (previous) store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(previous));
    const session = Buffer.from(randomBytes(32)).toString('base64url');
    store.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(time);
    store.db.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)').run(hash(session), time + SESSION_MS);
    response.cookie(COOKIE_NAME, session, { httpOnly: true, sameSite: 'strict', secure: isCloud || request.secure || process.env.COOKIE_SECURE === 'true', maxAge: SESSION_MS, path: '/' });
    response.json({ ok: true });
  });
  app.post('/api/auth/logout', (request, response) => {
    const token = cookieToken(request);
    if (token) store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
    response.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', ...(isCloud ? { secure: true } : {}), path: '/' });
    response.json({ ok: true });
  });
  app.get('/api/public/data', (_request, response) => {
    const history = store.all<StoredRun>('runs');
    const batchTimes = resultBatchTimes(history);
    const runs = groupResultRuns(publicResultRuns(history), batchTimes).flatMap(group => group.runs);
    const providers = store.all<StoredProvider>('providers');
    const publicProviders = new Map(providers.map(provider => [provider.id, { id: provider.id, name: provider.name }]));
    for (const run of runs) {
      const id = runProviderId(run);
      if (id && !publicProviders.has(id)) publicProviders.set(id, { id, name: run.providerName || '历史 API 接口' });
    }
    const prompts = store.all<Prompt>('prompts').filter(prompt => prompt.enabled);
    const models = store.all<Model>('models').filter(model => model.enabled && providers.some(provider => provider.id === model.providerId && provider.enabled))
      .map(model => ({ id: model.id, name: model.name, providerId: model.providerId, providerName: providers.find(provider => provider.id === model.providerId)?.name || '' }));
    const data: PublicData = { prompts, models, providers: [...publicProviders.values()], runs: dtoList(runs.slice(0, 200), providers)
      .map(run => ({ ...run, batchCreatedAt: batchTimes.get(runBatchKey(run)) })), stats: { apiRuns: runs.filter(run => run.source === 'api').length,
      sampleRuns: runs.filter(run => run.source === 'sample').length, modelCount: models.length, promptCount: prompts.length } };
    response.json(data);
  });
  app.get('/api/public/runs', (request, response) => {
    const query = publicRunsQuery.parse(request.query);
    const history = store.all<StoredRun>('runs');
    const batchTimes = resultBatchTimes(history);
    const filtered = publicResultRuns(history).filter(run => (!query.providerId || runProviderId(run) === query.providerId)
      && (!query.category || run.category === query.category) && (!query.source || run.source === query.source)
      && matchesRunSearch(run, query.q));
    const project = (runs: StoredRun[]) => dtoList(runs).map(run => ({ ...run, batchCreatedAt: batchTimes.get(runBatchKey(run)) }));
    if (query.sort === 'grouped') {
      const groups = groupResultRuns(filtered, batchTimes);
      if (query.page !== undefined) {
        const result = paginateResultGroups(groups, query.limit, query.page);
        response.json({ ...result, runs: project(result.runs), total: filtered.length });
      } else {
        response.json({ runs: project(groups.flatMap(group => group.runs).slice(query.offset, query.offset + query.limit)), total: filtered.length });
      }
    } else {
      filtered.sort(query.sort === 'oldest' ? (a, b) => -newestFirst(a, b)
        : query.sort === 'latency' ? (a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || newestFirst(a, b)
          : newestFirst);
      response.json({ runs: project(filtered.slice(query.offset, query.offset + query.limit)), total: filtered.length });
    }
  });
  app.get('/api/public/reasoning-history', async (request, response) => {
    const query = z.object({ providerId: z.string().max(100).optional(), q: z.string().trim().max(200).optional() }).parse(request.query);
    response.json(await reasoningHistory.read(query));
  });
  app.get('/api/public/runs/:id', async (request, response) => {
    const run = store.get<StoredRun>('runs', request.params.id as string);
    if (!run) throw new HttpError(404, '测试结果不存在。');
    response.json({ run: await hydrate(run) });
  });
  app.use('/api/admin', (request, _response, next) => {
    if (!authenticated(request)) return next(new HttpError(401, '请先登录管理后台。'));
    next();
  });
  app.use('/api/admin/config', express.json({ limit: CONFIG_BACKUP_MAX_BYTES }));
  app.post('/api/admin/config/export', async (request, response) => {
    const input = z.object({ password: z.string() }).parse(request.body);
    const backup = await exportConfig(store, artifacts, input.password);
    response.setHeader('Content-Disposition', `attachment; filename="model-lab-config-${new Date().toISOString().slice(0, 10)}.json"`);
    response.json(backup);
  });
  app.post('/api/admin/config/preview', async (request, response) => {
    const input = z.object({ password: z.string(), backup: z.unknown() }).parse(request.body);
    response.json(await previewConfig(input.password, input.backup));
  });
  app.post('/api/admin/config/import', async (request, response) => {
    const input = z.object({ password: z.string(), backup: z.unknown() }).parse(request.body);
    response.json(await importConfig(store, artifacts, input.password, input.backup));
  });
  app.get('/api/admin/data', (_request, response) => {
    const providers = store.all<StoredProvider>('providers');
    const settings = store.settings();
    const runs = store.all<StoredRun>('runs');
    const data: AdminData = { providers: providers.map(provider => providerDto(provider, store)), models: store.all<Model>('models'),
      prompts: store.all<Prompt>('prompts'), runs: dtoList(runs.slice(0, 200), providers, settings),
      schedules: store.all<Schedule>('schedules'), settings, storage: artifacts.status() };
    response.json(data);
  });
  const requireProvider = (id: string) => { const value = store.get<StoredProvider>('providers', id); if (!value) throw new HttpError(404, 'API 服务不存在。'); return value; };
  const requireModel = (id: string) => { const value = store.get<Model>('models', id); if (!value) throw new HttpError(404, '模型不存在。'); return value; };
  const requirePrompt = (id: string) => { const value = store.get<Prompt>('prompts', id); if (!value) throw new HttpError(404, '提示词不存在。'); return value; };
  const requireRun = (id: string) => { const value = store.get<StoredRun>('runs', id); if (!value) throw new HttpError(404, '测试结果不存在。'); return value; };
  const requireSchedule = (id: string) => { const value = store.get<Schedule>('schedules', id); if (!value) throw new HttpError(404, '定时计划不存在。'); return value; };
  app.get('/api/admin/providers/:id/models', async (request, response) => {
    const provider = requireProvider(request.params.id as string);
    const models = await discoverModels(provider, store.decrypt(provider.encryptedApiKey));
    response.json({ models });
  });
  app.get('/api/admin/storage', (_request, response) => response.json({ storage: artifacts.status() }));
  app.put('/api/admin/storage', storageUpdate);
  app.patch('/api/admin/storage', storageUpdate);
  function storageUpdate(request: Request, response: Response) {
    const input = z.object({ mode: z.enum(['memory', 'disk', 's3', 'cloudflare']), endpoint: z.string().max(2048).optional(), region: z.string().max(100).optional(),
      bucket: z.string().max(200).optional(), prefix: z.string().max(200).optional(), accessKeyId: z.string().max(8192).optional(), secretAccessKey: z.string().max(8192).optional(),
    }).parse(request.body);
    try { response.json({ storage: artifacts.configure(input) }); }
    catch { throw new HttpError(400, '对象存储配置无效，请检查地址、区域、桶名称和访问密钥。'); }
  }
  app.post('/api/admin/storage/test', async (_request, response) => {
    try { await artifacts.test(); response.json({ ok: true }); }
    catch { throw new HttpError(502, '对象存储读写测试失败，请检查端点、桶、访问密钥和读写删除权限。'); }
  });
  app.get('/api/admin/runs/:id', async (request, response) => response.json({ run: await hydrate(requireRun(request.params.id as string)) }));
  app.patch('/api/admin/settings', (request, response) => {
    const patch = z.object({ retentionDays: z.number().int().min(1).max(3650).optional(), maxRetries: z.number().int().min(0).max(MAX_AUTO_RETRIES).optional(),
      requestTimeoutSeconds: z.number().int().min(MIN_REQUEST_TIMEOUT_SECONDS).max(MAX_REQUEST_TIMEOUT_SECONDS).optional() })
      .refine(value => Object.keys(value).length > 0, '请提供要修改的设置。').parse(request.body);
    response.json({ settings: store.saveSettings({ ...store.settings(), ...patch }) });
  });
  app.post('/api/admin/schedules', (request, response) => {
    const input = scheduleInput.parse(request.body); scheduler.validate(input.promptIds, input.modelIds);
    const timing = normalizeScheduleTiming(input, clock());
    const schedule: Schedule = { ...input, ...timing, promptIds: [...new Set(input.promptIds)], modelIds: [...new Set(input.modelIds)],
      id: randomUUID(), createdAt: now(), lastRunAt: null, lastError: '', nextRunAt: nextScheduleRunAt(timing, clock()) };
    store.put('schedules', schedule); response.status(201).json({ schedule });
  });
  app.post('/api/admin/schedules/preview', (request, response) => {
    const input = z.object({ cronExpression: z.string().max(200), timezone: z.string().max(100).optional() }).parse(request.body);
    response.json({ nextRuns: previewCron(input.cronExpression, input.timezone, clock(), 3) });
  });
  app.put('/api/admin/schedules/:id', (request, response) => {
    const previous = requireSchedule(request.params.id as string); const input = scheduleInput.parse(request.body);
    scheduler.validate(input.promptIds, input.modelIds, previous);
    const timing = normalizeScheduleTiming({ ...previous, ...input }, clock());
    let oldTiming: ReturnType<typeof normalizeScheduleTiming> | undefined;
    try { oldTiming = normalizeScheduleTiming(previous, clock()); } catch { /* A valid edit can repair an invalid persisted plan. */ }
    const reset = !oldTiming || input.enabled !== previous.enabled || (Object.keys(timing) as (keyof typeof timing)[]).some(key => timing[key] !== oldTiming?.[key]);
    const schedule: Schedule = { ...previous, ...input, ...timing, promptIds: [...new Set(input.promptIds)], modelIds: [...new Set(input.modelIds)],
      nextRunAt: reset ? nextScheduleRunAt(timing, clock()) : previous.nextRunAt, lastError: '' };
    store.put('schedules', schedule); response.json({ schedule });
  });
  app.delete('/api/admin/schedules/:id', (request, response) => {
    const schedule = requireSchedule(request.params.id as string); store.delete('schedules', schedule.id); response.json({ ok: true });
  });
  app.post('/api/admin/schedules/:id/run', (request, response) => {
    const schedule = requireSchedule(request.params.id as string);
    response.status(202).json({ runs: dtoList(scheduler.run(schedule)) });
  });
  app.get('/api/admin/runs', (request, response) => {
    const query = z.object({ providerId: z.string().max(100).optional(), modelId: z.string().max(100).optional(),
      status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
      source: z.enum(['api', 'sample']).optional(), q: z.string().trim().max(200).optional(),
      offset: z.coerce.number().int().min(0).max(10000000).default(0), limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query);
    const filtered = store.all<StoredRun>('runs').filter(run => (!query.providerId || (run.providerId || run.execution?.providerId) === query.providerId)
      && (!query.modelId || run.modelId === query.modelId) && (!query.status || run.status === query.status)
      && (!query.source || run.source === query.source) && matchesRunSearch(run, query.q));
    response.json({ runs: dtoList(filtered.slice(query.offset, query.offset + query.limit)), total: filtered.length });
  });
  app.post('/api/admin/providers', (request, response) => {
    const { apiKey, ...input } = providerInput.parse(request.body);
    const provider: StoredProvider = { id: randomUUID(), ...input, encryptedApiKey: store.encrypt(apiKey), createdAt: now() };
    store.put('providers', provider); response.status(201).json({ provider: providerDto(provider, store) });
  });
  app.put('/api/admin/providers/:id', (request, response) => {
    const previous = requireProvider(request.params.id as string); const { apiKey, ...input } = providerInput.parse(request.body);
    const provider = { ...previous, ...input, encryptedApiKey: apiKey ? store.encrypt(apiKey) : previous.encryptedApiKey };
    store.put('providers', provider); response.json({ provider: providerDto(provider, store) });
  });
  app.delete('/api/admin/providers/:id', (request, response) => {
    const id = request.params.id as string; requireProvider(id);
    if (store.all<Model>('models').some(model => model.providerId === id)) throw new HttpError(409, '请先删除该 API 服务下的模型。');
    store.delete('providers', id); response.json({ ok: true });
  });
  app.post('/api/admin/models', (request, response) => {
    const input = modelInput.parse(request.body); requireProvider(input.providerId);
    const model: Model = { id: randomUUID(), ...input, createdAt: now() };
    store.put('models', model); response.status(201).json({ model });
  });
  app.put('/api/admin/models/:id', (request, response) => {
    const previous = requireModel(request.params.id as string); const input = modelInput.parse(request.body); requireProvider(input.providerId);
    const model = { ...previous, ...input }; store.put('models', model); response.json({ model });
  });
  app.delete('/api/admin/models/:id', (request, response) => {
    const id = request.params.id as string; requireModel(id);
    if (store.all<StoredRun>('runs').some(run => run.modelId === id && ['running', 'queued'].includes(run.status))) throw new HttpError(409, '该模型仍有进行中的任务，请先取消或等待完成。');
    store.delete('models', id); response.json({ ok: true });
  });
  app.post('/api/admin/prompts', (request, response) => {
    const input = promptInput.parse(request.body);
    const prompt: Prompt = { id: randomUUID(), ...input, createdAt: now(), updatedAt: now() };
    store.put('prompts', prompt); response.status(201).json({ prompt });
  });
  app.put('/api/admin/prompts/:id', (request, response) => {
    const previous = requirePrompt(request.params.id as string); const input = promptInput.parse(request.body);
    const prompt = { ...previous, ...input, updatedAt: now() }; store.put('prompts', prompt); response.json({ prompt });
  });
  app.delete('/api/admin/prompts/:id', (request, response) => {
    const id = request.params.id as string; requirePrompt(id);
    if (store.all<StoredRun>('runs').some(run => run.promptId === id && ['running', 'queued'].includes(run.status))) throw new HttpError(409, '该提示词仍有进行中的任务，请先取消或等待完成。');
    store.delete('prompts', id); response.json({ ok: true });
  });
  app.post('/api/admin/runs', (request, response) => {
    const input = batchInput.parse(request.body);
    const prompts = [...new Set(input.promptIds)].map(requirePrompt); const models = [...new Set(input.modelIds)].map(requireModel);
    const count = prompts.length * models.length * input.repeats;
    if (count > 50) throw new HttpError(400, '每批最多创建 50 个测试任务。');
    if (queue.size() + count > 200) throw new HttpError(429, '队列已满（最多 200 个待完成任务），请稍后重试。');
    if (prompts.some(prompt => !prompt.enabled)) throw new HttpError(400, '所选提示词已停用。');
    const batchId = randomUUID(); const runs: StoredRun[] = [];
    for (const model of models) {
      const provider = requireProvider(model.providerId);
      if (!model.enabled || !provider.enabled) throw new HttpError(400, '所选模型或 API 服务已停用。');
      for (const prompt of prompts) for (let repeat = 0; repeat < input.repeats; repeat++) runs.push(queue.create(prompt, model, provider, batchId));
    }
    queue.enqueue(runs); response.status(202).json({ runs: dtoList(runs) });
  });
  app.delete('/api/admin/runs/:id', async (request, response) => {
    const run = requireRun(request.params.id as string);
    if (['queued', 'running'].includes(run.status)) throw new HttpError(409, '进行中的任务不能删除，请先取消。');
    try { await deleteRunArtifacts(run.id); } catch {
      const current = store.get<StoredRun>('runs', run.id);
      if (current) store.put('runs', { ...current, cleanupError: '作品正文删除失败，历史记录已保留，请稍后重试。' });
      throw new HttpError(502, '结果对象删除失败，历史记录已保留，请稍后重试。');
    }
    store.delete('runs', run.id); response.json({ ok: true });
  });
  app.post('/api/admin/runs/:id/cancel', (request, response) => {
    const run = requireRun(request.params.id as string);
    if (!['queued', 'running'].includes(run.status)) throw new HttpError(409, '该任务已结束。');
    response.json({ run: dto(queue.cancel(run)) });
  });
  app.post('/api/admin/runs/:id/retry', (request, response) => {
    const run = requireRun(request.params.id as string);
    if (run.source !== 'api' || !run.execution) throw new HttpError(400, '样例不能重试，请选择配置模型创建新测试。');
    if (['queued', 'running'].includes(run.status)) throw new HttpError(409, '该任务正在执行。');
    const model = requireModel(run.modelId); const provider = requireProvider(run.execution.providerId);
    if (!model.enabled || !provider.enabled) throw new HttpError(400, '该模型或 API 服务已停用。');
    if (queue.size() >= 200) throw new HttpError(429, '队列已满，请稍后重试。');
    const next = queue.retry(run); queue.enqueue([next]); response.status(202).json({ runs: dtoList([next]) });
  });
  app.use('/api', (_request, response) => response.status(404).json({ error: '接口不存在。' }));
  if (!isCloud && options.serveStatic !== false) {
    const distDir = options.distDir ?? resolve(process.cwd(), 'dist');
    if (existsSync(resolve(distDir, 'index.html'))) {
      app.use(express.static(distDir, { index: false, maxAge: '1h' }));
      app.get('/{*path}', (_request, response) => { response.setHeader('Cache-Control', 'no-cache'); response.sendFile(resolve(distDir, 'index.html')); });
    }
  }
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) return response.status(400).json({ error: error.issues.map(issue => `${issue.path.join('.') || '参数'}: ${issue.message}`).join('；') });
    if (error instanceof HttpError || error instanceof SchedulerError || error instanceof ScheduleTimingError || error instanceof QueueError || error instanceof ModelDiscoveryError || error instanceof ConfigBackupError) return response.status(error.status).json({ error: error.message });
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') return response.status(413).json({ error: `请求内容超过 ${isConfigRequest(request) ? '6' : '1'} MB 限制。` });
    if (error instanceof SyntaxError) return response.status(400).json({ error: '请求不是有效 JSON。' });
    response.status(500).json({ error: '服务器内部错误，请检查服务状态。' });
  });
  return { app, store, artifacts, queue, scheduler, ready,
    close: async () => { if (closed) return; closed = true; await ready.catch(() => undefined); await Promise.all([scheduler.close(), queue.close()]); await Promise.all([reasoningHistory.close(), artifacts.close()]); store.close(); } };
}
