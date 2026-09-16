import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { CloudStore } from './store.ts';
import { CloudflareArtifactStore } from './artifacts.ts';
import { CloudRunQueue } from './queue.ts';
import { cleanupCloudBatch } from './cleanup.ts';
import { initializeFreshStore } from './bootstrap.ts';
import type { Schedule } from '../shared/types.ts';
import { MAX_REQUEST_TIMEOUT_SECONDS } from '../shared/timeouts.ts';
import type { StoredRun } from '../server/store.ts';
import type { ArtifactPayload } from '../server/artifacts.ts';

interface Env {
  LAB: DurableObjectNamespace<ModelLab>;
  ASSETS: Fetcher;
  ARTIFACTS?: R2Bucket;
  ENCRYPTION_KEY: string;
  ADMIN_TOKEN: string;
  MIGRATION_TOKEN?: string;
  APP_ORIGIN: string;
  ADDITIONAL_ORIGINS?: string;
  AUTOMATION_ENABLED: string;
  FRESH_INSTALL?: string;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
const digest = (value: string) => createHash('sha256').update(value).digest();
const sameSecret = (a: string, b: string) => Boolean(a && b) && timingSafeEqual(digest(a), digest(b));
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}

export class ModelLab extends DurableObject<Env> {
  private store: CloudStore;
  private artifacts: CloudflareArtifactStore;
  private queue: CloudRunQueue;
  private application: ReturnType<typeof createApp>;
  private armed = false;
  private armPromise?: Promise<void>;
  private armDirty = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const encryptionKey = Buffer.from(env.ENCRYPTION_KEY || '', 'base64');
    this.store = new CloudStore(ctx.storage, { encryptionKey, adminToken: env.ADMIN_TOKEN });
    this.store.db.exec('CREATE TABLE IF NOT EXISTS cloud_state (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    initializeFreshStore(this.store, env.FRESH_INSTALL === 'true');
    this.artifacts = new CloudflareArtifactStore(this.store, env.ARTIFACTS);
    this.queue = new CloudRunQueue(this.store, this.artifacts, { wake: () => this.requestWake(), concurrency: 2 });
    this.application = createApp({ store: this.store, artifacts: this.artifacts, queue: this.queue, cloud: {
      origin: env.APP_ORIGIN,
      additionalOrigins: env.ADDITIONAL_ORIGINS?.trim() ? env.ADDITIONAL_ORIGINS.split(',').map(origin => origin.trim()) : [],
    } });
  }

  private state(id: string): string | undefined {
    return this.store.db.prepare('SELECT data FROM cloud_state WHERE id = ?').get(id)?.data as string | undefined;
  }
  private setState(id: string, value: string) {
    this.store.db.prepare('INSERT INTO cloud_state(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, value);
  }
  private enabled() { return this.state('migration_complete') === 'true'; }
  private scheduled() { return this.enabled() && this.env.AUTOMATION_ENABLED === 'true'; }
  private configFingerprint() {
    const values: Record<string, unknown> = { settings: this.store.settings() };
    for (const table of ['providers', 'models', 'prompts', 'schedules'] as const) {
      values[table] = this.store.all(table).sort((a, b) => a.id.localeCompare(b.id, 'en'));
    }
    return createHash('sha256').update(canonical(values)).digest('hex');
  }

  private requestWake() {
    // Only arm a persisted alarm here. Long API requests never run after an HTTP response.
    if (!this.enabled()) return;
    this.ctx.waitUntil(this.arm());
  }
  private arm(): Promise<void> {
    this.armDirty = true;
    if (this.armPromise) return this.armPromise;
    this.armPromise = (async () => {
      do { this.armDirty = false; await this.armNext(); } while (this.armDirty);
    })().finally(() => { this.armPromise = undefined; });
    return this.armPromise;
  }
  private async armNext() {
    if (!this.enabled()) return;
    const now = Date.now();
    const times: number[] = this.scheduled() ? [now + 60_000] : [];
    const queueAt = this.queue.nextWakeAt();
    if (queueAt !== null) times.push(queueAt);
    for (const schedule of this.store.all<Schedule>('schedules')) {
      if (this.scheduled() && schedule.enabled && schedule.nextRunAt) {
        const time = Date.parse(schedule.nextRunAt);
        if (Number.isFinite(time)) times.push(time);
      }
    }
    if (!times.length) { await this.ctx.storage.deleteAlarm(); this.armed = true; return; }
    const next = Math.max(now + 1000, Math.min(...times));
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > next || existing < now) await this.ctx.storage.setAlarm(next);
    this.armed = true;
  }

  async alarm() {
    if (!this.enabled()) return;
    // Parallel requests share one bounded wave; reserve time for storing their results.
    await this.ctx.storage.setAlarm(Date.now() + MAX_REQUEST_TIMEOUT_SECONDS * 1000 + 60_000);
    try {
      await this.application.ready;
      if (this.scheduled()) this.application.scheduler.tick();
      const lastCleanup = Number(this.state('last_cleanup') || 0);
      // Cleanup can spend up to 390s waiting on R2. Keep it in a separate alarm
      // from a 720s request wave to stay below the platform's 15min wall limit.
      // Alternate when cleanup is incomplete, so persistent storage errors cannot
      // starve queued model requests (or vice versa).
      if (this.scheduled() && Date.now() - lastCleanup >= 3_600_000 && this.state('last_alarm_work') !== 'cleanup') {
        this.setState('last_alarm_work', 'cleanup');
        const complete = await cleanupCloudBatch(this.store, this.artifacts);
        if (complete) this.setState('last_cleanup', String(Date.now()));
        return;
      }
      this.setState('last_alarm_work', 'queue');
      await this.queue.processWave();
    } finally {
      await this.ctx.storage.deleteAlarm();
      await this.arm();
    }
  }

  private migrationAuthorized(request: Request) {
    return this.state('migration_sealed') !== 'true'
      && sameSecret(request.headers.get('x-model-lab-migration') || '', this.env.MIGRATION_TOKEN || '');
  }
  private async migration(request: Request, pathname: string): Promise<Response> {
    if (!this.migrationAuthorized(request)) return json({ error: '接口不存在。' }, 404);
    if (request.method === 'GET' && pathname === '/api/_migration/status') {
      const tables = ['providers', 'models', 'prompts', 'runs', 'schedules'] as const;
      const runs = this.store.all<StoredRun>('runs');
      return json({ counts: Object.fromEntries(tables.map(table => [table, this.store.all(table).length])),
        artifactCount: runs.filter(run => run.artifact && this.artifacts.availability(run.artifact) !== false).length,
        configFingerprint: this.configFingerprint(),
        complete: this.state('migration_complete') === 'true', automation: this.scheduled(), alarm: await this.ctx.storage.getAlarm() });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 16 * 1024 * 1024) return json({ error: '迁移分片超过大小限制。' }, 413);
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (pathname === '/api/_migration/manifest') {
      if (this.state('migration_complete') === 'true') return json({ error: '迁移数据已锁定。' }, 409);
      if (!body.counts || typeof body.configFingerprint !== 'string' || !Number.isSafeInteger(body.artifactCount)) return json({ error: '迁移清单无效。' }, 400);
      this.setState('migration_manifest', JSON.stringify(body));
      return json({ ok: true });
    }
    if (pathname === '/api/_migration/records') {
      if (this.state('migration_complete') === 'true') return json({ error: '迁移数据已锁定。' }, 409);
      const table = body.table;
      if (!['providers', 'models', 'prompts', 'runs', 'schedules'].includes(table) || !Array.isArray(body.records) || body.records.length > 100) return json({ error: '迁移分片无效。' }, 400);
      for (const row of body.records) if (!row || typeof row.id !== 'string' || typeof row.data !== 'string') return json({ error: '迁移记录无效。' }, 400);
      this.store.transaction(() => {
        for (const row of body.records) {
          const entity = JSON.parse(row.data);
          if (entity.id !== row.id) throw new Error('迁移记录ID不一致');
          if (table === 'runs') {
            const previous = this.store.get<StoredRun>('runs', row.id);
            if (previous?.artifact && previous.artifact.configId?.startsWith('cloudflare')) {
              entity.artifact = previous.artifact; entity.artifactStorage = previous.artifactStorage; entity.artifactAvailable = previous.artifactAvailable;
            } else { delete entity.artifact; entity.artifactAvailable = false; delete entity.artifactStorage; }
            entity.pendingArtifactDeletes = [];
            if (['queued', 'running'].includes(entity.status)) {
              entity.status = 'cancelled'; entity.error = '迁移时未完成的旧实例任务，未在新实例重复执行。'; entity.finishedAt = new Date().toISOString();
            }
          }
          this.store.put(table, entity);
        }
      });
      return json({ imported: body.records.length });
    }
    if (pathname === '/api/_migration/settings') {
      if (this.state('migration_complete') === 'true') return json({ error: '迁移数据已锁定。' }, 409);
      this.store.saveSettings(body.settings);
      if (Array.isArray(body.sessions)) this.store.transaction(() => {
        for (const item of body.sessions) if (typeof item.token_hash === 'string' && Number.isSafeInteger(item.expires_at) && item.expires_at > Date.now()) {
          this.store.db.prepare('INSERT OR REPLACE INTO sessions(token_hash,expires_at) VALUES(?,?)').run(item.token_hash, item.expires_at);
        }
      });
      return json({ ok: true });
    }
    if (pathname === '/api/_migration/artifact') {
      if (this.state('migration_complete') === 'true') return json({ error: '迁移数据已锁定。' }, 409);
      const run = this.store.get<StoredRun>('runs', body.id);
      if (!run) return json({ error: '测试记录不存在。' }, 404);
      const payload: ArtifactPayload = body.payload;
      if (!payload || ['output', 'html', 'reasoning'].some(key => typeof payload[key as keyof ArtifactPayload] !== 'string')) return json({ error: '正文无效。' }, 400);
      const artifact = await this.artifacts.put(run.id, payload);
      const current = this.store.get<StoredRun>('runs', run.id);
      if (!current || this.state('migration_complete') === 'true' || !this.migrationAuthorized(request)) {
        await this.artifacts.delete(artifact);
        return json({ error: '迁移数据已锁定或原记录已删除。' }, 409);
      }
      const previous = current.artifact;
      const pendingArtifactDeletes = [...(current.pendingArtifactDeletes || [])];
      if (previous && previous.key !== artifact.key) pendingArtifactDeletes.push(previous);
      this.store.put('runs', { ...current, artifact, artifactStorage: artifact.storage, artifactAvailable: true, hasHtml: Boolean(payload.html), pendingArtifactDeletes });
      this.artifacts.ack(artifact);
      if (previous && previous.key !== artifact.key) {
        try {
          await this.artifacts.delete(previous);
          const fresh = this.store.get<StoredRun>('runs', current.id);
          if (fresh) this.store.put('runs', { ...fresh, pendingArtifactDeletes: (fresh.pendingArtifactDeletes || []).filter(ref => ref.key !== previous.key || ref.configId !== previous.configId) });
        } catch { /* Keep the old reference until bounded retention cleanup succeeds. */ }
      }
      return json({ ok: true, bytes: artifact.sizeBytes });
    }
    if (pathname === '/api/_migration/complete') {
      const manifestText = this.state('migration_manifest');
      if (!manifestText) return json({ error: '缺少迁移核对清单。' }, 409);
      const manifest = JSON.parse(manifestText);
      for (const table of ['providers', 'models', 'prompts', 'runs', 'schedules'] as const) {
        if (manifest.counts[table] !== this.store.all(table).length) return json({ error: `迁移记录数量尚未匹配：${table}` }, 409);
      }
      if (manifest.configFingerprint !== this.configFingerprint()) return json({ error: 'API、模型、提示词或计划配置校验未通过。' }, 409);
      const artifactCount = this.store.all<StoredRun>('runs').filter(run => run.artifact && this.artifacts.availability(run.artifact) !== false).length;
      if (artifactCount !== manifest.artifactCount) return json({ error: '迁移正文数量尚未匹配。' }, 409);
      this.setState('migration_complete', 'true');
      await this.arm();
      return json({ ok: true, automation: this.scheduled() });
    }
    if (pathname === '/api/_migration/seal') {
      if (this.state('migration_complete') !== 'true') return json({ error: '请先完成迁移。' }, 409);
      this.setState('migration_sealed', 'true');
      return json({ ok: true });
    }
    return json({ error: '接口不存在。' }, 404);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/_migration/')) return await this.migration(request, path);
      if (!this.armed) await this.arm();
      const server = createServer(this.application.app);
      try {
        const handler = httpServerHandler(server as unknown as Parameters<typeof httpServerHandler>[0]);
        const response = await handler.fetch!(request as unknown as Parameters<NonNullable<typeof handler.fetch>>[0], this.env, {
          waitUntil: promise => this.ctx.waitUntil(promise), passThroughOnException() {},
        } as ExecutionContext);
        // Buffer Express JSON responses before disposing of its virtual HTTP server.
        const body = await response.arrayBuffer();
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) await this.arm();
        return new Response(request.method === 'HEAD' || [204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
      } finally { server.close(); }
    } catch {
      return json({ error: '云端服务暂时不可用，请稍后重试。' }, 503);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const headers = new Headers(request.headers);
    // These headers must never be supplied by visitors to the Durable Object.
    headers.delete('x-forwarded-host'); headers.delete('x-forwarded-proto'); headers.delete('x-forwarded-for');
    const forwarded = new Request(request, { headers });
    const cacheable = request.method === 'GET' && ['/api/public/data', '/api/public/runs', '/api/public/reasoning-history'].includes(url.pathname);
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    if (cacheable) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
    const stub = env.LAB.get(env.LAB.idFromName('primary'));
    const response = await stub.fetch(forwarded);
    if (cacheable && response.ok) {
      const copy = new Response(response.clone().body, response);
      copy.headers.delete('Set-Cookie'); copy.headers.set('Cache-Control', 'public, max-age=15');
      ctx.waitUntil(cache.put(cacheKey, copy));
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
