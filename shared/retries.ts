export const DEFAULT_AUTO_RETRIES = 5;
export const MAX_AUTO_RETRIES = 10;

export function normalizeMaxRetries(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_AUTO_RETRIES
    ? value : DEFAULT_AUTO_RETRIES;
}
