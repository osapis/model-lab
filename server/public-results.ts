import type { StoredRun } from './store.ts';

const attemptNumber = (run: StoredRun) => Number.isInteger(run.retryAttempt) && run.retryAttempt! >= 0 ? run.retryAttempt! : 0;
const automatic = (run: StoredRun) => run.retryKind === 'automatic'
  || (!run.retryKind && attemptNumber(run) > 0 && Boolean(run.retryRootId && run.retryRootId !== run.id));
const testKey = (run: StoredRun) => JSON.stringify([
  run.source, run.batchId, run.providerId || run.execution?.providerId || run.providerName,
  run.modelId, run.promptId, run.category,
]);
const chainKey = (run: StoredRun) => JSON.stringify([
  testKey(run), automatic(run) ? run.retryRootId || run.retryOf || run.id : run.id,
]);

/**
 * Project one outcome per automatic retry chain without deleting attempt history.
 * Apply this to the complete history before filtering, sorting or pagination.
 * A failed attempt is superseded only when a replacement was actually scheduled:
 * remaining retry budget alone does not prove that a terminal error will retry.
 */
export function publicResultRuns(runs: StoredRun[]): StoredRun[] {
  const byId = new Map(runs.map(run => [run.id, run]));
  const superseded = new Set<string>();
  const highestAutomaticAttempt = new Map<string, number>();

  for (const run of runs) {
    if (run.source !== 'api') continue;
    if (run.status === 'failed' && run.nextRetryId) {
      const successor = byId.get(run.nextRetryId);
      // Keep the marker authoritative when an administrator deleted a successor.
      // Deleting a recovered result must not resurrect its previous red cards.
      if (!successor || (automatic(successor) && testKey(successor) === testKey(run))) superseded.add(run.id);
    }
    if (!automatic(run)) continue;
    const key = chainKey(run);
    highestAutomaticAttempt.set(key, Math.max(highestAutomaticAttempt.get(key) ?? 0, attemptNumber(run)));
    const parent = run.retryOf && byId.get(run.retryOf);
    if (parent && parent.status === 'failed' && testKey(parent) === testKey(run)) superseded.add(parent.id);
  }

  return runs.filter(run => run.source !== 'api' || run.status !== 'failed'
    || (!superseded.has(run.id) && (highestAutomaticAttempt.get(chainKey(run)) ?? 0) <= attemptNumber(run)));
}
