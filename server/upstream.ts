import type { ExecutionSnapshot, StoredProvider } from './store.ts';
import { normalizeReasoningEffort } from '../shared/reasoning.ts';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const CODEX_DESKTOP_USER_AGENT = 'Codex Desktop/0.155.0-alpha.2.6 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.911.61220)';
export class ModelDiscoveryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function discoverModels(provider: Pick<StoredProvider, 'baseUrl'>, apiKey: string): Promise<{ id: string; ownedBy?: string }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      // The edge runtime accepts manual/follow only. Inspect 3xx without forwarding credentials.
      redirect: 'manual', signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelDiscoveryError(502, `获取模型列表失败：上游 HTTP ${response.status}，请检查该接口地址、密钥和模型列表权限。`);
    }
    if (Number(response.headers.get('content-length') || 0) > MAX_CATALOG_BYTES) {
      await response.body?.cancel();
      throw new ModelDiscoveryError(502, '模型列表响应超过 2 MB 限制。');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ModelDiscoveryError(502, '模型列表响应为空。');
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new ModelDiscoveryError(502, '模型列表响应超过 2 MB 限制。');
      }
      chunks.push(value);
    }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ModelDiscoveryError(502, '模型列表响应不是有效 JSON，请检查该接口地址。'); }
    if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
      throw new ModelDiscoveryError(502, '模型列表响应缺少有效的 data 数组；该接口可能不支持模型列表查询。');
    }
    const catalog = new Map<string, { id: string; ownedBy?: string }>();
    for (const item of payload.data) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200) continue;
      const id = item.id.trim();
      // An upstream can echo arbitrary values. Never reflect credentials in a catalog.
      if (apiKey && id.includes(apiKey)) continue;
      const owner = typeof item.owned_by === 'string' ? item.owned_by.trim() : '';
      if (!catalog.has(id)) catalog.set(id, { id, ...(owner && owner.length <= 200 && !(apiKey && owner.includes(apiKey)) ? { ownedBy: owner } : {}) });
    }
    return [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error;
    throw new ModelDiscoveryError(controller.signal.aborted ? 504 : 502, controller.signal.aborted
      ? '获取模型列表超时（15 秒），请检查该接口连接后重试。'
      : '无法获取模型列表，请检查该接口地址、网络、TLS 或重定向配置。');
  } finally { clearTimeout(timer); }
}
export interface UpstreamResult {
  output: string; reasoning: string; html: string; error: string;
  inputTokens: number | null; outputTokens: number | null;
}
/** Safe, typed failures separate transport retries from model or configuration errors. */
export class UpstreamError extends Error {
  constructor(message: string, public readonly retryable: boolean,
    public readonly kind: 'http' | 'network' | 'invalid-response' | 'aborted', public readonly httpStatus?: number) {
    super(message); this.name = 'UpstreamError';
  }
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part && ['text', 'output_text'].includes(part.type) && typeof part.text === 'string').map(part => part.text).join('\n');
}
export function extractHtml(output: string): string {
  const fenced = [...output.matchAll(/```(?:html|svg|xml)?[ \t]*\r?\n([\s\S]*?)```/gi)].map(match => match[1]);
  for (const candidate of [...fenced, output]) {
    const html = candidate.match(/(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*?<\/html\s*>/i);
    if (html) return html[0];
    const svg = candidate.match(/<svg\b[\s\S]*?<\/svg\s*>/i);
    if (svg) return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7fa}svg{max-width:100%;height:auto}</style></head><body>${svg[0]}</body></html>`;
  }
  return '';
}
function parseChat(payload: any): UpstreamResult {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const output = messageText(message?.content);
  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : typeof message?.reasoning === 'string' ? message.reasoning : '';
  let error = '';
  if (payload?.error) error = '上游 API 返回错误。';
  else if (message?.refusal || (Array.isArray(message?.content) && message.content.some((part: any) => part.type === 'refusal'))) error = '模型拒绝了该请求。';
  else if (choice?.finish_reason === 'length') error = '输出达到 token 上限，结果已截断；请提高最大输出 token 后重试。';
  else if (choice?.finish_reason === 'content_filter') error = '输出被上游内容过滤器拦截。';
  else if (['tool_calls', 'function_call'].includes(choice?.finish_reason)) error = '模型请求了工具调用，未返回完整文本；本测试不执行工具。';
  else if (!output.trim()) error = '上游响应中没有可用的文本内容。';
  return { output, reasoning, html: extractHtml(output), error, inputTokens: count(payload?.usage?.prompt_tokens), outputTokens: count(payload?.usage?.completion_tokens) };
}
function parseResponses(payload: any): UpstreamResult {
  const texts: string[] = []; const reasoning: string[] = []; let refused = false;
  if (Array.isArray(payload?.output)) for (const item of payload.output) {
    if (item?.type === 'message' && Array.isArray(item.content)) for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      if (part?.type === 'refusal') refused = true;
    }
    if (item?.type === 'reasoning' && Array.isArray(item.summary)) for (const part of item.summary) {
      if (typeof part?.text === 'string') reasoning.push(part.text);
    }
  }
  const output = texts.length ? texts.join('\n') : typeof payload?.output_text === 'string' ? payload.output_text : '';
  let error = '';
  if (payload?.error || payload?.status === 'failed') error = '上游 API 返回失败状态。';
  else if (refused) error = '模型拒绝了该请求。';
  else if (payload?.status === 'incomplete') error = payload?.incomplete_details?.reason === 'max_output_tokens' ? '输出达到 token 上限，结果已截断；请提高最大输出 token 后重试。' : '上游返回未完成的响应。';
  else if (['cancelled', 'queued', 'in_progress'].includes(payload?.status)) error = '上游尚未完成该响应。';
  else if (!output.trim()) error = '上游响应中没有可用的文本内容。';
  return { output, reasoning: reasoning.join('\n'), html: extractHtml(output), error, inputTokens: count(payload?.usage?.input_tokens), outputTokens: count(payload?.usage?.output_tokens) };
}
type StreamEvent = { type: string; value: any };
function streamEvents(text: string): { events: StreamEvent[]; done: boolean; invalid: boolean } {
  const events: StreamEvent[] = [];
  let data: string[] = [], type = '', done = false, invalid = false;
  const dispatch = () => {
    if (data.length) {
      const content = data.join('\n').trim();
      if (content === '[DONE]') done = true;
      else {
        try {
          const value = JSON.parse(content);
          if (!value || typeof value !== 'object' || Array.isArray(value) || done) invalid = true;
          else events.push({ type: typeof value.type === 'string' ? value.type : type, value });
        } catch { invalid = true; }
      }
    }
    data = []; type = '';
  };
  // Decoding occurs after bounded byte collection, so neither UTF-8 nor SSE frames can split incorrectly.
  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    if (!line) { dispatch(); continue; }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') type = value;
  }
  dispatch();
  return { events, done, invalid };
}
function parseChatStream(text: string): UpstreamResult {
  const stream = streamEvents(text);
  let content = '', reasoning = '', refusal = '', finish: unknown = null, usage: unknown, failed = false;
  for (const { type, value } of stream.events) {
    if (type === 'error' || value.error) failed = true;
    if (value.usage) usage = value.usage;
    const choice = value.choices?.find((item: any) => item?.index === 0) ?? value.choices?.[0];
    if (!choice || choice.index !== undefined && choice.index !== 0) continue;
    const delta = choice.delta || {};
    content += messageText(delta.content);
    reasoning += typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (typeof delta.refusal === 'string') refusal += delta.refusal;
    if (Array.isArray(delta.content) && delta.content.some((part: any) => part?.type === 'refusal')) refusal ||= 'refused';
    if (choice.finish_reason != null) finish = choice.finish_reason;
  }
  const result = parseChat({ choices: [{ message: { content, reasoning_content: reasoning, refusal }, finish_reason: finish }], usage });
  if (failed) result.error = '上游流式响应返回错误。';
  else if (stream.invalid) result.error = '上游流式响应格式无效，结果未确认完整。';
  else if (!stream.done || typeof finish !== 'string') result.error ||= '上游流式响应未完整结束，已保留收到的部分内容。';
  else if (!['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(finish)) result.error ||= '上游流式响应结束状态未知。';
  return result;
}
function parseResponsesStream(text: string): UpstreamResult {
  const stream = streamEvents(text);
  const output = new Map<string, string>(), reasoning = new Map<string, string>(), rawReasoning = new Map<string, string>();
  let final: any, terminal = '', terminalConflict = false, refused = false, failed = false;
  const append = (parts: Map<string, string>, value: any, index: string) => {
    const key = `${Number.isInteger(value.output_index) ? value.output_index : 0}:${Number.isInteger(value[index]) ? value[index] : 0}`;
    if (typeof value.delta === 'string') parts.set(key, (parts.get(key) || '') + value.delta);
  };
  const joined = (parts: Map<string, string>) => [...parts].sort(([a], [b]) => {
    const [ai, aj] = a.split(':').map(Number), [bi, bj] = b.split(':').map(Number);
    return ai! - bi! || aj! - bj!;
  }).map(([, value]) => value).join('\n');
  for (const { type, value } of stream.events) {
    if (type === 'response.output_text.delta') append(output, value, 'content_index');
    else if (type === 'response.reasoning_summary_text.delta') append(reasoning, value, 'summary_index');
    else if (type === 'response.reasoning_text.delta') append(rawReasoning, value, 'content_index');
    if (type === 'response.refusal.delta' || type === 'response.refusal.done') refused = true;
    if (type === 'error' || type === 'response.failed' || value.error) failed = true;
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
      if (terminal && terminal !== type) terminalConflict = true;
      terminal = type;
      final = value.response && typeof value.response === 'object' && !Array.isArray(value.response) ? value.response : undefined;
    }
  }
  const terminalStatus = terminal === 'response.incomplete' ? 'incomplete' : terminal === 'response.failed' ? 'failed' : 'completed';
  const hasFinalOutput = final && ('output' in final || 'output_text' in final);
  const result = parseResponses({ ...final, status: terminalStatus,
    output_text: hasFinalOutput ? final.output_text : joined(output) });
  result.reasoning ||= joined(reasoning) || joined(rawReasoning);
  if (failed) result.error = '上游流式响应返回失败状态。';
  else if (refused) result.error = '模型拒绝了该请求。';
  else if (stream.invalid) result.error = '上游流式响应格式无效，结果未确认完整。';
  else if (terminalConflict || final?.status && final.status !== terminalStatus) result.error ||= '上游流式响应结束状态不一致，结果未确认完整。';
  else if (!terminal || !final) result.error ||= '上游流式响应未完整结束，已保留收到的部分内容。';
  return result;
}
export async function callUpstream(snapshot: ExecutionSnapshot, prompt: string, apiKey: string, signal: AbortSignal,
  options: { stream?: boolean; fetcher?: typeof fetch } = {}): Promise<UpstreamResult> {
  const body: Record<string, unknown> = { model: snapshot.modelId, stream: options.stream === true };
  const reasoningEffort = normalizeReasoningEffort(snapshot.reasoningEffort);
  const responses = snapshot.protocol === 'responses';
  if (responses) {
    body.input = prompt; body.max_output_tokens = snapshot.maxTokens;
    body.reasoning = { effort: reasoningEffort };
  } else {
    body.messages = [{ role: 'user', content: prompt }]; body.max_completion_tokens = snapshot.maxTokens;
    body.reasoning_effort = reasoningEffort;
    if (options.stream) body.stream_options = { include_usage: true };
  }
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(`${snapshot.baseUrl.replace(/\/+$/, '')}/${responses ? 'responses' : 'chat/completions'}`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json',
        ...(snapshot.simulateCodexClient ? {
          'User-Agent': CODEX_DESKTOP_USER_AGENT,
          'x-codex-v': '1.0.0',
        } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      // Inspect redirects as a permanent HTTP failure without forwarding credentials.
      body: JSON.stringify(body), signal, redirect: 'manual',
    });
  } catch {
    throw new UpstreamError(signal.aborted ? '请求已中断。' : '无法连接上游 API，请检查地址、网络或 TLS 配置。',
      !signal.aborted, signal.aborted ? 'aborted' : 'network');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500 && response.status < 600;
    throw new UpstreamError(`上游 HTTP ${response.status}；请检查服务地址、密钥、模型权限、额度或重定向配置。`, retryable, 'http', response.status);
  }
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_RESPONSE_BYTES) { await response.body?.cancel().catch(() => undefined); throw new UpstreamError('上游响应超过 4 MB 限制。', false, 'invalid-response'); }
  const reader = response.body?.getReader();
  if (!reader) throw new UpstreamError('上游响应为空。', false, 'invalid-response');
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try { read = await reader.read(); }
    catch { throw new UpstreamError(signal.aborted ? '请求已中断。' : '读取上游响应时连接中断。', !signal.aborted, signal.aborted ? 'aborted' : 'network'); }
    const { done, value } = read;
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new UpstreamError('上游响应超过 4 MB 限制。', false, 'invalid-response'); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let result: UpstreamResult;
  if (!/^\s*[\[{]/.test(text) && (response.headers.get('content-type')?.includes('text/event-stream') || /^\s*(?:data:|event:|:)/.test(text))) {
    result = responses ? parseResponsesStream(text) : parseChatStream(text);
  } else {
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw new UpstreamError('上游返回的内容不是有效 JSON；请检查 API 协议与地址。', false, 'invalid-response'); }
    result = responses ? parseResponses(payload) : parseChat(payload);
  }
  if (apiKey) {
    for (const key of ['output', 'reasoning', 'html', 'error'] as const) result[key] = result[key].split(apiKey).join('[密钥已隐藏]');
  }
  return result;
}
