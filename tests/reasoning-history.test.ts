import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import { ArtifactStore, type ArtifactPayload, type ArtifactRef } from '../server/artifacts.ts';
import { ReasoningHistoryService } from '../server/reasoning-history.ts';
import { reasoningPrompt } from '../server/seed.ts';
import { Store, type StoredProvider, type StoredRun } from '../server/store.ts';
import type { ReasoningHistoryEntry, ReasoningHistoryResponse } from '../shared/reasoning-history.ts';

const NOW = Date.parse('2026-09-14T04:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const KEY = 'sk-history-private-key-49f7d3';
const BODY = 'PRIVATE_FULL_REASONING_BODY_NOT_FOR_TIMELINE_8175a';
const iso = (time: number) => new Date(time).toISOString();

function makeRun(id: string, fields: Partial<StoredRun> = {}): StoredRun {
  return {
    id, batchId: 'history-batch', providerId: 'provider-a', modelId: 'model-a', modelSlug: 'gpt-6',
    providerName: '接口 A', modelName: 'A 模型', promptId: 'prompt-candy', promptTitle: '黑袋里的糖果',
    promptContent: reasoningPrompt, category: 'reasoning', referenceAnswer: '21', rubric: '',
    status: 'completed', source: 'api', sourceLabel: 'API 实测', output: '', html: '', reasoning: '', error: '',
    latencyMs: 100, inputTokens: 20, outputTokens: 10, createdAt: iso(NOW - 1000), finishedAt: iso(NOW - 500),
    parameters: { protocol: 'responses', maxTokens: 8192, reasoningEffort: 'max' },
    execution: { providerId: 'provider-a', baseUrl: 'https://private-history.invalid/v1', encryptedApiKey: 'PRIVATE_CIPHERTEXT_9af31',
      protocol: 'responses', modelId: 'gpt-6', maxTokens: 8192, reasoningEffort: 'max' },
    ...fields,
  };
}

function provider(store: Store, id = 'provider-a', name = '接口 A'): StoredProvider {
  const value: StoredProvider = { id, name, baseUrl: 'https://private-history.invalid/v1', protocol: 'responses',
    enabled: true, encryptedApiKey: store.encrypt(KEY), createdAt: iso(NOW - DAY) };
  store.put('providers', value);
  return value;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-reasoning-history-'));
  const store = new Store(directory, 'history-admin-secret');
  const artifacts = new ArtifactStore(store);
  let now = NOW;
  const service = new ReasoningHistoryService(store, artifacts, () => now);
  t.after(async () => { await service.close(); await artifacts.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const add = (id: string, output = '21', fields: Partial<StoredRun> = {}, reasoning = '') => {
    const artifact = artifacts.putMemory(id, { output, html: '', reasoning });
    const run = makeRun(id, { artifact, artifactAvailable: true, artifactStorage: 'memory', ...fields });
    store.put('runs', run);
    return run;
  };
  const snapshot = () => JSON.stringify(store.db.prepare('SELECT id, data FROM runs ORDER BY id').all());
  return { directory, store, artifacts, service, add, snapshot, now: () => now, advance: (time: number) => { now += time; } };
}

function entries(response: ReasoningHistoryResponse): ReasoningHistoryEntry[] {
  return response.rows.flatMap((row) => row.entries);
}

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message);
    await delay(5);
  }
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test('rolling history uses completion time for both 24-hour boundaries and retains empty and historical APIs', async (t) => {
  const f = await fixture(t);
  provider(f.store); provider(f.store, 'provider-empty', '未测试的接口');
  const disabled = provider(f.store, 'provider-disabled', '已停用的接口');
  f.store.put('providers', { ...disabled, enabled: false });
  f.add('too-old', '21', { createdAt: iso(NOW - DAY - 2000), finishedAt: iso(NOW - DAY - 1) });
  f.add('lower-bound', '21', { createdAt: iso(NOW - DAY - 1000), finishedAt: iso(NOW - DAY) });
  f.add('upper-bound', '29', { createdAt: iso(NOW - 1000), finishedAt: iso(NOW) });
  f.add('future', '21', { createdAt: iso(NOW - 1000), finishedAt: iso(NOW + 1) });
  f.add('historical', '21', { providerId: 'removed-api', providerName: '已经删除的接口', createdAt: iso(NOW - 2000) });
  f.add('sample', '21', { source: 'sample' });
  f.add('visual', '21', { category: 'visual' });
  const result = await f.service.read();
  assert.equal(result.from, iso(NOW - DAY)); assert.equal(result.to, iso(NOW)); assert.equal(result.expectedAnswer, '21');
  assert.deepEqual(result.rows.find((row) => row.providerId === 'provider-a')!.entries.map((entry) => entry.id), ['lower-bound', 'upper-bound']);
  assert.deepEqual(result.rows.find((row) => row.providerId === 'provider-empty')!.entries, []);
  assert.deepEqual(result.rows.find((row) => row.providerId === 'provider-disabled')!.entries, []);
  assert.equal(result.rows.find((row) => row.providerId === 'removed-api')!.providerName, '已经删除的接口');
  assert.deepEqual(new Set(entries(result).map((entry) => entry.id)), new Set(['lower-bound', 'upper-bound', 'historical']));
  const emptyMatch = await f.service.read({ q: '未测试的接口' });
  assert.deepEqual(emptyMatch.rows.map((row) => row.providerId), ['provider-empty']);
  assert.deepEqual(emptyMatch.rows[0]!.entries, []);
  f.advance(1);
  const advanced = await f.service.read();
  assert.ok(!entries(advanced).some((entry) => entry.id === 'lower-bound'), 'The start boundary must advance with the service clock');
  assert.ok(entries(advanced).some((entry) => entry.id === 'future'), 'A record becomes eligible once the clock reaches it');
});

test('completion chronology preserves creation timestamps and explicitly falls back for unfinished or legacy records', async (t) => {
  const f = await fixture(t); provider(f.store);
  const createdAt = iso(NOW - DAY - 5000);
  f.add('completed-later', '29', { createdAt, finishedAt: iso(NOW - 100) });
  f.add('completed-earlier', '21', { createdAt, finishedAt: iso(NOW - 200) });
  f.add('legacy-no-finish', '21', { createdAt: iso(NOW - 400), finishedAt: null });
  f.add('legacy-invalid-finish', '21', { createdAt: iso(NOW - 300), finishedAt: 'not-a-date' });
  f.add('unfinished', '21', { status: 'running', createdAt: iso(NOW - 500), finishedAt: iso(NOW + DAY) });
  f.add('invalid-times', '21', { createdAt: 'invalid', finishedAt: null });
  f.add('old-legacy', '21', { createdAt, finishedAt: null });
  const result = entries(await f.service.read());
  assert.deepEqual(result.map(entry => entry.id), ['unfinished', 'legacy-no-finish', 'legacy-invalid-finish', 'completed-earlier', 'completed-later']);
  for (const id of ['completed-earlier', 'completed-later']) assert.equal(result.find(entry => entry.id === id)!.createdAt, createdAt);
  assert.equal(result.find(entry => entry.id === 'completed-later')!.finishedAt, iso(NOW - 100));
  for (const id of ['legacy-no-finish', 'legacy-invalid-finish', 'unfinished']) assert.equal(result.find(entry => entry.id === id)!.finishedAt, null);
  assert.equal(result.find(entry => entry.id === 'unfinished')!.verdict, 'pending');
});

test('only the exact candy problem is classified, regardless of reused title or prompt identifier', async (t) => {
  const f = await fixture(t); provider(f.store);
  f.add('original', '21');
  f.add('renamed-original', '21', { promptTitle: '独立命名的原题', promptId: 'another-id' });
  f.add('spacing-only', '21', { promptContent: reasoningPrompt.replace(/\s+/g, '') });
  f.add('original-core', '21', { promptContent: reasoningPrompt
    .replace(/^不要使用任何工具或写代码，直接推理回答以下问题:\s*/, '')
    .replace(/\s*请只给出你的最终答案数字，并简述推理过程。\s*$/, '') });
  f.add('changed-count', '21', { promptContent: reasoningPrompt.replace('苹果味7颗', '苹果味8颗') });
  f.add('changed-rule', '21', { promptContent: reasoningPrompt + '\n附加条件：禁止按形状选取，只允许完全随机抓取。' });
  f.add('other-problem', '21', { promptContent: '计算 10 + 11。请只回答数字。' });
  f.add('question-in-quotation', '21', { promptContent: `请评价下面的题目是否有歧义，不要解答：\n${reasoningPrompt}` });
  const result = await f.service.read();
  assert.deepEqual(new Set(entries(result).map((entry) => entry.id)), new Set(['original', 'renamed-original', 'spacing-only', 'original-core']));
});

test('answer extraction reads explicit final output instead of incidental numbers or hidden reasoning', async (t) => {
  const f = await fixture(t); provider(f.store);
  const cases: { id: string; output: string; reasoning?: string; verdict: ReasoningHistoryEntry['verdict']; answer?: string }[] = [
    { id: 'correct-first', output: `21\n${BODY}`, verdict: 'correct', answer: '21' },
    { id: 'markdown-first', output: '**21**\n20颗不能保证。', verdict: 'correct', answer: '21' },
    { id: 'wrong-first', output: '29\n推理过程中可以讨论 21，但最终选择首行的数字。', verdict: 'incorrect', answer: '29' },
    { id: 'wrong-with-condition', output: '29。若按形状选取则21。', verdict: 'incorrect', answer: '29' },
    { id: 'disputed-alternative', output: '29。有人认为答案是21，但这是错误的。', verdict: 'incorrect', answer: '29' },
    { id: 'quoted-alternative', output: '29。有人会说“答案是21。”但这种说法不对。', verdict: 'incorrect', answer: '29' },
    { id: 'explicit-final', output: `先考虑最坏情况下最多可以取20颗。${BODY}\n最终答案：21。`, verdict: 'correct', answer: '21' },
    { id: 'answer-is', output: '经过推理，答案是 21。', verdict: 'correct', answer: '21' },
    { id: 'minimum-conclusion', output: '所以最少需取21颗糖。', verdict: 'correct', answer: '21' },
    { id: 'negative-mention', output: '不是21，最终答案29。', verdict: 'incorrect', answer: '29' },
    { id: 'final-correction', output: '21\n重新检查后，最终答案：29。', verdict: 'incorrect', answer: '29' },
    { id: 'negative-correction', output: '21。更正：最终答案不是21，应为29。', verdict: 'incorrect' },
    { id: 'negative-final-without-marker', output: '21。最终答案不是21，应为29。', verdict: 'incorrect', answer: '29' },
    { id: 'ambiguous-final', output: '21\n最终答案：29或21。', verdict: 'incorrect' },
    { id: 'withdrawn-numeric-final', output: '21\n最终答案不是21。', verdict: 'incorrect' },
    { id: 'withdrawn-answer', output: '21；但最终答案无法确定。', verdict: 'incorrect' },
    { id: 'alternate-interpretation', output: '21。\n在完全随机抓取的解释下，答案是29。', verdict: 'correct', answer: '21' },
    { id: 'think-tag', output: '<think>\n初步答案是21。\n</think>\n29', verdict: 'incorrect', answer: '29' },
    { id: 'unclosed-think-tag', output: '<think>\n最终答案21。', verdict: 'unavailable' },
    { id: 'ambiguous', output: '21或29', verdict: 'incorrect' },
    { id: 'larger-number', output: '210', verdict: 'incorrect', answer: '210' },
    { id: 'decimal', output: '21.5', verdict: 'incorrect', answer: '21.5' },
    { id: 'random-number', output: '这是第21次测试，以下文字没有给出问题的答案。', verdict: 'incorrect' },
    { id: 'not-a-number', output: '无法确定。', verdict: 'incorrect' },
    { id: 'hidden-reasoning', output: '29', reasoning: '最终答案：21。', verdict: 'incorrect', answer: '29' },
    { id: 'reasoning-only', output: '', reasoning: '最终答案：21。', verdict: 'unavailable' },
  ];
  for (const item of cases) f.add(item.id, item.output, {}, item.reasoning || '');
  const result = await f.service.read();
  for (const item of cases) {
    const received = entries(result).find((entry) => entry.id === item.id)!;
    assert.equal(received.verdict, item.verdict, item.id);
    if (item.answer !== undefined) assert.equal(received.answer, item.answer, item.id);
  }
  assert.ok(!JSON.stringify(result).includes(BODY), 'Timeline summaries must not include reasoning paragraphs');
});

test('failed and pending attempts never load bodies, and every retry remains its own chronological entry', async (t) => {
  const f = await fixture(t); provider(f.store);
  let reads = 0;
  t.mock.method(f.artifacts, 'get', async () => { reads++; throw new Error('Terminal errors and pending work do not need an artifact'); });
  const ref: ArtifactRef = { storage: 's3', key: 'private-error-body', configId: 'secret-storage-config', sizeBytes: 100 };
  for (const [index, status] of (['failed', 'cancelled', 'queued', 'running'] as const).entries()) {
    f.store.put('runs', makeRun(`attempt-${index}`, { status, artifact: ref, createdAt: iso(NOW - 4000 + index * 1000),
      finishedAt: status === 'queued' || status === 'running' ? null : iso(NOW - 3900 + index * 1000),
      error: `Private SDK error with ${KEY}`, retryRootId: 'attempt-0', retryAttempt: index,
      retryKind: index ? 'automatic' : undefined, retryOf: index ? `attempt-${index - 1}` : undefined }));
  }
  const result = await f.service.read();
  assert.equal(reads, 0);
  assert.deepEqual(entries(result).map((entry) => entry.id), ['attempt-0', 'attempt-1', 'attempt-2', 'attempt-3']);
  assert.deepEqual(entries(result).map((entry) => entry.verdict), ['failed', 'failed', 'pending', 'pending']);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.ok(!JSON.stringify(result).includes('Private SDK error'));
});

test('provider and search filters cover complete histories with more than 200 entries', async (t) => {
  const f = await fixture(t); provider(f.store); provider(f.store, 'provider-b', '第二接口');
  for (let index = 0; index < 205; index++) f.add(`entry-${index}`, index % 2 ? '29' : '21', { createdAt: iso(NOW - 10_000 + index) });
  f.add('provider-b-entry', '21', { providerId: 'provider-b', providerName: '第二接口', modelName: '另一模型', modelSlug: 'other-slug',
    promptTitle: '重命名的糖果问题', createdAt: iso(NOW - 100) });
  const full = await f.service.read();
  assert.equal(entries(full).length, 206, 'Reasoning history must not reuse the 200-record bootstrap window');
  assert.equal(full.rows.find((row) => row.providerId === 'provider-a')!.entries.length, 205);
  const filtered = await f.service.read({ providerId: 'provider-b' });
  assert.deepEqual(filtered.rows.map((row) => row.providerId), ['provider-b']);
  assert.deepEqual(entries(filtered).map((entry) => entry.id), ['provider-b-entry']);
  for (const q of ['第二接口', '另一模型', 'OTHER-SLUG', '重命名的糖果问题']) {
    assert.deepEqual(entries(await f.service.read({ q })).map((entry) => entry.id), ['provider-b-entry']);
  }
  assert.deepEqual(entries(await f.service.read({ providerId: 'provider-a', q: '另一模型' })), []);
  assert.deepEqual((await f.service.read({ providerId: 'not-found' })).rows, []);
  assert.deepEqual((await f.service.read({ q: 'no-matching-title-model-or-api' })).rows, []);
});

test('unavailable artifacts never become incorrect answers and expired memory cannot retain cached green results', async (t) => {
  const f = await fixture(t); provider(f.store);
  const memory = f.add('evicted-memory', '21');
  f.store.put('runs', makeRun('no-artifact'));
  f.store.put('runs', makeRun('missing-cloud', { artifact: { storage: 's3', key: 'gone', configId: 'cloud', sizeBytes: 20 } }));
  const originalGet = f.artifacts.get.bind(f.artifacts);
  t.mock.method(f.artifacts, 'get', async (ref: ArtifactRef) => {
    if (ref.storage === 's3') return null;
    return originalGet(ref);
  });
  const first = entries(await f.service.read());
  assert.equal(first.find((entry) => entry.id === 'evicted-memory')!.verdict, 'correct');
  assert.equal(first.find((entry) => entry.id === 'no-artifact')!.verdict, 'unavailable');
  assert.equal(first.find((entry) => entry.id === 'missing-cloud')!.verdict, 'unavailable');
  await f.artifacts.delete(memory.artifact!);
  assert.equal(entries(await f.service.read()).find((entry) => entry.id === 'evicted-memory')!.verdict, 'unavailable',
    'Availability must be checked even after a correct answer has entered the RAM cache');
  await f.service.close();
  await f.artifacts.close();
  const reopenedArtifacts = new ArtifactStore(f.store);
  const reopenedService = new ReasoningHistoryService(f.store, reopenedArtifacts, () => NOW);
  try {
    assert.equal(entries(await reopenedService.read()).find((entry) => entry.id === 'evicted-memory')!.verdict, 'unavailable');
  } finally { await reopenedService.close(); await reopenedArtifacts.close(); }
});

test('concurrent readers share artifact work, limit global reads to four, and do not modify persisted metadata', async (t) => {
  const f = await fixture(t); provider(f.store);
  let reads = 0; let active = 0; let maximum = 0;
  const pending = gate();
  t.after(() => pending.release());
  for (let index = 0; index < 12; index++) f.store.put('runs', makeRun(`cloud-${index}`, {
    artifact: { storage: 's3', configId: 'shared-cloud', key: `object-${index}`, sizeBytes: 20 },
  }));
  // Different historical records can reference the same stored artifact.
  f.store.put('runs', makeRun('same-ref', { createdAt: iso(NOW - 1001),
    artifact: { storage: 's3', configId: 'shared-cloud', key: 'object-0', sizeBytes: 20 } }));
  t.mock.method(f.artifacts, 'get', async () => {
    reads++; active++; maximum = Math.max(maximum, active);
    await pending.promise;
    await delay(1);
    active--;
    return { output: '21', html: '', reasoning: BODY };
  });
  const before = f.snapshot();
  const first = f.service.read();
  const second = f.service.read();
  try { await until(() => active >= 2, 'The history reader should begin concurrent artifact work'); }
  finally { pending.release(); }
  const results = await Promise.all([first, second]);
  assert.ok(maximum <= 4, 'Concurrent history requests share one global I/O limit of four');
  assert.equal(reads, 12, 'Each unique artifact reference should be loaded once across both readers');
  for (const result of results) assert.equal(entries(result).filter((entry) => entry.verdict === 'correct').length, 13);
  assert.equal(f.snapshot(), before, 'History reads must not persist cached answers or rewrite execution records');
  await f.service.read();
  assert.equal(reads, 12, 'Repeated reads should reuse the extracted-answer cache');
});

test('deleting a run during artifact loading omits the stale entry and never recreates its metadata', async (t) => {
  const f = await fixture(t); provider(f.store);
  f.store.put('runs', makeRun('deleted-while-reading', { artifact: { storage: 's3', configId: 'cloud', key: 'delayed', sizeBytes: 20 } }));
  const pending = gate(); let started = false;
  t.after(() => pending.release());
  t.mock.method(f.artifacts, 'get', async () => {
    started = true; await pending.promise;
    return { output: '21', html: '', reasoning: BODY };
  });
  const result = f.service.read();
  try {
    await until(() => started, 'The artifact fetch should be pending');
    f.store.delete('runs', 'deleted-while-reading');
  } finally { pending.release(); }
  assert.deepEqual(entries(await result), []);
  assert.equal(f.store.get<StoredRun>('runs', 'deleted-while-reading'), undefined);
  assert.deepEqual(entries(await f.service.read()), []);
});

test('completion changes during artifact reads cannot return out-of-window or stale timestamps', async (t) => {
  const f = await fixture(t); provider(f.store);
  const pending = gate(); let started = 0;
  t.after(() => pending.release());
  const artifact = (key: string): ArtifactRef => ({ storage: 's3', configId: 'cloud', key, sizeBytes: 20 });
  const movedOut = makeRun('moved-out', { artifact: artifact('moved-out') });
  const movedLater = makeRun('moved-later', { artifact: artifact('moved-later') });
  const becamePending = makeRun('became-pending', { artifact: artifact('became-pending') });
  for (const run of [movedOut, movedLater, becamePending]) f.store.put('runs', run);
  t.mock.method(f.artifacts, 'get', async () => {
    started++; await pending.promise;
    return { output: '21', html: '', reasoning: '' };
  });
  const reading = f.service.read();
  try {
    await until(() => started === 3, 'All delayed artifact reads should start');
    f.store.put('runs', { ...movedOut, finishedAt: iso(NOW + 1) });
    f.store.put('runs', { ...movedLater, finishedAt: iso(NOW - 100) });
    f.store.put('runs', { ...becamePending, status: 'running', finishedAt: null });
  } finally { pending.release(); }
  const result = entries(await reading);
  assert.deepEqual(result.map(entry => entry.id), ['became-pending', 'moved-later']);
  assert.equal(result[0]!.verdict, 'pending'); assert.equal(result[0]!.finishedAt, null);
  assert.equal(result[1]!.verdict, 'correct'); assert.equal(result[1]!.finishedAt, iso(NOW - 100));
  assert.equal(result[1]!.createdAt, movedLater.createdAt);
});

test('the extracted-answer cache remains bounded when a history has more than 2048 artifacts', async (t) => {
  const f = await fixture(t); provider(f.store);
  let reads = 0;
  t.mock.method(f.artifacts, 'get', async () => { reads++; return { output: '21', html: '', reasoning: BODY }; });
  f.store.transaction(() => {
    for (let index = 0; index < 2050; index++) f.store.put('runs', makeRun(`cache-${index}`, {
      createdAt: iso(NOW - 5000 + index),
      artifact: { storage: 's3', configId: 'cache-cloud', key: `cache-object-${index}`, sizeBytes: 20 },
    }));
  });
  assert.equal(entries(await f.service.read()).length, 2050);
  assert.equal(reads, 2050);
  const afterFirst = reads;
  assert.equal(entries(await f.service.read()).length, 2050);
  assert.ok(reads > afterFirst, 'A fixed-clock second read must encounter evicted answers once the cache exceeds its capacity');
});

test('cache pruning uses all eligible history, preserves other searches, and forgets deleted or expired snapshots', async (t) => {
  const f = await fixture(t); provider(f.store);
  const outputs = new Map([['cache-a', '21'], ['cache-b', '21'], ['cache-a-v2', '21']]);
  let reads = 0;
  t.mock.method(f.artifacts, 'get', async (ref: ArtifactRef) => {
    reads++;
    return { output: outputs.get(ref.key)!, html: '', reasoning: '' };
  });
  const originalA = makeRun('search-cache-a', { modelName: '模型缓存 A', createdAt: iso(NOW - DAY), finishedAt: iso(NOW - DAY + 1000),
    artifact: { storage: 's3', configId: 'query-cache', key: 'cache-a', sizeBytes: 20 } });
  const originalB = makeRun('search-cache-b', { modelName: '模型缓存 B',
    artifact: { storage: 's3', configId: 'query-cache', key: 'cache-b', sizeBytes: 20 } });
  f.store.put('runs', originalA); f.store.put('runs', originalB);
  assert.ok(entries(await f.service.read()).every((entry) => entry.verdict === 'correct'));
  assert.equal(reads, 2);
  assert.equal(entries(await f.service.read({ q: '模型缓存 A' }))[0]!.id, originalA.id);
  assert.equal(entries(await f.service.read({ q: '模型缓存 B' }))[0]!.id, originalB.id);
  assert.equal(reads, 2, 'Switching searches must not evict another still-eligible record');

  // A leaves the 24-hour window while its normal answer-cache TTL would still be valid.
  f.advance(1001);
  await f.service.read({ q: '模型缓存 B' });
  assert.deepEqual(entries(await f.service.read({ q: '模型缓存 A' })), []);
  outputs.set('cache-a', '29');
  const recentA = { ...originalA, finishedAt: iso(f.now() - 500) };
  f.store.put('runs', recentA);
  assert.equal(entries(await f.service.read({ q: '模型缓存 A' }))[0]!.verdict, 'incorrect');
  assert.equal(reads, 3, 'A snapshot that left the history window must not retain an old green verdict');

  f.store.delete('runs', originalB.id);
  await f.service.read({ q: '模型缓存 A' });
  outputs.set('cache-b', '29');
  f.store.put('runs', originalB);
  assert.equal(entries(await f.service.read({ q: '模型缓存 B' }))[0]!.verdict, 'incorrect');
  assert.equal(reads, 4, 'Deletion must clear the cached result even when another search is active');

  f.store.put('runs', { ...recentA, artifact: { ...recentA.artifact!, key: 'cache-a-v2' } });
  assert.equal(entries(await f.service.read({ q: '模型缓存 A' }))[0]!.verdict, 'correct');
  assert.equal(reads, 5, 'Replacing an artifact reference must invalidate the prior extracted answer');
});

test('transient cloud read failures report unavailable and recover after a short cache TTL', async (t) => {
  const f = await fixture(t); provider(f.store);
  f.store.put('runs', makeRun('recover-cloud', { artifact: { storage: 's3', configId: 'cloud', key: 'recover', sizeBytes: 20 } }));
  let reads = 0;
  t.mock.method(f.artifacts, 'get', async () => {
    reads++;
    if (reads === 1) throw new Error(`Private cloud transport failure ${KEY}`);
    return { output: '21', html: '', reasoning: '' };
  });
  const first = await f.service.read();
  assert.equal(entries(first)[0]!.verdict, 'unavailable');
  assert.ok(!JSON.stringify(first).includes(KEY));
  assert.ok(!JSON.stringify(first).includes('Private cloud transport failure'));
  assert.equal(entries(await f.service.read())[0]!.verdict, 'unavailable');
  assert.equal(reads, 1, 'Temporary errors should be cached briefly to avoid repeated failing cloud requests');
  f.advance(60_000);
  assert.equal(entries(await f.service.read())[0]!.verdict, 'correct', 'A short error cache must not permanently hide restored artifacts');
  assert.equal(reads, 2);
});

test('the anonymous HTTP route returns only timeline fields and validates filters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-history-route-'));
  const store = new Store(directory, 'history-route-admin-token');
  provider(store);
  const cloud: ArtifactRef = { storage: 's3', configId: 'PRIVATE_CONFIG', key: 'PRIVATE_OBJECT', sizeBytes: 20 };
  store.put('runs', makeRun('http-correct', { artifact: cloud }));
  store.put('runs', makeRun('http-failed', { status: 'failed', error: `PRIVATE_ERROR ${KEY}` }));
  store.close();
  let reads = 0;
  t.mock.method(ArtifactStore.prototype, 'get', async (): Promise<ArtifactPayload> => {
    reads++; return { output: `21\n${BODY}`, html: '<svg>PRIVATE_HTML</svg>', reasoning: 'PRIVATE_REASONING' };
  });
  const application = createApp({ dataDir: directory, seed: false, adminToken: 'history-route-admin-token', now: () => NOW,
    schedulerIntervalMs: 60_000, cleanupIntervalMs: 60_000 });
  const server = createServer(application.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await application.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const response = await fetch(origin + '/api/public/reasoning-history');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const result = await response.json() as ReasoningHistoryResponse;
  assert.equal(entries(result).length, 2); assert.equal(reads, 1);
  assert.deepEqual(Object.keys(entries(result)[0]!).sort(), ['answer', 'createdAt', 'error', 'finishedAt', 'id', 'modelName', 'reasoningEffort', 'status', 'verdict']);
  for (const secret of [KEY, BODY, 'PRIVATE_ERROR', 'PRIVATE_CONFIG', 'PRIVATE_OBJECT', 'PRIVATE_HTML', 'PRIVATE_REASONING',
    'private-history.invalid', 'encryptedApiKey', 'execution', 'promptContent', 'referenceAnswer', 'rubric', 'score']) {
    assert.ok(!JSON.stringify(result).includes(secret), `Public history must not disclose ${secret}`);
  }
  for (const query of [`providerId=${'x'.repeat(101)}`, `q=${'x'.repeat(201)}`]) {
    assert.equal((await fetch(`${origin}/api/public/reasoning-history?${query}`)).status, 400);
  }
  const filtered = await fetch(origin + '/api/public/reasoning-history?providerId=provider-a&q=gpt-6');
  assert.equal(filtered.status, 200);
  assert.equal(entries(await filtered.json() as ReasoningHistoryResponse).length, 2);
});
