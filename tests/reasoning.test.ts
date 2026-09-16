import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { ArtifactStore } from '../server/artifacts.ts';
import { RunQueue } from '../server/queue.ts';
import { Store, type ExecutionSnapshot, type StoredProvider, type StoredRun } from '../server/store.ts';
import { callUpstream } from '../server/upstream.ts';
import { REASONING_EFFORTS, normalizeReasoningEffort } from '../shared/reasoning.ts';
import type { Model, Prompt } from '../shared/types.ts';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('model configuration accepts only the five supported levels and defaults missing effort to medium', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reasoning-api-'));
  const application = createApp({ dataDir, adminToken: 'test-reasoning-admin', seed: false });
  const server = createServer(application.app);
  const url = await listen(server);
  t.after(async () => { await application.close(); await closeServer(server); await rm(dataDir, { recursive: true, force: true }); });
  let cookie = '';
  const request = (path: string, method: string, body: unknown) => fetch(`${url}${path}`, {
    method, headers: { Origin: url, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const login = await request('/api/auth/login', 'POST', { token: 'test-reasoning-admin' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const providerResponse = await request('/api/admin/providers', 'POST', { name: '测试接口', baseUrl: url, protocol: 'responses' });
  assert.equal(providerResponse.status, 201);
  const { provider } = await providerResponse.json();
  const input = { providerId: provider.id, name: '测试模型', modelId: 'mock' };
  const created = await request('/api/admin/models', 'POST', input);
  assert.equal(created.status, 201);
  const { model } = await created.json();
  assert.equal(model.reasoningEffort, 'medium');
  for (const reasoningEffort of REASONING_EFFORTS) {
    const response = await request(`/api/admin/models/${model.id}`, 'PUT', { ...input, reasoningEffort });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model.reasoningEffort, reasoningEffort);
  }
  for (const reasoningEffort of ['minimal', 'none', '', 'custom', ' high ', null, 1]) {
    for (const [path, method] of [['/api/admin/models', 'POST'], [`/api/admin/models/${model.id}`, 'PUT']]) {
      const response = await request(path!, method!, { ...input, reasoningEffort });
      assert.equal(response.status, 400, `${method} must reject ${JSON.stringify(reasoningEffort)}`);
      assert.match((await response.json()).error, /reasoningEffort/);
    }
  }
});

test('both upstream protocols send exactly supported levels and normalize stale execution snapshots', async t => {
  const received: { path: string; body: Record<string, any> }[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    received.push({ path: request.url!, body: JSON.parse(text) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/responses'
      ? { status: 'completed', output_text: '完成' }
      : { choices: [{ message: { content: '完成' } }] }));
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  const cases: [unknown, string][] = [
    ...REASONING_EFFORTS.map(value => [value, value] as [unknown, string]),
    ['minimal', 'low'], ['none', 'low'], ['', 'medium'], [undefined, 'medium'], ['custom', 'medium'], [null, 'medium'],
  ];
  for (const protocol of ['responses', 'chat-completions'] as const) {
    for (const [input, expected] of cases) {
      const snapshot: ExecutionSnapshot = { providerId: 'provider', baseUrl, encryptedApiKey: '', protocol,
        modelId: 'mock', maxTokens: 32, reasoningEffort: input as string };
      const result = await callUpstream(snapshot, '原始提示词', '', new AbortController().signal);
      assert.equal(result.error, '');
      const { path, body } = received.at(-1)!;
      assert.equal(path, protocol === 'responses' ? '/responses' : '/chat/completions');
      if (protocol === 'responses') {
        assert.deepEqual(body.reasoning, { effort: expected });
        assert.equal('reasoning_effort' in body, false);
      } else {
        assert.equal(body.reasoning_effort, expected);
        assert.equal('reasoning' in body, false);
      }
      assert.equal(snapshot.reasoningEffort, input, 'Sending must not mutate a historical snapshot');
    }
  }
});

test('legacy models migrate on startup while retry normalizes only the new run and preserves original failure evidence', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reasoning-migration-'));
  let store = new Store(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const stamp = new Date().toISOString();
  const model: Model = { id: 'model', providerId: 'provider', name: '模型', modelId: 'mock', enabled: true,
    maxTokens: 32, reasoningEffort: 'minimal', createdAt: stamp };
  const provider: StoredProvider = { id: 'provider', name: '接口', baseUrl: 'http://127.0.0.1:1', protocol: 'responses',
    enabled: true, encryptedApiKey: '', createdAt: stamp };
  const prompt: Prompt = { id: 'prompt', title: '推理', description: '', category: 'reasoning', content: '回答',
    referenceAnswer: '', rubric: '', tags: [], enabled: true, createdAt: stamp, updatedAt: stamp };
  let artifacts = new ArtifactStore(store);
  let queue = new RunQueue(store, 1000, 1, Date.now, artifacts);
  const initial = queue.create(prompt, model, provider, 'batch');
  assert.equal(initial.parameters.reasoningEffort, 'low');
  assert.equal(initial.execution!.reasoningEffort, 'low');
  const legacy: StoredRun = { ...initial, status: 'failed', error: 'HTTP 400: minimal not supported',
    parameters: { ...initial.parameters, reasoningEffort: 'minimal' }, execution: { ...initial.execution!, reasoningEffort: 'minimal' } };
  store.put('runs', legacy);
  // Insert raw legacy models to exercise persisted startup migration, not the write guard.
  for (const [id, effort] of [['model', 'minimal'], ['none-model', 'none'], ['empty-model', ''], ['old-model', 'custom']]) {
    store.db.prepare('INSERT INTO models(id, data) VALUES (?, ?)').run(id!, JSON.stringify({ ...model, id, reasoningEffort: effort }));
  }
  await queue.close(); await artifacts.close(); store.close();
  store = new Store(dataDir);
  artifacts = new ArtifactStore(store);
  queue = new RunQueue(store, 1000, 1, Date.now, artifacts);
  t.after(async () => { await queue.close(); await artifacts.close(); });
  for (const [id, expected] of [['model', 'low'], ['none-model', 'low'], ['empty-model', 'medium'], ['old-model', 'medium']]) {
    assert.equal(store.get<Model>('models', id!)!.reasoningEffort, expected);
    const persisted = store.db.prepare('SELECT data FROM models WHERE id = ?').get(id!)!;
    assert.equal(JSON.parse(persisted.data as string).reasoningEffort, expected);
  }
  const original = store.get<StoredRun>('runs', legacy.id)!;
  assert.equal(original.parameters.reasoningEffort, 'minimal');
  assert.equal(original.execution!.reasoningEffort, 'minimal');
  const next = queue.retry(original);
  assert.notEqual(next.id, original.id);
  assert.equal(next.parameters.reasoningEffort, 'low');
  assert.equal(next.execution!.reasoningEffort, 'low');
  assert.equal(next.status, 'queued');
  assert.equal(next.error, '');
  assert.deepEqual(store.get<StoredRun>('runs', legacy.id), original);
  assert.equal(original.execution!.reasoningEffort, 'minimal');
  assert.equal(original.parameters.reasoningEffort, 'minimal');
  assert.equal(original.error, 'HTTP 400: minimal not supported');
  for (const value of [undefined, '', 'custom']) assert.equal(normalizeReasoningEffort(value), 'medium');
});
