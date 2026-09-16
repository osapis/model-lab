import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { cleanupCloudBatch } from '../cloudflare/cleanup.ts';
import type { CloudflareArtifactStore } from '../cloudflare/artifacts.ts';
import type { ArtifactRef } from '../server/artifacts.ts';
import { Store, type StoredProvider, type StoredRun } from '../server/store.ts';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const identity = (ref: ArtifactRef) => `${ref.storage}:${ref.configId || ''}:${ref.key}`;

function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  const store = new Store({
    database, encryptionKey: new Uint8Array(32).fill(61), adminToken: 'local-cleanup-test-token',
    transaction: <T>(callback: () => T): T => {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  });
  database.exec('CREATE TABLE artifact_pending (config_id TEXT NOT NULL, object_key TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(config_id, object_key))');
  store.saveSettings({ retentionDays: 1 });
  t.after(() => store.close());
  return store;
}

function ref(key: string): ArtifactRef {
  return { storage: 'cloudflare', configId: 'cloudflare-sqlite', key, sizeBytes: 12 };
}

function journal(store: Store, references: ArtifactRef[]) {
  const insert = store.db.prepare('INSERT INTO artifact_pending(config_id, object_key, data, created_at) VALUES (?, ?, ?, ?)');
  for (const item of references) insert.run(item.configId!, item.key, JSON.stringify(item), at(2));
}

function forget(store: Store, reference: ArtifactRef) {
  store.db.prepare('DELETE FROM artifact_pending WHERE config_id = ? AND object_key = ?').run(reference.configId!, reference.key);
}

function pendingCount(store: Store) {
  return Number(store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count);
}

function run(id: string, patch: Partial<StoredRun> = {}): StoredRun {
  return {
    id, batchId: 'batch', promptId: 'prompt', modelId: 'model', providerId: 'provider',
    providerName: '本地测试', modelName: '测试模型', modelSlug: 'test-model', promptTitle: '测试提示词',
    promptContent: '1 + 1', category: 'reasoning', referenceAnswer: '2', rubric: '',
    status: 'completed', source: 'api', sourceLabel: '本地模拟', output: '', html: '', reasoning: '', error: '',
    latencyMs: 1, inputTokens: 1, outputTokens: 1, createdAt: at(2), finishedAt: at(2), parameters: {}, ...patch,
  };
}

function artifacts(options: {
  delete?: (ref: ArtifactRef) => Promise<void>;
  cleanup?: (isReferenced: (ref: ArtifactRef) => boolean, budget: number) => Promise<void>;
} = {}) {
  const deletes: ArtifactRef[] = [];
  const budgets: number[] = [];
  const repository = {
    async delete(reference: ArtifactRef) { deletes.push(reference); await options.delete?.(reference); },
    async cleanupPending(isReferenced: (ref: ArtifactRef) => boolean, budget: number) {
      budgets.push(budget);
      await options.cleanup?.(isReferenced, budget);
    },
  };
  return { repository: repository as unknown as CloudflareArtifactStore, deletes, budgets };
}

test('cloud cleanup limits each slice to eight object deletes and passes a five-orphan budget', async (t) => {
  const store = fixture(t);
  const pending = Array.from({ length: 10 }, (_, index) => ref(`pending-${index}`));
  const main = ref('main-artifact');
  store.put('runs', run('many-objects', { artifact: main, artifactAvailable: true, pendingArtifactDeletes: pending }));
  const orphanCandidates = Array.from({ length: 9 }, (_, index) => ref(`orphan-${index}`));
  journal(store, orphanCandidates);
  const orphanDeletes: string[] = [];
  const fake = artifacts({ cleanup: async (referenced, budget) => {
    for (const candidate of orphanCandidates.splice(0, budget)) {
      assert.equal(referenced(candidate), false);
      orphanDeletes.push(candidate.key);
      forget(store, candidate);
    }
  } });
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), false);
  assert.equal(fake.deletes.length, 8);
  assert.deepEqual(fake.budgets, [5]);
  assert.equal(orphanDeletes.length, 5);
  const remaining = store.get<StoredRun>('runs', 'many-objects')!;
  assert.deepEqual(remaining.pendingArtifactDeletes?.map((item) => item.key), ['pending-8', 'pending-9']);
  assert.equal(remaining.artifact?.key, main.key);
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), true);
  assert.equal(fake.deletes.length, 11);
  assert.deepEqual(fake.budgets, [5, 5]);
  assert.equal(orphanDeletes.length, 9);
  assert.equal(store.get('runs', 'many-objects'), undefined);
});

test('orphan-only cleanup remains incomplete until all journal entries fit through the five-object slices', async (t) => {
  const store = fixture(t);
  journal(store, Array.from({ length: 7 }, (_, index) => ref(`orphan-only-${index}`)));
  const removed: string[] = [];
  const fake = artifacts({ cleanup: async (referenced, budget) => {
    const candidates = store.db.prepare('SELECT data FROM artifact_pending ORDER BY object_key LIMIT ?').all(budget);
    for (const row of candidates) {
      const candidate = JSON.parse(String(row.data)) as ArtifactRef;
      assert.equal(referenced(candidate), false);
      removed.push(candidate.key);
      forget(store, candidate);
    }
  } });
  assert.equal(store.all('runs').length, 0);
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), false);
  assert.equal(removed.length, 5);
  assert.equal(pendingCount(store), 2, 'Remaining orphan references must prevent marking the cleanup complete');
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), true);
  assert.equal(removed.length, 7);
  assert.equal(pendingCount(store), 0);
  assert.equal(fake.deletes.length, 0, 'Only the orphan-cleanup path should run');
  assert.deepEqual(fake.budgets, [5, 5]);
});

test('a swallowed orphan deletion failure keeps cleanup incomplete and retains the journal until retry succeeds', async (t) => {
  const store = fixture(t);
  const candidate = ref('orphan-delete-failure');
  journal(store, [candidate]);
  let rejectDelete = true;
  let attempts = 0;
  const fake = artifacts({ cleanup: async (referenced, budget) => {
    assert.equal(budget, 5);
    assert.equal(referenced(candidate), false);
    attempts++;
    try {
      if (rejectDelete) throw new Error('fake orphan delete failure');
      forget(store, candidate);
    } catch { /* Match the native artifact cleanup contract: retain journal and retry later. */ }
  } });
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), false);
  assert.equal(pendingCount(store), 1);
  assert.equal(store.db.prepare('SELECT object_key FROM artifact_pending').get()!.object_key, candidate.key);
  rejectDelete = false;
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), true);
  assert.equal(attempts, 2);
  assert.equal(pendingCount(store), 0);
});

test('cloud cleanup removes at most forty expired metadata-only records per slice', async (t) => {
  const store = fixture(t);
  for (let index = 0; index < 45; index++) store.put('runs', run(`metadata-${index}`));
  const fake = artifacts();
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), false);
  assert.equal(store.all('runs').length, 5);
  assert.equal(fake.deletes.length, 0);
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), true);
  assert.equal(store.all('runs').length, 0);
});

test('a failed delete preserves its reference and metadata and the next slice retries only unfinished objects', async (t) => {
  const store = fixture(t);
  const first = ref('first'), failed = ref('temporarily-failing'), main = ref('main');
  store.put('runs', run('retry-cleanup', { artifact: main, artifactAvailable: true, pendingArtifactDeletes: [first, failed] }));
  let reject = true;
  const fake = artifacts({ delete: async (item) => {
    if (reject && item.key === failed.key) throw new Error('fake unavailable storage');
  } });
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), false);
  const retained = store.get<StoredRun>('runs', 'retry-cleanup')!;
  assert.ok(retained.cleanupError);
  assert.equal(retained.artifact?.key, main.key);
  assert.deepEqual(retained.pendingArtifactDeletes?.map((item) => item.key), [failed.key]);
  assert.deepEqual(fake.deletes.map((item) => item.key), [first.key, failed.key]);
  reject = false;
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), true);
  assert.deepEqual(fake.deletes.map((item) => item.key), [first.key, failed.key, failed.key, main.key]);
  assert.equal(store.get('runs', 'retry-cleanup'), undefined);
});

test('failed deletes count toward the eight-operation limit instead of allowing an unbounded failure loop', async (t) => {
  const store = fixture(t);
  for (let index = 0; index < 12; index++) store.put('runs', run(`failure-${index}`, { artifact: ref(`object-${index}`) }));
  const fake = artifacts({ delete: async () => { throw new Error('fake failure'); } });
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), false);
  assert.equal(fake.deletes.length, 8);
  assert.equal(store.all('runs').length, 12);
  assert.equal(store.all<StoredRun>('runs').filter((item) => item.cleanupError).length, 8);
  assert.deepEqual(fake.budgets, [5]);
});

test('retention preserves active runs, samples, provider overrides and the exact expiry boundary', async (t) => {
  const store = fixture(t);
  const provider: StoredProvider = { id: 'long-provider', name: '较长保留期', baseUrl: 'https://example.invalid/v1',
    protocol: 'responses', enabled: true, encryptedApiKey: '', retentionDays: 3, createdAt: at(10) };
  store.put('providers', provider);
  const protectedRows = [
    run('running', { status: 'running', artifact: ref('running-main'), pendingArtifactDeletes: [ref('running-pending')] }),
    run('queued', { status: 'queued', artifact: ref('queued-main'), pendingArtifactDeletes: [ref('queued-pending')] }),
    run('sample', { source: 'sample', artifact: ref('sample-main') }),
    run('provider-retained', { providerId: provider.id, artifact: ref('retained-main') }),
    run('expiry-boundary', { finishedAt: at(1), artifact: ref('boundary-main') }),
  ];
  for (const value of protectedRows) store.put('runs', value);
  store.put('runs', run('expired-completed', { artifact: ref('expired-completed-main') }));
  store.put('runs', run('expired-failed', { status: 'failed' }));
  store.put('runs', run('expired-cancelled', { status: 'cancelled' }));
  store.put('runs', run('created-at-fallback', { finishedAt: null }));
  store.put('runs', run('provider-expired', { providerId: provider.id, finishedAt: at(4) }));
  const fake = artifacts();
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), true);
  assert.deepEqual(new Set(store.all<StoredRun>('runs').map((item) => item.id)), new Set(protectedRows.map((item) => item.id)));
  assert.deepEqual(fake.deletes.map((item) => item.key), ['expired-completed-main']);
  assert.equal(store.get<StoredRun>('runs', 'running')?.pendingArtifactDeletes?.length, 1);
  assert.equal(store.get<StoredRun>('runs', 'queued')?.pendingArtifactDeletes?.length, 1);
});

test('pending compensation clears before retention without deleting the retained main artifact or sample metadata', async (t) => {
  const store = fixture(t);
  store.put('runs', run('fresh-cancelled', { status: 'cancelled', finishedAt: at(0),
    pendingArtifactDeletes: [ref('cancelled-pending')], cleanupError: '等待清理' }));
  store.put('runs', run('fresh-result', { finishedAt: at(0), artifact: ref('fresh-main'), artifactAvailable: true,
    pendingArtifactDeletes: [ref('fresh-pending')], cleanupError: '等待清理' }));
  store.put('runs', run('sample-with-pending', { source: 'sample', artifact: ref('sample-main'), pendingArtifactDeletes: [ref('sample-pending')] }));
  const fake = artifacts();
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), true);
  assert.equal(store.all('runs').length, 3);
  assert.deepEqual(new Set(fake.deletes.map((item) => item.key)), new Set(['cancelled-pending', 'fresh-pending', 'sample-pending']));
  for (const value of store.all<StoredRun>('runs')) {
    assert.deepEqual(value.pendingArtifactDeletes, []);
    assert.equal(value.cleanupError, '');
  }
  assert.equal(store.get<StoredRun>('runs', 'fresh-result')?.artifact?.key, 'fresh-main');
  assert.equal(store.get<StoredRun>('runs', 'sample-with-pending')?.artifact?.key, 'sample-main');
});

test('orphan cleanup protects both existing references and uploads committed after its initial snapshot', async (t) => {
  const store = fixture(t);
  const existing = ref('existing-main'), pending = ref('existing-pending'), arriving = ref('late-upload');
  store.put('runs', run('active-upload', { status: 'running', artifact: existing, pendingArtifactDeletes: [pending] }));
  const fake = artifacts({ cleanup: async (referenced, budget) => {
    assert.equal(budget, 5);
    assert.equal(referenced(existing), true);
    assert.equal(referenced(pending), true);
    assert.equal(referenced(arriving), false);
    store.put('runs', run('just-committed', { finishedAt: at(0), artifact: arriving }));
    assert.equal(referenced(arriving), true, 'A newly committed artifact must not be deleted as an orphan');
    assert.equal(referenced({ ...arriving, configId: 'other-config' }), false, 'Reference identity includes storage configuration');
    assert.notEqual(identity(arriving), identity({ ...arriving, storage: 's3' }));
    assert.equal(referenced({ ...arriving, storage: 's3' }), false, 'Reference identity includes storage backend');
  } });
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), true);
  assert.equal(fake.deletes.length, 0);
  assert.equal(store.get<StoredRun>('runs', 'just-committed')?.artifact?.key, arriving.key);
});

test('cleanup does not resurrect a run removed while an artifact deletion is pending', async (t) => {
  const store = fixture(t);
  store.put('runs', run('concurrent-removal', { artifact: ref('concurrent-main') }));
  const fake = artifacts({ delete: async () => { store.delete('runs', 'concurrent-removal'); } });
  assert.equal(await cleanupCloudBatch(store, fake.repository, NOW), true);
  assert.equal(store.get('runs', 'concurrent-removal'), undefined);
  assert.equal(fake.deletes.length, 1);
});
