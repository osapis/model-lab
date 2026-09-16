export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

// Migrate unsupported legacy settings without rewriting historical run snapshots.
export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (value === 'minimal' || value === 'none') return 'low';
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? value as ReasoningEffort : 'medium';
}
