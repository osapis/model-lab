import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import type { StoredRun } from '../server/store.ts';
import type { AdminData, PublicData, Run } from '../shared/types.ts';
import { runBatchKey, runModelGroupKey } from '../shared/result-groups.ts';

const ADMIN_TOKEN = 'public-results-regression-admin';
const NOW = Date.parse('2026-09-15T12:00:00Z');

function record(id: string, overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id, batchId: 'batch', providerId: 'provider', modelId: 'model', promptId: 'prompt',
    providerName: 'Public test API', modelName: 'Test model', modelSlug: 'model-test',
    promptTitle: 'Test prompt', promptContent: 'Return HTML', category: 'visual', referenceAnswer: '', rubric: '',
    status: 'failed', source: 'api', sourceLabel: 'API 实测', output: '', html: '', reasoning: '', error: '请求超时（180 秒）',
    latencyMs: 180000, inputTokens: null, outputTokens: null,
    createdAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW + 180000).toISOString(),
    parameters: { protocol: 'responses', maxTokens: 1000, reasoningEffort: 'medium' },
    retryLimit: 5, retryAttempt: 0, retryRootId: id,
    ...overrides,
  };
}

function child(parent: StoredRun, id: string, overrides: Partial<StoredRun> = {}): StoredRun {
  return record(id, {
    ...parent, id, nextRetryId: undefined, retryKind: 'automatic', retryOf: parent.id,
    retryRootId: parent.retryRootId || parent.id, retryAttempt: (parent.retryAttempt ?? 0) + 1,
    createdAt: new Date(Date.parse(parent.createdAt) + 181000).toISOString(),
    ...overrides,
  });
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-public-results-'));
  const application = createApp({ dataDir: directory, adminToken: ADMIN_TOKEN, seed: false,
    autoStartScheduler: false, initializeArtifacts: false, serveStatic: false, now: () => NOW });
  await application.ready;
  const server = createServer(application.app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const request = (path: string, method = 'GET', body?: unknown) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(path, method, body);
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
    return data as T;
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store: application.store, request, json,
    put: (...runs: StoredRun[]) => { for (const run of runs) application.store.put('runs', run); },
    list: (query = '') => json<{ runs: Run[]; total: number; page?: number; pageCount?: number }>(`/api/public/runs?${query}`),
    data: () => json<PublicData>('/api/public/data'),
    login: async () => {
      const response = await request('/api/auth/login', 'POST', { token: ADMIN_TOKEN });
      assert.equal(response.status, 200);
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    },
  };
}

test('public gallery replaces intermediate errors with the queued, running, then recovered attempt while preserving history', async t => {
  const f = await fixture(t);
  const root = record('initial', { nextRetryId: 'retry-1' });
  const retry = child(root, 'retry-1', { status: 'queued', error: '', finishedAt: null });
  f.put(root, retry);
  for (const status of ['queued', 'running', 'completed'] as const) {
    f.put({ ...retry, status });
    const list = await f.list();
    assert.equal(list.total, 1);
    assert.deepEqual(list.runs.map(run => [run.id, run.status]), [[retry.id, status]]);
    const data = await f.data();
    assert.deepEqual(data.runs.map(run => run.id), [retry.id]);
    assert.equal(data.stats.apiRuns, 1);
  }
  assert.equal((await f.json<{ run: Run }>(`/api/public/runs/${root.id}`)).run.status, 'failed');
  await f.login();
  assert.equal((await f.json<AdminData>('/api/admin/data')).runs.length, 2);
  assert.equal((await f.json<{ total: number }>('/api/admin/runs')).total, 2);
  assert.equal(f.store.get<StoredRun>('runs', root.id)?.error, root.error);
});

test('only the final failure is displayed for each saved retry budget, including disabled retries', async t => {
  const f = await fixture(t);
  const terminalIds: string[] = [];
  let attempts = 0;
  for (const retryLimit of [0, 1, 2, 5, 10]) {
    let current = record(`limit-${retryLimit}-0`, { retryLimit, batchId: `batch-${retryLimit}` });
    for (let attempt = 0; attempt < retryLimit; attempt++) {
      const next = child(current, `limit-${retryLimit}-${attempt + 1}`);
      f.put({ ...current, nextRetryId: next.id });
      current = next;
      attempts++;
    }
    f.put(current);
    attempts++;
    terminalIds.push(current.id);
  }
  // A later global setting change must not alter historical attempt chains.
  f.store.saveSettings({ retentionDays: 30, maxRetries: 0 });
  const list = await f.list('limit=200');
  assert.equal(list.total, terminalIds.length);
  assert.deepEqual(list.runs.map(run => run.id).sort(), terminalIds.sort());
  assert.ok(list.runs.every(run => run.status === 'failed' && run.retryAttempt === run.retryLimit));
  assert.equal((await f.data()).stats.apiRuns, terminalIds.length);
  assert.equal(f.store.all<StoredRun>('runs').length, attempts);
});

test('legacy root links hide old failures even with a missing parent and before search, sort, or pagination', async t => {
  const f = await fixture(t);
  const root = record('legacy-root', { retryAttempt: undefined, promptTitle: 'Old title', latencyMs: 1,
    createdAt: new Date(NOW - 1000).toISOString(), nextRetryId: undefined });
  const recovered = child(root, 'legacy-recovered', { status: 'completed', error: '', retryOf: 'removed-middle',
    retryAttempt: 2, retryKind: undefined, promptTitle: 'Current title', latencyMs: 500,
    createdAt: new Date(NOW + 1_000_000).toISOString() });
  f.put(root, recovered);
  for (let index = 0; index < 205; index++) f.put(record(`independent-${index}`, {
    status: 'completed', createdAt: new Date(NOW + index * 1000).toISOString(),
  }));
  for (const sort of ['newest', 'oldest', 'latency']) {
    const ids: string[] = [];
    for (let offset = 0; offset < 206; offset += 50) {
      const page = await f.list(`sort=${sort}&offset=${offset}&limit=50`);
      assert.equal(page.total, 206);
      ids.push(...page.runs.map(run => run.id));
    }
    assert.equal(new Set(ids).size, 206);
    assert.ok(!ids.includes(root.id));
    assert.ok(ids.includes(recovered.id));
  }
  assert.equal((await f.list('q=Old%20title')).total, 0, 'Search must not resurrect a superseded attempt');
  const data = await f.data();
  assert.equal(data.runs.length, 200);
  assert.equal(data.stats.apiRuns, 206);
});

test('cancelled or deleted replacements do not resurrect prior error cards', async t => {
  const f = await fixture(t);
  const root = record('cancel-root', { nextRetryId: 'cancel-retry' });
  const cancelled = child(root, 'cancel-retry', { status: 'cancelled', error: '管理员已取消该任务。' });
  f.put(root, cancelled);
  assert.deepEqual((await f.list()).runs.map(run => [run.id, run.status]), [[cancelled.id, 'cancelled']]);
  await f.login();
  await f.json(`/api/admin/runs/${cancelled.id}`, 'DELETE');
  assert.equal((await f.list()).total, 0);
  assert.equal((await f.data()).stats.apiRuns, 0);
  assert.equal((await f.json<AdminData>('/api/admin/data')).runs[0]?.id, root.id);
  assert.equal((await f.request(`/api/public/runs/${root.id}`)).status, 200);
});

test('manual retries and unrelated tests remain separate even if retry metadata points at another test', async t => {
  const f = await fixture(t);
  const first = record('old-final', { retryLimit: 1, retryAttempt: 1, retryKind: 'automatic', retryRootId: 'old-root' });
  const manual = record('manual-root', { retryKind: 'manual', retryOf: first.id, batchId: 'manual-batch', nextRetryId: 'manual-retry' });
  const recovered = child(manual, 'manual-retry', { status: 'completed', error: '' });
  const independent = record('independent');
  f.put(first, manual, recovered, independent);
  const unrelated = [
    { providerId: 'another-provider' }, { modelId: 'another-model' },
    { promptId: 'another-prompt' }, { batchId: 'another-batch' },
    { category: 'reasoning' as const }, { source: 'sample' as const },
  ].map((overrides, index) => child(independent, `unrelated-${index}`, { status: 'completed', error: '', ...overrides }));
  f.put(...unrelated);
  const list = await f.list('limit=200');
  assert.deepEqual(list.runs.map(run => run.id).sort(), [first.id, recovered.id, independent.id, ...unrelated.map(run => run.id)].sort());
  const data = await f.data();
  assert.equal(data.stats.apiRuns, list.total - 1);
  assert.equal(data.stats.sampleRuns, 1);
});

test('terminal failures remain visible when retry budget remains but no replacement was scheduled', async t => {
  const f = await fixture(t);
  f.put(record('unauthorized', { error: '上游 HTTP 401', retryLimit: 5 }),
    record('stopped', { retryKind: 'automatic', retryAttempt: 1, retryRootId: 'old', retryLimit: 5,
      error: '服务在任务完成前重新启动；请手动重试。' }),
    record('legacy', { retryLimit: undefined, retryAttempt: undefined, retryRootId: undefined }));
  assert.equal((await f.list()).total, 3);
  assert.equal((await f.data()).stats.apiRuns, 3);
});

test('explicit completion-time sorting remains available across midnight while the default is grouped', async t => {
  const f = await fixture(t);
  const createdAt = '2026-09-15T23:59:00+08:00';
  const early = record('finished-earlier', { status: 'completed', createdAt, finishedAt: '2026-09-15T23:59:25+08:00' });
  const late = record('finished-later', { status: 'completed', createdAt, finishedAt: '2026-09-16T00:01:25+08:00' });
  // Insert in a different order from both requested sorts to exercise the HTTP projection.
  f.put(late, early);
  assert.deepEqual((await f.list('sort=newest')).runs.map(run => run.id), [late.id, early.id]);
  assert.deepEqual((await f.list('sort=oldest')).runs.map(run => run.id), [early.id, late.id]);
  assert.deepEqual((await f.data()).runs.map(run => run.id), [early.id, late.id], 'Grouped previews use stable prompt order instead of finish time');
  assert.deepEqual((await f.list('sort=latency')).runs.map(run => run.id), [late.id, early.id], 'Equal latency is ordered by result time');
  for (const expected of [early, late]) {
    const returned = (await f.json<{ run: Run }>(`/api/public/runs/${expected.id}`)).run;
    assert.equal(returned.createdAt, createdAt, 'Keep the original scheduling timestamp available');
    assert.equal(returned.finishedAt, expected.finishedAt);
    assert.equal(f.store.get<StoredRun>('runs', expected.id)?.createdAt, createdAt);
  }
});

test('public result ordering falls back for legacy records and ignores stale completion on active attempts', async t => {
  const f = await fixture(t);
  const timestamp = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
  const runs = [
    record('latest-queued', { status: 'queued', createdAt: timestamp(60), finishedAt: timestamp(-60) }),
    record('latest-completed', { status: 'completed', createdAt: timestamp(0), finishedAt: timestamp(50) }),
    record('legacy-completed', { status: 'completed', createdAt: timestamp(40), finishedAt: null }),
    record('running', { status: 'running', createdAt: timestamp(30), finishedAt: timestamp(3600) }),
    record('final-failure', { createdAt: timestamp(0), finishedAt: timestamp(20), retryLimit: 0 }),
    record('cancelled', { status: 'cancelled', createdAt: timestamp(0), finishedAt: timestamp(10) }),
  ];
  f.put(...runs);
  const expectedIds = runs.map(run => run.id);
  assert.deepEqual((await f.list('sort=newest')).runs.map(run => run.id), expectedIds);
  assert.deepEqual((await f.list('sort=oldest')).runs.map(run => run.id), expectedIds.toReversed());
  // This feature changes public result ordering only, not the administrator's execution history.
  await f.login();
  const admin = await f.json<{ runs: Run[] }>('/api/admin/runs');
  assert.deepEqual(admin.runs.map(run => run.id), expectedIds.toReversed(), 'Keep the existing insertion-based administrator history order');
});

test('equal completion times use creation time and id to keep public pagination stable', async t => {
  const f = await fixture(t);
  const commonFinishedAt = new Date(NOW + 120000).toISOString();
  f.put(
    record('tie-a', { status: 'completed', createdAt: new Date(NOW).toISOString(), finishedAt: commonFinishedAt }),
    record('tie-newer-created', { status: 'completed', createdAt: new Date(NOW + 1000).toISOString(), finishedAt: commonFinishedAt }),
    record('tie-z', { status: 'completed', createdAt: new Date(NOW).toISOString(), finishedAt: commonFinishedAt }),
  );
  const newest = ['tie-newer-created', 'tie-z', 'tie-a'];
  for (const sort of ['newest', 'oldest', 'latency']) {
    const expected = sort === 'oldest' ? newest.toReversed() : newest;
    const ids: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const page = await f.list(`sort=${sort}&offset=${offset}&limit=1`);
      assert.equal(page.total, 3);
      ids.push(page.runs[0]!.id);
    }
    assert.deepEqual(ids, expected);
  }
});

test('malformed legacy completion timestamps do not break public listing, details, or retention projection', async t => {
  const f = await fixture(t);
  const malformed = record('malformed-finish', { status: 'completed', createdAt: new Date(NOW + 60000).toISOString(), finishedAt: 'invalid timestamp' });
  const valid = record('valid-finish', { status: 'completed', createdAt: new Date(NOW + 90000).toISOString(), finishedAt: new Date(NOW + 120000).toISOString() });
  f.put(malformed, valid);
  for (const response of [await f.list('sort=newest'), await f.data()]) {
    const badFinish = response.runs.find(run => run.id === malformed.id)!;
    const goodFinish = response.runs.find(run => run.id === valid.id)!;
    assert.equal(badFinish.artifactExpiresAt, null);
    assert.equal(badFinish.finishedAt, malformed.finishedAt, 'A display fallback must not rewrite historical metadata');
    assert.equal(goodFinish.artifactExpiresAt, new Date(Date.parse(valid.finishedAt!) + f.store.settings().retentionDays * 86400000).toISOString());
  }
  const detail = await f.json<{ run: Run }>(`/api/public/runs/${malformed.id}`);
  assert.equal(detail.run.artifactExpiresAt, null);
  assert.equal((await f.list('sort=oldest')).runs[0]!.id, malformed.id);
});

test('grouped gallery keeps each API and model pair adjacent as completion times and statuses change', async t => {
  const f = await fixture(t);
  const createdAt = '2026-09-15T23:59:00+08:00';
  const runs = [
    record('alpha-candy', { status: 'completed', providerId: 'alpha', providerName: 'Alpha', category: 'reasoning',
      promptId: 'candy', promptTitle: '糖果', createdAt, finishedAt: '2026-09-15T23:59:10+08:00' }),
    record('beta-pelican', { status: 'completed', providerId: 'beta', providerName: 'Beta', createdAt,
      finishedAt: '2026-09-16T00:02:00+08:00' }),
    record('alpha-pelican', { status: 'running', providerId: 'alpha', providerName: 'Alpha', createdAt, finishedAt: null }),
    record('beta-candy', { status: 'queued', providerId: 'beta', providerName: 'Beta', category: 'reasoning',
      promptId: 'candy', promptTitle: '糖果', createdAt, finishedAt: null }),
  ];
  f.put(...runs);
  const expected = ['alpha-pelican', 'alpha-candy', 'beta-pelican', 'beta-candy'];
  const snapshot = f.store.all<StoredRun>('runs');
  for (const query of ['', 'sort=grouped', 'sort=grouped&page=0&limit=3']) {
    const result = await f.list(query);
    assert.deepEqual(result.runs.map(run => run.id), query.includes('page=') ? expected.slice(0, 2) : expected);
    assert.ok(result.runs.every(run => run.batchCreatedAt === createdAt));
  }
  assert.deepEqual((await f.data()).runs.map(run => run.id), expected);
  assert.deepEqual(f.store.all<StoredRun>('runs'), snapshot, 'Display metadata and ordering must not be persisted');
  for (const run of runs.filter(run => ['running', 'queued'].includes(run.status))) {
    f.put({ ...run, status: 'completed', finishedAt: '2026-09-16T01:00:00+08:00' });
    assert.deepEqual((await f.list()).runs.map(item => item.id), expected, 'A completion must not move its card away from the matching API/model');
  }
  const result = await f.list();
  assert.equal(result.runs[0]!.finishedAt, '2026-09-16T01:00:00+08:00');
  assert.equal(result.runs[1]!.finishedAt, '2026-09-15T23:59:10+08:00', 'Each card keeps its actual finish time');
  await f.login();
  assert.ok((await f.json<AdminData>('/api/admin/data')).runs.every(run => run.batchCreatedAt === undefined));
});

test('a retry crossing midnight stays in its original batch even after filtering out its failed parent', async t => {
  const f = await fixture(t);
  const createdAt = '2026-09-15T23:59:00+08:00';
  const root = record('previous-day-root', { batchId: 'older-batch', createdAt, nextRetryId: 'recovered', promptTitle: 'Before retry' });
  const recovered = child(root, 'recovered', { status: 'completed', error: '', promptTitle: 'Find recovered',
    createdAt: '2026-09-16T02:00:00+08:00', finishedAt: '2026-09-16T02:02:00+08:00' });
  const candy = record('previous-day-candy', { batchId: root.batchId, createdAt, category: 'reasoning', promptId: 'candy',
    status: 'completed', finishedAt: '2026-09-16T00:00:00+08:00' });
  const newer = record('newer-batch-pelican', { batchId: 'newer-batch', createdAt: '2026-09-16T01:00:00+08:00',
    status: 'completed', finishedAt: '2026-09-16T01:02:00+08:00' });
  f.put(recovered, newer, candy, root);
  const result = await f.list();
  assert.deepEqual(result.runs.map(run => run.id), [newer.id, recovered.id, candy.id]);
  assert.ok(result.runs.slice(1).every(run => run.batchCreatedAt === createdAt));
  assert.equal((await f.list('q=Find%20recovered')).runs[0]!.batchCreatedAt, createdAt);
  assert.deepEqual((await f.list('category=visual')).runs.map(run => run.id), [newer.id, recovered.id]);
  assert.equal((await f.list('sort=newest')).runs[0]!.id, recovered.id, 'Explicit newest still means most recently completed');
  assert.equal(f.store.all<StoredRun>('runs').length, 4);
  assert.equal((await f.data()).stats.apiRuns, 3);
});

test('group identity separates source, invocation, API, model and reasoning strength despite matching display names', async t => {
  const f = await fixture(t);
  const identities = [
    { providerId: 'api-a', modelId: 'model-a', parameters: { reasoningEffort: 'medium' } },
    { providerId: 'api-a', modelId: 'model-a', parameters: { reasoningEffort: 'max' } },
    { providerId: 'api-a', modelId: 'model-b', parameters: { reasoningEffort: 'medium' } },
    { providerId: 'api-b', modelId: 'model-a', parameters: { reasoningEffort: 'medium' } },
    { providerId: 'api-b', modelId: 'model-a', source: 'sample' as const, parameters: { reasoningEffort: 'medium' } },
    { providerId: 'api-b', modelId: 'model-a', batchId: 'second-batch', parameters: { reasoningEffort: 'medium' } },
  ];
  // Insert all candy records first to ensure grouping cannot rely on insertion order.
  for (const category of ['reasoning', 'visual'] as const) for (const [index, identity] of identities.entries()) {
    f.put(record(`identity-${index}-${category}`, { ...identity, category, status: 'completed' }));
  }
  const result = await f.list('limit=200');
  assert.equal(new Set(result.runs.map(runModelGroupKey)).size, identities.length);
  assert.equal(new Set(result.runs.map(runBatchKey)).size, 3);
  for (let index = 0; index < result.runs.length; index += 2) {
    const pair = result.runs.slice(index, index + 2);
    assert.equal(runModelGroupKey(pair[0]!), runModelGroupKey(pair[1]!));
    assert.deepEqual(pair.map(run => run.category), ['visual', 'reasoning']);
  }
  const selected = await f.list('providerId=api-a&category=reasoning&source=api&page=0&limit=12');
  assert.equal(selected.total, 3);
  assert.ok(selected.runs.every(run => run.providerId === 'api-a' && run.category === 'reasoning' && run.source === 'api'));
});

test('grouped pagination never splits API/model groups and still supports flat legacy offsets', async t => {
  const f = await fixture(t);
  for (let group = 0; group < 7; group++) for (const category of ['reasoning', 'visual'] as const) {
    f.put(record(`page-${group}-${category}`, { providerId: `api-${group}`, providerName: `API ${group}`, category, status: 'completed' }));
  }
  const first = await f.list('sort=grouped&page=0&limit=12');
  const second = await f.list('sort=grouped&page=1&limit=12');
  assert.deepEqual([first.runs.length, second.runs.length, first.total, first.page, second.page, first.pageCount], [12, 2, 14, 0, 1, 2]);
  const firstKeys = new Set(first.runs.map(runModelGroupKey));
  assert.ok(second.runs.every(run => !firstKeys.has(runModelGroupKey(run))));
  assert.equal(new Set([...first.runs, ...second.runs].map(run => run.id)).size, 14);
  const odd = await f.list('sort=grouped&page=0&limit=3');
  assert.equal(odd.runs.length, 2, 'Do not fill an odd last slot with half of the next pair');
  assert.equal(odd.pageCount, 7);
  assert.equal((await f.list('sort=grouped&page=999&limit=12')).page, 1, 'Clamp a stale page after results are deleted');
  const flat = await f.list('sort=grouped&offset=1&limit=3');
  assert.deepEqual(flat.runs.map(run => run.id), first.runs.slice(1, 4).map(run => run.id));
  assert.equal(flat.page, undefined);
  assert.equal((await f.request('/api/public/runs?page=-1')).status, 400);
});

test('an oversized model group remains complete on its own page and empty filters stay valid', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 15; index++) f.put(record(`large-${index}`, { providerName: 'B', status: 'completed',
    promptId: `prompt-${index}`, promptTitle: `Prompt ${index}`, category: index ? 'text' : 'visual' }));
  f.put(record('small-before', { providerId: 'before', providerName: 'A', status: 'completed' }),
    record('small-after', { providerId: 'after', providerName: 'C', status: 'completed' }));
  const pages = await Promise.all([0, 1, 2].map(page => f.list(`page=${page}&limit=12`)));
  assert.deepEqual(pages.map(page => page.runs.length), [1, 15, 1]);
  assert.ok(pages.every(page => page.pageCount === 3 && page.total === 17));
  assert.equal(pages[1]!.runs[0]!.category, 'visual');
  assert.equal(new Set(pages.flatMap(page => page.runs.map(run => run.id))).size, 17);
  const empty = await f.list('page=2&providerId=absent');
  assert.deepEqual({ runs: empty.runs, total: empty.total, page: empty.page, pageCount: empty.pageCount },
    { runs: [], total: 0, page: 0, pageCount: 1 });
});
