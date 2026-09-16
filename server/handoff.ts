import { existsSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { ARTIFACT_MAX_BYTES, ARTIFACT_MEMORY_LIMIT_BYTES, type ArtifactStore } from './artifacts.ts';
import type { Store, StoredRun } from './store.ts';

const snapshotSchema = z.object({
  version: z.literal(1),
  runs: z.array(z.object({ id: z.string().min(1), output: z.string(), html: z.string(), reasoning: z.string() })).max(1000),
});

/** One-time RAM-to-RAM transfer during a controlled service upgrade. */
export function restoreArtifactsFromHandoff(store: Store, artifacts: ArtifactStore, path = process.env.ARTIFACT_HANDOFF_PATH): number {
  if (!path || !existsSync(path)) return 0;
  const resolved = realpathSync(path);
  if (!resolved.startsWith('/dev/shm/')) throw new Error('作品交接文件必须位于 /dev/shm 内存文件系统。');
  const info = statSync(resolved);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > ARTIFACT_MEMORY_LIMIT_BYTES) {
    throw new Error('作品交接文件权限或大小无效，原文件已保留。');
  }
  const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(resolved, 'utf8')));
  const seen = new Set<string>();
  const entries = snapshot.runs.flatMap(entry => {
    if (seen.has(entry.id)) throw new Error('作品交接文件含重复记录。');
    seen.add(entry.id);
    const run = store.get<StoredRun>('runs', entry.id);
    if (!run || run.source === 'sample' || run.artifact?.storage !== 'memory' || ['queued', 'running'].includes(run.status)) return [];
    const { id, ...payload } = entry;
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > ARTIFACT_MAX_BYTES) throw new Error('交接作品超过大小限制，原文件已保留。');
    return [{ run, payload, bytes }];
  });
  if (entries.reduce((sum, entry) => sum + entry.bytes, 0) > ARTIFACT_MEMORY_LIMIT_BYTES - Math.ceil(artifacts.status().memoryUsedMb * 1024 * 1024)) {
    throw new Error('内存空间不足以完整恢复交接作品，原文件已保留。');
  }
  store.transaction(() => {
    for (const { run, payload } of entries) {
      const artifact = artifacts.putMemory(run.id, payload);
      store.put('runs', { ...run, artifact, artifactAvailable: true, artifactStorage: 'memory', hasHtml: Boolean(payload.html) });
    }
  });
  unlinkSync(resolved);
  return entries.length;
}
