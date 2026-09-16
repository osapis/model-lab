import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { collectCleanupCandidates, deleteSelectedRuns } from '../src/cleanup.ts';
import type { Run } from '../shared/types.ts';

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('select all reads past the first 200 records, preserves filters, and excludes active runs', async t => {
  const rows = Array.from({ length: 245 }, (_, i) => ({ id: `run-${i}`, status: i < 2 ? 'running' : i === 2 ? 'queued' : 'completed', source: 'api' }) as Run);
  const calls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.equal(init.method, undefined, 'Selection must never delete records');
    const url = new URL(input, 'http://lab'); calls.push(url);
    const offset = Number(url.searchParams.get('offset'));
    return response({ runs: rows.slice(offset, offset + 200), total: rows.length });
  });
  const found = await collectCleanupCandidates({ providerId: 'provider-A', modelId: 'model-1', source: 'api', status: 'all', q: '  鹈鹕  ' });
  assert.deepEqual(calls.map(url => url.searchParams.get('offset')), ['0', '200']);
  for (const url of calls) {
    assert.equal(url.searchParams.get('providerId'), 'provider-A');
    assert.equal(url.searchParams.get('modelId'), 'model-1');
    assert.equal(url.searchParams.get('q'), '鹈鹕');
    assert.equal(url.searchParams.get('source'), 'api');
    assert.equal(url.searchParams.has('status'), false);
  }
  assert.equal(found.runs.length, 242); assert.equal(found.activeCount, 3);
  assert.equal(found.runs.every(run => run.source === 'api'), true);
});

test('selection failure and cancellation never return an incomplete all-selection', async t => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response({ runs: [{ id: 'first', status: 'completed' }], total: 2 }); });
  await assert.rejects(collectCleanupCandidates({}, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(calls, 1);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => response({ error: '列表不可用' }, 502));
  await assert.rejects(collectCleanupCandidates({ providerId: 'A' }), /列表不可用/);
});

test('batch deletion deduplicates selected IDs, limits concurrency and reports partial failures', async t => {
  let active = 0; let maximum = 0;
  const requested: string[] = []; const progress: number[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const id = decodeURIComponent(input.slice('/api/admin/runs/'.length)); requested.push(id);
    assert.equal(init.method, 'DELETE'); assert.equal(init.credentials, 'same-origin');
    active++; maximum = Math.max(maximum, active); await delay(8); active--;
    if (id === 'cloud-failure') return response({ error: '云端正文删除失败，历史已保留' }, 502);
    if (id === 'active') return response({ error: '任务进行中' }, 409);
    if (id === 'missing') return response({}, 404);
    if (id === 'network') throw new TypeError('network');
    return response({ ok: true });
  });
  const result = await deleteSelectedRuns(['success', 'cloud-failure', 'active', 'missing', 'network', 'encoded/id', 'success'], { onProgress: done => progress.push(done) });
  assert.ok(maximum <= 3); assert.equal(requested.length, 6);
  assert.deepEqual(new Set(result.deletedIds), new Set(['success', 'encoded/id']));
  assert.deepEqual(result.missingIds, ['missing']); assert.deepEqual(result.skippedIds, ['active']);
  assert.deepEqual(new Set(result.failures.map(failure => failure.id)), new Set(['cloud-failure', 'network']));
  assert.match(result.failures.find(failure => failure.id === 'cloud-failure')!.error, /历史已保留/);
  assert.deepEqual(progress, [0, 1, 2, 3, 4, 5, 6]);
});

test('authentication failure stops new deletes and keeps all unresolved IDs available for retry', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return response({ error: '请先登录' }, 401); });
  const ids = Array.from({ length: 10 }, (_, i) => `run-${i}`);
  const result = await deleteSelectedRuns(ids);
  assert.ok(requests <= 3); assert.equal(result.failures.length, 10);
  assert.equal(result.deletedIds.length, 0); assert.equal(result.skippedIds.length, 0);
  assert.deepEqual(new Set(result.failures.map(row => row.id)), new Set(ids));
});
