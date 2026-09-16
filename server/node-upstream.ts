import { Agent } from 'undici';

/** Node-only transport; the run queue's AbortSignal owns the whole request deadline. */
export function createNodeUpstreamTransport() {
  // Node's default fetch transport otherwise stops at 300 seconds while waiting
  // for response headers or between response body chunks, before a long run expires.
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  const upstreamFetch: typeof fetch = (input, init) => {
    const options: RequestInit & { dispatcher: Agent } = { ...init, dispatcher };
    return fetch(input, options);
  };
  return { fetch: upstreamFetch, close: () => dispatcher.close() };
}
