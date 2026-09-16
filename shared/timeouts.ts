export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 600;
export const MIN_REQUEST_TIMEOUT_SECONDS = 30;
// Leave room for result persistence before Cloudflare's 15-minute alarm limit.
export const MAX_REQUEST_TIMEOUT_SECONDS = 720;

export function normalizeRequestTimeoutSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_REQUEST_TIMEOUT_SECONDS && value <= MAX_REQUEST_TIMEOUT_SECONDS
    ? value : DEFAULT_REQUEST_TIMEOUT_SECONDS;
}
