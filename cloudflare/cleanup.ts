import type { Store, StoredProvider, StoredRun } from '../server/store.ts';
import type { ArtifactRef } from '../server/artifacts.ts';
import type { CloudflareArtifactStore } from './artifacts.ts';

const same = (a: ArtifactRef, b: ArtifactRef) => a.storage === b.storage && a.configId === b.configId && a.key === b.key;

/** A bounded cleanup slice: even with 30s R2 timeouts it cannot consume an alarm's 15min budget. */
export async function cleanupCloudBatch(store: Store, artifacts: CloudflareArtifactStore, now = Date.now()): Promise<boolean> {
  const all = store.all<StoredRun>('runs');
  const providers = new Map(store.all<StoredProvider>('providers').map(provider => [provider.id, provider]));
  const defaultDays = store.settings().retentionDays;
  let operations = 0, removed = 0, remaining = false;
  const expired = (run: StoredRun) => run.source !== 'sample' && !['queued', 'running'].includes(run.status)
    && Date.parse(run.finishedAt || run.createdAt) < now - (providers.get(run.providerId || run.execution?.providerId || '')?.retentionDays ?? defaultDays) * 86_400_000;
  for (const snapshot of all) {
    if (operations >= 8 || removed >= 40) { remaining = true; break; }
    let current = store.get<StoredRun>('runs', snapshot.id);
    if (!current || ['queued', 'running'].includes(current.status)) continue;
    const shouldDelete = expired(current);
    const refs = [...(current.pendingArtifactDeletes || []), ...(shouldDelete && current.artifact ? [current.artifact] : [])];
    let failed = false;
    for (const ref of refs) {
      if (operations >= 8) { remaining = true; failed = true; break; }
      operations++;
      try {
        await artifacts.delete(ref);
        const fresh = store.get<StoredRun>('runs', snapshot.id);
        if (!fresh) break;
        const pending = (fresh.pendingArtifactDeletes || []).filter(item => !same(item, ref));
        store.put('runs', { ...fresh, pendingArtifactDeletes: pending, cleanupError: '',
          ...(shouldDelete && fresh.artifact && same(fresh.artifact, ref) ? { artifact: undefined, artifactAvailable: false } : {}) });
      } catch {
        const fresh = store.get<StoredRun>('runs', snapshot.id);
        if (fresh) store.put('runs', { ...fresh, cleanupError: '云端正文删除失败，记录已保留，下一轮自动重试。' });
        failed = true; remaining = true; break;
      }
    }
    current = store.get<StoredRun>('runs', snapshot.id);
    if (current && shouldDelete && !failed && expired(current) && !current.artifact && !current.pendingArtifactDeletes?.length) {
      store.delete('runs', current.id); removed++;
    }
  }
  const references = new Set(store.all<StoredRun>('runs').flatMap(run => [...(run.pendingArtifactDeletes || []), ...(run.artifact ? [run.artifact] : [])])
    .map(ref => `${ref.storage}:${ref.configId || ''}:${ref.key}`));
  // Recheck synchronously before deleting each orphan; a completed upload may have committed meanwhile.
  await artifacts.cleanupPending(ref => references.has(`${ref.storage}:${ref.configId || ''}:${ref.key}`)
    || store.all<StoredRun>('runs').some(run => [...(run.pendingArtifactDeletes || []), ...(run.artifact ? [run.artifact] : [])].some(item => same(item, ref))), 5);
  if (store.db.prepare('SELECT 1 FROM artifact_pending LIMIT 1').get()) remaining = true;
  return !remaining;
}
