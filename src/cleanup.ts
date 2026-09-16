import type { Run } from '../shared/types';
import { api } from './api';

export interface CleanupFilters {
  providerId?: string; modelId?: string; status?: string; source?: string; q?: string;
}
export interface CleanupResult {
  deletedIds: string[]; missingIds: string[]; skippedIds: string[];
  failures: { id: string; error: string }[];
}

const terminal = new Set<Run['status']>(['completed', 'failed', 'cancelled']);

/** Collect the selected IDs before confirmation; deletion never re-evaluates filters. */
export async function collectCleanupCandidates(
  filters: CleanupFilters,
  options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {},
): Promise<{ runs: Run[]; activeCount: number }> {
  const collected = new Map<string, Run>();
  const pageSize = 200;
  let offset = 0;
  while (true) {
    options.signal?.throwIfAborted();
    const params = new URLSearchParams({ offset: String(offset), limit: String(pageSize) });
    for (const key of ['providerId', 'modelId', 'status', 'source', 'q'] as const) {
      const value = filters[key]?.trim();
      if (value && (key === 'q' || value !== 'all')) params.set(key, value);
    }
    const result = await api<{ runs: Run[]; total: number }>(`/api/admin/runs?${params}`, { signal: options.signal });
    options.signal?.throwIfAborted();
    if (!Array.isArray(result.runs) || !Number.isInteger(result.total) || result.total < 0 ||
      result.runs.some(run => !run || typeof run.id !== 'string' || !run.id || typeof run.status !== 'string')) {
      throw new Error('历史列表响应无效，未执行任何删除，请刷新后重试。');
    }
    for (const run of result.runs) collected.set(run.id, run);
    options.onProgress?.(collected.size, result.total);
    offset += result.runs.length;
    if (!result.runs.length || offset >= result.total) break;
  }
  const rows = [...collected.values()];
  return { runs: rows.filter(run => terminal.has(run.status)), activeCount: rows.filter(run => !terminal.has(run.status)).length };
}

/** Reuse the server's authenticated, cloud-first delete route with bounded concurrency. */
export async function deleteSelectedRuns(
  ids: string[],
  options: { onProgress?: (done: number, total: number) => void } = {},
): Promise<CleanupResult> {
  const selected = [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0))];
  const result: CleanupResult = { deletedIds: [], missingIds: [], skippedIds: [], failures: [] };
  let next = 0; let done = 0; let authenticationError = '';
  options.onProgress?.(0, selected.length);
  async function worker() {
    while (next < selected.length) {
      const id = selected[next++];
      try {
        if (authenticationError) {
          result.failures.push({ id, error: authenticationError });
          continue;
        }
        const response = await fetch(`/api/admin/runs/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
        if (response.ok) result.deletedIds.push(id);
        else if (response.status === 404) result.missingIds.push(id);
        else if (response.status === 409) result.skippedIds.push(id);
        else {
          const body = await response.json().catch(() => ({}));
          const message = typeof body.error === 'string' ? body.error : `删除失败（HTTP ${response.status}），记录已保留，请重试。`;
          if (response.status === 401 || response.status === 403) authenticationError = `${message} 已停止后续删除。`;
          result.failures.push({ id, error: message });
        }
      } catch {
        result.failures.push({ id, error: '网络中断，无法确认删除结果；请刷新或重试。' });
      } finally {
        done++; options.onProgress?.(done, selected.length);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, () => worker()));
  return result;
}
