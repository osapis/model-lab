import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import { discoverModels, ModelDiscoveryError } from '../server/upstream.ts';
import type { AdminData, Model, Prompt, Provider, PublicData, Run, Schedule } from '../shared/types.ts';
import { runResultTime } from '../shared/run-time.ts';

const ADMIN_TOKEN = 'test-admin-token-value';
const API_KEY = 'sk-test-provider-secret-never-public';
type AppOptions = Parameters<typeof createApp>[0];

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function fixture(t: TestContext, options: AppOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'model-lab-test-'));
  let application = createApp({ dataDir, adminToken: ADMIN_TOKEN, seed: false, ...options });
  let server = createServer(application.app);
  let url = await listen(server);
  let cookie = '';
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await application.close();
    await closeServer(server);
  };
  t.after(async () => {
    try { await stop(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        Origin: url,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  };
  const json = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await request(path, method, body);
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };
  const login = async () => {
    const response = await request('/api/auth/login', 'POST', { token: ADMIN_TOKEN });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.ok(setCookie.includes('model_lab_session='));
    assert.match(setCookie, /HttpOnly/i);
    cookie = setCookie.split(';')[0]!;
    return setCookie;
  };
  const restart = async () => {
    await stop();
    application = createApp({ dataDir, adminToken: ADMIN_TOKEN, seed: false, ...options });
    server = createServer(application.app);
    url = await listen(server);
    cookie = '';
    stopped = false;
    await login();
  };
  return { dataDir, request, json, login, stop, restart, url: () => url };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type UpstreamRequest = {
  url: string; authorization: string | undefined; codexVersion: string | undefined;
  userAgent: string | undefined; body: Record<string, unknown>;
};

async function upstream(t: TestContext, handler: (request: UpstreamRequest, response: ServerResponse) => void | Promise<void>) {
  const requests: UpstreamRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const captured = {
        url: request.url || '',
        authorization: request.headers.authorization,
        codexVersion: request.headers['x-codex-v'] as string | undefined,
        userAgent: request.headers['user-agent'],
        body: body ? JSON.parse(body) as Record<string, unknown> : {},
      };
      requests.push(captured);
      await handler(captured, response);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  const url = await listen(server);
  t.after(() => closeServer(server));
  return { url, requests };
}

function reply(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function requestGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { started: false, promise, release };
}

async function controlledObjectStore(t: TestContext) {
  const objects = new Map<string, Buffer>();
  let pendingPut: ReturnType<typeof requestGate> | undefined;
  let pendingGet: { gate: ReturnType<typeof requestGate>; missing: boolean } | undefined;
  let deleteForbidden = false;
  let deletionAttempts = 0;
  let reads = 0;
  const gates: ReturnType<typeof requestGate>[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === 'PUT') {
      const gate = pendingPut;
      pendingPut = undefined;
      if (gate) { gate.started = true; await gate.promise; }
      objects.set(path, Buffer.concat(chunks));
      response.writeHead(200, { ETag: '"controlled-etag"' });
      response.end();
    } else if (request.method === 'GET') {
      reads++;
      // Keep a snapshot so a deferred request can return stale bytes after DELETE.
      const payload = objects.get(path);
      const next = pendingGet;
      pendingGet = undefined;
      if (next) { next.gate.started = true; await next.gate.promise; }
      if (!payload || next?.missing) {
        response.writeHead(404, { 'Content-Type': 'application/xml' });
        response.end('<Error><Code>NoSuchKey</Code></Error>');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength });
        response.end(payload);
      }
    } else if (request.method === 'DELETE') {
      deletionAttempts++;
      if (deleteForbidden) {
        response.writeHead(403, { 'Content-Type': 'application/xml' });
        response.end('<Error><Code>AccessDenied</Code></Error>');
      } else {
        objects.delete(path);
        response.writeHead(204);
        response.end();
      }
    } else {
      response.writeHead(405);
      response.end();
    }
  });
  const endpoint = await listen(server);
  t.after(async () => {
    for (const gate of gates) gate.release();
    await closeServer(server);
  });
  return {
    endpoint, objects,
    get deletionAttempts() { return deletionAttempts; },
    get reads() { return reads; },
    rejectDeletes(reject: boolean) { deleteForbidden = reject; },
    deferPut() { const gate = requestGate(); gates.push(gate); pendingPut = gate; return gate; },
    deferGet(missing = false) { const gate = requestGate(); gates.push(gate); pendingGet = { gate, missing }; return gate; },
  };
}

async function useObjectStore(f: Fixture, endpoint: string) {
  await f.json('/api/admin/storage', 'PATCH', {
    mode: 's3', endpoint, region: 'us-east-1', bucket: 'controlled-test-bucket', prefix: 'runs',
    accessKeyId: 'controlled-local-access', secretAccessKey: 'controlled-local-secret',
  });
}

async function configure(f: Fixture, baseUrl: string, protocol: Provider['protocol'] = 'chat-completions', content = '创建一个 HTML，内容是SVG绘制一个鹈鹕骑自行车的 2D 动画 禁止测试') {
  // These tests exercise one attempt at a time; retry policy has its own integration suite.
  await f.json('/api/admin/settings', 'PATCH', { maxRetries: 0 });
  const { provider } = await f.json<{ provider: Provider }>('/api/admin/providers', 'POST', {
    name: '本地模拟接口', baseUrl: `${baseUrl}/v1`, protocol, apiKey: API_KEY, enabled: true,
  });
  const { model } = await f.json<{ model: Model }>('/api/admin/models', 'POST', {
    providerId: provider.id, name: '模拟模型', modelId: 'mock-model', enabled: true,
    maxTokens: 512, reasoningEffort: 'medium',
  });
  const { prompt } = await f.json<{ prompt: Prompt }>('/api/admin/prompts', 'POST', {
    title: '自定义提示词', description: '测试用提示词', category: 'visual', content,
    referenceAnswer: '', rubric: '', tags: ['测试'], enabled: true,
  });
  return { provider, model, prompt };
}

async function start(f: Fixture, model: Model, prompt: Prompt) {
  const { runs } = await f.json<{ runs: Run[] }>('/api/admin/runs', 'POST', {
    modelIds: [model.id], promptIds: [prompt.id], repeats: 1,
  });
  assert.equal(runs.length, 1);
  return runs[0]!;
}

async function waitForRun(f: Fixture, id: string, predicate: (run: Run) => boolean = (run) => ['completed', 'failed', 'cancelled'].includes(run.status)) {
  const deadline = Date.now() + 5_000;
  let latest: Run | undefined;
  do {
    latest = (await f.json<{ run: Run }>(`/api/admin/runs/${id}`)).run;
    if (latest && predicate(latest)) return latest;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`Run ${id} did not reach expected state: ${JSON.stringify(latest)}`);
}

async function readStoredFiles(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? readStoredFiles(join(directory, entry.name))
    : (await readFile(join(directory, entry.name))).toString('utf8')));
  return contents.join('\n');
}

function updateLegacyRecord(dataDir: string, table: 'providers' | 'models' | 'runs' | 'schedules', id: string,
  fields: Record<string, unknown> | ((value: Record<string, unknown>) => Record<string, unknown>)) {
  const db = new DatabaseSync(join(dataDir, 'app.db'));
  try {
    const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    assert.ok(row, `Fixture ${table}/${id} must exist`);
    const stored = JSON.parse(row.data as string) as Record<string, unknown>;
    const value = { ...stored, ...(typeof fields === 'function' ? fields(stored) : fields) };
    db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(value), id);
  } finally { db.close(); }
}

test('saved key previews are management-only, update with credentials, and cannot leak through public records', async t => {
  const originalKey = 'sk-TEST-hidden-original-api-key-TAIL5';
  const replacementKey = 'abcd-hidden-replacement-api-key-Z9876';
  const mock = await upstream(t, (_request, response) => reply(response, { choices: [{ message: { content: '完成' } }] }));
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/data')).status, 401);
  await f.login();
  const input = { name: '密钥缩略测试接口', baseUrl: `${mock.url}/v1`, protocol: 'chat-completions', enabled: true };
  const created = await f.json<{ provider: Provider }>('/api/admin/providers', 'POST', { ...input, apiKey: originalKey });
  assert.equal(created.provider.apiKeyPreview, 'sk-TEST...TAIL5');
  assert.equal(created.provider.hasApiKey, true);
  assert.equal(JSON.stringify(created).includes(originalKey), false);
  const kept = await f.json<{ provider: Provider }>(`/api/admin/providers/${created.provider.id}`, 'PUT', {
    ...created.provider, apiKey: '', apiKeyPreview: 'client-preview-must-not-be-stored',
  });
  assert.equal(kept.provider.apiKeyPreview, 'sk-TEST...TAIL5');
  const replaced = await f.json<{ provider: Provider }>(`/api/admin/providers/${created.provider.id}`, 'PUT', {
    ...created.provider, apiKey: replacementKey,
  });
  assert.equal(replaced.provider.apiKeyPreview, 'abcd...Z9876');
  assert.equal(JSON.stringify(replaced).includes(replacementKey), false);
  for (const [apiKey, expected] of [['short', '••••••••'], ['', '']]) {
    const result = await f.json<{ provider: Provider }>('/api/admin/providers', 'POST', { ...input, apiKey });
    assert.equal(result.provider.apiKeyPreview, expected);
    assert.equal(result.provider.hasApiKey, Boolean(apiKey));
  }
  const admin = await f.json<AdminData>('/api/admin/data');
  assert.equal(admin.providers.find(provider => provider.id === created.provider.id)!.apiKeyPreview, 'abcd...Z9876');
  for (const secret of [originalKey, replacementKey]) assert.equal(JSON.stringify(admin).includes(secret), false);
  const { model } = await f.json<{ model: Model }>('/api/admin/models', 'POST', {
    providerId: created.provider.id, name: '测试模型', modelId: 'mock', maxTokens: 128,
  });
  const { prompt } = await f.json<{ prompt: Prompt }>('/api/admin/prompts', 'POST', {
    title: '测试题', content: '回答', category: 'text',
  });
  const completed = await waitForRun(f, (await start(f, model, prompt)).id);
  assert.equal(completed.status, 'completed');
  assert.equal(mock.requests[0]!.authorization, `Bearer ${replacementKey}`);
  updateLegacyRecord(f.dataDir, 'runs', completed.id, { apiKeyPreview: 'private-run-preview', parameters: {
    ...completed.parameters, apiKeyPreview: 'private-parameter-preview',
  } });
  for (const path of ['/api/public/data', '/api/public/runs', `/api/public/runs/${completed.id}`]) {
    const response = await f.request(path, 'GET', undefined, { Cookie: '' });
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const value of [originalKey, replacementKey, 'apiKeyPreview', 'sk-TEST...TAIL5', 'abcd...Z9876', 'private-run-preview', 'private-parameter-preview']) {
      assert.equal(body.includes(value), false, `${path} must not expose a credential or preview`);
    }
  }
  const db = new DatabaseSync(join(f.dataDir, 'app.db'));
  try {
    const providerRows = JSON.stringify(db.prepare('SELECT data FROM providers').all());
    for (const value of [originalKey, replacementKey, 'apiKeyPreview', 'client-preview-must-not-be-stored']) assert.equal(providerRows.includes(value), false);
  } finally { db.close(); }
  updateLegacyRecord(f.dataDir, 'providers', created.provider.id, { encryptedApiKey: 'invalid-encrypted-credential' });
  const damaged = await f.json<AdminData>('/api/admin/data');
  assert.equal(damaged.providers.find(provider => provider.id === created.provider.id)!.apiKeyPreview, '');
  assert.equal(damaged.providers.find(provider => provider.id === created.provider.id)!.hasApiKey, true);
  assert.equal(JSON.stringify(damaged).includes('invalid-encrypted-credential'), false);
});

function controlledClock() {
  let value = Date.now();
  return { now: () => value, advance: (milliseconds: number) => { value += milliseconds; } };
}

async function waitUntil(predicate: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  do {
    if (await predicate()) return;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function createSchedule(f: Fixture, model: Model, prompt: Prompt, overrides: Partial<Schedule> = {}) {
  return (await f.json<{ schedule: Schedule }>('/api/admin/schedules', 'POST', {
    name: '每分钟自动评测', modelIds: [model.id], promptIds: [prompt.id],
    intervalMinutes: 1, enabled: true, ...overrides,
  })).schedule;
}

async function scheduledRuns(f: Fixture, scheduleId: string) {
  return (await f.json<AdminData>('/api/admin/data')).runs.filter((run) => run.scheduleId === scheduleId);
}

test('admin requires a session and same-origin mutations; logout revokes the session', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/data')).status, 401);
  assert.equal((await f.request('/api/auth/login', 'POST', { token: 'incorrect-token' })).status, 401);
  const cookie = await f.login();
  assert.match(cookie, /SameSite=(?:Strict|Lax)/i);
  assert.equal((await f.request('/api/admin/data')).status, 200);
  assert.equal((await f.request('/api/admin/prompts', 'POST', {}, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await f.request('/api/auth/logout', 'POST')).status, 200);
  assert.equal((await f.request('/api/admin/data')).status, 401);
});

test('chat completion preserves prompts, stores encrypted keys and automatically exposes every SVG result', async (t) => {
  const html = '<!DOCTYPE html><html><body><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20"/></svg></body></html>';
  const mock = await upstream(t, (_request, response) => reply(response, {
    choices: [{ message: { role: 'assistant', content: `\`\`\`html\n${html}\n\`\`\``, reasoning_content: '绘图推理' } }],
    usage: { prompt_tokens: 23, completion_tokens: 45 },
  }));
  const f = await fixture(t);
  await f.login();
  const content = '\n创建一个 HTML，内容是SVG绘制一个鹈鹕骑自行车的 2D 动画 禁止测试\n保留  两个空格。\n';
  const { provider, model, prompt } = await configure(f, mock.url, 'chat-completions', content);
  assert.equal(provider.hasApiKey, true);
  assert.equal('apiKey' in provider, false);
  const created = await start(f, model, prompt);
  const run = await waitForRun(f, created.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.source, 'api');
  for (const field of ['published', 'score', 'notes']) assert.equal(field in run, false);
  assert.equal(run.promptContent, content);
  assert.ok(run.html.includes(html));
  assert.equal(run.reasoning, '绘图推理');
  assert.equal(run.inputTokens, 23);
  assert.equal(run.outputTokens, 45);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0]!.url, '/v1/chat/completions');
  assert.equal(mock.requests[0]!.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(mock.requests[0]!.body.messages, [{ role: 'user', content }]);
  assert.equal(mock.requests[0]!.body.model, model.modelId);
  assert.equal(mock.requests[0]!.body.stream, false);
  assert.equal((await f.request(`/api/public/runs/${run.id}`)).status, 200);
  assert.equal((await f.request(`/api/admin/runs/${run.id}`, 'PATCH', { score: 87, notes: '动画观感检查', published: false })).status, 404);
  const published = await f.json<PublicData>('/api/public/data');
  assert.ok(published.runs.some((item) => item.id === run.id));
  const summary = published.runs.find((item) => item.id === run.id)!;
  assert.equal(summary.output, '');
  assert.equal(summary.html, '');
  assert.equal(summary.reasoning, '');
  const publishedDetail = await f.json<{ run: Run }>(`/api/public/runs/${run.id}`);
  assert.ok(publishedDetail.run.html.includes('<svg'));
  assert.ok(!JSON.stringify(published).includes(API_KEY));
  const admin = await f.json<AdminData>('/api/admin/data');
  assert.ok(!JSON.stringify(admin).includes(API_KEY));
  assert.ok(!(await readStoredFiles(f.dataDir)).includes(API_KEY), 'API key must not be stored in plaintext');
  await f.restart();
  assert.equal((await f.json<AdminData>('/api/admin/data')).providers[0]!.hasApiKey, true);
  const restartedRun = await start(f, model, prompt);
  assert.equal((await waitForRun(f, restartedRun.id)).status, 'completed');
  assert.equal(mock.requests[1]!.authorization, `Bearer ${API_KEY}`, 'Persisted key must decrypt after restart');
});

test('responses protocol sends the exact prompt and aggregates every message output', async (t) => {
  const mock = await upstream(t, (_request, response) => reply(response, {
    id: 'resp-mock', status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '检查最坏情况。' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '29\n' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最多可取 28 颗而未满足条件。' }] },
    ], usage: { input_tokens: 99, output_tokens: 18 },
  }));
  const f = await fixture(t);
  await f.login();
  const content = '不要使用任何工具或写代码，直接推理回答。\n请保留原始提示词。';
  const { model, prompt } = await configure(f, mock.url, 'responses', content);
  const run = await waitForRun(f, (await start(f, model, prompt)).id);
  assert.equal(run.status, 'completed');
  assert.ok(run.output.includes('29\n'));
  assert.ok(run.output.includes('最多可取 28 颗而未满足条件。'));
  assert.ok(run.reasoning.includes('检查最坏情况。'));
  assert.equal(run.inputTokens, 99);
  assert.equal(run.outputTokens, 18);
  const request = mock.requests[0]!;
  assert.equal(request.url, '/v1/responses');
  assert.equal(request.body.input, content);
  assert.equal(request.body.max_output_tokens, 512);
  assert.equal('temperature' in request.body, false);
  assert.equal(request.body.stream, true);
  assert.equal(request.codexVersion, undefined);
  assert.equal('messages' in request.body, false);
});

test('responses calls stream and codex client simulation can be enabled and disabled', async (t) => {
  const mock = await upstream(t, (_request, response) => reply(response, {
    status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }],
    usage: { input_tokens: 3, output_tokens: 4 },
  }));
  const f = await fixture(t);
  await f.login();
  await f.json('/api/admin/settings', 'PATCH', { maxRetries: 0 });
  const { provider } = await f.json<{ provider: Provider }>('/api/admin/providers', 'POST', {
    name: '模拟 Codex 客户端', baseUrl: `${mock.url}/v1`, protocol: 'responses',
    simulateCodexClient: true, apiKey: API_KEY, enabled: true,
  });
  const { model } = await f.json<{ model: Model }>('/api/admin/models', 'POST', {
    providerId: provider.id, name: '模拟模型', modelId: 'mock-model', enabled: true,
    maxTokens: 128, reasoningEffort: 'medium',
  });
  const { prompt } = await f.json<{ prompt: Prompt }>('/api/admin/prompts', 'POST', {
    title: '流式测试', description: '', category: 'text', content: '回答：完成',
    referenceAnswer: '', rubric: '', tags: [], enabled: true,
  });
  const enabled = await waitForRun(f, (await start(f, model, prompt)).id);
  assert.equal(enabled.status, 'completed');
  assert.equal(mock.requests[0]!.codexVersion, '1.0.0');
  assert.equal(mock.requests[0]!.userAgent, 'Codex Desktop/0.155.0-alpha.2.6 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.911.61220)');
  assert.equal(mock.requests[0]!.body.stream, true);

  await f.json<{ provider: Provider }>(`/api/admin/providers/${provider.id}`, 'PUT', {
    ...provider, apiKey: '', simulateCodexClient: false,
  });
  const disabled = await waitForRun(f, (await start(f, model, prompt)).id);
  assert.equal(disabled.status, 'completed');
  assert.equal(mock.requests[1]!.codexVersion, undefined);
  assert.notEqual(mock.requests[1]!.userAgent, 'Codex Desktop/0.155.0-alpha.2.6 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.911.61220)');
  assert.equal(mock.requests[1]!.body.stream, true);
});

test('max reasoning maps to each upstream protocol and legacy temperature is never sent', async (t) => {
  const mock = await upstream(t, (request, response) => reply(response, request.url.endsWith('/responses') ? {
    status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }],
  } : { choices: [{ message: { role: 'assistant', content: '完成' } }] }));
  const f = await fixture(t);
  await f.login();
  for (const protocol of ['chat-completions', 'responses'] as const) {
    const { model, prompt } = await configure(f, mock.url, protocol);
    const saved = await f.json<{ model: Model }>(`/api/admin/models/${model.id}`, 'PUT', {
      ...model, temperature: 0.1, reasoningEffort: 'max',
    });
    assert.equal('temperature' in saved.model, false);
    assert.equal(saved.model.reasoningEffort, 'max');
    await f.stop();
    updateLegacyRecord(f.dataDir, 'models', model.id, { temperature: 0.8 });
    await f.restart();
    const admin = await f.json<AdminData>('/api/admin/data');
    assert.equal('temperature' in admin.models.find((item) => item.id === model.id)!, false);
    const run = await waitForRun(f, (await start(f, saved.model, prompt)).id);
    assert.equal(run.status, 'completed');
    assert.equal('temperature' in run.parameters, false);
    assert.equal(run.parameters.reasoningEffort, 'max');
    const request = mock.requests.at(-1)!;
    assert.equal('temperature' in request.body, false);
    if (protocol === 'responses') {
      assert.deepEqual(request.body.reasoning, { effort: 'max' });
      assert.equal('reasoning_effort' in request.body, false);
    } else {
      assert.equal(request.body.reasoning_effort, 'max');
      assert.equal('reasoning' in request.body, false);
    }
    await f.stop();
    updateLegacyRecord(f.dataDir, 'runs', run.id, (stored) => ({
      execution: { ...(stored.execution as Record<string, unknown>), temperature: 0.6 },
      parameters: { ...run.parameters, temperature: 0.6 },
    }));
    await f.restart();
    const retried = await f.json<{ runs: Run[] }>(`/api/admin/runs/${run.id}/retry`, 'POST');
    const retry = await waitForRun(f, retried.runs[0]!.id);
    assert.equal(retry.status, 'completed');
    assert.equal('temperature' in retry.parameters, false);
    const retryRequest = mock.requests.at(-1)!;
    assert.equal('temperature' in retryRequest.body, false, 'Retrying an old execution snapshot must not restore temperature');
    if (protocol === 'responses') assert.deepEqual(retryRequest.body.reasoning, { effort: 'max' });
    else assert.equal(retryRequest.body.reasoning_effort, 'max');
  }
});

test('model discovery uses edge-compatible manual redirects and never sends credentials to a redirect target', async (t) => {
  const target = await upstream(t, (_request, response) => reply(response, { data: [{ id: 'must-not-be-called' }] }));
  let redirect = false;
  const catalog = await upstream(t, (_request, response) => {
    if (redirect) { response.writeHead(302, { Location: `${target.url}/v1/models` }); response.end(); }
    else reply(response, { data: [{ id: 'available-model', owned_by: 'test-owner' }] });
  });
  const nativeFetch = globalThis.fetch;
  const modes: unknown[] = [];
  t.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    modes.push(init?.redirect);
    // Cloudflare's edge rejects this mode before sending even a non-redirecting request.
    if (init?.redirect === 'error') throw new TypeError("Invalid redirect value; must be 'follow' or 'manual'");
    return nativeFetch(input, init);
  });
  assert.deepEqual(await discoverModels({ baseUrl: `${catalog.url}/v1` }, API_KEY),
    [{ id: 'available-model', ownedBy: 'test-owner' }]);
  redirect = true;
  await assert.rejects(discoverModels({ baseUrl: `${catalog.url}/v1` }, API_KEY), (error: unknown) => {
    assert.ok(error instanceof ModelDiscoveryError);
    assert.equal(error.status, 502);
    assert.match(error.message, /HTTP 302/);
    assert.ok(!error.message.includes(API_KEY));
    return true;
  });
  assert.deepEqual(modes, ['manual', 'manual']);
  assert.equal(catalog.requests.length, 2);
  assert.ok(catalog.requests.every(request => request.authorization === `Bearer ${API_KEY}`));
  assert.equal(target.requests.length, 0);
});

test('provider model catalogs use only the selected provider endpoint and credentials', async (t) => {
  const first = await upstream(t, (_request, response) => reply(response, {
    data: [{ id: 'z-model', owned_by: 'team-z' }, { id: 'a-model', owned_by: 'team-a' },
      { id: 'z-model', owned_by: 'team-z' }, { id: '' }, { id: 12 }, { irrelevant: 'ignore' }],
  }));
  const second = await upstream(t, (_request, response) => reply(response, { data: [{ id: 'second-only' }] }));
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/providers/not-known/models')).status, 401);
  await f.login();
  const providers: Provider[] = [];
  for (const [index, mock] of [first, second].entries()) {
    providers.push((await f.json<{ provider: Provider }>('/api/admin/providers', 'POST', {
      name: `Catalog ${index}`, baseUrl: `${mock.url}/v1`, protocol: 'responses', enabled: true,
      apiKey: `${API_KEY}-${index}`,
    })).provider);
  }
  const firstCatalog = await f.json<{ models: { id: string; ownedBy?: string }[] }>(`/api/admin/providers/${providers[0]!.id}/models`);
  assert.deepEqual(firstCatalog.models, [{ id: 'a-model', ownedBy: 'team-a' }, { id: 'z-model', ownedBy: 'team-z' }]);
  assert.equal(first.requests.length, 1);
  assert.equal(second.requests.length, 0, 'Discovery must not query unrelated API providers');
  assert.equal(first.requests[0]!.url, '/v1/models');
  assert.equal(first.requests[0]!.authorization, `Bearer ${API_KEY}-0`);
  const secondCatalog = await f.json<{ models: { id: string }[] }>(`/api/admin/providers/${providers[1]!.id}/models`);
  assert.deepEqual(secondCatalog.models, [{ id: 'second-only' }]);
  assert.equal(second.requests[0]!.url, '/v1/models');
  assert.equal(second.requests[0]!.authorization, `Bearer ${API_KEY}-1`);
  assert.equal((await f.request('/api/admin/providers/not-known/models')).status, 404);
  assert.ok(!JSON.stringify([firstCatalog, secondCatalog]).includes(API_KEY));
});

test('provider model discovery rejects redirects, oversized bodies, invalid catalogs and redacts errors', async (t) => {
  const redirected = await upstream(t, (_request, response) => reply(response, { data: [{ id: 'must-not-be-called' }] }));
  let scenario: 'http-error' | 'redirect' | 'oversized' | 'invalid-json' | 'invalid-shape' | 'empty' = 'http-error';
  const mock = await upstream(t, (_request, response) => {
    if (scenario === 'http-error') reply(response, { error: { message: `Denied Bearer ${API_KEY}` } }, 401);
    else if (scenario === 'redirect') {
      response.writeHead(302, { Location: `${redirected.url}/v1/models` }); response.end();
    } else if (scenario === 'oversized') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024 + 1) }); response.end('{}');
    } else if (scenario === 'invalid-json') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{invalid');
    } else if (scenario === 'invalid-shape') reply(response, { data: { id: 'not-an-array' } });
    else reply(response, { data: [] });
  });
  const f = await fixture(t);
  await f.login();
  const { provider } = await configure(f, mock.url);
  for (const next of ['http-error', 'redirect', 'oversized', 'invalid-json', 'invalid-shape'] as const) {
    scenario = next;
    const response = await f.request(`/api/admin/providers/${provider.id}/models`);
    assert.equal(response.status, 502, `${next} should report an upstream discovery failure`);
    const result = await response.json() as { error: string };
    assert.ok(result.error.length > 0);
    assert.ok(!JSON.stringify(result).includes(API_KEY), `${next} must not expose the configured key`);
  }
  assert.equal(redirected.requests.length, 0, 'Discovery must not forward credentials across redirects');
  scenario = 'empty';
  assert.deepEqual((await f.json<{ models: unknown[] }>(`/api/admin/providers/${provider.id}/models`)).models, []);
});

test('queued and active runs are public, can be cancelled, and cannot be deleted while active', async (t) => {
  const mock = await upstream(t, () => { /* Keep the first request open until cancellation. */ });
  const f = await fixture(t, { concurrency: 1, requestTimeoutMs: 10_000 });
  await f.login();
  const { model, prompt } = await configure(f, mock.url);
  const active = await start(f, model, prompt);
  await waitForRun(f, active.id, (run) => run.status === 'running');
  const queued = await start(f, model, prompt);
  assert.equal((await waitForRun(f, queued.id, (run) => run.status === 'queued')).status, 'queued');
  const ongoing = await f.json<PublicData>('/api/public/data');
  assert.equal(ongoing.runs.find((run) => run.id === active.id)?.status, 'running');
  assert.equal(ongoing.runs.find((run) => run.id === queued.id)?.status, 'queued');
  assert.equal((await f.request(`/api/public/runs/${active.id}`)).status, 200);
  assert.equal((await f.request(`/api/public/runs/${queued.id}`)).status, 200);
  assert.equal((await f.request(`/api/admin/runs/${active.id}`, 'PATCH', { published: true })).status, 404);
  assert.equal((await f.request(`/api/admin/runs/${active.id}`, 'DELETE')).status, 409);
  await f.json(`/api/admin/runs/${queued.id}/cancel`, 'POST');
  await f.json(`/api/admin/runs/${active.id}/cancel`, 'POST');
  assert.equal((await waitForRun(f, queued.id)).status, 'cancelled');
  assert.equal((await waitForRun(f, active.id)).status, 'cancelled');
  const data = await f.json<PublicData>('/api/public/data');
  assert.equal(data.runs.length, 2);
  assert.ok(data.runs.every((run) => run.status === 'cancelled'));
});

test('upstream failures redact credentials and timeouts settle as failed runs', async (t) => {
  let rejectRequest = true;
  const mock = await upstream(t, (_request, response) => {
    if (rejectRequest) reply(response, { error: { message: `upstream rejected ${API_KEY}` } }, 429);
    else reply(response, { choices: [{ message: { role: 'assistant', content: '恢复成功' } }] });
  });
  const f = await fixture(t, { requestTimeoutMs: 80 });
  await f.login();
  const { model, prompt } = await configure(f, mock.url);
  const failed = await waitForRun(f, (await start(f, model, prompt)).id);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error.length > 0);
  assert.ok(!failed.error.includes(API_KEY));
  assert.equal((await f.json<{ run: Run }>(`/api/public/runs/${failed.id}`)).run.status, 'failed');
  rejectRequest = false;
  const retry = await f.json<{ runs: Run[] }>(`/api/admin/runs/${failed.id}/retry`, 'POST');
  assert.equal(retry.runs.length, 1);
  assert.notEqual(retry.runs[0]!.id, failed.id);
  assert.equal((await waitForRun(f, retry.runs[0]!.id)).status, 'completed');
  assert.equal((await waitForRun(f, failed.id)).status, 'failed', 'Retry retains the original failure record');
  const hanging = await upstream(t, () => {});
  const slow = await configure(f, hanging.url);
  const timeout = await waitForRun(f, (await start(f, slow.model, slow.prompt)).id);
  assert.equal(timeout.status, 'failed');
  assert.ok(timeout.error.length > 0);
  assert.ok(timeout.finishedAt);
});

test('HTTP 200 with truncated output is recorded as failure instead of a successful evaluation', async (t) => {
  const mock = await upstream(t, (request, response) => reply(response, request.url.endsWith('/responses') ? {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '未完成的回答' }] }],
  } : {
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '未完成的回答' } }],
  }));
  const f = await fixture(t);
  await f.login();
  for (const protocol of ['chat-completions', 'responses'] as const) {
    const { model, prompt } = await configure(f, mock.url, protocol);
    const run = await waitForRun(f, (await start(f, model, prompt)).id);
    assert.equal(run.status, 'failed', `${protocol} truncation must fail`);
    assert.equal(run.output, '未完成的回答');
    assert.ok(run.error.length > 0);
    assert.equal((await f.json<{ run: Run }>(`/api/public/runs/${run.id}`)).run.output, '未完成的回答');
  }
});

test('restart settles interrupted runs and retains saved configuration', async (t) => {
  const mock = await upstream(t, () => {});
  const f = await fixture(t, { requestTimeoutMs: 10_000 });
  await f.login();
  const { model, prompt } = await configure(f, mock.url);
  const started = await start(f, model, prompt);
  await waitForRun(f, started.id, (run) => run.status === 'running');
  await f.restart();
  const data = await f.json<AdminData>('/api/admin/data');
  assert.ok(data.models.some((item) => item.id === model.id));
  assert.ok(data.prompts.some((item) => item.id === prompt.id));
  const recovered = data.runs.find((item) => item.id === started.id)!;
  assert.ok(recovered);
  assert.equal(recovered.status, 'failed');
  assert.ok(recovered.error.length > 0);
  assert.ok(recovered.finishedAt);
});

test('upstream redirects, oversized bodies, invalid JSON, refusals and empty output fail safely', async (t) => {
  const redirectTarget = await upstream(t, (_request, response) => reply(response, {
    choices: [{ message: { role: 'assistant', content: '不应访问重定向目标' } }],
  }));
  let scenario: 'redirect' | 'oversized' | 'invalid-json' | 'refusal' | 'empty' = 'redirect';
  const mock = await upstream(t, (request, response) => {
    if (scenario === 'redirect') {
      response.writeHead(302, { Location: `${redirectTarget.url}/v1/chat/completions` });
      response.end();
    } else if (scenario === 'oversized') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(4 * 1024 * 1024 + 1) });
      response.end('{}');
    } else if (scenario === 'invalid-json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{not-valid-json');
    } else if (request.url.endsWith('/responses')) {
      reply(response, {
        status: 'completed', output: [{ type: 'message', role: 'assistant', content: [scenario === 'refusal'
          ? { type: 'refusal', refusal: `拒绝 ${API_KEY}` }
          : { type: 'output_text', text: '   ' }] }],
      });
    } else {
      reply(response, { choices: [{ message: scenario === 'refusal'
        ? { role: 'assistant', content: null, refusal: `拒绝 ${API_KEY}` }
        : { role: 'assistant', content: '   ' } }] });
    }
  });
  const f = await fixture(t);
  await f.login();
  const chat = await configure(f, mock.url);
  const responses = await configure(f, mock.url, 'responses');
  for (const next of ['redirect', 'oversized', 'invalid-json', 'refusal', 'empty'] as const) {
    scenario = next;
    const protocols = next === 'refusal' || next === 'empty' ? [chat, responses] : [chat];
    for (const { model, prompt } of protocols) {
      const run = await waitForRun(f, (await start(f, model, prompt)).id);
      assert.equal(run.status, 'failed', `${next} must fail`);
      assert.ok(run.error.length > 0, `${next} must provide an error`);
      assert.ok(!JSON.stringify(run).includes(API_KEY), `${next} must not leak the API key`);
      const detail = await f.json<{ run: Run }>(`/api/public/runs/${run.id}`);
      assert.equal(detail.run.status, 'failed');
      assert.ok(!JSON.stringify(detail).includes(API_KEY));
    }
  }
  assert.equal(redirectTarget.requests.length, 0, 'Do not forward requests or credentials to redirect targets');
  assert.equal(mock.requests[0]!.authorization, `Bearer ${API_KEY}`);
});

test('scheduled evaluations run when due, deduplicate active work and expose running and completed results', async (t) => {
  let pendingResponse: ServerResponse | undefined;
  const mock = await upstream(t, (_request, response) => { pendingResponse = response; });
  const clock = controlledClock();
  const f = await fixture(t, { now: clock.now, schedulerIntervalMs: 10, requestTimeoutMs: 10_000 });
  await f.login();
  const { provider, model, prompt } = await configure(f, mock.url);
  const schedule = await createSchedule(f, model, prompt);
  assert.ok(schedule.nextRunAt);
  clock.advance(59_000);
  await delay(40);
  assert.equal((await scheduledRuns(f, schedule.id)).length, 0);
  clock.advance(1_000);
  await waitUntil(async () => (await scheduledRuns(f, schedule.id)).length === 1 && Boolean(pendingResponse), 'Due schedule should start one upstream request');
  const run = (await scheduledRuns(f, schedule.id))[0]!;
  assert.equal(run.providerId, provider.id);
  assert.equal(run.status, 'running');
  assert.equal('published' in run, false);
  assert.equal((await f.json<{ run: Run }>(`/api/public/runs/${run.id}`)).run.status, 'running');
  clock.advance(3 * 60_000);
  await delay(50);
  assert.equal((await scheduledRuns(f, schedule.id)).length, 1, 'An overdue schedule must not duplicate its active run');
  assert.equal(mock.requests.length, 1);
  reply(pendingResponse!, { choices: [{ message: { role: 'assistant', content: '<svg><circle r="5"/></svg>' } }] });
  const completed = await waitForRun(f, run.id);
  assert.equal(completed.status, 'completed');
  assert.equal('published' in completed, false);
  assert.ok((await f.json<{ run: Run }>(`/api/public/runs/${run.id}`)).run.html.includes('<svg'));
  const current = (await f.json<AdminData>('/api/admin/data')).schedules.find((item) => item.id === schedule.id)!;
  assert.ok(current.lastRunAt);
  await f.json(`/api/admin/schedules/${schedule.id}`, 'PUT', { ...current, enabled: false });
});

test('manual schedule execution preserves the next deadline and disabled schedules stay idle', async (t) => {
  const mock = await upstream(t, (_request, response) => reply(response, { choices: [{ message: { role: 'assistant', content: '手动运行成功' } }] }));
  const clock = controlledClock();
  const f = await fixture(t, { now: clock.now, schedulerIntervalMs: 10 });
  await f.login();
  const { model, prompt } = await configure(f, mock.url);
  const schedule = await createSchedule(f, model, prompt);
  assert.equal((await f.request('/api/admin/schedules', 'POST', { ...schedule, intervalMinutes: 0 })).status, 400);
  clock.advance(30_000);
  const response = await f.request(`/api/admin/schedules/${schedule.id}/run`, 'POST');
  assert.equal(response.status, 202);
  const { runs } = await response.json() as { runs: Run[] };
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.scheduleId, schedule.id);
  const completed = await waitForRun(f, runs[0]!.id);
  assert.equal(completed.status, 'completed');
  assert.equal((await f.json<{ run: Run }>(`/api/public/runs/${completed.id}`)).run.status, 'completed');
  const current = (await f.json<AdminData>('/api/admin/data')).schedules.find((item) => item.id === schedule.id)!;
  assert.equal(current.nextRunAt, schedule.nextRunAt, 'A manual execution must not shift the automatic interval');
  const disabled = (await f.json<{ schedule: Schedule }>(`/api/admin/schedules/${schedule.id}`, 'PUT', { ...current, enabled: false })).schedule;
  assert.equal(disabled.enabled, false);
  clock.advance(5 * 60_000);
  await delay(50);
  assert.equal((await scheduledRuns(f, schedule.id)).length, 1);
  assert.equal(mock.requests.length, 1);
  await f.json(`/api/admin/schedules/${schedule.id}`, 'DELETE');
  assert.equal((await f.json<AdminData>('/api/admin/data')).schedules.some((item) => item.id === schedule.id), false);
  assert.equal((await f.request(`/api/admin/schedules/${schedule.id}/run`, 'POST')).status, 404);
});

test('restarting an overdue schedule catches up once and keeps failed automatic runs publicly visible', async (t) => {
  const mock = await upstream(t, (_request, response) => reply(response, { error: { message: '模拟上游失败' } }, 503));
  const clock = controlledClock();
  const f = await fixture(t, { now: clock.now, schedulerIntervalMs: 10 });
  await f.login();
  const { model, prompt } = await configure(f, mock.url);
  const schedule = await createSchedule(f, model, prompt);
  await f.stop();
  clock.advance(12 * 60_000);
  await f.restart();
  await waitUntil(async () => (await scheduledRuns(f, schedule.id)).length === 1, 'A persisted overdue schedule should run after restart');
  const run = (await scheduledRuns(f, schedule.id))[0]!;
  const failed = await waitForRun(f, run.id);
  assert.equal(failed.status, 'failed');
  assert.equal((await f.json<{ run: Run }>(`/api/public/runs/${failed.id}`)).run.status, 'failed');
  await delay(50);
  assert.equal(mock.requests.length, 1, 'Missed intervals should produce one catch-up run');
  assert.equal((await scheduledRuns(f, schedule.id)).length, 1);
  const current = (await f.json<AdminData>('/api/admin/data')).schedules.find((item) => item.id === schedule.id)!;
  assert.ok(current.nextRunAt && Date.parse(current.nextRunAt) > clock.now());
});

test('legacy review fields cannot hide historical results and schedules ignore autoPublish', async (t) => {
  const mock = await upstream(t, (_request, response) => reply(response, {
    choices: [{ message: { role: 'assistant', content: '真实原始回答' } }],
  }));
  const f = await fixture(t);
  await f.login();
  const { provider, model, prompt } = await configure(f, mock.url);
  const run = await waitForRun(f, (await start(f, model, prompt)).id);
  const schedule = await createSchedule(f, model, prompt, { enabled: false });
  await f.stop();
  updateLegacyRecord(f.dataDir, 'runs', run.id, {
    published: false, score: 1, notes: '旧版审核文字', autoPublish: false,
    parameters: { ...run.parameters, temperature: 0.3 },
  });
  updateLegacyRecord(f.dataDir, 'schedules', schedule.id, { autoPublish: false });
  await f.restart();
  const legacy = await f.json<{ run: Run }>(`/api/public/runs/${run.id}`);
  assert.equal(legacy.run.id, run.id);
  for (const field of ['published', 'score', 'notes', 'autoPublish']) assert.equal(field in legacy.run, false);
  assert.equal('temperature' in legacy.run.parameters, false);
  const data = await f.json<PublicData>('/api/public/data');
  assert.ok(data.runs.some((item) => item.id === run.id));
  assert.equal(data.models.find((item) => item.id === model.id)?.providerId, provider.id);
  assert.deepEqual(data.providers.find((item) => item.id === provider.id), { id: provider.id, name: provider.name });
  const admin = await f.json<AdminData>('/api/admin/data');
  assert.equal('autoPublish' in admin.schedules[0]!, false);
  const { runs } = await f.json<{ runs: Run[] }>(`/api/admin/schedules/${schedule.id}/run`, 'POST');
  const scheduled = await waitForRun(f, runs[0]!.id);
  assert.equal((await f.json<{ run: Run }>(`/api/public/runs/${scheduled.id}`)).run.status, 'completed');
  assert.equal((await f.request(`/api/admin/runs/${run.id}`, 'PATCH', { published: false, score: 100 })).status, 404);
  await f.json(`/api/admin/schedules/${schedule.id}`, 'DELETE');
  await f.json(`/api/admin/models/${model.id}`, 'DELETE');
  await f.json(`/api/admin/providers/${provider.id}`, 'DELETE');
  const historical = await f.json<PublicData>('/api/public/data');
  assert.deepEqual(historical.providers.find((item) => item.id === provider.id), { id: provider.id, name: provider.name });
  const filtered = await f.json<{ runs: Run[]; total: number }>(`/api/public/runs?providerId=${provider.id}`);
  assert.equal(filtered.total, 2, 'Deleting configuration must not remove its historical result filter');
  assert.ok(filtered.runs.every((item) => item.providerId === provider.id));
  assert.ok(!JSON.stringify(historical).includes(API_KEY));
  assert.ok(!JSON.stringify(historical.providers).includes(mock.url), 'Public providers expose names and identifiers only');
});

test('retention applies global and provider periods while preserving samples and active work', async (t) => {
  const mock = await upstream(t, (request, response) => {
    const content = (request.body.messages as { content: string }[])[0]!.content;
    if (content === 'hold') return;
    if (content === 'fail') reply(response, { error: { message: '模拟失败' } }, 500);
    else reply(response, { choices: [{ message: { role: 'assistant', content: `完成 ${content}` } }] });
  });
  const clock = controlledClock();
  const f = await fixture(t, { seed: true, now: clock.now, cleanupIntervalMs: 10, concurrency: 1, requestTimeoutMs: 10_000 });
  await f.login();
  const initial = await f.json<AdminData>('/api/admin/data');
  assert.equal(initial.settings.retentionDays, 30);
  const sampleIds = initial.runs.filter((run) => run.source === 'sample').map((run) => run.id);
  assert.ok(sampleIds.length > 0);
  const settings = await f.json<{ settings: { retentionDays: number } }>('/api/admin/settings', 'PATCH', { retentionDays: 1 });
  assert.equal(settings.settings.retentionDays, 1);
  assert.equal((await f.request('/api/admin/settings', 'PATCH', { retentionDays: 0 })).status, 400);
  const short = await configure(f, mock.url, 'chat-completions', 'short');
  assert.equal(short.provider.retentionDays, null);
  const shortRun = await waitForRun(f, (await start(f, short.model, short.prompt)).id);
  const long = await configure(f, mock.url, 'chat-completions', 'long');
  await f.json(`/api/admin/providers/${long.provider.id}`, 'PUT', { ...long.provider, retentionDays: 3 });
  const longRun = await waitForRun(f, (await start(f, long.model, long.prompt)).id);
  const failing = await configure(f, mock.url, 'chat-completions', 'fail');
  const failed = await waitForRun(f, (await start(f, failing.model, failing.prompt)).id);
  assert.equal(failed.status, 'failed');
  const hanging = await configure(f, mock.url, 'chat-completions', 'hold');
  const cancelled = await start(f, hanging.model, hanging.prompt);
  await waitForRun(f, cancelled.id, (run) => run.status === 'running');
  await f.json(`/api/admin/runs/${cancelled.id}/cancel`, 'POST');
  const active = await start(f, hanging.model, hanging.prompt);
  await waitForRun(f, active.id, (run) => run.status === 'running');
  const queued = await start(f, hanging.model, hanging.prompt);
  await waitForRun(f, queued.id, (run) => run.status === 'queued');
  clock.advance(2 * 24 * 60 * 60_000);
  await f.login();
  await waitUntil(async () => (await f.request(`/api/admin/runs/${shortRun.id}`)).status === 404, 'Expired run should be removed by the cleanup timer');
  assert.equal((await f.request(`/api/admin/runs/${failed.id}`)).status, 404);
  assert.equal((await f.request(`/api/admin/runs/${cancelled.id}`)).status, 404);
  assert.equal((await f.request(`/api/admin/runs/${longRun.id}`)).status, 200, 'Provider retention overrides the global period');
  const retained = await f.json<AdminData>('/api/admin/data');
  for (const id of sampleIds) assert.ok(retained.runs.some((run) => run.id === id), 'Samples are exempt from retention');
  assert.equal(retained.runs.find((run) => run.id === active.id)?.status, 'running');
  assert.equal(retained.runs.find((run) => run.id === queued.id)?.status, 'queued');
  clock.advance(2 * 24 * 60 * 60_000);
  await waitUntil(async () => (await f.request(`/api/admin/runs/${longRun.id}`)).status === 404, 'Provider-specific expiry should eventually remove the run');
});

test('run lists are lightweight and paginated while response bodies remain memory-only', async (t) => {
  const sentinel = 'MEMORY_ONLY_BODY_b31aa31e_不得落盘';
  const body = `<svg><text>${sentinel}</text></svg>`;
  const mock = await upstream(t, (_request, response) => reply(response, {
    choices: [{ message: { role: 'assistant', content: body, reasoning_content: `${sentinel} 推理` } }],
  }));
  const f = await fixture(t);
  await f.login();
  const first = await configure(f, mock.url);
  const second = await configure(f, mock.url);
  const promptIds = [first.prompt.id];
  for (let index = 1; index < 5; index++) {
    const { prompt } = await f.json<{ prompt: Prompt }>('/api/admin/prompts', 'POST', {
      title: `分页提示词 ${index}`, content: `内容 ${index}`, category: 'text', enabled: true,
    });
    promptIds.push(prompt.id);
  }
  for (let batch = 0; batch < 4; batch++) {
    const { runs } = await f.json<{ runs: Run[] }>('/api/admin/runs', 'POST', { modelIds: [first.model.id], promptIds, repeats: 10 });
    assert.equal(runs.length, 50);
    await waitForRun(f, runs.at(-1)!.id);
  }
  await waitForRun(f, (await start(f, first.model, first.prompt)).id);
  const last = await waitForRun(f, (await start(f, second.model, second.prompt)).id);
  await waitUntil(async () => (await f.json<{ total: number }>(`/api/admin/runs?providerId=${first.provider.id}&status=completed&limit=1`)).total === 201, 'All generated records should complete before checking pagination');
  const admin = await f.json<AdminData>('/api/admin/data');
  assert.equal(admin.runs.length, 200, 'Bootstrap data contains only the latest 200 metadata records');
  for (const run of admin.runs) {
    assert.equal(run.output, '');
    assert.equal(run.html, '');
    assert.equal(run.reasoning, '');
  }
  const page = await f.json<{ runs: Run[]; total: number }>(`/api/admin/runs?providerId=${first.provider.id}&modelId=${first.model.id}&status=completed&offset=0&limit=2`);
  assert.equal(page.total, 201);
  assert.equal(page.runs.length, 2);
  assert.ok(page.runs.every((run) => run.providerId === first.provider.id && run.modelId === first.model.id && run.hasHtml));
  const next = await f.json<{ runs: Run[]; total: number }>(`/api/admin/runs?providerId=${first.provider.id}&offset=2&limit=2`);
  assert.equal(next.total, 201);
  assert.equal(new Set([...page.runs, ...next.runs].map((run) => run.id)).size, 4);
  const filtered = await f.json<{ runs: Run[]; total: number }>(`/api/admin/runs?providerId=${second.provider.id}&limit=10`);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.runs[0]!.id, last.id);
  assert.ok(last.output.includes(sentinel));
  assert.ok(last.artifactAvailable);
  assert.ok(!(await readStoredFiles(f.dataDir)).includes(sentinel), 'Generated output and reasoning must never be persisted');
  const publicDefault = await f.json<{ runs: Run[]; total: number }>('/api/public/runs');
  assert.equal(publicDefault.total, 202);
  assert.equal(publicDefault.runs.length, 12);
  const publicIds = new Set<string>();
  for (let offset = 0; offset < 202; offset += 50) {
    const current = await f.json<{ runs: Run[]; total: number }>(`/api/public/runs?offset=${offset}&limit=50`);
    assert.equal(current.total, 202);
    for (const run of current.runs) {
      assert.equal(run.output, '');
      assert.equal(run.html, '');
      assert.equal(run.reasoning, '');
      assert.equal(publicIds.has(run.id), false, 'Pages must not duplicate entries');
      publicIds.add(run.id);
    }
  }
  assert.equal(publicIds.size, 202, 'Public pagination must reach results beyond the bootstrap window');
  for (const sort of ['newest', 'oldest', 'latency'] as const) {
    const sorted = (await f.json<{ runs: Run[] }>(`/api/public/runs?sort=${sort}&limit=200`)).runs;
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (sort === 'latency') assert.ok((previous.latencyMs ?? Infinity) <= (current.latencyMs ?? Infinity));
      else if (sort === 'oldest') assert.ok(runResultTime(previous) <= runResultTime(current));
      else assert.ok(runResultTime(previous) >= runResultTime(current));
    }
  }
  const publicFiltered = await f.json<{ runs: Run[]; total: number }>(`/api/public/runs?providerId=${second.provider.id}&category=visual&source=api&q=${encodeURIComponent('本地模拟接口')}`);
  assert.equal(publicFiltered.total, 1);
  assert.equal(publicFiltered.runs[0]!.id, last.id);
  const categoryMismatch = await f.json<{ total: number }>(`/api/public/runs?providerId=${second.provider.id}&category=reasoning`);
  assert.equal(categoryMismatch.total, 0);
  assert.equal((await f.json<{ total: number }>('/api/public/runs?source=sample')).total, 0);
  assert.equal((await f.json<{ total: number }>('/api/admin/runs?source=sample')).total, 0);
  const search = await f.json<{ runs: Run[]; total: number }>(`/api/public/runs?q=${encodeURIComponent('分页提示词 1')}&limit=5`);
  assert.equal(search.total, 40);
  assert.ok(search.runs.every((run) => run.promptTitle === '分页提示词 1'));
  assert.ok((await f.json<{ run: Run }>(`/api/public/runs/${last.id}`)).run.output.includes(sentinel));
  await f.restart();
  const recovered = (await f.json<{ run: Run }>(`/api/admin/runs/${last.id}`)).run;
  assert.equal(recovered.status, 'completed');
  assert.equal('published' in recovered, false);
  assert.equal(recovered.artifactAvailable, false);
  assert.equal(recovered.output, '');
  assert.equal(recovered.html, '');
  assert.equal(recovered.reasoning, '');
  assert.ok(!(await readStoredFiles(f.dataDir)).includes(sentinel));
  assert.equal((await f.request(`/api/admin/runs/${last.id}`, 'GET', undefined, { Cookie: '' })).status, 401);
});

test('public lists and provider filters never download cloud artifacts', async (t) => {
  const cloud = await controlledObjectStore(t);
  const mock = await upstream(t, (_request, response) => reply(response, {
    choices: [{ message: { role: 'assistant', content: '<svg><text>云端正文</text></svg>' } }],
  }));
  const f = await fixture(t);
  await f.login();
  await useObjectStore(f, cloud.endpoint);
  const { model, prompt, provider } = await configure(f, mock.url);
  const completed = await waitForRun(f, (await start(f, model, prompt)).id);
  assert.equal(completed.artifactStorage, 's3');
  const before = cloud.reads;
  const [bootstrap, page] = await Promise.all([
    f.json<PublicData>('/api/public/data'),
    f.json<{ runs: Run[]; total: number }>(`/api/public/runs?providerId=${provider.id}&category=visual&source=api&sort=newest`),
  ]);
  assert.equal(cloud.reads, before, 'Metadata lists must not fetch generated SVG or text bodies');
  assert.equal(page.total, 1);
  for (const run of [...bootstrap.runs, ...page.runs]) {
    assert.equal(run.html, ''); assert.equal(run.output, ''); assert.equal(run.reasoning, '');
    assert.equal(run.hasHtml, true);
  }
  assert.ok((await f.json<{ run: Run }>(`/api/public/runs/${completed.id}`)).run.html.includes('云端正文'));
  assert.equal(cloud.reads, before + 1, 'Only opening result details should fetch the generated artifact');
});

test('failed S3 deletion preserves object references and automatic retention retries safely', async (t) => {
  const objects = new Map<string, Buffer>();
  const accessKey = 'local-s3-access-for-test';
  const secretKey = 'local-s3-secret-never-expose';
  let rejectDelete = true;
  let deletionAttempts = 0;
  const objectServer = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === 'PUT') {
      objects.set(path, Buffer.concat(chunks));
      response.writeHead(200, { ETag: '"local-test-etag"' });
      response.end();
    } else if (request.method === 'DELETE') {
      deletionAttempts++;
      if (rejectDelete) {
        response.writeHead(403, { 'Content-Type': 'application/xml' });
        response.end(`<Error><Code>AccessDenied</Code><Message>${secretKey}</Message></Error>`);
      } else {
        objects.delete(path);
        response.writeHead(204);
        response.end();
      }
    } else if (request.method === 'GET' && objects.has(path)) {
      const body = objects.get(path)!;
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.byteLength });
      response.end(body);
    } else {
      response.writeHead(404, { 'Content-Type': 'application/xml' });
      response.end('<Error><Code>NoSuchKey</Code></Error>');
    }
  });
  const endpoint = await listen(objectServer);
  t.after(() => closeServer(objectServer));
  const body = 'S3_RESPONSE_BODY_c4a1c49f_正文只进对象存储';
  const mock = await upstream(t, (_request, response) => reply(response, { choices: [{ message: { role: 'assistant', content: body } }] }));
  const clock = controlledClock();
  const f = await fixture(t, { now: clock.now, cleanupIntervalMs: 10 });
  await f.login();
  const storage = await f.json('/api/admin/storage', 'PATCH', {
    mode: 's3', endpoint, region: 'us-east-1', bucket: 'local-test-bucket', prefix: 'test-results',
    accessKeyId: accessKey, secretAccessKey: secretKey,
  });
  assert.ok(!JSON.stringify(storage).includes(accessKey));
  assert.ok(!JSON.stringify(storage).includes(secretKey));
  await f.json('/api/admin/settings', 'PATCH', { retentionDays: 1 });
  const { model, prompt } = await configure(f, mock.url);
  const manual = await waitForRun(f, (await start(f, model, prompt)).id);
  assert.equal(manual.status, 'completed');
  assert.equal(manual.artifactStorage, 's3');
  assert.equal(objects.size, 1);
  const rejected = await f.request(`/api/admin/runs/${manual.id}`, 'DELETE');
  assert.equal(rejected.status, 502);
  assert.ok(!(await rejected.text()).includes(secretKey));
  const preserved = (await f.json<{ run: Run }>(`/api/admin/runs/${manual.id}`)).run;
  assert.ok(preserved.cleanupError);
  assert.equal(preserved.output, body);
  assert.equal(objects.size, 1);
  await f.restart();
  assert.equal((await f.json<{ run: Run }>(`/api/admin/runs/${manual.id}`)).run.output, body, 'The retained cloud reference must survive restart');
  rejectDelete = false;
  await f.json(`/api/admin/runs/${manual.id}`, 'DELETE');
  assert.equal((await f.request(`/api/admin/runs/${manual.id}`)).status, 404);
  assert.equal(objects.size, 0);
  const automatic = await waitForRun(f, (await start(f, model, prompt)).id);
  rejectDelete = true;
  clock.advance(2 * 24 * 60 * 60_000);
  await f.login();
  await waitUntil(async () => Boolean((await f.json<AdminData>('/api/admin/data')).runs.find((run) => run.id === automatic.id)?.cleanupError), 'Failed retention deletion must retain metadata with a cleanup error');
  assert.equal(objects.size, 1);
  const retained = (await f.json<{ run: Run }>(`/api/admin/runs/${automatic.id}`)).run;
  assert.equal(retained.output, body);
  assert.ok(!JSON.stringify(retained).includes(secretKey));
  const attemptsBeforeRetry = deletionAttempts;
  rejectDelete = false;
  await waitUntil(async () => (await f.request(`/api/admin/runs/${automatic.id}`)).status === 404, 'The next retention pass should retry and delete both object and metadata');
  assert.ok(deletionAttempts > attemptsBeforeRetry);
  assert.equal(objects.size, 0);
  const localFiles = await readStoredFiles(f.dataDir);
  for (const value of [body, accessKey, secretKey]) assert.ok(!localFiles.includes(value));
});

test('a cloud upload completed after cancellation retains a private cleanup reference until cleanup succeeds', async (t) => {
  const cloud = await controlledObjectStore(t);
  const mock = await upstream(t, (_request, response) => reply(response, {
    choices: [{ message: { role: 'assistant', content: '取消后抵达云端的正文' } }],
  }));
  const clock = controlledClock();
  const f = await fixture(t, { now: clock.now, cleanupIntervalMs: 20 });
  await f.login();
  await useObjectStore(f, cloud.endpoint);
  const { model, prompt } = await configure(f, mock.url);
  assert.equal((await f.json<AdminData>('/api/admin/data')).settings.retentionDays, 30);
  for (const restart of [false, true]) {
    cloud.rejectDeletes(true);
    const put = cloud.deferPut();
    let run: Run;
    try {
      run = await start(f, model, prompt);
      await waitUntil(async () => put.started, 'The model response should reach the deferred S3 upload');
      await f.json(`/api/admin/runs/${run.id}/cancel`, 'POST');
      assert.equal((await waitForRun(f, run.id)).status, 'cancelled');
    } finally { put.release(); }
    await waitUntil(async () => Boolean((await f.json<AdminData>('/api/admin/data')).runs.find((item) => item.id === run.id)?.cleanupError), 'Failed compensation must persist a cleanup reference and error');
    assert.equal(cloud.objects.size, 1);
    const pending = (await f.json<{ run: Run }>(`/api/admin/runs/${run.id}`)).run;
    assert.equal(pending.status, 'cancelled');
    assert.equal('artifact' in pending, false);
    assert.equal('execution' in pending, false);
    const path = [...cloud.objects.keys()][0]!;
    assert.ok(!JSON.stringify(pending).includes(path.split('/').slice(2).join('/')), 'Private object references must not appear in API responses');
    if (restart) await f.stop();
    cloud.rejectDeletes(false);
    if (restart) await f.restart();
    await waitUntil(async () => {
      const current = (await f.json<AdminData>('/api/admin/data')).runs.find((item) => item.id === run.id);
      return cloud.objects.size === 0 && Boolean(current && !current.cleanupError);
    }, 'Compensating cleanup should retry immediately without waiting for normal retention');
    const cleaned = (await f.json<{ run: Run }>(`/api/admin/runs/${run.id}`)).run;
    assert.equal(cleaned.status, 'cancelled', 'Cancellation metadata should survive body cleanup');
    assert.equal(cleaned.artifactAvailable, false);
    assert.equal(cleaned.output, '');
  }
});

test('delayed cloud details respect concurrent deletion without leaking or resurrecting results', async (t) => {
  const cloud = await controlledObjectStore(t);
  const body = 'PRIVATE_DELAYED_DETAIL_77b54cd6';
  const mock = await upstream(t, (_request, response) => reply(response, {
    choices: [{ message: { role: 'assistant', content: body } }],
  }));
  const f = await fixture(t);
  await f.login();
  await useObjectStore(f, cloud.endpoint);
  const { model, prompt } = await configure(f, mock.url);
  const scenarios = [
    { scope: 'public', missing: false },
    { scope: 'public', missing: true },
    { scope: 'admin', missing: false },
    { scope: 'admin', missing: true },
  ] as const;
  for (const scenario of scenarios) {
    const run = await waitForRun(f, (await start(f, model, prompt)).id);
    const get = cloud.deferGet(scenario.missing);
    const pending = f.request(`/api/${scenario.scope}/runs/${run.id}`);
    try {
      await waitUntil(async () => get.started, 'Detail request should be waiting for the S3 response');
      await f.json(`/api/admin/runs/${run.id}`, 'DELETE');
    } finally { get.release(); }
    const response = await pending;
    assert.equal(response.status, 404, `${scenario.scope}/${scenario.missing ? 'missing' : 'body'} must observe the latest metadata`);
    assert.ok(!(await response.text()).includes(body), 'A deleted result must not return a previously requested body');
    const data = await f.json<AdminData>('/api/admin/data');
    const current = data.runs.find((item) => item.id === run.id);
    assert.equal(current, undefined, 'A stale hydrate must not recreate deleted metadata');
    assert.equal((await f.request(`/api/admin/runs/${run.id}`)).status, 404);
    assert.equal((await f.request(`/api/public/runs/${run.id}`)).status, 404);
  }
});
