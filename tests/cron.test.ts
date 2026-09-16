import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import { normalizeScheduleTiming, nextScheduleRunAt, previewCron } from '../server/schedule-time.ts';
import { DEFAULT_SCHEDULE_TIMEZONE, EXAMPLE_SCHEDULE_CRON } from '../shared/schedules.ts';
import type { AdminData, Model, Prompt, Provider, Run, Schedule } from '../shared/types.ts';

const TOKEN = 'cron-suite-admin-token';
const SECRET = 'sk-cron-suite-private-key';
const BEIJING = 'Asia/Shanghai';
const timestamp = (value: string) => Date.parse(value);

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

async function upstream(t: TestContext, handler: (number: number, response: ServerResponse) => void = (_number, response) => respond(response)) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the local test request. */ }
    calls++;
    handler(calls, response);
  });
  const url = await listen(server);
  t.after(() => closeServer(server));
  return { url, get calls() { return calls; } };
}

function respond(response: ServerResponse, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(status === 200 ? { choices: [{ message: { role: 'assistant', content: '定时任务完成' } }] }
    : { error: { message: '本地模拟暂时失败' } }));
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  let value!: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function fixture(t: TestContext, initialTime = '2026-09-13T16:30:00.000Z', retryBaseDelayMs = 10) {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-cron-test-'));
  let now = timestamp(initialTime);
  const options = { dataDir: directory, adminToken: TOKEN, seed: false, now: () => now,
    schedulerIntervalMs: 10, cleanupIntervalMs: 60_000, requestTimeoutMs: 10_000, retryBaseDelayMs };
  let application = createApp(options);
  let server = createServer(application.app);
  let origin = await listen(server);
  let cookie = '';
  let stopped = false;
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await request(path, method, body);
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };
  const login = async () => {
    const response = await request('/api/auth/login', 'POST', { token: TOKEN });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await application.close(); await closeServer(server);
  };
  const restart = async () => {
    await stop(); application = createApp(options); server = createServer(application.app);
    origin = await listen(server); cookie = ''; stopped = false; await login();
  };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const data = () => json<AdminData>('/api/admin/data');
  const plan = async (id: string) => (await data()).schedules.find((item) => item.id === id)!;
  const runs = async (id: string) => (await data()).runs.filter((item) => item.scheduleId === id);
  return { directory, request, json, login, data, plan, runs, stop, restart,
    now: () => now, setTime: (value: string) => { now = timestamp(value); }, advance: (milliseconds: number) => { now += milliseconds; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function configure(f: Fixture, baseUrl: string) {
  await f.login();
  await f.json('/api/admin/settings', 'PATCH', { maxRetries: 0 });
  const { provider } = await f.json<{ provider: Provider }>('/api/admin/providers', 'POST', {
    name: 'Cron 本地接口', baseUrl: `${baseUrl}/v1`, protocol: 'chat-completions', apiKey: SECRET, enabled: true,
  });
  const { model } = await f.json<{ model: Model }>('/api/admin/models', 'POST', {
    providerId: provider.id, name: 'Cron 测试模型', modelId: 'mock-cron', maxTokens: 512, reasoningEffort: 'max', enabled: true,
  });
  const { prompt } = await f.json<{ prompt: Prompt }>('/api/admin/prompts', 'POST', {
    title: '定时测试提示词', category: 'text', content: '请直接回答。', enabled: true,
  });
  return { provider, model, prompt };
}

async function createPlan(f: Fixture, model: Model, prompt: Prompt, overrides: Record<string, unknown> = {}) {
  return (await f.json<{ schedule: Schedule }>('/api/admin/schedules', 'POST', {
    name: '北京时间定时计划', modelIds: [model.id], promptIds: [prompt.id], enabled: true,
    scheduleType: 'cron', cronExpression: EXAMPLE_SCHEDULE_CRON, timezone: BEIJING, ...overrides,
  })).schedule;
}

test('the Beijing example has 19 daily executions, skips 02:00–06:00, and crosses midnight correctly', () => {
  assert.equal(DEFAULT_SCHEDULE_TIMEZONE, BEIJING);
  assert.equal(EXAMPLE_SCHEDULE_CRON, '0 0-1,7-23 * * *');
  const dates = previewCron(EXAMPLE_SCHEDULE_CRON, BEIJING, timestamp('2026-09-12T15:59:59.000Z'), 20);
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: BEIJING, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const parts = dates.map((date) => Object.fromEntries(format.formatToParts(new Date(date)).map((part) => [part.type, part.value])));
  assert.deepEqual(parts.slice(0, 19).map((part) => Number(part.hour)), [0, 1, ...Array.from({ length: 17 }, (_, index) => index + 7)]);
  assert.ok(parts.slice(0, 19).every((part) => part.day === '13'));
  assert.equal(parts[19]!.day, '14'); assert.equal(parts[19]!.hour, '00');
  assert.equal(nextScheduleRunAt({ scheduleType: 'cron', cronExpression: EXAMPLE_SCHEDULE_CRON, timezone: BEIJING },
    timestamp('2026-09-12T17:00:00.000Z')), '2026-09-12T23:00:00.000Z');
  assert.equal(nextScheduleRunAt({ scheduleType: 'cron', cronExpression: EXAMPLE_SCHEDULE_CRON, timezone: BEIJING },
    timestamp('2026-09-13T15:00:00.000Z')), '2026-09-13T16:00:00.000Z');
});

test('calendar calculations handle leap years, month lengths and standard month/weekday aliases', () => {
  assert.equal(previewCron('0 0 29 2 *', BEIJING, timestamp('2025-03-01T00:00:00.000Z'), 1)[0], '2028-02-28T16:00:00.000Z');
  assert.equal(previewCron('0 9 31 * *', BEIJING, timestamp('2026-04-30T00:00:00.000Z'), 1)[0], '2026-05-31T01:00:00.000Z');
  assert.equal(previewCron('0 9 31 * *', BEIJING, timestamp('2026-06-01T00:00:00.000Z'), 1)[0], '2026-07-31T01:00:00.000Z');
  const symbolic = previewCron('0 9 * JAN MON-FRI', BEIJING, timestamp('2025-12-31T16:00:00.000Z'), 3);
  assert.deepEqual(symbolic, ['2026-01-01T01:00:00.000Z', '2026-01-02T01:00:00.000Z', '2026-01-05T01:00:00.000Z']);
});

test('IANA timezones are independent of host timezone and adjust across New York DST transitions', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    assert.deepEqual(previewCron('0 9 * * *', 'America/New_York', timestamp('2026-03-07T00:00:00.000Z'), 3), [
      '2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z',
    ]);
    assert.deepEqual(previewCron('0 9 * * *', 'America/New_York', timestamp('2026-10-31T00:00:00.000Z'), 3), [
      '2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z',
    ]);
    assert.equal(previewCron('0 9 * * *', undefined, timestamp('2026-03-07T00:00:00.000Z'), 1)[0], '2026-03-07T01:00:00.000Z');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('timing normalization preserves interval compatibility and rejects cron extensions or impossible dates', () => {
  const now = timestamp('2026-09-13T00:00:00.000Z');
  const interval = normalizeScheduleTiming({ intervalMinutes: 17 }, now);
  assert.equal(interval.scheduleType, 'interval'); assert.equal(interval.intervalMinutes, 17);
  assert.equal(nextScheduleRunAt({ intervalMinutes: 17 }, now), '2026-09-13T00:17:00.000Z');
  const cron = normalizeScheduleTiming({ scheduleType: 'cron', cronExpression: EXAMPLE_SCHEDULE_CRON }, now);
  assert.equal(cron.scheduleType, 'cron'); assert.equal(cron.intervalMinutes, 60); assert.equal(cron.timezone, BEIJING);
  for (const expression of ['0 0 0 * * *', '@daily', 'H * * * *', '0 0 L * *', '0 0 * * MON#2', '0 0 ? * *',
    '60 * * * *', '0 24 * * *', '0 0 31 2 *', '0 0 * XYZ *', '0 0 * * FUNDAY', '*/0 * * * *', '']) {
    assert.throws(() => normalizeScheduleTiming({ scheduleType: 'cron', cronExpression: expression }, now), `Reject ${expression}`);
  }
  assert.throws(() => previewCron('* * * * *', 'Not/A_Timezone', now));
  for (const intervalMinutes of [0, 43201, 1.5]) assert.throws(() => normalizeScheduleTiming({ intervalMinutes }, now));
});

test('cron preview requires admin and same-origin access, returns three runs, and never saves a schedule', async (t) => {
  const f = await fixture(t);
  const body = { cronExpression: EXAMPLE_SCHEDULE_CRON, timezone: BEIJING };
  assert.equal((await f.request('/api/admin/schedules/preview', 'POST', body)).status, 401);
  await f.login();
  assert.equal((await f.request('/api/admin/schedules/preview', 'POST', body, { Origin: 'https://foreign.invalid' })).status, 403);
  const before = (await f.data()).schedules;
  const result = await f.json<{ nextRuns: string[] }>('/api/admin/schedules/preview', 'POST', body);
  assert.deepEqual(result.nextRuns, ['2026-09-13T17:00:00.000Z', '2026-09-13T23:00:00.000Z', '2026-09-14T00:00:00.000Z']);
  assert.deepEqual((await f.data()).schedules, before);
  for (const input of [{ cronExpression: '@hourly' }, { cronExpression: '* * * * *', timezone: 'Invalid/Zone' }, { cronExpression: '0 0 31 2 *' }]) {
    assert.equal((await f.request('/api/admin/schedules/preview', 'POST', input)).status, 400);
    assert.deepEqual((await f.data()).schedules, before);
  }
});

test('invalid cron creation or edits preserve all stored schedules unchanged', async (t) => {
  const mock = await upstream(t);
  const f = await fixture(t);
  const { model, prompt } = await configure(f, mock.url);
  const schedule = await createPlan(f, model, prompt);
  assert.equal(schedule.intervalMinutes, 60);
  const before = (await f.data()).schedules;
  for (const fields of [{ cronExpression: '0 0 0 * * *' }, { cronExpression: '0 0 31 2 *' },
    { cronExpression: 'H * * * *' }, { timezone: 'Invalid/Zone' }, { cronExpression: '' }]) {
    assert.equal((await f.request('/api/admin/schedules', 'POST', { ...schedule, ...fields })).status, 400);
    assert.equal((await f.request(`/api/admin/schedules/${schedule.id}`, 'PUT', { ...schedule, ...fields })).status, 400);
    assert.deepEqual((await f.data()).schedules, before);
  }
  assert.equal(mock.calls, 0);
});

test('cron pause/resume, expression/timezone edits and interval-mode changes recompute deadlines', async (t) => {
  const mock = await upstream(t);
  const f = await fixture(t);
  const { model, prompt } = await configure(f, mock.url);
  let schedule = await createPlan(f, model, prompt);
  assert.equal(schedule.nextRunAt, '2026-09-13T17:00:00.000Z');
  const update = async (fields: Record<string, unknown>) => {
    schedule = (await f.json<{ schedule: Schedule }>(`/api/admin/schedules/${schedule.id}`, 'PUT', { ...schedule, ...fields })).schedule;
    return schedule;
  };
  await update({ enabled: false });
  f.setTime('2026-09-13T18:00:00.000Z');
  await delay(30);
  assert.equal(mock.calls, 0);
  await update({ enabled: true });
  assert.equal(schedule.nextRunAt, '2026-09-13T23:00:00.000Z');
  await update({ cronExpression: '15 9 * * *' });
  assert.equal(schedule.nextRunAt, '2026-09-14T01:15:00.000Z');
  await update({ timezone: 'UTC' });
  assert.equal(schedule.nextRunAt, '2026-09-14T09:15:00.000Z');
  await update({ scheduleType: 'interval', intervalMinutes: 17 });
  assert.equal(schedule.nextRunAt, '2026-09-13T18:17:00.000Z');
  f.advance(60_000);
  const preserved = schedule.nextRunAt;
  await update({ name: '仅修改名称' });
  assert.equal(schedule.nextRunAt, preserved, 'Editing the name must not postpone execution');
  await update({ intervalMinutes: 20 });
  assert.equal(schedule.nextRunAt, '2026-09-13T18:21:00.000Z');
  await update({ scheduleType: 'cron', cronExpression: '0 3 * * *', timezone: BEIJING });
  assert.equal(schedule.nextRunAt, '2026-09-13T19:00:00.000Z');
  assert.equal(mock.calls, 0);
});

test('a corrupt persisted cron expression can be repaired by a valid edit without losing the schedule', async (t) => {
  const mock = await upstream(t);
  const f = await fixture(t);
  const { model, prompt } = await configure(f, mock.url);
  const schedule = await createPlan(f, model, prompt, { enabled: false });
  const database = new DatabaseSync(join(f.directory, 'app.db'));
  try {
    database.prepare('UPDATE schedules SET data = ? WHERE id = ?')
      .run(JSON.stringify({ ...schedule, cronExpression: 'corrupt persisted value' }), schedule.id);
  } finally { database.close(); }
  assert.equal((await f.plan(schedule.id)).cronExpression, 'corrupt persisted value');
  const repaired = (await f.json<{ schedule: Schedule }>(`/api/admin/schedules/${schedule.id}`, 'PUT', {
    ...schedule, cronExpression: '0 6 * * *',
  })).schedule;
  assert.equal(repaired.id, schedule.id);
  assert.equal(repaired.cronExpression, '0 6 * * *');
  assert.equal(repaired.nextRunAt, '2026-09-13T22:00:00.000Z');
  assert.equal(repaired.enabled, false);
  assert.equal((await f.data()).schedules.length, 1);
  assert.equal(mock.calls, 0);
});

test('manual cron execution keeps its deadline and an overdue restart catches up once from current time', async (t) => {
  const mock = await upstream(t);
  const f = await fixture(t, '2026-09-13T00:10:00.000Z');
  const { model, prompt } = await configure(f, mock.url);
  const schedule = await createPlan(f, model, prompt, { cronExpression: '0 * * * *' });
  assert.equal(schedule.nextRunAt, '2026-09-13T01:00:00.000Z');
  const manual = await f.json<{ runs: Run[] }>(`/api/admin/schedules/${schedule.id}/run`, 'POST');
  await until(() => f.runs(schedule.id), (runs) => runs.some((run) => run.id === manual.runs[0]!.id && run.status === 'completed'), 'Manual cron run should finish');
  assert.equal((await f.plan(schedule.id)).nextRunAt, schedule.nextRunAt);
  await f.stop();
  f.setTime('2026-09-13T05:30:00.000Z');
  await f.restart();
  const runs = await until(() => f.runs(schedule.id), (items) => items.length === 2 && items.every((run) => run.status === 'completed'), 'Overdue restart should make one catch-up request');
  assert.equal(runs.length, 2);
  assert.equal((await f.plan(schedule.id)).nextRunAt, '2026-09-13T06:00:00.000Z');
  await delay(40);
  assert.equal(mock.calls, 2, 'Missed cron slots must not create a burst of catch-up tasks');
  assert.equal((await f.runs(schedule.id)).length, 2);
});

test('cron keeps active tasks from overlapping across missed scheduled times', async (t) => {
  let response: ServerResponse | undefined;
  const mock = await upstream(t, (_number, current) => { response = current; });
  const f = await fixture(t, '2026-09-13T00:00:00.000Z');
  const { model, prompt } = await configure(f, mock.url);
  const schedule = await createPlan(f, model, prompt, { cronExpression: '* * * * *' });
  f.advance(60_000);
  await until(() => f.runs(schedule.id), (runs) => runs.length === 1 && runs[0]!.status === 'running' && Boolean(response), 'Due cron slot should launch one active request');
  f.advance(5 * 60_000);
  await until(() => f.plan(schedule.id), (current) => current.nextRunAt === '2026-09-13T00:07:00.000Z', 'Scheduler should advance to the next future cron time');
  assert.equal(mock.calls, 1);
  assert.equal((await f.runs(schedule.id)).length, 1);
  assert.equal((await f.request(`/api/admin/schedules/${schedule.id}/run`, 'POST')).status, 409);
  respond(response!);
  await until(() => f.runs(schedule.id), (runs) => runs[0]!.status === 'completed', 'The original active task should complete normally');
});

test('an automatic retry waiting in a cron chain blocks another scheduled launch', async (t) => {
  const mock = await upstream(t, (number, response) => respond(response, number === 1 ? 429 : 200));
  const f = await fixture(t, '2026-09-13T00:00:00.000Z', 200);
  const { model, prompt } = await configure(f, mock.url);
  await f.json('/api/admin/settings', 'PATCH', { maxRetries: 1 });
  const schedule = await createPlan(f, model, prompt, { cronExpression: '* * * * *' });
  f.advance(60_000);
  const waiting = await until(() => f.runs(schedule.id), (runs) => runs.some((run) => run.retryKind === 'automatic' && run.status === 'queued'), 'The cron chain should have a delayed automatic retry');
  assert.equal(waiting.length, 2);
  assert.equal((await f.request(`/api/admin/schedules/${schedule.id}/run`, 'POST')).status, 409);
  f.advance(60_000);
  await until(() => f.plan(schedule.id), (current) => current.nextRunAt === '2026-09-13T00:03:00.000Z', 'The next cron deadline should move forward while the chain waits');
  const finished = await until(() => f.runs(schedule.id), (runs) => runs.length === 2 && runs.some((run) => run.status === 'completed'), 'The existing retry should recover');
  assert.equal(mock.calls, 2);
  assert.equal(new Set(finished.map((run) => run.batchId)).size, 1);
  assert.equal((await f.plan(schedule.id)).nextRunAt, '2026-09-13T00:03:00.000Z');
});

test('existing schedules can be paused and edited with disabled or deleted selections without admitting new missing IDs', async t => {
  const mock = await upstream(t);
  const f = await fixture(t);
  const { model, prompt } = await configure(f, mock.url);
  const original = await createPlan(f, model, prompt);
  await f.json(`/api/admin/models/${model.id}`, 'PUT', { ...model, enabled: false });
  let schedule = (await f.json<{ schedule: Schedule }>(`/api/admin/schedules/${original.id}`, 'PUT', {
    ...original, name: '保留暂停模型',
  })).schedule;
  assert.deepEqual(schedule.modelIds, original.modelIds); assert.equal(schedule.nextRunAt, original.nextRunAt);
  await f.json(`/api/admin/models/${model.id}`, 'DELETE');
  await f.json(`/api/admin/prompts/${prompt.id}`, 'DELETE');
  schedule = (await f.json<{ schedule: Schedule }>(`/api/admin/schedules/${original.id}`, 'PUT', {
    ...schedule, enabled: false,
  })).schedule;
  assert.equal(schedule.enabled, false); assert.deepEqual(schedule.modelIds, original.modelIds); assert.deepEqual(schedule.promptIds, original.promptIds);
  schedule = (await f.json<{ schedule: Schedule }>(`/api/admin/schedules/${original.id}`, 'PUT', {
    ...schedule, name: '可重新配置的暂停计划',
  })).schedule;
  assert.equal(schedule.name, '可重新配置的暂停计划');
  for (const fields of [{ modelIds: ['new-missing-model'] }, { promptIds: ['new-missing-prompt'] }]) {
    assert.equal((await f.request(`/api/admin/schedules/${original.id}`, 'PUT', { ...schedule, ...fields })).status, 400);
    assert.deepEqual(await f.plan(original.id), schedule, 'Rejected references cannot mutate the saved plan');
  }
  assert.equal((await f.request('/api/admin/schedules', 'POST', schedule)).status, 400, 'A new plan cannot reuse deleted references');
  assert.equal(mock.calls, 0);
});
