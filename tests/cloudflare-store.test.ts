import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CloudStore, DurableObjectDatabase } from '../cloudflare/store.ts';
import { Store, providerDto, runDto, type StoredProvider, type StoredRun, type SyncDatabase } from '../server/store.ts';
import type { Model, Prompt, Schedule } from '../shared/types.ts';

const ADMIN_TOKEN = 'cloudflare-local-test-admin';
const API_KEY = 'sk-cloud-provider-private-key-0123456789';
const ENCRYPTION_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const CREATED_AT = '2026-09-15T00:00:00.000Z';
type CloudStorage = ConstructorParameters<typeof DurableObjectDatabase>[0];
type SqlValue = string | number | null | ArrayBuffer;

function mockStorage(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const statements: { sql: string; bindings: unknown[]; rowCount: number; consumed: boolean; calls: number }[] = [];
  let transactions = 0;
  let transactionDepth = 0;
  const storage = {
    sql: {
      exec(sql: string, ...bindings: SqlValue[]) {
        assert.ok(!statements.some((item) => !item.consumed), 'A Durable Object cursor must be fully consumed before another statement');
        assert.doesNotMatch(sql, /\bPRAGMA\s+(?:journal_mode|busy_timeout)\b|\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i, 'Worker adapters must delegate transactions and avoid host SQLite settings');
        assert.ok(bindings.every((value) => value === null || typeof value === 'string' || typeof value === 'number' || value instanceof ArrayBuffer), 'Bindings must use Durable Object SQL value types');
        const nodeBindings = bindings.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
        const statement = sqlite.prepare(sql);
        const rows = statement.all(...nodeBindings).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
          key, value instanceof Uint8Array ? Uint8Array.from(value).buffer : value,
        ])));
        const record = { sql, bindings, rowCount: rows.length, consumed: false, calls: 0 };
        statements.push(record);
        return {
          // These are billing counters, deliberately different from SQLite changes().
          rowsRead: 9000, rowsWritten: 8000,
          toArray() {
            record.calls++;
            assert.equal(record.calls, 1, 'Each cursor should be materialized exactly once');
            record.consumed = true;
            return rows;
          },
        };
      },
    },
    transactionSync<T>(callback: () => T): T {
      transactions++;
      const nested = transactionDepth > 0;
      const savepoint = `mock_transaction_${transactionDepth}`;
      sqlite.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      transactionDepth++;
      try {
        const result = callback();
        sqlite.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        sqlite.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        throw error;
      } finally { transactionDepth--; }
    },
  };
  t.after(() => sqlite.close());
  return {
    storage: storage as unknown as CloudStorage, sqlite, statements,
    get transactions() { return transactions; },
    transaction: <T>(callback: () => T) => storage.transactionSync(callback),
  };
}

function provider(store: Store, id = 'provider-one'): StoredProvider {
  return {
    id, name: '本地 Cloudflare 适配测试', baseUrl: 'https://example.invalid/v1', protocol: 'responses',
    enabled: true, encryptedApiKey: store.encrypt(API_KEY), retentionDays: null, createdAt: CREATED_AT,
  };
}

function model(id = 'model-one'): Model {
  return { id, providerId: 'provider-one', name: '测试模型', modelId: 'test-model', enabled: true,
    maxTokens: 1024, reasoningEffort: 'high', createdAt: CREATED_AT };
}

function prompt(): Prompt {
  return { id: 'prompt-one', title: '测试提示词', description: '', category: 'reasoning', content: '请直接回答 1 + 1。',
    referenceAnswer: '2', rubric: '', tags: ['本地测试'], enabled: true, createdAt: CREATED_AT, updatedAt: CREATED_AT };
}

function schedule(): Schedule {
  return { id: 'schedule-one', name: '测试计划', promptIds: ['prompt-one'], modelIds: ['model-one'],
    intervalMinutes: 60, enabled: true, lastRunAt: null, nextRunAt: CREATED_AT, lastError: '', createdAt: CREATED_AT };
}

function run(): StoredRun {
  return {
    id: 'run-one', batchId: 'batch-one', promptId: 'prompt-one', modelId: 'model-one', providerId: 'provider-one',
    providerName: '测试 API', modelName: '测试模型', modelSlug: 'test-model', promptTitle: '测试提示词',
    promptContent: '请直接回答 1 + 1。', category: 'reasoning', referenceAnswer: '2', rubric: '',
    status: 'completed', source: 'api', sourceLabel: '本地模拟', output: '', html: '', reasoning: '', error: '',
    latencyMs: 8, inputTokens: 7, outputTokens: 1, createdAt: CREATED_AT, finishedAt: CREATED_AT,
    parameters: { protocol: 'responses', maxTokens: 1024, reasoningEffort: 'high' },
    execution: { providerId: 'provider-one', baseUrl: 'https://example.invalid/v1', encryptedApiKey: 'private-ciphertext',
      protocol: 'responses', modelId: 'test-model', maxTokens: 1024, reasoningEffort: 'high' },
  };
}

test('Durable Object database eagerly consumes zero and multiple rows and reports real write metadata', (t) => {
  const mock = mockStorage(t);
  const database: SyncDatabase = new DurableObjectDatabase(mock.storage);
  database.exec('CREATE TABLE adapter_rows (id INTEGER PRIMARY KEY, value TEXT)');
  const inserted = database.prepare('INSERT INTO adapter_rows(value) VALUES (?)').run('first');
  assert.equal(Number(inserted.changes), 1);
  assert.equal(Number(inserted.lastInsertRowid), 1);
  database.prepare('INSERT INTO adapter_rows(value) VALUES (?)').run('second');
  const zero = database.prepare('SELECT value FROM adapter_rows WHERE id = ?').get(99);
  assert.equal(zero, undefined);
  assert.equal(mock.statements.at(-1)!.rowCount, 0);
  assert.equal(mock.statements.at(-1)!.consumed, true);
  const first = database.prepare('SELECT value FROM adapter_rows ORDER BY id').get();
  assert.equal(first?.value, 'first');
  assert.equal(mock.statements.at(-1)!.rowCount, 2, 'get() must consume all rows while returning only the first');
  assert.equal(mock.statements.at(-1)!.calls, 1);
  assert.deepEqual(database.prepare('SELECT value FROM adapter_rows ORDER BY id').all().map((row) => row.value), ['first', 'second']);
  const unchanged = database.prepare('UPDATE adapter_rows SET value = ? WHERE id = ?').run('none', 99);
  assert.equal(Number(unchanged.changes), 0, 'Billing rowsWritten must not stand in for SQLite changes()');
  database.close();
  assert.equal(database.prepare('SELECT COUNT(*) AS total FROM adapter_rows').get()?.total, 2, 'Closing the adapter must not close Durable Object storage');
  assert.ok(mock.statements.every((item) => item.consumed && item.calls === 1));
});

test('Durable Object bindings preserve sliced blobs and only convert safe bigint values', (t) => {
  const mock = mockStorage(t);
  const database = new DurableObjectDatabase(mock.storage);
  database.exec('CREATE TABLE adapter_values (id INTEGER PRIMARY KEY, n INTEGER, blob BLOB)');
  const backing = new Uint8Array([99, 10, 20, 88]);
  database.prepare('INSERT INTO adapter_values(n, blob) VALUES (?, ?)').run(42n, backing.subarray(1, 3));
  const bound = mock.statements.find((item) => item.sql.startsWith('INSERT INTO adapter_values'))!;
  assert.equal(bound.bindings[0], 42);
  assert.ok(bound.bindings[1] instanceof ArrayBuffer);
  assert.equal(bound.bindings[1].byteLength, 2, 'Blob conversion must honor a Uint8Array view offset and length');
  const row = database.prepare('SELECT n, blob FROM adapter_values').get()!;
  assert.equal(row.n, 42);
  assert.ok(row.blob instanceof Uint8Array);
  assert.deepEqual([...row.blob], [10, 20]);
  const before = mock.statements.length;
  for (const number of [BigInt(Number.MAX_SAFE_INTEGER) + 1n, BigInt(Number.MIN_SAFE_INTEGER) - 1n]) {
    assert.throws(() => database.prepare('SELECT ? AS n').get(number), RangeError);
  }
  assert.equal(mock.statements.length, before, 'Unsafe bigint values must be rejected before SQL executes');
  assert.equal(database.prepare('SELECT ? AS n').get(BigInt(Number.MAX_SAFE_INTEGER))?.n, Number.MAX_SAFE_INTEGER);
});

test('injected Store supports CRUD and delegates atomic commit and rollback to transactionSync', (t) => {
  const mock = mockStorage(t);
  const store = new Store({ database: new DurableObjectDatabase(mock.storage), transaction: mock.transaction,
    encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  store.put('providers', provider(store));
  store.put('models', model());
  store.put('prompts', prompt());
  store.put('schedules', schedule());
  store.put('runs', run());
  assert.equal(store.get<Model>('models', 'model-one')?.maxTokens, 1024);
  assert.equal(store.get<Prompt>('prompts', 'prompt-one')?.content, prompt().content);
  assert.equal(store.get<Schedule>('schedules', 'schedule-one')?.intervalMinutes, 60);
  assert.equal(store.get<StoredRun>('runs', 'run-one')?.execution?.modelId, 'test-model');
  store.put('models', { ...model(), maxTokens: 2048 });
  store.put('models', model('model-two'));
  assert.deepEqual(store.all<Model>('models').map((value) => value.id), ['model-two', 'model-one']);
  const before = mock.transactions;
  assert.equal(store.transaction(() => { store.put('models', model('committed')); return 123; }), 123);
  assert.equal(mock.transactions, before + 1);
  const marker = new Error('rollback marker');
  assert.throws(() => store.transaction(() => {
    store.put('models', { ...model(), maxTokens: 999 });
    store.put('models', model('rolled-back'));
    store.delete('prompts', 'prompt-one');
    throw marker;
  }), (error) => error === marker);
  assert.equal(mock.transactions, before + 2);
  assert.equal(store.get<Model>('models', 'model-one')?.maxTokens, 2048);
  assert.equal(store.get<Model>('models', 'rolled-back'), undefined);
  assert.ok(store.get<Prompt>('prompts', 'prompt-one'));
  store.delete('models', 'model-two');
  assert.equal(store.get<Model>('models', 'model-two'), undefined);
  store.close();
  assert.ok(mock.statements.every((statement) => statement.consumed));
});

test('CloudStore normalizes persisted legacy controls while preserving historical request snapshots', (t) => {
  const mock = mockStorage(t);
  const initial = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  const legacyModel = { ...model(), temperature: 0.3, reasoningEffort: 'minimal' };
  const legacySchedule = { ...schedule(), autoPublish: true };
  const legacyRun = { ...run(), score: 90, notes: 'retired', published: true, autoPublish: true,
    parameters: { ...run().parameters, temperature: 0.2, reasoningEffort: 'historical-effort' },
    execution: { ...run().execution, temperature: 0.2, reasoningEffort: 'historical-effort' } };
  for (const [table, value] of [['models', legacyModel], ['schedules', legacySchedule], ['runs', legacyRun]] as const) {
    initial.db.prepare(`INSERT INTO ${table}(id, data) VALUES (?, ?)`).run(value.id, JSON.stringify(value));
  }
  initial.close();
  const store = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  const normalized = store.get<Model>('models', legacyModel.id)!;
  assert.equal(normalized.reasoningEffort, 'low');
  assert.equal('temperature' in normalized, false);
  const historical = store.get<StoredRun>('runs', legacyRun.id)!;
  assert.equal(historical.parameters.reasoningEffort, 'historical-effort');
  assert.equal(historical.execution?.reasoningEffort, 'historical-effort');
  for (const key of ['score', 'notes', 'published', 'autoPublish']) assert.equal(key in historical, false);
  assert.equal('temperature' in historical.parameters, false);
  assert.equal('temperature' in historical.execution!, false);
  assert.equal('autoPublish' in store.get<Schedule>('schedules', legacySchedule.id)!, false);
  for (const table of ['models', 'runs', 'schedules']) {
    const rows = store.db.prepare(`SELECT data FROM ${table}`).all();
    for (const row of rows) {
      const serialized = String(row.data);
      assert.ok(!serialized.includes('"temperature"'));
      assert.ok(!serialized.includes('"autoPublish"'));
    }
  }
});

test('CloudStore preserves settings and sessions across reconstruction and removes expired sessions', (t) => {
  const mock = mockStorage(t);
  let store = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  assert.deepEqual(store.settings(), { retentionDays: 30, maxRetries: 5, requestTimeoutSeconds: 600 });
  assert.deepEqual(store.saveSettings({ retentionDays: 7, maxRetries: 3, requestTimeoutSeconds: 720 }), { retentionDays: 7, maxRetries: 3, requestTimeoutSeconds: 720 });
  assert.deepEqual(store.saveSettings({ retentionDays: 14 }), { retentionDays: 14, maxRetries: 3, requestTimeoutSeconds: 720 });
  store.db.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)').run('expired-hash', Date.now() - 1000);
  store.db.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)').run('active-hash', Date.now() + 60_000);
  store.close();
  store = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  assert.deepEqual(store.settings(), { retentionDays: 14, maxRetries: 3, requestTimeoutSeconds: 720 });
  assert.equal(store.db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get('expired-hash'), undefined);
  assert.equal(store.db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get('active-hash')?.token_hash, 'active-hash');
  store.db.prepare("UPDATE settings SET data = ? WHERE id = 'global'").run(JSON.stringify({ retentionDays: -1, maxRetries: 999 }));
  assert.deepEqual(store.settings(), { retentionDays: 30, maxRetries: 5, requestTimeoutSeconds: 600 });
});

test('CloudStore rotates only administrator sessions while preserving encrypted API keys, configuration, and historical records', (t) => {
  const mock = mockStorage(t);
  let store = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  const savedProvider = provider(store);
  store.put('providers', savedProvider);
  store.put('models', model());
  store.put('prompts', prompt());
  store.put('schedules', schedule());
  store.put('runs', run());
  store.saveSettings({ retentionDays: 7, maxRetries: 3 });
  store.db.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)').run('before-password-change', Date.now() + 60_000);
  const versionBefore = store.db.prepare('SELECT data FROM cloud_auth_state WHERE id = ?').get('admin_token_version')!.data;
  const snapshot = Object.fromEntries(['providers', 'models', 'prompts', 'schedules', 'runs', 'settings'].map(table =>
    [table, store.db.prepare(`SELECT * FROM ${table}`).all()]));
  store.close();
  const nextToken = 'synthetic-rotated-cloud-admin-token';
  store = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: nextToken });
  assert.equal(store.adminToken, nextToken);
  assert.deepEqual(store.db.prepare('SELECT * FROM sessions').all(), []);
  const versionAfter = store.db.prepare('SELECT data FROM cloud_auth_state WHERE id = ?').get('admin_token_version')!.data;
  assert.notEqual(versionAfter, versionBefore);
  assert.ok(!String(versionAfter).includes(nextToken), 'The password version must not store the password');
  assert.ok(!String(versionBefore).includes(ADMIN_TOKEN));
  for (const [table, rows] of Object.entries(snapshot)) assert.deepEqual(store.db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
  assert.equal(store.get<StoredProvider>('providers', savedProvider.id)!.encryptedApiKey, savedProvider.encryptedApiKey);
  assert.equal(store.decrypt(savedProvider.encryptedApiKey), API_KEY);
  store.db.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)').run('after-password-change', Date.now() + 60_000);
  store.close();
  store = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: nextToken });
  assert.equal(store.db.prepare('SELECT token_hash FROM sessions').get()?.token_hash, 'after-password-change');
  assert.equal(store.db.prepare('SELECT data FROM cloud_auth_state WHERE id = ?').get('admin_token_version')!.data, versionAfter);
});

test('CloudStore first password-version initialization revokes legacy sessions without deleting configuration', (t) => {
  const mock = mockStorage(t);
  const legacy = new Store({ database: new DurableObjectDatabase(mock.storage), transaction: mock.transaction,
    encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  const savedProvider = provider(legacy);
  legacy.put('providers', savedProvider);
  legacy.db.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)').run('legacy-session', Date.now() + 60_000);
  const store = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  assert.deepEqual(store.db.prepare('SELECT * FROM sessions').all(), []);
  assert.ok(store.db.prepare('SELECT data FROM cloud_auth_state WHERE id = ?').get('admin_token_version'));
  assert.equal(store.get<StoredProvider>('providers', savedProvider.id)!.encryptedApiKey, savedProvider.encryptedApiKey);
  assert.equal(store.decrypt(savedProvider.encryptedApiKey), API_KEY);
});

test('injected encryption survives reconstruction and rejects invalid secrets before executing SQL', (t) => {
  const mock = mockStorage(t);
  for (const length of [0, 31, 33]) {
    assert.throws(() => new CloudStore(mock.storage, { encryptionKey: new Uint8Array(length), adminToken: ADMIN_TOKEN }));
  }
  assert.throws(() => new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: '' }));
  assert.equal(mock.statements.length, 0, 'Invalid construction options must not mutate storage');
  const key = Uint8Array.from(ENCRYPTION_KEY);
  const first = new CloudStore(mock.storage, { encryptionKey: key, adminToken: 'x' });
  assert.equal(first.adminToken, 'x', 'Store compatibility accepts any nonempty token');
  const encrypted = first.encrypt(API_KEY);
  assert.ok(!encrypted.includes(API_KEY));
  assert.notEqual(first.encrypt(API_KEY), encrypted, 'AES-GCM encryption should use a fresh IV');
  key.fill(255);
  assert.equal(first.decrypt(encrypted), API_KEY, 'Mutating caller key bytes must not mutate the Store key');
  first.put('providers', { ...provider(first), encryptedApiKey: encrypted });
  first.close();
  const restored = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  assert.equal(restored.decrypt(restored.get<StoredProvider>('providers', 'provider-one')!.encryptedApiKey), API_KEY);
  assert.equal(restored.encrypt(''), '');
  assert.equal(restored.decrypt(''), '');
  const wrongKey = new CloudStore(mock.storage, { encryptionKey: new Uint8Array(32).fill(200), adminToken: ADMIN_TOKEN });
  assert.throws(() => wrongKey.decrypt(encrypted));
});

test('CloudStore persists only run metadata and DTOs exclude private and future internal fields', (t) => {
  const mock = mockStorage(t);
  const store = new CloudStore(mock.storage, { encryptionKey: ENCRYPTION_KEY, adminToken: ADMIN_TOKEN });
  const secretProvider = { ...provider(store), apiKeyPreview: 'must-not-persist-preview', futurePrivate: 'private-provider-marker' };
  store.put('providers', secretProvider);
  const text = 'CLOUDFLARE_BODY_SENTINEL_50d7fdb2';
  const privateRef = { storage: 's3' as const, key: 'private-cloud-object-key', configId: 'private-config-id', sizeBytes: 20 };
  const storedRun = { ...run(), output: text, html: `<svg><text>${text}</text></svg>`, reasoning: `${text} 推理`,
    artifact: privateRef, pendingArtifactDeletes: [privateRef], futurePrivate: 'private-run-marker',
    parameters: { ...run().parameters, apiKey: 'private-nested-key' } };
  store.put('runs', storedRun);
  const persisted = store.get<StoredRun>('runs', storedRun.id)!;
  assert.equal(persisted.output, '');
  assert.equal(persisted.html, '');
  assert.equal(persisted.reasoning, '');
  assert.equal(persisted.artifact?.key, privateRef.key, 'Private cleanup references must remain available internally');
  const rows = [...store.db.prepare('SELECT data FROM runs').all(), ...store.db.prepare('SELECT data FROM providers').all()];
  assert.ok(!JSON.stringify(rows).includes(text));
  assert.ok(!JSON.stringify(rows).includes(API_KEY));
  assert.ok(!JSON.stringify(rows).includes('must-not-persist-preview'));
  const safeProvider = providerDto(secretProvider, store);
  assert.equal(safeProvider.hasApiKey, true);
  assert.ok(safeProvider.apiKeyPreview);
  assert.equal('encryptedApiKey' in safeProvider, false);
  assert.equal('futurePrivate' in safeProvider, false);
  assert.ok(!JSON.stringify(safeProvider).includes(API_KEY));
  const safeRun = runDto(storedRun);
  for (const value of [text, privateRef.key, privateRef.configId, 'private-run-marker', 'private-nested-key', 'private-ciphertext']) {
    assert.ok(!JSON.stringify(safeRun).includes(value));
  }
  assert.equal('artifact' in safeRun, false);
  assert.equal('pendingArtifactDeletes' in safeRun, false);
  assert.equal('execution' in safeRun, false);
});

test('the original filesystem Store constructor still preserves its generated encryption key', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-store-compat-'));
  let store: Store | undefined;
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = new Store(directory, ADMIN_TOKEN);
  const encrypted = store.encrypt(API_KEY);
  store.put('providers', { ...provider(store), encryptedApiKey: encrypted });
  store.close();
  store = new Store(directory, ADMIN_TOKEN);
  assert.equal(store.adminToken, ADMIN_TOKEN);
  assert.equal(store.decrypt(store.get<StoredProvider>('providers', 'provider-one')!.encryptedApiKey), API_KEY);
});
