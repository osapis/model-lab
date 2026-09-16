import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { CloudStore, type DurableSqlStorage } from '../cloudflare/store.ts';
import { CloudflareArtifactStore, CloudflareArtifactWriteError, CLOUDFLARE_ARTIFACT_CHUNK_BYTES, CLOUDFLARE_ARTIFACT_MAX_BYTES, type NativeR2Bucket } from '../cloudflare/artifacts.ts';
import { ArtifactStore, ARTIFACT_MAX_BYTES, type ArtifactPayload, type ArtifactRef } from '../server/artifacts.ts';
import { exportConfig, importConfig, previewConfig } from '../server/config-backup.ts';

const payload: ArtifactPayload = { output: '完整测试回答', html: '<svg><text>鹈鹕骑自行车</text></svg>', reasoning: '测试推理' };

function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(query: string, ...parameters: (string | number | null | ArrayBuffer)[]) {
      if (query.split(';').filter(part => part.trim()).length > 1) { database.exec(query); return { toArray: () => [] }; }
      const statement = database.prepare(query);
      const args = parameters.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      if (!statement.columns().length) { statement.run(...args); return { toArray: () => [] }; }
      const rows = statement.all(...args);
      return { toArray: () => rows };
    } },
    transactionSync<T>(callback: () => T): T {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  } as unknown as DurableSqlStorage;
  const store = new CloudStore(storage, { encryptionKey: new Uint8Array(32).fill(7), adminToken: 'test-cloud-admin' });
  t.after(() => database.close());
  return { store, database };
}

class FakeBucket implements NativeR2Bucket {
  objects = new Map<string, Uint8Array>();
  deleteFailure = false;
  dropResponse = false;
  delayWrite = false;
  releaseWrite?: () => void;
  async put(key: string, body: Uint8Array) {
    if (this.delayWrite) await new Promise<void>(resolve => { this.releaseWrite = resolve; });
    this.objects.set(key, body.slice());
    if (this.dropResponse) throw new Error('sensitive remote error must not be returned');
    return { key, size: body.byteLength };
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) return null;
    return { size: body.byteLength, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body); controller.close(); } }) };
  }
  async delete(key: string) {
    if (this.deleteFailure) throw new Error('sensitive remote delete error');
    this.objects.delete(key);
  }
}

test('cloud SQLite bodies persist in bounded chunks and remain readable after recreation', async t => {
  const { store } = fixture(t);
  let artifacts = new CloudflareArtifactStore(store);
  assert.equal(artifacts.status().mode, 'cloudflare');
  assert.equal(artifacts.status().backend, 'durable-sqlite');
  assert.equal(artifacts.status().memoryLimitMb, 0);
  const large = { ...payload, output: '糖果'.repeat(150_000) };
  const ref = await artifacts.put('sqlite-run', large);
  artifacts.ack(ref);
  assert.equal(ref.storage, 'cloudflare');
  assert.equal(ref.configId, 'cloudflare-sqlite');
  const stats = store.db.prepare('SELECT COUNT(*) AS count, MAX(length(data)) AS maximum FROM cloud_artifact_chunks').get()!;
  assert.ok(Number(stats.count) > 1);
  assert.ok(Number(stats.maximum) <= CLOUDFLARE_ARTIFACT_CHUNK_BYTES);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM runs').get()!.count, 0, 'generated bodies do not enter run metadata');
  await artifacts.close();
  artifacts = new CloudflareArtifactStore(store);
  assert.deepEqual(await artifacts.get(ref), large);
  artifacts.configure({ mode: 'cloudflare', prefix: 'new-prefix' });
  assert.deepEqual(await artifacts.get(ref), large, 'changing prefixes does not move historical bodies');
  await artifacts.delete(ref);
  await artifacts.delete(ref);
  assert.equal(await artifacts.get(ref), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM cloud_artifact_chunks').get()!.count, 0);
});

test('cloud chunks roll back atomically and only cloud stores can activate this backend', async t => {
  const { store } = fixture(t);
  assert.throws(() => new CloudflareArtifactStore({ db: store.db, transaction: callback => store.transaction(callback) }), /只能使用 Cloudflare/);
  const artifacts = new CloudflareArtifactStore(store, undefined, { orphanGraceMs: 0 });
  assert.throws(() => artifacts.putMemory('forbidden', payload), /不能暂存内存/);
  assert.throws(() => artifacts.configure({ mode: 'memory' }), /不能切换/);
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('INSERT INTO cloud_artifact_chunks')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { if (args[1] === 1) throw new Error('simulated mid-transaction failure'); return run(...args); };
    }
    return statement;
  };
  await assert.rejects(artifacts.put('rollback', { ...payload, output: 'x'.repeat(600_000) }), CloudflareArtifactWriteError);
  store.db.prepare = prepare;
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM cloud_artifact_objects').get()!.count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM cloud_artifact_chunks').get()!.count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 1);
  await artifacts.cleanupPending(() => false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 0);
});

test('body size and integrity checks reject oversized or incomplete cloud content', async t => {
  const { store } = fixture(t);
  const artifacts = new CloudflareArtifactStore(store);
  assert.equal(CLOUDFLARE_ARTIFACT_MAX_BYTES, ARTIFACT_MAX_BYTES);
  await assert.rejects(artifacts.put('oversized', { ...payload, output: 'x'.repeat(ARTIFACT_MAX_BYTES) }), /12 MB/);
  const ref = await artifacts.put('missing-chunk', payload);
  store.db.prepare('DELETE FROM cloud_artifact_chunks WHERE object_key = ?').run(ref.key);
  await assert.rejects(artifacts.get(ref), /正文完整性/);
  const foreign: ArtifactRef = { storage: 's3', configId: 'old-external-config', key: 'old-object', sizeBytes: 1 };
  await assert.rejects(artifacts.delete(foreign), /删除失败/);
});

test('binding R2 preserves previously saved SQLite bodies and deletes each backend correctly', async t => {
  const { store } = fixture(t);
  const sqlite = new CloudflareArtifactStore(store);
  const original = await sqlite.put('sqlite-original', payload);
  sqlite.ack(original);
  const bucket = new FakeBucket();
  const artifacts = new CloudflareArtifactStore(store, bucket);
  assert.equal(artifacts.status().backend, 'r2');
  const ref = await artifacts.put('r2-new', payload);
  artifacts.ack(ref);
  assert.equal(ref.configId, 'cloudflare-r2');
  assert.equal(bucket.objects.size, 1);
  assert.deepEqual(await artifacts.get(ref), payload);
  assert.deepEqual(await artifacts.get(original), payload);
  await artifacts.delete(original);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM cloud_artifact_chunks').get()!.count, 0);
  await artifacts.delete(ref);
  assert.equal(bucket.objects.size, 0);
});

test('uncertain R2 PUTs keep durable references and a cleanup grace period across recreation', async t => {
  const { store } = fixture(t);
  let now = 1_800_000_000_000;
  const bucket = new FakeBucket(); bucket.dropResponse = true;
  let artifacts = new CloudflareArtifactStore(store, bucket, { clock: () => now });
  let uncertain: ArtifactRef | undefined;
  await assert.rejects(artifacts.put('lost-response', payload), error => {
    assert.ok(error instanceof CloudflareArtifactWriteError);
    assert.ok(!error.message.includes('sensitive'));
    uncertain = error.ref; return true;
  });
  assert.ok(uncertain);
  artifacts.ack(uncertain);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 1, 'ack cannot discard an uncertain write');
  await assert.rejects(artifacts.delete(uncertain), /删除失败/);
  await artifacts.close();
  artifacts = new CloudflareArtifactStore(store, bucket, { clock: () => now });
  await artifacts.cleanupPending(() => false);
  assert.equal(bucket.objects.size, 1);
  now += 5 * 60_000 + 1;
  bucket.deleteFailure = true;
  await artifacts.cleanupPending(() => false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 1);
  bucket.deleteFailure = false;
  await artifacts.cleanupPending(() => false);
  assert.equal(bucket.objects.size, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 1, 'an unconfirmed PUT keeps a durable cleanup tombstone even after DELETE succeeds');
});

test('R2 timeout stays bounded and late success can be safely removed', async t => {
  const { store } = fixture(t);
  const bucket = new FakeBucket(); bucket.delayWrite = true;
  const artifacts = new CloudflareArtifactStore(store, bucket, { operationTimeoutMs: 10 });
  let ref: ArtifactRef | undefined;
  await assert.rejects(artifacts.put('late-upload', payload), error => { assert.ok(error instanceof CloudflareArtifactWriteError); ref = error.ref; return true; });
  assert.ok(ref);
  await assert.rejects(artifacts.delete(ref), /删除失败/);
  bucket.releaseWrite!();
  await new Promise(resolve => setTimeout(resolve, 0));
  await artifacts.delete(ref);
  assert.equal(bucket.objects.size, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 0);
});

test('cleanup tombstones survive DELETE before a timed-out PUT eventually completes', async t => {
  const { store } = fixture(t);
  let now = 1_800_000_000_000;
  const bucket = new FakeBucket(); bucket.delayWrite = true;
  let artifacts = new CloudflareArtifactStore(store, bucket, { clock: () => now, operationTimeoutMs: 10 });
  let ref: ArtifactRef | undefined;
  await assert.rejects(artifacts.put('write-after-delete', payload), error => { assert.ok(error instanceof CloudflareArtifactWriteError); ref = error.ref; return true; });
  assert.ok(ref);
  await artifacts.close();
  artifacts = new CloudflareArtifactStore(store, bucket, { clock: () => now, operationTimeoutMs: 10 });
  now += 5 * 60_000 + 1;
  await artifacts.delete(ref);
  assert.equal(bucket.objects.size, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 1);
  bucket.releaseWrite!();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(bucket.objects.size, 1, 'the delayed PUT can arrive after DELETE');
  await artifacts.cleanupPending(() => false);
  assert.equal(bucket.objects.size, 0, 'the retained tombstone must remove that delayed body');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 0);
});

test('cloud orphan cleanup limits each pass to the requested number of objects', async t => {
  const { store } = fixture(t);
  const artifacts = new CloudflareArtifactStore(store, undefined, { orphanGraceMs: 0 });
  for (let index = 0; index < 7; index++) await artifacts.put(`orphan-${index}`, payload);
  await artifacts.cleanupPending(() => false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM cloud_artifact_objects').get()!.count, 2);
  await artifacts.cleanupPending(() => false, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM cloud_artifact_objects').get()!.count, 1);
  await artifacts.cleanupPending(() => false, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM cloud_artifact_objects').get()!.count, 1);
});

test('R2 read timeouts and close cancel body streams including a late GET response', async t => {
  const { store } = fixture(t);
  let cancelled = 0;
  const body = () => new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const bucket: NativeR2Bucket = {
    put: async () => null, delete: async () => {}, get: async () => ({ size: 8, body: body() }),
  };
  const ref: ArtifactRef = { storage: 'cloudflare', configId: 'cloudflare-r2', key: 'hanging', sizeBytes: 8 };
  let artifacts = new CloudflareArtifactStore(store, bucket, { operationTimeoutMs: 10 });
  await assert.rejects(artifacts.get(ref), /读取失败/);
  assert.equal(cancelled, 1);
  await artifacts.close();
  artifacts = new CloudflareArtifactStore(store, bucket, { operationTimeoutMs: 1_000 });
  const reading = assert.rejects(artifacts.get(ref), /读取失败/);
  await new Promise(resolve => setTimeout(resolve, 0));
  await artifacts.close(); await reading;
  assert.equal(cancelled, 2);
  let respond: (() => void) | undefined;
  bucket.get = async () => { await new Promise<void>(resolve => { respond = resolve; }); return { size: 8, body: body() }; };
  artifacts = new CloudflareArtifactStore(store, bucket, { operationTimeoutMs: 10 });
  await assert.rejects(artifacts.get(ref), /读取失败/);
  respond!();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, 3, 'a body that arrives after the timeout is cancelled before allocation');
  await artifacts.close();
});

test('cloud connection checks remove temporary objects and retry failed cleanup', async t => {
  const { store } = fixture(t);
  const sqlite = new CloudflareArtifactStore(store);
  await sqlite.test();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM cloud_artifact_objects').get()!.count, 0);
  const bucket = new FakeBucket();
  const artifacts = new CloudflareArtifactStore(store, bucket, { orphanGraceMs: 0 });
  bucket.deleteFailure = true;
  await assert.rejects(artifacts.test(), /临时正文清理失败/);
  assert.equal(bucket.objects.size, 1);
  bucket.deleteFailure = false;
  await artifacts.cleanupPending(() => false);
  assert.equal(bucket.objects.size, 0);
});

test('native cloud configuration backups preserve the target backend and transactional prefixes', async t => {
  const source = fixture(t), target = fixture(t);
  const artifacts = new CloudflareArtifactStore(source.store);
  artifacts.configure({ mode: 'cloudflare', prefix: 'exported' });
  const backup = await exportConfig(source.store, artifacts, 'test-backup-password');
  assert.equal((await previewConfig('test-backup-password', backup)).preview.storageMode, 'cloudflare');
  const bucket = new FakeBucket(), receiving = new CloudflareArtifactStore(target.store, bucket);
  await importConfig(target.store, receiving, 'test-backup-password', backup);
  assert.equal(receiving.status().backend, 'r2');
  assert.equal(receiving.status().prefix, 'exported');
  const previous = receiving.status();
  assert.throws(() => target.store.transaction(() => { receiving.importConfigurationInTransaction({ mode: 'cloudflare', driver: 'cloudflare-binding', prefix: 'rolled-back' }); throw new Error('rollback'); }));
  assert.deepEqual(receiving.status(), previous);
  assert.throws(() => receiving.configure({ mode: 'cloudflare', secretAccessKey: 'do-not-accept' }), /部署绑定/);
  assert.throws(() => receiving.configure({ mode: 'cloudflare', prefix: '../escape' }), /相对路径/);
  const nodeArtifacts = new ArtifactStore(target.store);
  const nodeStatus = nodeArtifacts.status();
  await importConfig(target.store, nodeArtifacts, 'test-backup-password', backup);
  assert.deepEqual(nodeArtifacts.status(), nodeStatus, 'a Node installation imports cloud configuration without replacing its own storage');
});
