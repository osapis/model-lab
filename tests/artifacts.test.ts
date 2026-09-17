import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { ARTIFACT_MAX_BYTES, ArtifactStore, ArtifactWriteError, type ArtifactPayload, type ArtifactRef } from '../server/artifacts.ts';
import { Store } from '../server/store.ts';

const PAYLOAD: ArtifactPayload = { output: '正文唯一标记-output-测试', html: '<svg><text>鹈鹕</text></svg>', reasoning: '推理唯一标记-012345' };
const ACCESS_KEY = 'test-access-key-do-not-return';
const SECRET_KEY = 'test-secret-key-do-not-return';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-artifacts-'));
  let store = new Store(directory, 'test-admin-token');
  let artifacts = new ArtifactStore(store);
  t.after(async () => {
    await artifacts.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, get store() { return store; }, get artifacts() { return artifacts; },
    async restart() {
      await artifacts.close();
      store.close();
      store = new Store(directory, 'test-admin-token');
      artifacts = new ArtifactStore(store);
    },
  };
}

async function mockS3(t: TestContext) {
  const objects = new Map<string, Buffer>();
  const requests: { method: string; path: string; authorization: string }[] = [];
  let failure: 'none' | 'forbidden' | 'large' | 'invalid' | 'put-drop' | 'put-hold' | 'delete-forbidden' = 'none';
  const releasePuts: (() => void)[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    const method = request.method!;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ method, path, authorization: request.headers.authorization || '' });
    if (failure === 'forbidden' || (failure === 'delete-forbidden' && method === 'DELETE')) {
      response.writeHead(403, { 'Content-Type': 'application/xml' });
      response.end(`<Error><Code>AccessDenied</Code><Message>${ACCESS_KEY} ${SECRET_KEY}</Message></Error>`);
    } else if (method === 'PUT') {
      objects.set(path, Buffer.concat(chunks));
      if (failure === 'put-drop') { response.destroy(); return; }
      if (failure === 'put-hold') await new Promise<void>(resolve => releasePuts.push(resolve));
      response.writeHead(200, { ETag: '"mock-etag"' });
      response.end();
    } else if (method === 'DELETE') {
      objects.delete(path);
      response.writeHead(204);
      response.end();
    } else if (method === 'GET' && failure === 'large') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(ARTIFACT_MAX_BYTES + 1) });
      response.end('{}');
    } else if (method === 'GET' && failure === 'invalid') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(`invalid ${SECRET_KEY}`);
    } else if (method === 'GET' && objects.has(path)) {
      const body = objects.get(path)!;
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.byteLength });
      response.end(body);
    } else {
      response.writeHead(404, { 'Content-Type': 'application/xml' });
      response.end('<Error><Code>NoSuchKey</Code><Message>Missing artifact</Message></Error>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return {
    endpoint: `http://127.0.0.1:${address.port}`, objects, requests,
    fail(mode: typeof failure) { failure = mode; },
    releasePuts() { for (const release of releasePuts.splice(0)) release(); },
  };
}

test('default memory storage never persists bodies and restart makes missing bodies explicit', async t => {
  const f = await fixture(t);
  assert.equal(f.artifacts.status().mode, 'memory');
  assert.equal(f.artifacts.status().memoryLimitMb, 64);
  const payload = { ...PAYLOAD };
  const ref = await f.artifacts.put('memory-run', payload);
  payload.output = 'caller mutation';
  assert.equal(ref.storage, 'memory');
  assert.equal(f.artifacts.availability(ref), true);
  assert.deepEqual(await f.artifacts.get(ref), PAYLOAD);
  for (const file of await readdir(f.directory)) {
    const bytes = await readFile(join(f.directory, file));
    for (const value of Object.values(PAYLOAD)) assert.equal(bytes.includes(Buffer.from(value)), false, `${file} contains a generated body`);
  }
  await f.restart();
  assert.equal(f.artifacts.availability(ref), false);
  assert.equal(await f.artifacts.get(ref), null);
  assert.equal(f.artifacts.status().memoryUsedMb, 0);
});

test('memory FIFO stays within 64 MB, preserves recent bodies and rejects oversized data', async t => {
  const f = await fixture(t);
  const refs: ArtifactRef[] = [];
  const large = { output: 'a'.repeat(11 * 1024 * 1024), html: '', reasoning: '' };
  for (let i = 0; i < 6; i++) refs.push(await f.artifacts.put(`run-${i}`, large));
  assert.equal(f.artifacts.availability(refs[0]!), false);
  assert.equal(await f.artifacts.get(refs[0]!), null);
  assert.equal(f.artifacts.availability(refs[1]!), true);
  assert.equal((await f.artifacts.get(refs[5]!))?.output.length, large.output.length);
  assert.ok(f.artifacts.status().memoryUsedMb <= 64);
  await f.artifacts.delete(refs[5]!);
  await f.artifacts.delete(refs[5]!);
  assert.equal(f.artifacts.availability(refs[5]!), false);
  await assert.rejects(f.artifacts.put('too-large', { ...PAYLOAD, output: 'x'.repeat(ARTIFACT_MAX_BYTES) }), /12 MB/);
  await assert.rejects(f.artifacts.put('utf8-size', { ...PAYLOAD, output: '糖'.repeat(5 * 1024 * 1024) }), /12 MB/);
});

test('disk storage writes bodies under DATA_DIR and survives restart', async t => {
  const f = await fixture(t);
  f.artifacts.configure({ mode: 'disk', prefix: 'generated/results' });
  assert.equal(f.artifacts.status().mode, 'disk');
  assert.equal(f.artifacts.status().memoryLimitMb, 0);
  const ref = await f.artifacts.put('disk-run', PAYLOAD);
  assert.equal(ref.storage, 'disk');
  const file = join(f.directory, 'artifacts', ...ref.key.split('/'));
  assert.deepEqual(JSON.parse((await readFile(file)).toString('utf8')), PAYLOAD);
  assert.deepEqual(await f.artifacts.get(ref), PAYLOAD);
  await f.restart();
  const restored = await f.artifacts.get(ref);
  assert.deepEqual(restored, PAYLOAD);
  await f.artifacts.delete(ref);
  await assert.rejects(readFile(file), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('S3 configuration is encrypted, blank keys preserve secrets and historic configurations keep working', async t => {
  const mock = await mockS3(t);
  const f = await fixture(t);
  const firstStatus = f.artifacts.configure({ mode: 's3', endpoint: mock.endpoint, bucket: 'first-bucket',
    prefix: '/history/', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
  assert.equal(firstStatus.hasAccessKeyId, true);
  assert.equal(firstStatus.hasSecretAccessKey, true);
  assert.equal(firstStatus.prefix, 'history');
  assert.ok(!JSON.stringify(firstStatus).includes(ACCESS_KEY));
  assert.ok(!JSON.stringify(firstStatus).includes(SECRET_KEY));
  const first = await f.artifacts.put('first', PAYLOAD);
  assert.equal(first.storage, 's3');
  assert.equal(f.artifacts.availability(first), null);
  assert.deepEqual(await f.artifacts.get(first), PAYLOAD);
  f.artifacts.configure({ mode: 's3', bucket: 'second-bucket', accessKeyId: ' ', secretAccessKey: '' });
  const second = await f.artifacts.put('second', { ...PAYLOAD, output: 'second artifact' });
  assert.notEqual(first.configId, second.configId);
  assert.ok(mock.requests.filter(item => item.method === 'PUT').every(item => item.authorization.includes(`Credential=${ACCESS_KEY}/`)));
  f.artifacts.configure({ mode: 'memory' });
  assert.equal((await f.artifacts.put('third', PAYLOAD)).storage, 'memory');
  const sample = f.artifacts.putMemory('sample', PAYLOAD);
  assert.equal(sample.storage, 'memory');
  for (const row of f.store.db.prepare('SELECT data FROM artifact_configs').all()) {
    const encrypted = String(row.data);
    assert.ok(!encrypted.includes(ACCESS_KEY));
    assert.ok(!encrypted.includes(SECRET_KEY));
    assert.ok(!encrypted.includes(mock.endpoint));
  }
  for (const file of await readdir(f.directory)) {
    const bytes = await readFile(join(f.directory, file));
    for (const value of [ACCESS_KEY, SECRET_KEY, ...Object.values(PAYLOAD)]) assert.equal(bytes.includes(Buffer.from(value)), false, `${file} leaks secret or output`);
  }
  await f.restart();
  assert.equal(f.artifacts.status().mode, 'memory');
  assert.deepEqual(await f.artifacts.get(first), PAYLOAD);
  assert.equal((await f.artifacts.get(second))?.output, 'second artifact');
  await f.artifacts.delete(first);
  assert.equal(await f.artifacts.get(first), null);
  await f.artifacts.delete(first);
  assert.equal((await f.artifacts.get(second))?.output, 'second artifact');
});

test('S3 connection test verifies write/read/delete and samples can stay in memory while S3 is active', async t => {
  const mock = await mockS3(t);
  const f = await fixture(t);
  f.artifacts.configure({ mode: 's3', endpoint: mock.endpoint, bucket: 'test-bucket', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
  const sample = f.artifacts.putMemory('sample', PAYLOAD);
  assert.deepEqual(await f.artifacts.get(sample), PAYLOAD);
  assert.equal(mock.requests.length, 0);
  await f.artifacts.test();
  assert.deepEqual(mock.requests.map(item => item.method), ['PUT', 'GET', 'DELETE']);
  assert.equal(mock.objects.size, 0);
});

test('S3 failures are explicit and redact credentials without local fallback', async t => {
  const mock = await mockS3(t);
  const f = await fixture(t);
  f.artifacts.configure({ mode: 's3', endpoint: mock.endpoint, bucket: 'test-bucket', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
  const ref = await f.artifacts.put('failure-test', PAYLOAD);
  const checkError = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /对象存储/);
    assert.ok(!error.message.includes(ACCESS_KEY));
    assert.ok(!error.message.includes(SECRET_KEY));
    return true;
  };
  mock.fail('forbidden');
  const before = mock.requests.length;
  await assert.rejects(f.artifacts.put('rejected', PAYLOAD), checkError);
  assert.equal(mock.requests.length, before + 1, 'do not automatically retry failed writes');
  assert.equal(f.artifacts.status().memoryUsedMb, 0, 'failed S3 writes must not silently fall back to memory');
  await assert.rejects(f.artifacts.get(ref), checkError);
  await assert.rejects(f.artifacts.delete(ref), checkError);
  await assert.rejects(f.artifacts.test(), checkError);
  mock.fail('large');
  await assert.rejects(f.artifacts.get(ref), checkError);
  mock.fail('invalid');
  await assert.rejects(f.artifacts.get(ref), checkError);
  mock.fail('none');
  assert.deepEqual(await f.artifacts.get(ref), PAYLOAD);
});

test('unsafe or incomplete storage settings are rejected without changing active configuration', async t => {
  const f = await fixture(t);
  const initial = f.artifacts.status();
  for (const endpoint of ['https://user:password@example.com', 'https://example.com?token=secret',
    'https://example.com#secret', 'http://remote.example.com', 'file:///tmp/storage']) {
    assert.throws(() => f.artifacts.configure({ mode: 's3', endpoint, bucket: 'bucket', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }), /Endpoint/);
  }
  assert.throws(() => f.artifacts.configure({ mode: 's3', endpoint: 'https://example.com' }), /完整配置/);
  assert.throws(() => f.artifacts.configure({ mode: 'memory', prefix: '../other-app' }), /Prefix/);
  assert.deepEqual(f.artifacts.status(), initial);
});

test('write-ahead journal protects active uploads and preserves durable run references after a crash', async t => {
  const mock = await mockS3(t);
  const f = await fixture(t);
  f.artifacts.configure({ mode: 's3', endpoint: mock.endpoint, bucket: 'test-bucket', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
  mock.fail('put-hold');
  const uploading = f.artifacts.put('active-upload', PAYLOAD);
  const deadline = Date.now() + 2_000;
  while (mock.requests.length === 0 && Date.now() < deadline) await delay(5);
  assert.equal(mock.requests.length, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 1);
  await f.artifacts.cleanupPending(() => false);
  assert.equal(mock.requests.filter(item => item.method === 'DELETE').length, 0, 'an in-flight PUT must not be deleted');
  mock.releasePuts();
  const saved = await uploading;
  mock.fail('none');
  await f.restart();
  await f.artifacts.cleanupPending(ref => ref.key === saved.key && ref.configId === saved.configId);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 0);
  assert.deepEqual(await f.artifacts.get(saved), PAYLOAD, 'a run reference that was saved before restart protects the body');
  const orphan = await f.artifacts.put('crash-before-run-save', PAYLOAD);
  await f.restart();
  await f.artifacts.cleanupPending(() => false);
  assert.equal(await f.artifacts.get(orphan), null, 'successful PUT with no saved run is removed after restart');
  assert.deepEqual(await f.artifacts.get(saved), PAYLOAD);
  const acknowledged = await f.artifacts.put('saved-and-acked', PAYLOAD);
  f.artifacts.ack(acknowledged);
  await f.artifacts.cleanupPending(() => false);
  assert.deepEqual(await f.artifacts.get(acknowledged), PAYLOAD);
});

test('a PUT that succeeds remotely but loses its response keeps a durable key for cleanup retries', async t => {
  const mock = await mockS3(t);
  const f = await fixture(t);
  f.artifacts.configure({ mode: 's3', endpoint: mock.endpoint, bucket: 'test-bucket', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
  mock.fail('put-drop');
  let uncertain: ArtifactRef | undefined;
  await assert.rejects(f.artifacts.put('response-lost', PAYLOAD), error => {
    assert.ok(error instanceof ArtifactWriteError);
    uncertain = error.ref;
    return true;
  });
  assert.ok(uncertain);
  assert.equal(mock.objects.size, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 1);
  mock.fail('delete-forbidden');
  await f.artifacts.cleanupPending(() => false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 1, 'failed delete must keep its reference');
  await f.restart();
  mock.fail('none');
  await f.artifacts.cleanupPending(() => false);
  assert.equal(mock.objects.size, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 0);
  assert.equal(await f.artifacts.get(uncertain), null);
});

test('connection-test temporary objects retain cleanup references when delete permission fails', async t => {
  const mock = await mockS3(t);
  const f = await fixture(t);
  f.artifacts.configure({ mode: 's3', endpoint: mock.endpoint, bucket: 'test-bucket', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
  mock.fail('delete-forbidden');
  await assert.rejects(f.artifacts.test(), /临时对象清理失败/);
  assert.equal(mock.objects.size, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 1);
  await f.restart();
  mock.fail('none');
  await f.artifacts.cleanupPending(() => false);
  assert.equal(mock.objects.size, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM artifact_pending').get()!.count, 0);
});
