import type { Run } from './types.ts';

export interface ReasoningHistoryEntry {
  id: string; createdAt: string; finishedAt?: string | null; modelName: string; reasoningEffort: string; status: Run['status'];
  verdict: 'correct' | 'incorrect' | 'failed' | 'pending' | 'unavailable'; answer: string; error: string;
  expectedAnswer?: string;
}
export interface ReasoningHistoryRow { providerId: string; providerName: string; entries: ReasoningHistoryEntry[] }
export interface ReasoningHistoryResponse { from: string; to: string; expectedAnswer: string; rows: ReasoningHistoryRow[] }
