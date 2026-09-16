import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp, type AppOptions, type AppQueue } from '../server/app.ts';
import { Store, type StoredRun } from '../server/store.ts';
import { CloudStore, type DurableSqlStorage } from '../cloudflare/store.ts';
import { Scheduler } from '../server/scheduler.ts';
import type { ArtifactPayload, ArtifactRepository } from '../server/artifacts.ts';
import type { StorageSettings } from '../shared/types.ts';

const ADMIN_TOKEN = 'cloud-adapter-test-admin-token';
const CLOUD_ORIGIN = 'https://lab.example.test';
const DEFAULT_ORIGIN = 'https://test-lab.test-account.workers.dev';
const CLIENT_IP = '203.0.113.15';
const INITIAL_TIME = Date.parse('2026-09-15T12:00:00Z');

function runRecord(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: randomUUID(), batchId: 'batch', promptId: 'prompt', modelId: 'model', providerId: 'provider',
    providerName: 'Cloud API', modelName: 'Test model', modelSlug: 'test-model',
    promptTitle: 'Cloud prompt', promptContent: 'Answer the question.', category: 'reasoning', referenceAnswer: '', rubric: '',
    status: 'completed', source: 'api', sourceLabel: 'API 实测', output: '', html: '', reasoning: '', error: '',
    latencyMs: 100, inputTokens: 10, outputTokens: 20,
    createdAt: new Date(INITIAL_TIME).toISOString(), finishedAt: new Date(INITIAL_TIME).toISOString(),
    parameters: { protocol: 'responses', maxTokens: 128, reasoningEffort: 'medium' },
    ...overrides,
  };
}

function injectedResources(store: Store) {
  const objects = new Map<string, ArtifactPayload>();
  const calls = { created: 0, enqueued: 0, cancelled: 0, retried: 0, queueClosed: 0,
    memory: 0, writes: 0, reads: 0, deletes: 0, cleaned: 0, artifactsClosed: 0 };
  const controls = { failDelete: false };
  const status: StorageSettings = { mode: 'cloudflare', endpoint: '', region: 'auto', bucket: 'binding', prefix: 'model-lab',
    hasAccessKeyId: false, hasSecretAccessKey: false, memoryLimitMb: 0, memoryUsedMb: 0 };
  const artifacts: ArtifactRepository = {
    status: () => ({ ...status }),
    configure(input) {
      if (input.mode !== 'cloudflare') throw new Error('The cloud adapter cannot use a memory fallback.');
      return { ...status };
    },
    exportConfiguration: () => ({ mode: 'cloudflare', driver: 'cloudflare-binding', prefix: 'model-lab', backend: 'r2' }),
    importConfigurationInTransaction(input) {
      assert.equal(input.mode, 'cloudflare');
    },
    ack() {},
    async cleanupPending() { calls.cleaned++; },
    putMemory() { calls.memory++; throw new Error('Unexpected cloud memory fallback'); },
    async put(id, payload) {
      calls.writes++;
      const key = `cloud/${id}`;
      objects.set(key, payload);
      return { storage: 'cloudflare', key, configId: 'binding', sizeBytes: JSON.stringify(payload).length };
    },
    availability: (ref) => objects.has(ref.key),
    async get(ref) { calls.reads++; return objects.get(ref.key) ?? null; },
    async delete(ref) {
      calls.deletes++;
      if (controls.failDelete) throw new Error('R2 deletion unavailable');
      objects.delete(ref.key);
    },
    async test() {},
    async close() { calls.artifactsClosed++; },
  };
  const queue: AppQueue = {
    create(prompt, model, provider, batchId) {
      calls.created++;
      return runRecord({ batchId, promptId: prompt.id, modelId: model.id, providerId: provider.id,
        providerName: provider.name, modelName: model.name, modelSlug: model.modelId,
        promptTitle: prompt.title, promptContent: prompt.content, category: prompt.category,
        referenceAnswer: prompt.referenceAnswer, rubric: prompt.rubric, status: 'queued', finishedAt: null,
        execution: { providerId: provider.id, baseUrl: provider.baseUrl, encryptedApiKey: provider.encryptedApiKey,
          protocol: provider.protocol, modelId: model.modelId, maxTokens: model.maxTokens, reasoningEffort: model.reasoningEffort } });
    },
    enqueue(runs) { calls.enqueued += runs.length; for (const run of runs) store.put('runs', run); },
    cancel(run) { calls.cancelled++; const next = { ...run, status: 'cancelled' as const }; store.put('runs', next); return next; },
    retry(run) { calls.retried++; return { ...run, id: randomUUID(), status: 'queued', finishedAt: null }; },
    size: () => store.all<StoredRun>('runs').filter(run => ['queued', 'running'].includes(run.status)).length,
    async close() { calls.queueClosed++; },
  };
  return { artifacts, queue, calls, controls, objects };
}

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

type Application = ReturnType<typeof createApp>;
async function fixture(t: TestContext, setup: {
  prepareStore?: (store: Store) => void;
  wrapCreate?: (create: () => Application) => Application;
  options?: Partial<AppOptions>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-cloud-app-'));
  const time = { value: INITIAL_TIME };
  let store!: Store;
  let resources!: ReturnType<typeof injectedResources>;
  let application!: Application;
  let server!: Server;
  let url = '';
  let cookie = '';
  let stopped = true;
  const start = async (first: boolean) => {
    store = new Store(directory, ADMIN_TOKEN);
    if (first) setup.prepareStore?.(store);
    resources = injectedResources(store);
    const build = () => createApp({
      cloud: { origin: CLOUD_ORIGIN }, store, artifacts: resources.artifacts, queue: resources.queue,
      now: () => time.value, ...setup.options,
    });
    application = setup.wrapCreate ? setup.wrapCreate(build) : build();
    await application.ready;
    server = createServer(application.app);
    url = await listen(server);
    cookie = '';
    stopped = false;
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await application.close();
  };
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  await start(true);
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method,
    headers: { Origin: CLOUD_ORIGIN, 'CF-Connecting-IP': CLIENT_IP,
      ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (path: string, method = 'GET', body?: unknown) => {
    const response = await request(path, method, body);
    const value = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const login = async () => {
    const response = await request('/api/auth/login', 'POST', { token: ADMIN_TOKEN });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie);
    cookie = setCookie.split(';')[0]!;
    return setCookie;
  };
  return { directory, time, request, json, login, stop,
    application: () => application, store: () => store, resources: () => resources, url: () => url,
    restart: async () => { await stop(); await start(false); } };
}

test('cloud mode rejects missing injected dependencies and non-origin configuration', () => {
  assert.throws(() => createApp({ cloud: { origin: CLOUD_ORIGIN } }), /必须注入/);
  for (const origin of ['file:///tmp', 'https://lab.example.test/path', 'https://secret@lab.example.test', 'https://lab.example.test?x=1',
    'https://lab.example.test#fragment', 'https://*.workers.dev', ' https://lab.example.test', 'https://lab.example.test/../',
    'https://lab.example.test?', 'https://lab.example.test#']) {
    assert.throws(() => createApp({ cloud: { origin } }), /origin/);
    assert.throws(() => createApp({ cloud: { origin: CLOUD_ORIGIN, additionalOrigins: [origin] } }), /origin/);
  }
});

test('cloud creation uses injected resources without files, handoff, seed, queue recovery, or scheduler timers', async t => {
  let starts = 0;
  const cwdCallers: string[] = [];
  t.mock.method(Scheduler.prototype, 'start', () => { starts++; });
  const original = runRecord({ id: 'sample-pelican', source: 'sample', status: 'queued', finishedAt: null, output: 'legacy body' });
  const f = await fixture(t, {
    prepareStore(store) {
      // Bypass Store.put solely to simulate an old record that local startup migrates.
      store.db.prepare('INSERT INTO runs(id, data) VALUES (?, ?)').run(original.id, JSON.stringify(original));
    },
    options: { seed: true, initializeArtifacts: true, serveStatic: true, autoStartScheduler: true,
      dataDir: '/cloud-must-not-create\0', distDir: '/cloud-must-not-read\0', schedulerIntervalMs: 1, cleanupIntervalMs: 1 },
    wrapCreate(build) {
      // Express itself resolves its unused default "views" setting. Capture
      // callers so application-owned filesystem discovery still fails this check.
      const cwd = t.mock.method(process, 'cwd', () => {
        cwdCallers.push(new Error().stack || '');
        return '/cloudflare-virtual-root';
      });
      try { return build(); } finally { cwd.mock.restore(); }
    },
  });
  const runtime = f.application();
  assert.equal(runtime.store, f.store());
  assert.equal(runtime.artifacts, f.resources().artifacts);
  assert.equal(runtime.queue, f.resources().queue);
  assert.equal(starts, 0);
  assert.ok(cwdCallers.every(stack => stack.includes('express/lib/application.js')));
  assert.equal(f.store().get<StoredRun>('runs', original.id)?.status, 'queued');
  assert.equal(f.store().get<StoredRun>('runs', original.id)?.output, 'legacy body');
  assert.deepEqual(f.store().all('prompts'), []);
  assert.equal(f.resources().calls.memory, 0);
  assert.equal(f.resources().calls.writes, 0);
  assert.equal((await f.request('/api/health')).status, 200);
  assert.equal((await f.request('/')).status, 404);
  assert.ok(!(await readdir(f.directory)).some(name => name.includes('handoff')));
  await f.stop();
  assert.equal(f.resources().calls.queueClosed, 1);
  assert.equal(f.resources().calls.artifactsClosed, 1);
  await runtime.close();
  assert.equal(f.resources().calls.queueClosed, 1);
});

test('cloud writes trust only configured origin and cookies remain Secure behind the HTTP adapter', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/data')).status, 401);
  for (const origin of [f.url(), 'https://attacker.example', `${CLOUD_ORIGIN}/path`, 'null']) {
    const response = await f.request('/api/auth/login', 'POST', { token: ADMIN_TOKEN }, {
      Origin: origin, Host: 'attacker.example', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https',
    });
    assert.equal(response.status, 403, origin);
  }
  const cookie = await f.login();
  assert.match(cookie, /; Secure(?:;|$)/i);
  assert.match(cookie, /; HttpOnly(?:;|$)/i);
  assert.match(cookie, /; SameSite=Strict(?:;|$)/i);
  assert.deepEqual(await f.json('/api/auth/session'), { authenticated: true });
  const logout = await f.request('/api/auth/logout', 'POST');
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /; Secure(?:;|$)/i);
  assert.deepEqual(await f.json('/api/auth/session'), { authenticated: false });
});

test('cloud primary and explicitly configured Workers origins allow login and writes, without trusting other Workers or forged hosts', async t => {
  const f = await fixture(t, { options: { cloud: { origin: CLOUD_ORIGIN, additionalOrigins: [DEFAULT_ORIGIN] } } });
  for (const origin of [CLOUD_ORIGIN, DEFAULT_ORIGIN]) {
    const login = await f.request('/api/auth/login', 'POST', { token: ADMIN_TOKEN }, { Origin: origin });
    assert.equal(login.status, 200, origin);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(login.headers.get('set-cookie')!, /; Secure(?:;|$)/i);
    assert.equal((await f.request('/api/admin/settings', 'PATCH', { maxRetries: 2 }, { Origin: origin, Cookie: cookie })).status, 200);
    for (const untrusted of ['https://other.test-account.workers.dev', 'https://test-lab.other-account.workers.dev',
      `${DEFAULT_ORIGIN}.attacker.example`, `${DEFAULT_ORIGIN}:444`, `${DEFAULT_ORIGIN}/`, `${DEFAULT_ORIGIN}/path`,
      `${DEFAULT_ORIGIN}?q=1`, `${DEFAULT_ORIGIN}#hash`, 'https://user@test-lab.test-account.workers.dev', 'null']) {
      const forged = { Origin: untrusted, Cookie: cookie, Host: new URL(untrusted === 'null' ? DEFAULT_ORIGIN : untrusted).host,
        'X-Forwarded-Host': new URL(DEFAULT_ORIGIN).host, 'X-Forwarded-Proto': 'https' };
      assert.equal((await f.request('/api/auth/login', 'POST', { token: ADMIN_TOKEN }, forged)).status, 403, untrusted);
      assert.equal((await f.request('/api/admin/settings', 'PATCH', { maxRetries: 4 }, forged)).status, 403, untrusted);
    }
    assert.equal(f.store().settings().maxRetries, 2, 'Rejected writes cannot change settings');
  }
});

test('cloud password rotation invalidates existing cookies and accepts only the new password across application reconstruction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-cloud-password-'));
  const backing = new Store(directory, ADMIN_TOKEN);
  const storage = {
    sql: { exec(sql: string, ...values: (string | number | null | ArrayBuffer)[]) {
      const rows = backing.db.prepare(sql).all(...values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      return { toArray: () => rows };
    } },
    transactionSync: <T,>(callback: () => T) => backing.transaction(callback),
  } as unknown as DurableSqlStorage;
  const encryptionKey = new Uint8Array(32).fill(71);
  let application: Application | undefined;
  let server: Server | undefined;
  let url = '';
  const stop = async () => {
    if (!server || !application) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await application.close();
    server = undefined;
    application = undefined;
  };
  t.after(async () => { await stop(); backing.close(); await rm(directory, { recursive: true, force: true }); });
  const start = async (adminToken: string) => {
    await stop();
    const store = new CloudStore(storage, { encryptionKey, adminToken });
    const resources = injectedResources(store);
    application = createApp({ cloud: { origin: CLOUD_ORIGIN, additionalOrigins: [DEFAULT_ORIGIN] },
      store, artifacts: resources.artifacts, queue: resources.queue });
    await application.ready;
    server = createServer(application.app);
    url = await listen(server);
  };
  const login = (token: string) => fetch(`${url}/api/auth/login`, { method: 'POST',
    headers: { Origin: DEFAULT_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': CLIENT_IP }, body: JSON.stringify({ token }) });
  const session = (cookie: string) => fetch(`${url}/api/admin/data`, { headers: { Cookie: cookie } });
  await start(ADMIN_TOKEN);
  const originalLogin = await login(ADMIN_TOKEN);
  assert.equal(originalLogin.status, 200);
  const originalCookie = originalLogin.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await session(originalCookie)).status, 200);
  await start(ADMIN_TOKEN);
  assert.equal((await session(originalCookie)).status, 200, 'Same-password restarts preserve valid sessions');
  const changedToken = 'synthetic-cloud-password-rotated';
  await start(changedToken);
  assert.equal((await session(originalCookie)).status, 401, 'Password changes revoke cookies issued with the former password');
  assert.equal((await login(ADMIN_TOKEN)).status, 401);
  const changedLogin = await login(changedToken);
  assert.equal(changedLogin.status, 200);
  const changedCookie = changedLogin.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await session(changedCookie)).status, 200);
  await start(changedToken);
  assert.equal((await session(changedCookie)).status, 200);
  assert.equal((await session(originalCookie)).status, 401);
});

test('cloud login throttling survives instance recreation and ignores spoofed forwarding headers', async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal((await f.request('/api/auth/login', 'POST', { token: 'wrong-token' }, { 'X-Forwarded-For': `198.51.100.${attempt}` })).status, 401);
  }
  await f.restart();
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal((await f.request('/api/auth/login', 'POST', { token: 'wrong-token' }, { 'X-Forwarded-For': `192.0.2.${attempt}` })).status, 401);
  }
  const blocked = await f.request('/api/auth/login', 'POST', { token: ADMIN_TOKEN }, { 'X-Forwarded-For': '192.0.2.200' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
  assert.equal((await f.request('/api/auth/login', 'POST', { token: ADMIN_TOKEN }, { 'CF-Connecting-IP': '203.0.113.16' })).status, 200);
  const attempts = f.store().db.prepare('SELECT * FROM login_attempts').all();
  assert.equal(attempts.length, 1);
  assert.equal(Number(attempts[0]!.attempt_count), 10);
  assert.equal(JSON.stringify(attempts).includes(CLIENT_IP), false);
  f.time.value += 15 * 60_000 + 1;
  await f.login();
  assert.equal(f.store().db.prepare('SELECT * FROM login_attempts').all().length, 0);
});

test('cloud routes delegate queue operations and expose scheduler hooks without changing CRUD or backups', async t => {
  const f = await fixture(t);
  await f.login();
  const { provider } = await f.json('/api/admin/providers', 'POST', {
    name: 'Cloud API', baseUrl: 'https://upstream.example.test/v1', protocol: 'responses', apiKey: 'sk-cloud-test-private-secret', enabled: true,
  });
  const { model } = await f.json('/api/admin/models', 'POST', { name: 'Model', providerId: provider.id, modelId: 'test-model', maxTokens: 128, reasoningEffort: 'medium' });
  const { prompt } = await f.json('/api/admin/prompts', 'POST', { title: 'Question', category: 'reasoning', content: 'Compute mentally.' });
  const { runs } = await f.json('/api/admin/runs', 'POST', { promptIds: [prompt.id], modelIds: [model.id], repeats: 1 });
  assert.equal(f.resources().calls.created, 1);
  assert.equal(f.resources().calls.enqueued, 1);
  assert.equal((await f.json(`/api/admin/runs/${runs[0].id}/cancel`, 'POST')).run.status, 'cancelled');
  await f.json(`/api/admin/runs/${runs[0].id}/retry`, 'POST');
  assert.equal(f.resources().calls.cancelled, 1);
  assert.equal(f.resources().calls.retried, 1);
  const { schedule } = await f.json('/api/admin/schedules', 'POST', { name: 'Alarm plan', promptIds: [prompt.id], modelIds: [model.id], intervalMinutes: 1, enabled: true });
  assert.equal(f.resources().calls.enqueued, 2);
  f.time.value += 60_000;
  f.application().scheduler.tick();
  assert.equal(f.resources().calls.enqueued, 3);
  assert.ok(f.store().all<StoredRun>('runs').some(run => run.scheduleId === schedule.id));
  const data = await f.json('/api/admin/data');
  assert.equal(data.storage.mode, 'cloudflare');
  assert.equal(data.providers[0].hasApiKey, true);
  assert.equal(JSON.stringify(data).includes('sk-cloud-test-private-secret'), false);
  assert.equal((await f.json('/api/admin/storage', 'PATCH', { mode: 'cloudflare', prefix: 'model-lab' })).storage.mode, 'cloudflare');
  assert.equal((await f.request('/api/admin/storage', 'PATCH', { mode: 'memory' })).status, 400);
  const password = 'cloud-backup-test-password';
  const backup = await f.json('/api/admin/config/export', 'POST', { password });
  assert.ok(await f.json('/api/admin/config/preview', 'POST', { password, backup }));
  assert.ok(await f.json('/api/admin/config/import', 'POST', { password, backup }));
});

test('cloud hydration and retention delete through the injected object repository before removing history', async t => {
  const f = await fixture(t);
  await f.login();
  const output = { output: '<svg><circle r="10" /></svg>', html: '<svg><circle r="10" /></svg>', reasoning: '' };
  const artifact = await f.resources().artifacts.put('visual', output);
  const run = runRecord({ id: 'visual', category: 'visual', artifact, artifactStorage: 's3', artifactAvailable: true, hasHtml: true });
  f.store().put('runs', run);
  assert.equal((await f.json('/api/public/data')).runs[0].html, '');
  assert.equal((await f.json('/api/admin/runs/visual')).run.html, output.html);
  assert.equal((await f.json('/api/public/runs/visual')).run.output, output.output);
  f.resources().controls.failDelete = true;
  assert.equal((await f.request('/api/admin/runs/visual', 'DELETE')).status, 502);
  assert.ok(f.store().get<StoredRun>('runs', 'visual')?.cleanupError);
  assert.ok(f.resources().objects.has(artifact.key));
  f.resources().controls.failDelete = false;
  assert.equal((await f.request('/api/admin/runs/visual', 'DELETE')).status, 200);
  assert.equal(f.store().get('runs', 'visual'), undefined);
  assert.equal(f.resources().objects.has(artifact.key), false);
  const oldArtifact = await f.resources().artifacts.put('expired', { output: 'old result', html: '', reasoning: '' });
  f.store().put('runs', runRecord({ id: 'expired', artifact: oldArtifact, finishedAt: new Date(INITIAL_TIME - 31 * 86400_000).toISOString() }));
  await f.application().scheduler.cleanup();
  assert.equal(f.store().get('runs', 'expired'), undefined);
  assert.equal(f.resources().objects.has(oldArtifact.key), false);
  assert.ok(f.resources().calls.cleaned >= 1);
  assert.equal(f.resources().calls.memory, 0);
});

test('list projection reads retention once per response and immediately observes changed settings', async t => {
  const f = await fixture(t);
  await f.login();
  const provider = { id: 'provider', name: 'Cloud API', baseUrl: 'https://upstream.example.test/v1', protocol: 'responses' as const,
    enabled: true, retentionDays: 7, encryptedApiKey: '', createdAt: new Date(INITIAL_TIME).toISOString() };
  f.store().put('providers', provider);
  for (let index = 0; index < 200; index++) f.store().put('runs', runRecord({ id: `history-${index}` }));
  const db = f.store().db;
  const queries: string[] = [];
  const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql: string) => { queries.push(sql); return prepare(sql); });
  const expectedExpiry = (days: number) => new Date(INITIAL_TIME + days * 86400_000).toISOString();
  for (const path of ['/api/public/data', '/api/admin/data', '/api/public/runs?limit=200', '/api/admin/runs?limit=200']) {
    queries.length = 0;
    const result = await f.json(path);
    assert.equal(result.runs.length, 200, path);
    assert.ok(result.runs.every((run: StoredRun) => run.artifactExpiresAt === expectedExpiry(7)));
    assert.equal(queries.filter(sql => sql.includes('FROM providers WHERE id')).length, 0, `${path}: no per-run provider lookups`);
    assert.equal(queries.filter(sql => sql.includes('FROM providers ORDER')).length, 1, `${path}: one provider table read`);
    assert.equal(queries.filter(sql => sql.includes("FROM settings WHERE id = 'global'")).length, 1, `${path}: one settings read`);
    assert.equal(queries.filter(sql => sql.includes('FROM runs ORDER')).length, 1, `${path}: one history read`);
  }
  f.store().put('providers', { ...provider, retentionDays: 2 });
  assert.equal((await f.json('/api/public/runs?limit=1')).runs[0].artifactExpiresAt, expectedExpiry(2));
  f.store().put('providers', { ...provider, retentionDays: null });
  f.store().saveSettings({ retentionDays: 3 });
  assert.equal((await f.json('/api/admin/data')).runs[0].artifactExpiresAt, expectedExpiry(3));
});
