import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store, type StoredRun } from '../server/store.ts';
import { ArtifactStore } from '../server/artifacts.ts';
import { restoreArtifactsFromHandoff } from '../server/handoff.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'model-lab-handoff-test-'));
  const ram = mkdtempSync('/dev/shm/model-lab-handoff-test-');
  const store = new Store(directory, 'test-only-admin');
  const artifacts = new ArtifactStore(store);
  t.after(async () => { await artifacts.close(); store.close(); rmSync(directory, { recursive: true }); rmSync(ram, { recursive: true }); });
  const record = (id: string, storage: 'memory' | 's3' = 'memory') => ({
    id, batchId: 'batch', promptId: 'prompt', modelId: 'model', providerId: 'provider',
    providerName: '接口', modelName: '模型', modelSlug: 'model', promptTitle: '题目', promptContent: '原始题目',
    category: 'visual', referenceAnswer: '', rubric: '', status: 'completed', source: 'api', sourceLabel: 'API',
    output: '', html: '', reasoning: '', error: '', latencyMs: 120, inputTokens: 10, outputTokens: 20,
    createdAt: '2026-09-13T00:00:00Z', finishedAt: '2026-09-13T00:00:01Z', parameters: { maxTokens: 8192 },
    artifact: { storage, key: `original-${id}`, sizeBytes: 1 },
  } as StoredRun);
  return { directory, ram, store, artifacts, record };
}

test('RAM handoff preserves original bytes and metadata without persisting generated bodies', async t => {
  const f = fixture(t); const before = f.record('kept'); f.store.put('runs', before);
  const payload = { output: 'handoff-sentinel-原始回答', html: '<svg>handoff-sentinel-作品</svg>', reasoning: '原始推理' };
  const path = join(f.ram, 'snapshot.json');
  writeFileSync(path, JSON.stringify({ version: 1, runs: [{ id: 'kept', ...payload }] }), { mode: 0o600 });
  assert.equal(restoreArtifactsFromHandoff(f.store, f.artifacts, path), 1);
  const after = f.store.get<StoredRun>('runs', 'kept')!;
  assert.deepEqual(await f.artifacts.get(after.artifact!), payload);
  assert.equal(after.latencyMs, before.latencyMs); assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.output, ''); assert.equal(after.html, ''); assert.equal(existsSync(path), false);
  for (const name of ['app.db', 'app.db-wal']) if (existsSync(join(f.directory, name))) assert.equal(readFileSync(join(f.directory, name)).includes(Buffer.from('handoff-sentinel')), false);
  assert.equal(restoreArtifactsFromHandoff(f.store, f.artifacts, path), 0);
});

test('handoff does not restore deleted records or overwrite cloud references', t => {
  const f = fixture(t); f.store.put('runs', f.record('cloud', 's3'));
  const path = join(f.ram, 'snapshot.json');
  writeFileSync(path, JSON.stringify({ version: 1, runs: ['deleted', 'cloud'].map(id => ({ id, output: 'old', html: '', reasoning: '' })) }), { mode: 0o600 });
  assert.equal(restoreArtifactsFromHandoff(f.store, f.artifacts, path), 0);
  assert.equal(f.store.get<StoredRun>('runs', 'deleted'), undefined);
  assert.equal(f.store.get<StoredRun>('runs', 'cloud')?.artifact?.key, 'original-cloud');
});

test('invalid or duplicate handoff keeps the source intact and does not partially restore', t => {
  const f = fixture(t); f.store.put('runs', f.record('kept'));
  const path = join(f.ram, 'snapshot.json');
  const entry = { id: 'kept', output: 'old', html: '', reasoning: '' };
  writeFileSync(path, JSON.stringify({ version: 1, runs: [entry, entry] }), { mode: 0o600 });
  assert.throws(() => restoreArtifactsFromHandoff(f.store, f.artifacts, path), /重复/);
  assert.equal(existsSync(path), true);
  assert.equal(f.store.get<StoredRun>('runs', 'kept')?.artifact?.key, 'original-kept');
});
