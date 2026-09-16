import type { MouseEvent, ReactNode } from 'react';
import { ArrowRight, Clock3, RefreshCw } from 'lucide-react';
import type { Run } from '../shared/types';
import './retry-info.css';

type Props = { run: Run; onOpen?: (id: string) => void; compact?: boolean };
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

export function RetryInfo({ run, onOpen, compact = false }: Props) {
  const limit = isCount(run.retryLimit) ? run.retryLimit : null;
  const attempt = isCount(run.retryAttempt) ? run.retryAttempt : null;
  const hasMetadata = limit !== null || attempt !== null || run.retryKind || run.retryRootId || run.retryOf || run.nextRetryId || run.retryAt;
  if (run.source !== 'api' || !hasMetadata) return null;

  const automatic = run.retryKind === 'automatic' || (attempt !== null && attempt > 0);
  const retryDate = run.status === 'queued' && run.retryAt ? new Date(run.retryAt) : null;
  const waiting = retryDate && !Number.isNaN(retryDate.getTime());
  const rootId = run.retryRootId && run.retryRootId !== run.id ? run.retryRootId : null;
  const previousId = run.retryOf && run.retryOf !== run.id && run.retryOf !== rootId ? run.retryOf : null;

  const initialOnly = !automatic && run.retryKind !== 'manual' && !waiting && !rootId && !previousId
    && (!run.nextRetryId || run.nextRetryId === run.id);

  function link(id: string, children: ReactNode) {
    function open(event: MouseEvent<HTMLAnchorElement>) {
      if (!onOpen || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation(); onOpen(id);
    }
    return <a className="retry-info-link" href={`/?run=${encodeURIComponent(id)}`} onClick={open}>{children}<ArrowRight size={12} aria-hidden="true" /></a>;
  }

  return <div className={`retry-info${compact ? ' retry-info-compact' : ''}${initialOnly ? ' retry-info-initial' : ''}`} aria-label="测试重试信息">
    <span className={`retry-info-badge${automatic ? ' automatic' : ''}`}><RefreshCw size={12} aria-hidden="true" />{automatic
      ? attempt !== null ? `自动重试 第 ${attempt}${limit !== null ? ` / ${limit}` : ''} 次` : '自动重试'
      : run.retryKind === 'manual' ? '手动重新测试' : '首次调用'}</span>
    {!compact && !automatic && limit !== null && <span className="retry-info-policy">{limit === 0 ? '自动重试已关闭' : `失败时最多额外重试 ${limit} 次`}</span>}
    {waiting && <span className="retry-info-wait"><Clock3 size={12} aria-hidden="true" />等待重试，最早 <time dateTime={run.retryAt}>{retryDate.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time> 执行</span>}
    {run.nextRetryId && run.nextRetryId !== run.id && link(run.nextRetryId, '已安排下一次重试')}
    {rootId && link(rootId, '查看原始记录')}
    {previousId && !compact && link(previousId, '查看上一次记录')}
  </div>;
}

export default RetryInfo;
