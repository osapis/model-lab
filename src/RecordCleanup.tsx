import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, Trash2, X, XCircle } from 'lucide-react';
import type { Run } from '../shared/types';
import { collectCleanupCandidates, deleteSelectedRuns, type CleanupFilters, type CleanupResult } from './cleanup';
import './record-cleanup.css';

const isActive = (run: Run) => run.status === 'queued' || run.status === 'running';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '清理失败，请稍后重试';

export function useRecordCleanup({ filters, onChanged, onBusyChange }: {
  filters: CleanupFilters;
  onChanged: (deletedIds?: string[]) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState<Map<string, Run>>(new Map());
  const [phase, setPhase] = useState<'idle' | 'collecting' | 'deleting'>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [activeCount, setActiveCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [confirmation, setConfirmation] = useState<{ runs: Run[]; scope: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const phaseRef = useRef(phase);
  const attemptedRuns = useRef<Run[]>([]);
  const epoch = useRef(0);
  const filterKey = JSON.stringify(filters);
  const locked = phase !== 'idle';

  function changePhase(next: typeof phase) {
    phaseRef.current = next;
    setPhase(next);
    onBusyChange(next !== 'idle');
  }

  function clearSelection() {
    setSelected(new Map());
    setConfirmation(null);
  }

  function reset() {
    if (phaseRef.current === 'deleting') return;
    epoch.current++;
    controller.current?.abort();
    controller.current = null;
    if (phaseRef.current === 'collecting') changePhase('idle');
    clearSelection();
    setActiveCount(null);
    setResult(null);
    setError('');
  }

  useEffect(() => {
    reset();
  }, [filterKey]);

  useEffect(() => () => {
    epoch.current++;
    controller.current?.abort();
    onBusyChange(false);
  }, [onBusyChange]);

  function toggleMode() {
    if (phaseRef.current !== 'idle') return;
    reset();
    setEnabled((current) => !current);
  }

  function toggleRun(run: Run) {
    if (phaseRef.current !== 'idle' || isActive(run)) return;
    setConfirmation(null);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(run.id)) next.delete(run.id);
      else next.set(run.id, run);
      return next;
    });
  }

  function selectPage(runs: Run[]) {
    if (phaseRef.current !== 'idle') return;
    setConfirmation(null);
    setSelected((current) => {
      const next = new Map(current);
      for (const run of runs) if (!isActive(run)) next.set(run.id, run);
      return next;
    });
  }

  async function selectAll() {
    if (phaseRef.current !== 'idle') return;
    const version = ++epoch.current;
    const abortController = new AbortController();
    controller.current = abortController;
    setConfirmation(null); setError(''); setResult(null); setActiveCount(null);
    setProgress({ done: 0, total: 0 });
    changePhase('collecting');
    try {
      const candidates = await collectCleanupCandidates(filters, {
        signal: abortController.signal,
        onProgress: (done, total) => { if (version === epoch.current) setProgress({ done, total }); },
      });
      if (version !== epoch.current) return;
      setSelected(new Map(candidates.runs.map((run) => [run.id, run])));
      setActiveCount(candidates.activeCount);
    } catch (err) {
      if (version === epoch.current) setError(errorMessage(err));
    } finally {
      if (version === epoch.current) { controller.current = null; changePhase('idle'); }
    }
  }

  function requestConfirmation(scope: string) {
    if (phaseRef.current !== 'idle' || !selected.size) return;
    setConfirmation({ runs: [...selected.values()], scope });
  }

  async function confirmDelete() {
    if (phaseRef.current !== 'idle' || !confirmation?.runs.length) return;
    const snapshot = confirmation.runs;
    const version = ++epoch.current;
    attemptedRuns.current = snapshot;
    setError(''); setResult(null); setProgress({ done: 0, total: snapshot.length });
    changePhase('deleting');
    try {
      const next = await deleteSelectedRuns(snapshot.map((run) => run.id), {
        onProgress: (done, total) => { if (version === epoch.current) setProgress({ done, total }); },
      });
      if (version !== epoch.current) return;
      const failedIds = new Set(next.failures.map((failure) => failure.id));
      setSelected(new Map(snapshot.filter((run) => failedIds.has(run.id)).map((run) => [run.id, run])));
      setConfirmation(null); setResult(next); setActiveCount(null);
      try { await onChanged([...next.deletedIds, ...next.missingIds]); }
      catch (err) { if (version === epoch.current) setError(`删除请求已处理，但刷新记录失败：${errorMessage(err)}。请刷新数据确认。`); }
    } catch (err) {
      if (version === epoch.current) {
        setError(`清理中断：${errorMessage(err)}。已选记录仍保留在选择列表，请刷新后重试。`);
        setConfirmation(null);
      }
      try { await onChanged(); } catch { /* The existing error remains actionable. */ }
    } finally {
      if (version === epoch.current) changePhase('idle');
    }
  }

  function selectFailed() {
    if (phaseRef.current !== 'idle' || !result) return;
    const ids = new Set(result.failures.map((failure) => failure.id));
    setSelected(new Map(attemptedRuns.current.filter((run) => ids.has(run.id)).map((run) => [run.id, run])));
    setConfirmation(null);
  }

  return {
    enabled, selected, phase, locked, progress, activeCount, error, result, confirmation,
    reset, clearSelection, toggleMode, toggleRun, selectPage, selectAll,
    requestConfirmation, confirmDelete, selectFailed,
    cancelConfirmation: () => { if (phaseRef.current === 'idle') setConfirmation(null); },
  };
}

type Cleanup = ReturnType<typeof useRecordCleanup>;

export function RecordCleanup({ cleanup, runs, scope, hasFilters, unavailable }: {
  cleanup: Cleanup; runs: Run[]; scope: string; hasFilters: boolean; unavailable: boolean;
}) {
  if (!cleanup.enabled) return null;
  const disabled = cleanup.locked || unavailable;
  const pageCandidates = runs.filter((run) => !isActive(run));
  const pageSelected = pageCandidates.filter((run) => cleanup.selected.has(run.id)).length;
  const snapshot = cleanup.confirmation;
  const summary = cleanup.result;
  return <div className="admin-record-cleanup" aria-label="批量清理测试记录" aria-busy={cleanup.locked}>
    <div className="admin-cleanup-heading"><strong>已选 <span>{cleanup.selected.size}</span> 条记录</strong><span>跨页保留选择 · 更改筛选会清空选择</span></div>
    <p className="admin-cleanup-scope">筛选范围：{scope}</p>
    <div className="admin-cleanup-actions">
      <button type="button" className="admin-button admin-button-small" disabled={disabled || !pageCandidates.length || pageSelected === pageCandidates.length} onClick={() => cleanup.selectPage(runs)}>全选当前页{pageCandidates.length > 0 && `（${pageCandidates.length}）`}</button>
      <button type="button" className="admin-button admin-button-small" disabled={disabled} onClick={() => cleanup.selectAll()}>{hasFilters ? '全选当前筛选结果（所有页）' : '全选全部历史（所有页）'}</button>
      <button type="button" className="admin-text-button" disabled={disabled || !cleanup.selected.size} onClick={cleanup.clearSelection}>取消全选</button>
      <button type="button" className="admin-button admin-button-danger admin-cleanup-delete" disabled={disabled || !cleanup.selected.size} onClick={() => cleanup.requestConfirmation(scope)}><Trash2 size={15} />删除所选（{cleanup.selected.size}）</button>
    </div>
    <p className="admin-cleanup-help">仅选择已完成、失败或已取消的记录。等待中、测试中的任务请先展开记录取消。</p>
    {cleanup.activeCount !== null && <p className="admin-cleanup-help" role="status">已读取全部分页；跳过 {cleanup.activeCount} 条进行中的任务。新产生的记录不会自动加入选择。</p>}
    {cleanup.locked && <div className="admin-cleanup-progress" role="status"><LoaderCircle size={16} className="admin-spin" /><span>{cleanup.phase === 'collecting' ? '正在读取所有分页' : '正在删除记录与作品'}：{cleanup.progress.done} / {cleanup.progress.total || '…'}{cleanup.phase === 'deleting' && '，请保持此页面打开。'}</span></div>}
    {cleanup.error && <div className="admin-alert admin-alert-error" role="alert"><XCircle size={16} /><span>{cleanup.error}</span></div>}
    {summary && <div className={`admin-cleanup-result ${summary.failures.length ? 'has-errors' : ''}`} role="status">
      <strong><CheckCircle2 size={16} />清理完成：已删除 {summary.deletedIds.length} 条</strong>
      <p>已不存在 {summary.missingIds.length} 条 · 运行中跳过 {summary.skippedIds.length} 条 · 删除失败 {summary.failures.length} 条</p>
      {(summary.failures.length > 0 || summary.skippedIds.length > 0) && <p>运行中的任务已跳过；失败项保留在选择列表，可刷新确认或重试。云端作品未删除成功的记录不会计入成功数。</p>}
      {summary.failures.length > 0 && <><details><summary>查看失败原因（{summary.failures.length} 条）</summary><ul>{summary.failures.map((failure) => <li key={failure.id}><code>{failure.id.slice(0, 12)}</code>：{failure.error}</li>)}</ul></details><button type="button" className="admin-button admin-button-small" disabled={disabled} onClick={cleanup.selectFailed}>选择失败项后重试（{summary.failures.length}）</button></>}
    </div>}
    {snapshot && <div className="admin-cleanup-confirm" role="group" aria-labelledby="cleanup-confirm-title">
      <strong id="cleanup-confirm-title">确认永久删除这 {snapshot.runs.length} 条测试记录？</strong>
      <p>其中包含 <b>{snapshot.runs.filter((run) => run.source === 'sample').length} 条会话子代理样例</b>。所选记录的原始回答及 SVG / HTML 作品将一起删除，包括对应的云端作品，无法恢复。</p>
      <p>选择时的筛选范围：{snapshot.scope}</p>
      <div className="admin-cleanup-actions"><button type="button" className="admin-button admin-button-danger" disabled={disabled} onClick={() => cleanup.confirmDelete()}>{cleanup.phase === 'deleting' ? <LoaderCircle size={15} className="admin-spin" /> : <Trash2 size={15} />}确认删除 {snapshot.runs.length} 条</button><button type="button" className="admin-button" disabled={cleanup.locked} onClick={cleanup.cancelConfirmation}><X size={15} />取消</button></div>
    </div>}
  </div>;
}
