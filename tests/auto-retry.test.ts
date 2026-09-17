import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import { ArtifactStore } from '../server/artifacts.ts';
import { RunQueue, QueueError } from '../server/queue.ts';
import { Store, type StoredProvider, type StoredRun } from '../server/store.ts';
import type { AdminData, LabSettings, Model, Prompt, Provider, Run, Schedule } from '../shared/types.ts';

const ADMIN_TOKEN = 'retry-suite-admin-secret';
const API_KEY = 'sk-retry-suite-never-expose-a9841';
const PROMPT = '\n请保留  空格与换行并回答。\n';
// The polling helpers must observe a retry while it is still queued. A 100 ms
// window was too tight on loaded CI runners and made these tests flaky.
const RETRY_WINDOW_MS = 1_000;
type AppOptions = Parameters<typeof createApp>[0];
type Captured = { number: number; path: string; authorization: string | undefined; body: Record<string, unknown> };

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function mock(t: TestContext, handler: (request: Captured, response: ServerResponse) => void | Promise<void>) {
  const requests: Captured[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const captured = { number: requests.length + 1, path: request.url!, authorization: request.headers.authorization,
      body: body ? JSON.parse(body) as Record<string, unknown> : {} };
    requests.push(captured);
    await handler(captured, response);
  });
  const url = await listen(server);
  t.after(() => closeServer(server));
  return { url, requests };
}

function reply(response: ServerResponse, status = 200, content = '完成') {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(status === 200
    ? { choices: [{ message: { role: 'assistant', content } }] }
    : { error: { message: `upstream HTTP ${status} ${API_KEY}` } }));
}

async function until<T>(check: () => T | Promise<T>, predicate: (value: T) => boolean, message = 'Expected state was not reached'): Promise<T> {
  const deadline = Date.now() + 8_000;
  let value!: T;
  do {
    value = await check();
    if (predicate(value)) return value;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function fixture(t: TestContext, options: AppOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'model-lab-auto-retry-'));
  const appOptions = { dataDir, adminToken: ADMIN_TOKEN, seed: false, retryBaseDelayMs: 10,
    schedulerIntervalMs: 60_000, cleanupIntervalMs: 60_000, ...options };
  let application = createApp(appOptions);
  let server = createServer(application.app);
  let origin = await listen(server);
  let cookie = '';
  let stopped = false;
  const request = (path: string, method = 'GET', body?: unknown, anonymous = false) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(!anonymous && cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await request(path, method, body);
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };
  const login = async () => {
    const response = await request('/api/auth/login', 'POST', { token: ADMIN_TOKEN });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  };
  await login();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await application.close();
    await closeServer(server);
  };
  const restart = async () => {
    await stop();
    application = createApp(appOptions); server = createServer(application.app);
    origin = await listen(server); cookie = ''; stopped = false;
    await login();
  };
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const records = async () => (await json<AdminData>('/api/admin/data')).runs;
  const chain = async (rootId: string) => (await records()).filter((item) => item.retryRootId === rootId)
    .sort((a, b) => (a.retryAttempt ?? 0) - (b.retryAttempt ?? 0));
  return { json, request, records, chain, stop, restart };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function configure(f: Fixture, baseUrl: string, maxRetries = 5) {
  await f.json('/api/admin/settings', 'PATCH', { maxRetries });
  const { provider } = await f.json<{ provider: Provider }>('/api/admin/providers', 'POST', {
    name: '重试 API 接口', baseUrl: `${baseUrl}/v1`, protocol: 'chat-completions', apiKey: API_KEY, enabled: true,
  });
  const { model } = await f.json<{ model: Model }>('/api/admin/models', 'POST', {
    providerId: provider.id, name: '重试测试模型', modelId: 'mock-original-model', enabled: true, maxTokens: 512, reasoningEffort: 'max',
  });
  const { prompt } = await f.json<{ prompt: Prompt }>('/api/admin/prompts', 'POST', {
    title: '原始提示词', category: 'text', content: PROMPT, enabled: true,
  });
  return { provider, model, prompt };
}

async function start(f: Fixture, model: Model, prompt: Prompt) {
  return (await f.json<{ runs: Run[] }>('/api/admin/runs', 'POST', { modelIds: [model.id], promptIds: [prompt.id], repeats: 1 })).runs[0]!;
}

async function settled(f: Fixture, root: Run, count: number) {
  return until(() => f.chain(root.id), (runs) => runs.length === count && runs.every((item) => ['completed', 'failed', 'cancelled'].includes(item.status)),
    `Retry chain ${root.id} should contain ${count} terminal attempts`);
}

async function waiting(f: Fixture, root: Run) {
  const records = await until(() => f.chain(root.id), (runs) => runs.some((item) => item.retryAttempt === 1 && item.status === 'queued' && Boolean(item.retryAt)));
  return records.find((item) => item.retryAttempt === 1)!;
}

test('retry and timeout settings validate their bounds and PATCH preserves unrelated settings across restart', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.json<AdminData>('/api/admin/data')).settings, { retentionDays: 30, maxRetries: 5, requestTimeoutSeconds: 600 });
  assert.deepEqual((await f.json<{ settings: LabSettings }>('/api/admin/settings', 'PATCH', { retentionDays: 45 })).settings,
    { retentionDays: 45, maxRetries: 5, requestTimeoutSeconds: 600 });
  assert.deepEqual((await f.json<{ settings: LabSettings }>('/api/admin/settings', 'PATCH', { maxRetries: 0 })).settings,
    { retentionDays: 45, maxRetries: 0, requestTimeoutSeconds: 600 });
  await f.json('/api/admin/settings', 'PATCH', { maxRetries: 10 });
  for (const maxRetries of [-1, 11, 1.5, '2', null]) {
    assert.equal((await f.request('/api/admin/settings', 'PATCH', { maxRetries })).status, 400);
  }
  for (const requestTimeoutSeconds of [30, 720]) {
    assert.equal((await f.json<{ settings: LabSettings }>('/api/admin/settings', 'PATCH', { requestTimeoutSeconds })).settings.requestTimeoutSeconds, requestTimeoutSeconds);
  }
  for (const requestTimeoutSeconds of [0, 29, 721, 30.5, '600', null]) {
    assert.equal((await f.request('/api/admin/settings', 'PATCH', { requestTimeoutSeconds })).status, 400);
  }
  await f.json('/api/admin/settings', 'PATCH', { retentionDays: 46 });
  await f.restart();
  assert.deepEqual((await f.json<AdminData>('/api/admin/data')).settings, { retentionDays: 46, maxRetries: 10, requestTimeoutSeconds: 720 });
});

test('HTTP 408 automatically retries once, showing the recovered outcome and retaining both attempt details', async (t) => {
  const upstream = await mock(t, (request, response) => reply(response, request.number === 1 ? 408 : 200));
  const f = await fixture(t);
  const { model, prompt } = await configure(f, upstream.url, 2);
  const root = await start(f, model, prompt);
  assert.equal(root.retryAttempt, 0); assert.equal(root.retryLimit, 2); assert.equal(root.retryRootId, root.id);
  const attempts = await settled(f, root, 2);
  const [failed, completed] = attempts;
  assert.equal(upstream.requests.length, 2);
  assert.equal(failed!.status, 'failed'); assert.equal(completed!.status, 'completed');
  assert.equal(failed!.nextRetryId, completed!.id);
  assert.equal(completed!.retryOf, failed!.id); assert.equal(completed!.retryKind, 'automatic');
  assert.equal(completed!.retryRootId, root.id); assert.equal(completed!.retryAttempt, 1);
  assert.equal(completed!.batchId, root.batchId);
  assert.deepEqual(upstream.requests[0]!.body, upstream.requests[1]!.body);
  const gallery = await f.json<{ runs: Run[]; total: number }>('/api/public/runs');
  assert.equal(gallery.total, 1);
  assert.deepEqual(gallery.runs.map(run => run.id), [completed!.id]);
  for (const attempt of attempts) {
    const response = await f.request(`/api/public/runs/${attempt.id}`, 'GET', undefined, true);
    assert.equal(response.status, 200);
    const detail = await response.json() as { run: Run };
    assert.equal(detail.run.status, attempt.status);
    assert.ok(!JSON.stringify(detail).includes(API_KEY));
    assert.equal('execution' in detail.run, false);
  }
});

test('retry limits count additional attempts and zero disables automatic retries', async (t) => {
  for (const maxRetries of [0, 2]) {
    const upstream = await mock(t, (_request, response) => reply(response, 429));
    const f = await fixture(t);
    const { model, prompt } = await configure(f, upstream.url, maxRetries);
    const root = await start(f, model, prompt);
    const attempts = await settled(f, root, maxRetries + 1);
    await delay(50);
    assert.equal(upstream.requests.length, maxRetries + 1);
    assert.deepEqual(attempts.map((item) => item.retryAttempt), Array.from({ length: maxRetries + 1 }, (_, index) => index));
    assert.ok(attempts.every((item) => item.status === 'failed' && item.retryLimit === maxRetries));
    assert.ok(!attempts.at(-1)!.nextRetryId);
  }
});

test('permanent HTTP errors and invalid, incomplete, refused or empty output never retry', async (t) => {
  let scenario: number | 'invalid-json' | 'truncated' | 'refusal' | 'empty' = 401;
  const upstream = await mock(t, (_request, response) => {
    if (typeof scenario === 'number') return reply(response, scenario);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (scenario === 'invalid-json') response.end('{invalid');
    else if (scenario === 'truncated') response.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '未完整输出' } }] }));
    else if (scenario === 'refusal') response.end(JSON.stringify({ choices: [{ message: { refusal: '拒答', content: null } }] }));
    else response.end(JSON.stringify({ choices: [{ message: { content: '  ' } }] }));
  });
  const f = await fixture(t);
  const { model, prompt } = await configure(f, upstream.url, 2);
  for (const next of [400, 401, 403, 404, 422, 'invalid-json', 'truncated', 'refusal', 'empty'] as const) {
    scenario = next;
    const before = upstream.requests.length;
    const root = await start(f, model, prompt);
    const attempts = await settled(f, root, 1);
    await delay(35);
    assert.equal(upstream.requests.length, before + 1, `${next} must not trigger another billed model request`);
    assert.equal(attempts[0]!.status, 'failed');
    assert.ok(!attempts[0]!.nextRetryId);
  }
});

test('timeouts, connection failures and 5xx responses retry, then can recover', async (t) => {
  for (const scenario of ['timeout', 'network', 'server-error'] as const) {
    const upstream = await mock(t, (request, response) => {
      if (request.number > 1) return reply(response);
      if (scenario === 'timeout') return;
      if (scenario === 'network') response.destroy();
      else reply(response, 503);
    });
    const f = await fixture(t, { requestTimeoutMs: 80 });
    const { model, prompt } = await configure(f, upstream.url, 1);
    const attempts = await settled(f, await start(f, model, prompt), 2);
    assert.equal(upstream.requests.length, 2, `${scenario} should retry exactly once`);
    assert.deepEqual(attempts.map((item) => item.status), ['failed', 'completed']);
  }
});

test('cancelling a delayed retry removes its timer and leaves the failure history intact', async (t) => {
  const upstream = await mock(t, (_request, response) => reply(response, 500));
  const f = await fixture(t, { retryBaseDelayMs: RETRY_WINDOW_MS });
  const { model, prompt } = await configure(f, upstream.url, 2);
  const root = await start(f, model, prompt);
  const child = await waiting(f, root);
  await f.json(`/api/admin/runs/${child.id}/cancel`, 'POST');
  await delay(RETRY_WINDOW_MS + 100);
  assert.equal(upstream.requests.length, 1);
  const attempts = await f.chain(root.id);
  assert.deepEqual(attempts.map((item) => item.status), ['failed', 'cancelled']);
  assert.equal(attempts[0]!.nextRetryId, child.id);
});

test('closing and restarting settles delayed work without resuming or extending automatic chains', async (t) => {
  const upstream = await mock(t, (_request, response) => reply(response, 500));
  const f = await fixture(t, { retryBaseDelayMs: RETRY_WINDOW_MS });
  const { model, prompt } = await configure(f, upstream.url, 2);
  const root = await start(f, model, prompt);
  const child = await waiting(f, root);
  await f.stop();
  await delay(RETRY_WINDOW_MS + 100);
  assert.equal(upstream.requests.length, 1, 'Closing the queue must clear delayed retry timers');
  await f.restart();
  await delay(RETRY_WINDOW_MS + 100);
  assert.equal(upstream.requests.length, 1, 'Restart must not re-enqueue interrupted attempts');
  const attempts = await f.chain(root.id);
  assert.equal(attempts.length, 2);
  assert.equal(attempts.find((item) => item.id === child.id)!.status, 'failed');
  assert.ok(!attempts.at(-1)!.nextRetryId);
});

test('disabling an API provider or model prevents a queued automatic attempt from contacting upstream', async (t) => {
  for (const disabled of ['provider', 'model'] as const) {
    const upstream = await mock(t, (_request, response) => reply(response, 500));
    const f = await fixture(t, { retryBaseDelayMs: RETRY_WINDOW_MS });
    const { provider, model, prompt } = await configure(f, upstream.url, 2);
    const root = await start(f, model, prompt);
    const child = await waiting(f, root);
    if (disabled === 'provider') await f.json(`/api/admin/providers/${provider.id}`, 'PUT', { ...provider, enabled: false });
    else await f.json(`/api/admin/models/${model.id}`, 'PUT', { ...model, enabled: false });
    // Wait for the queued retry to settle instead of racing a fixed delay.
    const attempts = await until(() => f.chain(root.id), (runs) => runs.length === 2
      && runs.every((item) => ['completed', 'failed', 'cancelled'].includes(item.status)));
    assert.equal(upstream.requests.length, 1);
    assert.equal(attempts.length, 2);
    assert.ok(['failed', 'cancelled'].includes(attempts.find((item) => item.id === child.id)!.status));
    assert.ok(!attempts.at(-1)!.nextRetryId);
  }
});

test('automatic attempts retain request and retry-limit snapshots while manual retry starts a new chain', async (t) => {
  const upstream = await mock(t, (request, response) => reply(response, request.number <= 2 ? 503 : 200));
  const replacement = await mock(t, (_request, response) => reply(response));
  const f = await fixture(t, { retryBaseDelayMs: RETRY_WINDOW_MS });
  const { provider, model, prompt } = await configure(f, upstream.url, 1);
  const root = await start(f, model, prompt);
  assert.equal(root.requestTimeoutSeconds, 600);
  await waiting(f, root);
  await f.json('/api/admin/settings', 'PATCH', { maxRetries: 3, requestTimeoutSeconds: 720 });
  await f.json(`/api/admin/models/${model.id}`, 'PUT', { ...model, modelId: 'changed-model', maxTokens: 2048, reasoningEffort: 'low' });
  await f.json(`/api/admin/providers/${provider.id}`, 'PUT', { ...provider, baseUrl: `${replacement.url}/v1`, apiKey: 'sk-changed-live-provider-key' });
  await f.json(`/api/admin/prompts/${prompt.id}`, 'PUT', { ...prompt, content: '修改后的提示词' });
  const automatic = await settled(f, root, 2);
  assert.ok(automatic.every((item) => item.retryLimit === 1));
  assert.ok(automatic.every((item) => item.requestTimeoutSeconds === 600));
  assert.equal(automatic.at(-1)!.status, 'failed');
  assert.equal(replacement.requests.length, 0, 'Automatic retry must retain the original API endpoint');
  assert.deepEqual(upstream.requests[0]!.body, upstream.requests[1]!.body);
  assert.equal(upstream.requests[1]!.authorization, `Bearer ${API_KEY}`);
  const manual = (await f.json<{ runs: Run[] }>(`/api/admin/runs/${automatic.at(-1)!.id}/retry`, 'POST')).runs[0]!;
  assert.equal(manual.retryAttempt, 0); assert.equal(manual.retryRootId, manual.id); assert.equal(manual.retryLimit, 3);
  assert.equal(manual.retryOf, automatic.at(-1)!.id); assert.equal(manual.retryKind, 'manual');
  assert.equal(manual.requestTimeoutSeconds, 720);
  assert.notEqual(manual.batchId, root.batchId);
  const completed = await settled(f, manual, 1);
  assert.equal(completed[0]!.status, 'completed');
  assert.equal(upstream.requests.length, 3); assert.equal(replacement.requests.length, 0);
  assert.deepEqual(upstream.requests[2]!.body, upstream.requests[0]!.body, 'Manual retry retains the historical request snapshot');
  assert.equal(upstream.requests[2]!.authorization, `Bearer ${API_KEY}`);
});

test('scheduled retries share their schedule and batch, and prevent duplicate scheduled launches while waiting', async (t) => {
  const upstream = await mock(t, (request, response) => reply(response, request.number === 1 ? 429 : 200));
  const f = await fixture(t, { retryBaseDelayMs: RETRY_WINDOW_MS });
  const { model, prompt } = await configure(f, upstream.url, 2);
  const { schedule } = await f.json<{ schedule: Schedule }>('/api/admin/schedules', 'POST', {
    name: '带自动重试的计划', modelIds: [model.id], promptIds: [prompt.id], intervalMinutes: 60, enabled: false,
  });
  const root = (await f.json<{ runs: Run[] }>(`/api/admin/schedules/${schedule.id}/run`, 'POST')).runs[0]!;
  const child = await waiting(f, root);
  assert.equal(child.scheduleId, schedule.id); assert.equal(child.batchId, root.batchId);
  assert.equal((await f.request(`/api/admin/schedules/${schedule.id}/run`, 'POST')).status, 409);
  const attempts = await settled(f, root, 2);
  assert.equal(attempts.at(-1)!.status, 'completed');
  assert.ok(attempts.every((item) => item.scheduleId === schedule.id && item.batchId === root.batchId));
});

async function queueFixture(t: TestContext, baseUrl: string, retryBaseDelayMs = 100, clock: () => number = Date.now, timeoutMs: number | null = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-retry-queue-'));
  const store = new Store(directory, ADMIN_TOKEN);
  const artifacts = new ArtifactStore(store);
  store.saveSettings({ retentionDays: 30, maxRetries: 1 });
  const createdAt = new Date().toISOString();
  const provider: StoredProvider = { id: randomUUID(), name: '队列 API', baseUrl: `${baseUrl}/v1`, protocol: 'chat-completions',
    enabled: true, createdAt, encryptedApiKey: store.encrypt(API_KEY) };
  const model: Model = { id: randomUUID(), providerId: provider.id, name: '队列模型', modelId: 'mock-queue',
    enabled: true, maxTokens: 512, reasoningEffort: 'max', createdAt };
  const prompt: Prompt = { id: randomUUID(), title: '队列提示词', category: 'text', content: PROMPT, description: '',
    referenceAnswer: '', rubric: '', tags: [], enabled: true, createdAt, updatedAt: createdAt };
  store.put('providers', provider); store.put('models', model); store.put('prompts', prompt);
  const queue = new RunQueue(store, timeoutMs ?? undefined, 1, clock, artifacts, retryBaseDelayMs);
  t.after(async () => { await queue.close(); await artifacts.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, artifacts, queue, provider, model, prompt };
}

test('Node queue waits beyond 180 seconds and times out at the captured global deadline', async t => {
  const f = await queueFixture(t, 'https://mock.invalid', 100, Date.now, null);
  f.store.saveSettings({ ...f.store.settings(), maxRetries: 0, requestTimeoutSeconds: 600 });
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; }); let signal!: AbortSignal;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = init.signal!; signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    started();
  }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = f.queue.create(f.prompt, f.model, f.provider, randomUUID());
  f.queue.enqueue([{ ...root, requestTimeoutSeconds: undefined }]); await start;
  assert.equal(f.store.get<StoredRun>('runs', root.id)?.requestTimeoutSeconds, 600);
  f.store.saveSettings({ ...f.store.settings(), requestTimeoutSeconds: 30 });
  t.mock.timers.tick(180_001); assert.equal(signal.aborted, false);
  t.mock.timers.tick(419_998); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve));
  const failed = f.store.get<StoredRun>('runs', root.id)!;
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /请求超时（600 秒）/);
  assert.equal(failed.nextRetryId, undefined); assert.equal(f.queue.retry(failed).requestTimeoutSeconds, 30);
});

test('manual retry rejects samples and missing execution snapshots before queueing any work', async (t) => {
  const upstream = await mock(t, (_request, response) => reply(response));
  const f = await queueFixture(t, upstream.url);
  const root = f.queue.create(f.prompt, f.model, f.provider, randomUUID());
  for (const invalid of [{ ...root, source: 'sample' as const }, { ...root, execution: undefined }]) {
    assert.throws(() => f.queue.retry(invalid), (error: unknown) => error instanceof QueueError && error.status === 400);
  }
  assert.equal(f.queue.size(), 0);
  assert.equal(f.store.all<StoredRun>('runs').length, 0);
  assert.equal(upstream.requests.length, 0);
});

test('disabling queued first attempts preserves the active request and lets other models continue', async (t) => {
  for (const disabled of ['provider', 'model'] as const) await t.test(disabled, async (t) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const upstream = await mock(t, async (request, response) => {
      if (request.number === 1) await held;
      reply(response);
    });
    const f = await queueFixture(t, upstream.url, 100, Date.now, 10_000);
    const otherProvider = { ...f.provider, id: randomUUID(), name: '仍启用的接口' };
    const otherModel = { ...f.model, id: randomUUID(), providerId: otherProvider.id, modelId: 'mock-other' };
    f.store.put('providers', otherProvider); f.store.put('models', otherModel);
    const batchId = randomUUID();
    const active = f.queue.create(f.prompt, f.model, f.provider, batchId);
    const skipped = f.queue.create(f.prompt, f.model, f.provider, batchId);
    const unrelated = f.queue.create(f.prompt, otherModel, otherProvider, batchId);
    f.queue.enqueue([active, skipped, unrelated]);
    try {
      await until(() => upstream.requests.length, count => count === 1);
      if (disabled === 'provider') f.store.put('providers', { ...f.provider, enabled: false });
      else f.store.put('models', { ...f.model, enabled: false });
      assert.equal(f.store.get<StoredRun>('runs', active.id)?.status, 'running');
      assert.equal(f.store.get<StoredRun>('runs', skipped.id)?.status, 'queued');
      assert.equal(upstream.requests.length, 1);
    } finally { release(); }
    await until(() => f.queue.size(), count => count === 0);
    assert.equal(f.store.get<StoredRun>('runs', active.id)?.status, 'completed');
    const cancelled = f.store.get<StoredRun>('runs', skipped.id)!;
    assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.finishedAt);
    assert.match(cancelled.error, /已停用/); assert.equal(cancelled.nextRetryId, undefined);
    assert.equal(f.store.get<StoredRun>('runs', unrelated.id)?.status, 'completed');
    assert.deepEqual(upstream.requests.map(request => request.body.model), ['mock-queue', 'mock-other']);
    if (disabled === 'provider') f.store.put('providers', f.provider);
    else f.store.put('models', f.model);
    const restored = f.queue.create(f.prompt, f.model, f.provider, randomUUID());
    f.queue.enqueue([restored]);
    await until(() => f.queue.size(), count => count === 0);
    assert.equal(f.store.get<StoredRun>('runs', restored.id)?.status, 'completed');
    assert.deepEqual(f.store.get<StoredRun>('runs', skipped.id), cancelled, 'Re-enabling must not replay the cancelled attempt');
    assert.deepEqual(upstream.requests.map(request => request.body.model), ['mock-queue', 'mock-other', 'mock-queue']);
    assert.equal(f.store.all<StoredRun>('runs').length, 4);
  });
});

test('a queued first attempt missing its execution snapshot retains its diagnostic and makes no request', async t => {
  const upstream = await mock(t, (_request, response) => reply(response));
  const f = await queueFixture(t, upstream.url);
  const run = { ...f.queue.create(f.prompt, f.model, f.provider, randomUUID()), execution: undefined };
  f.queue.enqueue([run]);
  await until(() => f.queue.size(), count => count === 0);
  const failed = f.store.get<StoredRun>('runs', run.id)!;
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /缺少 API 参数快照/);
  assert.equal(failed.nextRetryId, undefined); assert.equal(upstream.requests.length, 0);
});

test('retry delays release active concurrency so unrelated evaluations can finish immediately', async (t) => {
  const upstream = await mock(t, (request, response) => reply(response, request.number === 1 ? 500 : 200));
  const f = await queueFixture(t, upstream.url, 500);
  const root = f.queue.create(f.prompt, f.model, f.provider, randomUUID());
  f.queue.enqueue([root]);
  const child = await until(() => f.store.all<StoredRun>('runs').find((item) => item.retryAttempt === 1),
    (item) => Boolean(item?.status === 'queued' && item.retryAt));
  const unrelated = f.queue.create(f.prompt, f.model, f.provider, randomUUID());
  f.queue.enqueue([unrelated]);
  await until(() => f.store.get<StoredRun>('runs', unrelated.id), (item) => item?.status === 'completed');
  assert.equal(upstream.requests.length, 2);
  assert.equal(f.store.get<StoredRun>('runs', child!.id)!.status, 'queued');
  assert.equal(f.queue.size(), 1);
  f.queue.cancel(f.store.get<StoredRun>('runs', child!.id)!);
  assert.equal(f.queue.size(), 0);
});

test('retry timestamps use exponential backoff from five seconds and cap the delay at one minute', async (t) => {
  const upstream = await mock(t, (_request, response) => reply(response, 500));
  const now = Date.now();
  const f = await queueFixture(t, upstream.url, 5000, () => now);
  for (const [retryAttempt, expectedDelay] of [[0, 5000], [1, 10000], [4, 60000]] as const) {
    // Seed a valid attempt snapshot at each stage to verify long delays without waiting for the timers.
    const root = { ...f.queue.create(f.prompt, f.model, f.provider, randomUUID()), retryLimit: 10, retryAttempt };
    f.queue.enqueue([root]);
    const child = await until(() => f.store.all<StoredRun>('runs').find((item) => item.retryOf === root.id),
      (item) => Boolean(item?.status === 'queued' && item.retryAt));
    assert.equal(child!.retryAttempt, retryAttempt + 1);
    assert.equal(Date.parse(child!.retryAt!) - now, expectedDelay);
    f.queue.cancel(child!);
  }
  assert.equal(upstream.requests.length, 3);
  assert.equal(f.queue.size(), 0);
});

test('queue capacity includes delayed retries and rejects a 201st queued evaluation atomically', async (t) => {
  const upstream = await mock(t, (_request, response) => reply(response, 429));
  const f = await queueFixture(t, upstream.url, 30_000);
  const roots = Array.from({ length: 200 }, () => f.queue.create(f.prompt, f.model, f.provider, randomUUID()));
  f.queue.enqueue(roots);
  const waiting = await until(() => f.store.all<StoredRun>('runs').filter((item) => item.retryAttempt === 1 && item.status === 'queued'),
    (items) => items.length === 200, 'Each failed initial evaluation should be replaced by one delayed attempt');
  assert.equal(upstream.requests.length, 200);
  assert.equal(f.queue.size(), 200);
  const overflow = f.queue.create(f.prompt, f.model, f.provider, randomUUID());
  assert.throws(() => f.queue.enqueue([overflow]), (error: unknown) => error instanceof QueueError && error.status === 429);
  assert.equal(f.store.get<StoredRun>('runs', overflow.id), undefined, 'Rejected enqueue must not persist a dangling queued record');
  f.queue.cancel(waiting[0]!);
  assert.equal(f.queue.size(), 199);
});

test('artifact persistence failure preserves the returned output and never repeats the model call', async (t) => {
  const upstream = await mock(t, (_request, response) => reply(response));
  const f = await queueFixture(t, upstream.url, 10);
  t.mock.method(f.artifacts, 'put', async () => { throw new Error('mock storage unavailable'); });
  const root = f.queue.create(f.prompt, f.model, f.provider, randomUUID());
  f.queue.enqueue([root]);
  const failed = await until(() => f.store.get<StoredRun>('runs', root.id), (item) => item?.status === 'failed');
  await delay(40);
  assert.equal(upstream.requests.length, 1);
  assert.ok(!failed!.nextRetryId);
  assert.equal(failed!.artifact?.storage, 'memory');
  assert.equal((await f.artifacts.get(failed!.artifact!))?.output, '完成');
});
