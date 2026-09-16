import type { Run } from './types.ts';

type GroupableRun = Pick<Run, 'id' | 'source' | 'batchId' | 'createdAt' | 'batchCreatedAt' | 'providerId' | 'providerName'
  | 'modelId' | 'modelSlug' | 'modelName' | 'parameters' | 'category' | 'promptId' | 'promptTitle'>
  & { execution?: { providerId?: string } };

const validAt = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? value : null;
const compareText = new Intl.Collator('zh-CN', { numeric: true }).compare;
const categories = { visual: 0, reasoning: 1, text: 2 };

/** A source and invocation batch remain together even when retries finish the next day. */
export function runBatchKey(run: Pick<Run, 'source' | 'batchId' | 'id'>): string {
  return JSON.stringify([run.source, run.batchId || run.id]);
}

export function runModelGroupKey(run: GroupableRun): string {
  return JSON.stringify([runBatchKey(run), run.providerId || run.execution?.providerId || run.providerName,
    run.modelId || run.modelSlug || run.modelName, run.parameters?.reasoningEffort || '']);
}

/** This is a section timestamp, not the completion time displayed on result cards. */
export function runBatchAt(run: Pick<Run, 'batchCreatedAt' | 'createdAt'>): string | null {
  return validAt(run.batchCreatedAt) ?? validAt(run.createdAt);
}

/** Use the complete stored history, including superseded retry attempts, when available. */
export function resultBatchTimes(runs: GroupableRun[]): Map<string, string> {
  const times = new Map<string, string>();
  for (const run of runs) {
    const timestamp = runBatchAt(run);
    if (!timestamp) continue;
    const key = runBatchKey(run);
    const current = times.get(key);
    if (!current || Date.parse(timestamp) < Date.parse(current)) times.set(key, timestamp);
  }
  return times;
}

export interface ResultModelGroup<T extends GroupableRun> { key: string; batchKey: string; runs: T[] }

/** Ordering never depends on completion status/time, so live updates cannot scatter a pair. */
export function groupResultRuns<T extends GroupableRun>(runs: T[], batchTimes = resultBatchTimes(runs)): ResultModelGroup<T>[] {
  const groups = new Map<string, ResultModelGroup<T>>();
  for (const run of runs) {
    const key = runModelGroupKey(run);
    const existing = groups.get(key);
    if (existing) existing.runs.push(run);
    else groups.set(key, { key, batchKey: runBatchKey(run), runs: [run] });
  }
  for (const group of groups.values()) group.runs.sort((a, b) => categories[a.category] - categories[b.category]
    || compareText(a.promptTitle, b.promptTitle) || compareText(a.promptId, b.promptId)
    || (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || compareText(a.id, b.id));
  return [...groups.values()].sort((a, b) => {
    const batchOrder = (Date.parse(batchTimes.get(b.batchKey) || '') || 0) - (Date.parse(batchTimes.get(a.batchKey) || '') || 0)
      || compareText(a.batchKey, b.batchKey);
    if (batchOrder) return batchOrder;
    const first = a.runs[0]!;
    const second = b.runs[0]!;
    return compareText(first.providerName, second.providerName)
      || compareText(first.providerId || first.execution?.providerId || '', second.providerId || second.execution?.providerId || '')
      || compareText(first.modelName, second.modelName) || compareText(first.modelId || first.modelSlug, second.modelId || second.modelSlug)
      || compareText(first.parameters?.reasoningEffort || '', second.parameters?.reasoningEffort || '') || compareText(a.key, b.key);
  });
}

/** A page may exceed its target only when one indivisible API/model group is larger. */
export function paginateResultGroups<T extends GroupableRun>(groups: ResultModelGroup<T>[], limit: number, requestedPage: number) {
  const pages: T[][] = [];
  let current: T[] = [];
  for (const group of groups) {
    if (current.length && current.length + group.runs.length > limit) { pages.push(current); current = []; }
    current.push(...group.runs);
  }
  if (current.length) pages.push(current);
  const pageCount = Math.max(1, pages.length);
  const page = Math.min(requestedPage, pageCount - 1);
  return { runs: pages[page] ?? [], page, pageCount };
}
