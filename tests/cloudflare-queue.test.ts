import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Store, runDto, type StoredProvider, type StoredRun } from '../server/store.ts';
import type { Model, Prompt } from '../shared/types.ts';
import { CloudRunQueue, CloudQueueError, type CloudStoredRun, type CloudRunQueueOptions } from '../cloudflare/queue.ts';
import { CloudflareArtifactStore, type NativeR2Bucket } from '../cloudflare/artifacts.ts';

const SECRET = 'sk-cloud-queue-secret-never-public';
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release, started: false }; }
async function until(condition: () => boolean, message: string) {
  const end = Date.now() + 4000;
  while (!condition() && Date.now() < end) await delay(5);
  assert.ok(condition(), message);
}
function reply(response: ServerResponse, content = '21', status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(status === 200 ? { choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 5 } }
    : { error: { message: SECRET } }));
}
async function upstream(t: TestContext, handler: (index: number, response: ServerResponse) => void | Promise<void> = (_index, response) => reply(response)) {
  const requests: { body: Record<string, unknown>; authorization?: string }[] = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part;
    requests.push({ body: JSON.parse(text), authorization: request.headers.authorization });
    await handler(requests.length, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { requests, url: `http://127.0.0.1:${address.port}/v1` };
}
async function fixture(t: TestContext, url: string, settings: { retries?: number; options?: Partial<CloudRunQueueOptions>; bucket?: NativeR2Bucket } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-cloud-queue-'));
  const store = new Store(directory, 'test-only-admin');
  Object.assign(store, { deployment: 'cloudflare' });
  let time = Date.now(), wakes = 0;
  const clock = () => time;
  const artifacts = new CloudflareArtifactStore(store as Store & { deployment: string }, settings.bucket, { clock, orphanGraceMs: 0 });
  store.saveSettings({ retentionDays: 7, maxRetries: settings.retries ?? 0 });
  const createdAt = new Date(time).toISOString();
  const provider: StoredProvider = { id: randomUUID(), name: '测试接口', baseUrl: url, protocol: 'chat-completions', enabled: true,
    retentionDays: 7, createdAt, encryptedApiKey: store.encrypt(SECRET) };
  const model: Model = { id: randomUUID(), providerId: provider.id, name: '测试模型', modelId: 'mock-model', maxTokens: 512, reasoningEffort: 'max', enabled: true, createdAt };
  const prompt: Prompt = { id: randomUUID(), title: '测试题', content: '请只回答21', category: 'reasoning', description: '', referenceAnswer: '21', rubric: '', tags: [], enabled: true, createdAt, updatedAt: createdAt };
  store.put('providers', provider); store.put('models', model); store.put('prompts', prompt);
  const queues: CloudRunQueue[] = [];
  const newQueue = () => { const queue = new CloudRunQueue(store, artifacts, { wake: () => { wakes++; }, now: clock, timeoutMs: 2000, ...settings.options }); queues.push(queue); return queue; };
  const queue = newQueue();
  t.after(async () => { await Promise.all(queues.map(queue => queue.close())); await artifacts.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, artifacts, queue, newQueue, provider, model, prompt, clock, advance: (ms: number) => { time += ms; }, wakes: () => wakes,
    create: (batchId = 'batch') => queue.create(prompt, model, provider, batchId), runs: () => store.all<CloudStoredRun>('runs') };
}

test('HTTP enqueue is durable-only; each awaited alarm wave runs at most two attempts', async t => {
  const mock = await upstream(t); const f = await fixture(t, mock.url);
  const runs = Array.from({ length: 5 }, () => f.create()); f.queue.enqueue(runs);
  await delay(20);
  assert.equal(mock.requests.length, 0); assert.equal(f.queue.size(), 5); assert.equal(f.queue.nextWakeAt(), f.clock()); assert.equal(f.wakes(), 1);
  const first = f.queue.processWave(); const overlapping = f.queue.processWave(); assert.equal(first, overlapping);
  await first; assert.equal(mock.requests.length, 2); assert.equal(f.queue.size(), 3);
  await delay(20); assert.equal(mock.requests.length, 2, 'No background pump may start another paid request');
  await f.queue.processWave(); assert.equal(mock.requests.length, 4);
  await f.queue.processWave(); assert.equal(mock.requests.length, 5); assert.equal(f.queue.nextWakeAt(), null);
  assert.ok(mock.requests.every(request => request.body.stream === true));
  assert.ok(f.runs().every(run => run.status === 'completed' && !run.queueLease));
  for (const run of f.runs()) {
    assert.equal((await f.artifacts.get(run.artifact!))?.output, '21');
    const json = JSON.stringify(runDto(run)); assert.ok(!json.includes(SECRET)); assert.ok(!json.includes('queueLease')); assert.ok(!json.includes('execution'));
  }
});

test('queued work survives reconstruction while an already-sent unknown request is not replayed', async t => {
  const hold = gate();
  const mock = await upstream(t, async (index, response) => { if (index === 1) { hold.started = true; await hold.promise; } reply(response); });
  const f = await fixture(t, mock.url, { retries: 5, options: { concurrency: 1 } });
  const first = f.create(); f.advance(1); const second = f.create(); f.queue.enqueue([first, second]);
  const oldWave = f.queue.processWave();
  try {
    await until(() => hold.started, 'First attempt should reach upstream');
    const claimed = f.store.get<CloudStoredRun>('runs', first.id)!;
    assert.equal(claimed.status, 'running'); assert.ok(claimed.queueLease?.token);
    const reconstructed = f.newQueue();
    assert.equal(f.store.get<StoredRun>('runs', first.id)?.status, 'failed');
    assert.match(f.store.get<StoredRun>('runs', first.id)!.error, /未自动重放/);
    assert.equal(f.store.get<StoredRun>('runs', second.id)?.status, 'queued');
    assert.equal(reconstructed.recoverInterrupted(), 0);
    await reconstructed.processWave();
    assert.equal(mock.requests.length, 2); assert.equal(f.store.get<StoredRun>('runs', second.id)?.status, 'completed');
  } finally { hold.release(); await oldWave; }
  assert.equal(f.store.get<StoredRun>('runs', first.id)?.status, 'failed', 'A stale owner cannot overwrite the recovery result');
  assert.equal(f.store.get<StoredRun>('runs', first.id)?.nextRetryId, undefined); assert.equal(f.runs().length, 2);
});

test('automatic retries persist deadlines and snapshots; a manual retry begins a fresh chain', async t => {
  const mock = await upstream(t, (_index, response) => reply(response, '', 429));
  const f = await fixture(t, mock.url, { retries: 2, options: { timeoutMs: undefined } });
  const first = { ...f.create('scheduled-batch'), scheduleId: 'schedule' }; f.queue.enqueue([first]);
  assert.equal(first.requestTimeoutSeconds, 600);
  f.store.saveSettings({ retentionDays: 7, maxRetries: 0, requestTimeoutSeconds: 720 });
  await f.queue.processWave();
  let failed = f.store.get<StoredRun>('runs', first.id)!;
  const child = f.store.get<StoredRun>('runs', failed.nextRetryId!)!;
  assert.equal(child.retryAttempt, 1); assert.equal(child.retryLimit, 2); assert.equal(child.retryRootId, first.id);
  assert.equal(child.retryOf, first.id); assert.equal(child.batchId, first.batchId); assert.equal(child.scheduleId, first.scheduleId);
  assert.equal(child.requestTimeoutSeconds, 600, 'Automatic retries retain the timeout captured before settings changed');
  assert.equal(f.queue.nextWakeAt(), f.clock() + 5000);
  const reloaded = f.newQueue(); await reloaded.processWave(); assert.equal(mock.requests.length, 1);
  f.advance(5000); await reloaded.processWave(); assert.equal(mock.requests.length, 2);
  assert.equal(reloaded.nextWakeAt(), f.clock() + 10000);
  f.advance(10000); await reloaded.processWave(); assert.equal(mock.requests.length, 3); assert.equal(reloaded.size(), 0);
  assert.deepEqual(mock.requests[0]!.body, mock.requests[2]!.body);
  failed = f.runs().find(run => run.retryAttempt === 2)!;
  const manual = reloaded.retry(failed);
  assert.equal(manual.retryAttempt, 0); assert.equal(manual.retryLimit, 0); assert.equal(manual.retryKind, 'manual');
  assert.equal(manual.retryOf, failed.id); assert.equal(manual.retryRootId, manual.id); assert.notEqual(manual.batchId, failed.batchId);
  assert.equal(manual.nextRetryId, undefined); assert.equal(manual.retryAt, undefined);
  assert.equal(manual.requestTimeoutSeconds, 720, 'A manual retry adopts the current global wait limit');
});

test('a 600-second cloud attempt can complete past the old 180-second cap without a second dispatch', async t => {
  const f = await fixture(t, 'https://mock.invalid/v1', { options: { timeoutMs: undefined } });
  const started = deferred<void>(), result = deferred<Response>();
  let signal!: AbortSignal, calls = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    calls++; signal = init.signal!; started.resolve();
    signal.addEventListener('abort', () => result.reject(new DOMException('Aborted', 'AbortError')), { once: true });
    return result.promise;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = f.create(); f.queue.enqueue([run]); const wave = f.queue.processWave(); await started.promise;
  const claimed = f.store.get<CloudStoredRun>('runs', run.id)!;
  assert.equal(claimed.requestTimeoutSeconds, 600);
  assert.equal(claimed.queueLease?.expiresAt, f.clock() + 660_000);
  assert.equal(f.queue.nextWakeAt(), claimed.queueLease!.expiresAt);
  t.mock.timers.tick(180_001); f.advance(180_001);
  assert.equal(signal.aborted, false); assert.equal(f.store.get<CloudStoredRun>('runs', run.id)?.status, 'running');
  assert.equal(f.queue.processWave(), wave, 'A concurrent wake must join the long-running wave');
  t.mock.timers.tick(419_998); f.advance(419_998);
  assert.equal(signal.aborted, false);
  result.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '21' } }] }), { headers: { 'Content-Type': 'application/json' } }));
  await wave;
  const completed = f.store.get<CloudStoredRun>('runs', run.id)!;
  assert.equal(completed.status, 'completed'); assert.equal(calls, 1);
  assert.equal((await f.artifacts.get(completed.artifact!))?.output, '21');
});

test('cloud timeout snapshots expire at 720 seconds, keep retries consistent, and claim legacy queued runs safely', async t => {
  const f = await fixture(t, 'https://mock.invalid/v1', { retries: 1, options: { timeoutMs: undefined } });
  f.store.saveSettings({ ...f.store.settings(), requestTimeoutSeconds: 720 });
  const started = deferred<void>(); let signal!: AbortSignal;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = init.signal!; signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    started.resolve();
  }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = { ...f.create(), requestTimeoutSeconds: undefined }; f.queue.enqueue([run]);
  const wave = f.queue.processWave(); await started.promise;
  const claimed = f.store.get<CloudStoredRun>('runs', run.id)!;
  assert.equal(claimed.requestTimeoutSeconds, 720, 'An old queued record acquires its timeout when claimed');
  assert.equal(claimed.queueLease?.expiresAt, f.clock() + 780_000);
  f.store.saveSettings({ ...f.store.settings(), requestTimeoutSeconds: 30 });
  t.mock.timers.tick(719_999); f.advance(719_999); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); f.advance(1); await wave;
  const failed = f.store.get<CloudStoredRun>('runs', run.id)!;
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /请求超时（720 秒）/);
  const child = f.store.get<CloudStoredRun>('runs', failed.nextRetryId!)!;
  assert.equal(child.requestTimeoutSeconds, 720); assert.equal(child.retryAttempt, 1);
  assert.equal(f.queue.retry(failed).requestTimeoutSeconds, 30);
});

test('permanent failures do not retry; timeouts and 408 do, without exposing upstream secrets', async t => {
  for (const status of [400, 401, 403, 404, 408, 500]) {
    const mock = await upstream(t, (_index, response) => reply(response, '', status));
    const f = await fixture(t, mock.url, { retries: 1 }); const run = f.create(); f.queue.enqueue([run]); await f.queue.processWave();
    const failure = f.store.get<StoredRun>('runs', run.id)!;
    assert.equal(failure.status, 'failed'); assert.equal(Boolean(failure.nextRetryId), status === 408 || status === 500);
    assert.ok(!JSON.stringify(runDto(failure)).includes(SECRET));
  }
  const mock = await upstream(t, () => {});
  const f = await fixture(t, mock.url, { retries: 1, options: { timeoutMs: 20 } }); const run = f.create(); f.queue.enqueue([run]);
  await f.queue.processWave(); const failed = f.store.get<StoredRun>('runs', run.id)!;
  assert.match(failed.error, /超时/); assert.ok(failed.nextRetryId);
});

test('waiting retries can be cancelled and disabled models or providers never start their queued call', async t => {
  const mock = await upstream(t, (_index, response) => reply(response, '', 503));
  const f = await fixture(t, mock.url, { retries: 1 }); const first = f.create(); f.queue.enqueue([first]); await f.queue.processWave();
  const child = f.store.get<StoredRun>('runs', f.store.get<StoredRun>('runs', first.id)!.nextRetryId!)!;
  f.queue.cancel(child); f.advance(6000); await f.queue.processWave(); assert.equal(mock.requests.length, 1); assert.equal(f.queue.nextWakeAt(), null);
  const another = f.create(); f.queue.enqueue([another]); f.store.put('models', { ...f.model, enabled: false });
  await f.queue.processWave(); assert.equal(mock.requests.length, 1); assert.equal(f.store.get<StoredRun>('runs', another.id)?.status, 'cancelled');
  f.store.put('models', f.model); f.store.put('providers', { ...f.provider, enabled: false });
  const final = f.create(); f.queue.enqueue([final]); await f.queue.processWave(); assert.equal(mock.requests.length, 1);
});

test('queue capacity includes future retries and rejection leaves the durable queue unchanged', async t => {
  const mock = await upstream(t); const f = await fixture(t, mock.url);
  const runs = Array.from({ length: 200 }, () => ({ ...f.create(), retryKind: 'automatic' as const, retryAt: new Date(f.clock() + 60000).toISOString() }));
  f.queue.enqueue(runs); assert.equal(f.queue.size(), 200);
  assert.throws(() => f.queue.enqueue([f.create()]), (error: unknown) => error instanceof CloudQueueError && error.status === 429);
  await f.queue.processWave(); assert.equal(mock.requests.length, 0); assert.equal(f.runs().length, 200); assert.equal(f.queue.nextWakeAt(), f.clock() + 60000);
});

test('cancellation or deletion during a cloud upload never resurrects a run and preserves cleanup references', async t => {
  for (const remove of [false, true]) {
    const upload = gate(), objects = new Map<string, Uint8Array>();
    const bucket: NativeR2Bucket = {
      async put(key, body) { upload.started = true; await upload.promise; objects.set(key, new Uint8Array(body)); return { key, size: body.byteLength }; },
      async get() { return null; }, async delete(key) { objects.delete(key); },
    };
    const mock = await upstream(t); const f = await fixture(t, mock.url, { retries: 5, bucket });
    const run = f.create(); f.queue.enqueue([run]); const wave = f.queue.processWave();
    try { await until(() => upload.started, 'The cloud upload should be waiting'); f.queue.cancel(run); if (remove) f.store.delete('runs', run.id); }
    finally { upload.release(); await wave; }
    const current = f.store.get<StoredRun>('runs', run.id);
    if (remove) { assert.equal(current, undefined); assert.equal(objects.size, 0); }
    else { assert.equal(current?.status, 'cancelled'); assert.equal(current.nextRetryId, undefined); assert.equal(current.pendingArtifactDeletes?.length, 1); }
    assert.equal(mock.requests.length, 1);
  }
});

test('R2 write failure keeps a durable cleanup reference and never repeats the completed model generation', async t => {
  const bucket: NativeR2Bucket = { async put() { throw new Error(SECRET); }, async get() { return null; }, async delete() {} };
  const mock = await upstream(t); const f = await fixture(t, mock.url, { retries: 5, bucket });
  const run = f.create(); f.queue.enqueue([run]); await f.queue.processWave();
  const failed = f.store.get<StoredRun>('runs', run.id)!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.artifactAvailable, false); assert.equal(failed.pendingArtifactDeletes?.length, 1);
  assert.match(failed.error, /保存失败/); assert.equal(failed.nextRetryId, undefined); assert.equal(f.queue.nextWakeAt(), null);
  assert.ok(!JSON.stringify(runDto(failed)).includes(SECRET)); await f.queue.processWave(); assert.equal(mock.requests.length, 1);
});

test('closing during an attempt prevents new work and leaves uncertain execution for safe reconstruction', async t => {
  const mock = await upstream(t, () => {}); const f = await fixture(t, mock.url, { retries: 5, options: { concurrency: 1 } });
  const first = f.create(); f.advance(1); const second = f.create(); f.queue.enqueue([first, second]); const wave = f.queue.processWave();
  await until(() => mock.requests.length === 1, 'First request should start'); await f.queue.close(); await wave;
  assert.equal(mock.requests.length, 1); assert.equal(f.queue.nextWakeAt(), null);
  assert.throws(() => f.queue.enqueue([f.create()]), (error: unknown) => error instanceof CloudQueueError && error.status === 503);
  const recreated = f.newQueue(); assert.equal(f.store.get<StoredRun>('runs', first.id)?.status, 'failed');
  assert.equal(f.store.get<StoredRun>('runs', first.id)?.nextRetryId, undefined); assert.equal(recreated.size(), 1);
});
