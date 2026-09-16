import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { callUpstream, UpstreamError } from '../server/upstream.ts';
import type { ExecutionSnapshot } from '../server/store.ts';

const KEY = 'sk-stream-test-secret';
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const completed = (output: string) => ({ type: 'response.completed', response: {
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }],
  usage: { input_tokens: 12, output_tokens: 34 },
} });
const chatDelta = (content: string, finish: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });

async function fixture(t: TestContext, handler: (response: ServerResponse) => void | Promise<void>) {
  const requests: { path: string; body: Record<string, any>; authorization?: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ path: request.url!, body: JSON.parse(body), authorization: request.headers.authorization });
    await handler(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const snapshot = (protocol: ExecutionSnapshot['protocol']): ExecutionSnapshot => ({ providerId: 'test-provider',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, encryptedApiKey: '', protocol, modelId: 'exact-model', maxTokens: 8192, reasoningEffort: 'max' });
  const call = (protocol: ExecutionSnapshot['protocol'], stream?: boolean, signal = new AbortController().signal) =>
    callUpstream(snapshot(protocol), 'exact prompt', KEY, signal, stream === undefined ? undefined : { stream });
  return { requests, call };
}

test('Responses SSE drains split UTF-8/CRLF/multiline frames and prefers completed response output and usage', async t => {
  const final = completed(`<svg><text>鹈鹕 ${KEY}</text></svg>`);
  final.response.output.unshift({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'final reasoning' }] } as any);
  let stream = ': heartbeat\r\n\r\nevent: response.output_text.delta\r\ndata: {"output_index":0,\r\ndata: "content_index":0,"delta":"temporary text"}\r\n\r\n';
  stream += event({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'delta reasoning' });
  stream += event({ type: 'response.output_text.done', text: 'must not duplicate' });
  stream += event(final);
  const f = await fixture(t, async response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(stream);
    const split = bytes.indexOf(Buffer.from('鹈')) + 1;
    for (const part of [bytes.subarray(0, 11), bytes.subarray(11, split), bytes.subarray(split, split + 1), bytes.subarray(split + 1)]) {
      response.write(part); await delay(2);
    }
    response.end();
  });
  const result = await f.call('responses', true);
  assert.equal(result.error, ''); assert.match(result.output, /鹈鹕 \[密钥已隐藏\]/); assert.match(result.html, /<svg>/);
  assert.equal(result.reasoning, 'final reasoning'); assert.equal(result.inputTokens, 12); assert.equal(result.outputTokens, 34);
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0]!.body, { model: 'exact-model', stream: true, input: 'exact prompt', max_output_tokens: 8192, reasoning: { effort: 'max' } });
});

test('Chat SSE accumulates content/reasoning, accepts usage after finish and requires DONE', async t => {
  const f = await fixture(t, response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(event({ choices: [{ index: 0, delta: { reasoning_content: '先推理。' } }] })
      + event(chatDelta('2')) + event(chatDelta('1', 'stop'))
      + event({ choices: [], usage: { prompt_tokens: 23, completion_tokens: 45 } }) + 'data: [DONE]\n\n');
  });
  const result = await f.call('chat-completions', true);
  assert.deepEqual(result, { output: '21', html: '', reasoning: '先推理。', error: '', inputTokens: 23, outputTokens: 45 });
  assert.deepEqual(f.requests[0]!.body, { model: 'exact-model', stream: true, messages: [{ role: 'user', content: 'exact prompt' }],
    max_completion_tokens: 8192, reasoning_effort: 'max', stream_options: { include_usage: true } });
});

test('Responses fallback orders independent delta parts and needs a response terminal marker', async t => {
  let ending = event({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 6 } } });
  const f = await fixture(t, response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(event({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'B' })
      + event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'A' })
      + event({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'reason' })
      + event({ type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: 'raw alternative' }) + ending);
  });
  const result = await f.call('responses', true);
  assert.equal(result.output, 'A\nB'); assert.equal(result.reasoning, 'reason'); assert.equal(result.error, ''); assert.equal(result.outputTokens, 6);
  ending = event({ type: 'response.output_text.done', text: 'A\nB' });
  const partial = await f.call('responses', true); assert.equal(partial.output, 'A\nB'); assert.match(partial.error, /未完整结束/);
  ending = 'data: [DONE]\n\n';
  assert.match((await f.call('responses', true)).error, /未完整结束/);
  ending = event({ type: 'response.completed', response: { status: 'completed', output: [] } });
  const emptyFinal = await f.call('responses', true);
  assert.equal(emptyFinal.output, ''); assert.match(emptyFinal.error, /没有可用/);
});

test('Responses SSE incomplete, refusal, failed, malformed and unfinished output never pass', async t => {
  let ending = '';
  const f = await fixture(t, response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' }) + ending);
  });
  const cases: [string, RegExp][] = [
    ['', /未完整结束/],
    [event({ type: 'response.completed' }), /未完整结束/],
    [event({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }), /截断/],
    [event({ type: 'response.incomplete', response: { status: 'completed' } }), /未完成|不一致/],
    [event({ type: 'response.completed', response: { status: 'incomplete' } }), /不一致/],
    [event({ type: 'response.refusal.delta', delta: KEY }) + event(completed('partial')), /拒绝/],
    [event({ type: 'response.failed', response: { status: 'failed', error: { message: KEY } } }), /失败/],
    [event({ type: 'error', code: 'server_error', message: KEY }) + event(completed('partial')), /失败/],
    ['data: {broken JSON\n\n' + event(completed('partial')), /格式无效/],
  ];
  for (const [value, expected] of cases) {
    ending = value; const result = await f.call('responses', true);
    assert.match(result.error, expected); assert.equal(result.output, 'partial'); assert.ok(!JSON.stringify(result).includes(KEY));
  }
});

test('Chat SSE preserves partial text but rejects missing finish/DONE, truncation, filtering and refusal', async t => {
  let payload = '';
  const f = await fixture(t, response => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(payload); });
  const cases: [string, RegExp][] = [
    [event(chatDelta('partial', 'stop')), /未完整结束/],
    [event(chatDelta('partial')) + 'data: [DONE]\n\n', /未完整结束/],
    [event(chatDelta('partial', 'length')) + 'data: [DONE]\n\n', /截断/],
    [event(chatDelta('partial', 'content_filter')) + 'data: [DONE]\n\n', /过滤/],
    [event(chatDelta('partial', 'tool_calls')) + 'data: [DONE]\n\n', /工具调用/],
    [event({ choices: [{ index: 0, delta: { content: 'partial', refusal: KEY }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', /拒绝/],
    [event(chatDelta('partial', 'stop')) + event({ error: { message: KEY } }) + 'data: [DONE]\n\n', /错误/],
  ];
  for (const [value, expected] of cases) {
    payload = value; const result = await f.call('chat-completions', true);
    assert.equal(result.output, 'partial'); assert.match(result.error, expected); assert.ok(!JSON.stringify(result).includes(KEY));
  }
});

test('JSON responses to stream requests reuse existing parsers without issuing a second request; default remains non-streaming', async t => {
  let protocol: ExecutionSnapshot['protocol'] = 'responses';
  const f = await fixture(t, response => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(protocol === 'responses' ? completed('JSON result').response
      : { choices: [{ message: { content: 'JSON result' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 34 } }));
  });
  for (const p of ['responses', 'chat-completions'] as const) {
    protocol = p;
    for (const streaming of [true, undefined]) {
      const before = f.requests.length; const result = await f.call(protocol, streaming);
      assert.equal(result.output, 'JSON result'); assert.equal(result.error, ''); assert.equal(result.outputTokens, 34);
      assert.equal(f.requests.length, before + 1); assert.equal(f.requests.at(-1)!.body.stream, streaming === true);
      if (streaming === undefined) assert.ok(!('stream_options' in f.requests.at(-1)!.body));
    }
  }
});

test('streaming still enforces the 4 MB byte limit and AbortSignal', async t => {
  let oversized = true;
  const f = await fixture(t, response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': heartbeat\n\n');
    if (oversized) response.end(event(chatDelta('x'.repeat(4 * 1024 * 1024))) + 'data: [DONE]\n\n');
  });
  await assert.rejects(f.call('chat-completions', true), (error: unknown) => {
    assert.ok(error instanceof UpstreamError); assert.equal(error.retryable, false); assert.match(error.message, /4 MB/); return true;
  });
  oversized = false;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25);
  try {
    await assert.rejects(f.call('responses', true, controller.signal), (error: unknown) => {
      assert.ok(error instanceof UpstreamError); assert.equal(error.kind, 'aborted'); assert.ok(!error.message.includes(KEY)); return true;
    });
  } finally { clearTimeout(timer); }
  assert.equal(f.requests.length, 2);
});
