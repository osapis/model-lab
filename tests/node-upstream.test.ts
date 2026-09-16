import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Agent } from 'undici';
import { createNodeUpstreamTransport } from '../server/node-upstream.ts';
import { callUpstream, UpstreamError } from '../server/upstream.ts';
import type { ExecutionSnapshot } from '../server/store.ts';

// Undici exposes this clock specifically for tests. Advance the real HTTP
// parser's timeout clock without waiting five minutes or contacting a model.
const require = createRequire(import.meta.url);
const timers = require('undici/lib/util/timers.js') as { tick(ms?: number): void; reset(): void };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Local HTTP did not settle')), 3000); })]); }
  finally { clearTimeout(timer!); }
}
async function heldServer(t: TestContext, phase: 'headers' | 'body') {
  const pending = new Map<string, ReturnType<typeof deferred<ServerResponse>>>();
  const get = (path: string) => {
    if (!pending.has(path)) pending.set(path, deferred<ServerResponse>());
    return pending.get(path)!;
  };
  const server = createServer((request, response) => {
    if (phase === 'body') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write('first '); }
    get(request.url!).resolve(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { base: `http://127.0.0.1:${address.port}`, received: (path: string) => within(get(path).promise) };
}

for (const phase of ['headers', 'body'] as const) {
  test(`Node upstream waits beyond Undici's 300-second ${phase} timeout while the default transport fails`, async t => {
    const mock = await heldServer(t, phase);
    const upstream = createNodeUpstreamTransport();
    const defaultAgent = new Agent();
    t.after(async () => { await Promise.all([upstream.close(), defaultAgent.close()]); timers.reset(); });

    let adaptedSettled = false;
    const adapted = upstream.fetch(`${mock.base}/adapted`).then(response => response.text()).finally(() => { adaptedSettled = true; });
    const defaultInit: RequestInit & { dispatcher: Agent } = { dispatcher: defaultAgent };
    const control = fetch(`${mock.base}/control`, defaultInit).then(response => response.text()).then(() => null, error => error);
    const [response] = await Promise.all([mock.received('/adapted'), mock.received('/control')]);
    // Let fetch consume the first body chunk before moving the parser clock.
    await nextTurn(); await nextTurn();
    timers.tick(1);
    timers.tick(301_000);
    const failure = await within(control);
    assert.ok(failure instanceof Error, 'The control must exercise the real built-in transport timeout');
    assert.equal((failure.cause as { code?: string })?.code, phase === 'headers' ? 'UND_ERR_HEADERS_TIMEOUT' : 'UND_ERR_BODY_TIMEOUT');
    assert.equal(adaptedSettled, false, 'The production adapter must keep the request alive');
    response.end('done');
    assert.equal(await within(adapted), phase === 'body' ? 'first done' : 'done');
  });

  test(`Node upstream still honors the run AbortSignal while waiting for ${phase}`, async t => {
    const mock = await heldServer(t, phase);
    const upstream = createNodeUpstreamTransport();
    t.after(() => upstream.close());
    const controller = new AbortController();
    const result = upstream.fetch(`${mock.base}/abort`, { signal: controller.signal }).then(response => response.text());
    const rejected = assert.rejects(result, { name: 'AbortError' });
    await mock.received('/abort');
    await nextTurn();
    controller.abort();
    await within(rejected);
  });
}

test('Node transport injection keeps manual redirects and upstream key redaction', async t => {
  const upstream = createNodeUpstreamTransport();
  const key = 'sk-local-transport-test-secret';
  let redirected = false;
  const server = createServer((request, response) => {
    if (request.url === '/redirect/chat/completions') { response.writeHead(307, { Location: '/must-not-follow' }); response.end(); }
    else if (request.url === '/must-not-follow') { redirected = true; response.end(); }
    else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: `21 ${key}` } }] })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await upstream.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const snapshot: ExecutionSnapshot = { providerId: 'test', baseUrl: `http://127.0.0.1:${address.port}/v1`, encryptedApiKey: '', protocol: 'chat-completions', modelId: 'test', maxTokens: 100, reasoningEffort: 'max' };
  const signal = new AbortController().signal;
  const result = await callUpstream(snapshot, 'test', key, signal, { fetcher: upstream.fetch });
  assert.equal(result.output, '21 [密钥已隐藏]');
  await assert.rejects(callUpstream({ ...snapshot, baseUrl: `http://127.0.0.1:${address.port}/redirect` }, 'test', key, signal, { fetcher: upstream.fetch }), error => error instanceof UpstreamError && error.httpStatus === 307 && !error.retryable);
  assert.equal(redirected, false);
});
