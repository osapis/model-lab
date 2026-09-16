import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Model, Prompt, Schedule } from '../shared/types.ts';
import { resolveScheduleSelection } from '../shared/schedule-availability.ts';
import { Store, type StoredProvider, type StoredRun } from '../server/store.ts';
import { ArtifactStore } from '../server/artifacts.ts';
import { RunQueue } from '../server/queue.ts';
import { Scheduler, SchedulerError } from '../server/scheduler.ts';
import { CloudRunQueue } from '../cloudflare/queue.ts';
import { CloudflareArtifactStore } from '../cloudflare/artifacts.ts';

const HOUR = 3_600_000;
const INITIAL_TIME = Date.parse('2026-09-16T00:40:24.000Z');

async function fixture(t: TestContext, deployment: 'node' | 'cloudflare' = 'cloudflare', cron = false) {
  const requests: { model: string; messages: { content: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '21' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-selection-'));
  const store = new Store(directory, 'schedule-selection-test-admin');
  if (deployment === 'cloudflare') Object.assign(store, { deployment });
  let now = INITIAL_TIME;
  const clock = () => now;
  const artifacts = deployment === 'cloudflare'
    ? new CloudflareArtifactStore(store as Store & { deployment: string }, undefined, { clock }) : new ArtifactStore(store);
  const queue = deployment === 'cloudflare'
    ? new CloudRunQueue(store, artifacts, { now: clock, timeoutMs: 2000, wake() {} })
    : new RunQueue(store, 2000, 2, clock, artifacts);
  const scheduler = new Scheduler(store, queue as RunQueue, { now: clock });
  store.saveSettings({ retentionDays: 7, maxRetries: 0 });
  const createdAt = new Date(now).toISOString();
  const providers: StoredProvider[] = Array.from({ length: 4 }, (_, index) => ({
    id: `provider-${index}`, name: `本地接口 ${index}`, baseUrl: `http://127.0.0.1:${address.port}/v1`,
    protocol: 'chat-completions', enabled: true, createdAt, encryptedApiKey: store.encrypt('synthetic-test-key'),
  }));
  const models: Model[] = providers.map((provider, index) => ({
    id: `model-${index}`, name: `模型 ${index}`, modelId: `mock-${index}`, providerId: provider.id,
    enabled: true, maxTokens: 512, reasoningEffort: 'medium', createdAt,
  }));
  const prompts: Prompt[] = ['pelican', 'candy'].map((id, index) => ({
    id, title: id, description: '', content: id, category: index ? 'reasoning' : 'visual',
    referenceAnswer: index ? '21' : '', rubric: '', tags: [], enabled: true, createdAt, updatedAt: createdAt,
  }));
  for (const item of providers) store.put('providers', item);
  for (const item of models) store.put('models', item);
  for (const item of prompts) store.put('prompts', item);
  const schedule: Schedule = {
    id: 'scheduled-test', name: '每小时测试', promptIds: prompts.map(item => item.id), modelIds: models.map(item => item.id),
    intervalMinutes: 60, enabled: true, scheduleType: cron ? 'cron' : 'interval',
    ...(cron ? { cronExpression: '40 * * * *', timezone: 'Asia/Shanghai' } : {}),
    nextRunAt: cron ? '2026-09-16T01:40:00.000Z' : '2026-09-16T01:40:24.000Z', lastRunAt: null, lastError: '', createdAt,
  };
  store.put('schedules', schedule);
  const current = () => store.get<Schedule>('schedules', schedule.id)!;
  const runs = () => store.all<StoredRun>('runs').filter(run => run.scheduleId === schedule.id);
  const drain = async () => {
    const deadline = Date.now() + 5000;
    while (queue.size() && Date.now() < deadline) {
      if (queue instanceof CloudRunQueue) await queue.processWave();
      else await delay(5);
    }
    assert.equal(queue.size(), 0, 'Every eligible queued task should finish');
    assert.ok(runs().every(run => run.status === 'completed'));
  };
  t.after(async () => {
    await scheduler.close(); await queue.close(); await artifacts.close(); store.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { store, queue, scheduler, providers, models, prompts, schedule, current, runs, drain, requests,
    clock, advance: (amount: number) => { now += amount; }, next: () => { now = Date.parse(current().nextRunAt); scheduler.tick(); } };
}

for (const deployment of ['node', 'cloudflare'] as const) {
  test(`${deployment}: API off/on followed by one disabled model leaves six automatic tests and restores eight next round`, async t => {
    const f = await fixture(t, deployment);
    // Reproduce the exact switch sequence without editing the schedule's saved selection.
    f.store.put('providers', { ...f.providers[0]!, enabled: false });
    f.store.put('providers', { ...f.providers[0]!, enabled: true });
    f.store.put('models', { ...f.models[0]!, enabled: false });
    f.next();
    assert.equal(f.runs().length, 6);
    assert.ok(f.runs().every(run => run.modelId !== f.models[0]!.id));
    assert.equal(new Set(f.runs().map(run => run.batchId)).size, 1);
    assert.equal(f.current().nextRunAt, '2026-09-16T02:40:24.000Z');
    assert.equal(f.current().lastError, '');
    assert.deepEqual(f.current().modelIds, f.schedule.modelIds);
    await f.drain();
    assert.equal(f.requests.length, 6);
    f.scheduler.tick(); assert.equal(f.runs().length, 6, 'Repeated ticks must not replay the slot');
    f.next(); await f.drain(); assert.equal(f.requests.length, 12, 'The following slot remains operational');
    f.store.put('models', f.models[0]!);
    f.next(); await f.drain();
    assert.equal(f.requests.length, 20, 'Re-enabled models rejoin without editing the saved plan');
    assert.equal(new Set(f.runs().map(run => run.batchId)).size, 3);
    assert.deepEqual(f.current().modelIds, f.schedule.modelIds);
  });
}

test('manual scheduled launches skip disabled API/prompt and missing references before creating any calls', async t => {
  const f = await fixture(t);
  f.store.put('providers', { ...f.providers[0]!, enabled: false });
  f.store.delete('providers', f.providers[1]!.id);
  f.store.delete('models', f.models[2]!.id);
  f.store.put('prompts', { ...f.prompts[0]!, enabled: false });
  const saved = { ...f.schedule, promptIds: [...f.schedule.promptIds, 'deleted-prompt'], modelIds: [...f.schedule.modelIds, 'deleted-model'] };
  f.store.put('schedules', saved);
  const selected = resolveScheduleSelection(saved, f.store.all<Prompt>('prompts'), f.store.all<Model>('models'), f.store.all<StoredProvider>('providers'));
  assert.equal(selected.skippedModelCount, 4); assert.equal(selected.skippedPromptCount, 2);
  const runs = f.scheduler.run(saved);
  assert.equal(runs.length, 1); assert.equal(runs[0]!.modelId, f.models[3]!.id); assert.equal(runs[0]!.promptId, f.prompts[1]!.id);
  assert.equal(f.current().nextRunAt, saved.nextRunAt, 'Manual partial execution must preserve cadence');
  assert.deepEqual(f.current().modelIds, saved.modelIds); assert.deepEqual(f.current().promptIds, saved.promptIds);
  await f.drain(); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.model, f.models[3]!.modelId);
});

for (const cron of [false, true]) {
  test(`${cron ? 'cron' : 'interval'}: no eligible combinations skips without creating a batch, then recovers once on the next future slot`, async t => {
    const f = await fixture(t, 'cloudflare', cron);
    for (const provider of f.providers) f.store.put('providers', { ...provider, enabled: false });
    f.next();
    assert.equal(f.runs().length, 0); assert.equal(f.queue.size(), 0); assert.equal(f.current().lastRunAt, null);
    assert.match(f.current().lastError, /当前没有可执行的测试组合/); assert.equal(f.current().enabled, true);
    const firstSkipped = f.clock();
    assert.equal(Date.parse(f.current().nextRunAt), firstSkipped + HOUR);
    f.advance(3 * HOUR); f.scheduler.tick();
    assert.equal(f.runs().length, 0); assert.equal(Date.parse(f.current().nextRunAt), firstSkipped + 4 * HOUR);
    f.store.put('providers', f.providers[0]!);
    f.scheduler.tick(); assert.equal(f.runs().length, 0, 'Re-enabling must not replay any skipped slots');
    f.next();
    assert.equal(f.runs().length, 2); assert.equal(f.current().lastError, '');
    assert.equal(f.current().lastRunAt, new Date(f.clock()).toISOString());
    await f.drain(); assert.equal(f.requests.length, 2);
  });
}

test('only eligible combinations count toward queue and round capacity, with no partial enqueue on failure', async t => {
  const f = await fixture(t);
  // The saved plan is unchanged; only three models can participate now.
  f.store.put('models', { ...f.models[0]!, enabled: false });
  const originalSize = f.queue.size.bind(f.queue);
  const size = t.mock.method(f.queue, 'size', () => 195);
  const create = t.mock.method(f.queue, 'create');
  const enqueue = t.mock.method(f.queue, 'enqueue');
  assert.throws(() => f.scheduler.run(f.current()), error => error instanceof SchedulerError && error.status === 429);
  assert.equal(create.mock.callCount(), 0); assert.equal(enqueue.mock.callCount(), 0); assert.equal(f.runs().length, 0);
  size.mock.mockImplementation(() => 194);
  assert.equal(f.scheduler.run(f.current()).length, 6, 'Six eligible tasks fit even when eight selected tasks would exceed capacity');
  assert.equal(create.mock.callCount(), 6); assert.equal(enqueue.mock.callCount(), 1);
  size.mock.mockImplementation(originalSize);
  await f.drain();
  assert.equal(f.requests.length, 6);
});

test('active partial rounds still prevent overlap and retain the next automatic deadline', async t => {
  const f = await fixture(t);
  f.store.put('models', { ...f.models[0]!, enabled: false });
  f.next(); assert.equal(f.runs().length, 6);
  f.advance(HOUR); f.scheduler.tick();
  assert.equal(f.runs().length, 6); assert.equal(f.current().nextRunAt, '2026-09-16T03:40:24.000Z');
  assert.match(f.current().lastError, /仍有任务未完成/);
  assert.throws(() => f.scheduler.run(f.current()), error => error instanceof SchedulerError && error.status === 409);
  assert.equal(f.requests.length, 0, 'Cloudflare enqueues durably and only alarm waves send calls');
  await f.drain();
  f.next(); await f.drain(); assert.equal(f.requests.length, 12); assert.equal(f.current().lastError, '');
});

test('selection deduplicates IDs and configuration validation still rejects new nonexistent references', async t => {
  const f = await fixture(t);
  const duplicated = { ...f.schedule, promptIds: [...f.schedule.promptIds, ...f.schedule.promptIds], modelIds: [...f.schedule.modelIds, ...f.schedule.modelIds] };
  const selected = resolveScheduleSelection(duplicated, f.prompts, f.models, f.providers);
  assert.equal(selected.runnableCount, 8); assert.equal(selected.selectedModelCount, 4); assert.equal(selected.selectedPromptCount, 2);
  assert.equal(f.scheduler.run(duplicated).length, 8); await f.drain(); assert.equal(f.requests.length, 8);
  assert.throws(() => f.scheduler.validate(['missing'], f.schedule.modelIds), /提示词不存在/);
  assert.throws(() => f.scheduler.validate(f.schedule.promptIds, ['missing']), /模型不存在/);
  f.store.put('models', { ...f.models[0]!, enabled: false });
  assert.doesNotThrow(() => f.scheduler.validate(f.schedule.promptIds, f.schedule.modelIds), 'Disabled existing choices remain valid saved configuration');
  f.store.delete('models', f.models[0]!.id); f.store.delete('prompts', f.prompts[0]!.id);
  const retained = f.scheduler.validate(f.schedule.promptIds, f.schedule.modelIds, f.schedule);
  assert.equal(retained.models.length, 3); assert.equal(retained.prompts.length, 1);
  assert.throws(() => f.scheduler.validate(['new-missing-prompt'], f.schedule.modelIds, f.schedule), /提示词不存在/);
  assert.throws(() => f.scheduler.validate(f.schedule.promptIds, ['new-missing-model'], f.schedule), /模型不存在/);
  assert.throws(() => f.scheduler.validate([], f.schedule.modelIds, f.schedule), /提示词不存在/);
  assert.throws(() => f.scheduler.validate(f.schedule.promptIds, [], f.schedule), /模型不存在/);
});

test('the per-round maximum is checked against eligible combinations before snapshots or enqueue', async t => {
  const f = await fixture(t);
  const prompts = Array.from({ length: 26 }, (_, index) => ({ ...f.prompts[0]!, id: `large-prompt-${index}` }));
  for (const prompt of prompts) f.store.put('prompts', prompt);
  const schedule = { ...f.schedule, promptIds: prompts.map(prompt => prompt.id), modelIds: f.models.slice(0, 2).map(model => model.id) };
  const create = t.mock.method(f.queue, 'create'); const enqueue = t.mock.method(f.queue, 'enqueue');
  assert.throws(() => f.scheduler.run(schedule), /最多创建 50/);
  assert.equal(create.mock.callCount(), 0); assert.equal(enqueue.mock.callCount(), 0); assert.equal(f.runs().length, 0);
  f.store.put('prompts', { ...prompts[0]!, enabled: false });
  assert.equal(f.scheduler.run(schedule).length, 50, 'Legacy selections with only 50 eligible combinations can run');
  await f.drain(); assert.equal(f.requests.length, 50);
  assert.throws(() => f.scheduler.validate(schedule.promptIds, schedule.modelIds, schedule), /最多创建 50/,
    'Saved configuration still limits all selected combinations, including disabled choices');
});
