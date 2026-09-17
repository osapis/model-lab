import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { ReasoningHistoryEntry, ReasoningHistoryResponse } from '../shared/reasoning-history';
import { runFinishedAt, runResultAt } from '../shared/run-time';
import { hourlyEntries, type HourSlot } from '../shared/reasoning-hours';
import { api } from './api';
import { lockPageScroll } from './dialog-scroll';
import './reasoning-history.css';

const historyPollMs = 60_000;
const manualRefreshGapMs = 1_000;
const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const hourFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const calendarFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const verdictNames: Record<ReasoningHistoryEntry['verdict'], string> = { correct: '正确', incorrect: '错误', failed: '调用失败', pending: '执行中', unavailable: '无法判定' };
const statusNames: Record<ReasoningHistoryEntry['status'], string> = { completed: '已完成', failed: '失败', queued: '排队中', running: '运行中', cancelled: '已取消' };
interface Selection { providerId: string; hourStart: number; entryId: string | null; anchor: HTMLElement; mode: 'popover' | 'sheet'; takeFocus: boolean }

function formattedTime(value: string | number | null, formatter = dateTimeFormat): string {
  const instant = new Date(value ?? Number.NaN);
  return Number.isFinite(instant.getTime()) ? formatter.format(instant) : '未记录时间';
}

function entryTimeLabel(entry: ReasoningHistoryEntry): string {
  if (runFinishedAt(entry)) return entry.status === 'completed' ? '完成时间' : '结束时间';
  return entry.status === 'queued' || entry.status === 'running'
    ? '创建时间（尚未完成）' : '创建时间（未记录完成时间）';
}

export default function ReasoningHistory({ providerId, query, refreshVersion, onOpen }: { providerId: string; query: string; refreshVersion: number; onOpen: (id: string) => void }) {
  const [data, setData] = useState<ReasoningHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const refreshRequest = useRef<() => void>(() => {});
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const suppressFocus = useRef<HTMLElement | null>(null);
  const recordFocusGuard = useRef<HTMLElement | null>(null);
  const lastRefreshVersion = useRef(refreshVersion);
  const regionId = useId();
  const trimmedQuery = query.trim();

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;
    let lastRequestAt = 0;
    setLoading(true); setData(null); setSelection(null); setError('');
    const params = new URLSearchParams();
    if (providerId !== 'all') params.set('providerId', providerId);
    if (trimmedQuery) params.set('q', trimmedQuery);
    const schedule = (delay = historyPollMs, force = false) => {
      clearTimeout(timer);
      if (!cancelled && !document.hidden) timer = window.setTimeout(() => { timer = undefined; void request(force); }, delay);
    };
    const request = async (force = false, immediately = false) => {
      if (cancelled || document.hidden) return;
      clearTimeout(timer); timer = undefined;
      if (inFlight) return;
      const remaining = (force ? manualRefreshGapMs : historyPollMs) - (Date.now() - lastRequestAt);
      if (!immediately && lastRequestAt && remaining > 0) { schedule(remaining, force); return; }
      lastRequestAt = Date.now();
      inFlight = true;
      setRefreshing(true); setError('');
      try {
        const result = await api<ReasoningHistoryResponse>(`/api/public/reasoning-history?${params}`, { signal: controller.signal });
        if (!cancelled) setData(result);
      } catch (err) { if (!cancelled) setError((err as Error).message); }
      finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false); setRefreshing(false);
          schedule();
        }
      }
    };
    refreshRequest.current = () => { void request(true); };
    schedule(180, true);
    const onVisibility = () => { if (document.hidden) { clearTimeout(timer); timer = undefined; } else void request(true, true); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      controller.abort(); clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      refreshRequest.current = () => {};
    };
  }, [providerId, trimmedQuery]);

  useEffect(() => {
    if (lastRefreshVersion.current === refreshVersion) return;
    lastRefreshVersion.current = refreshVersion;
    refreshRequest.current();
  }, [refreshVersion]);
  const closeSelection = useCallback((restoreFocus = true) => {
    const anchor = selectionRef.current?.anchor;
    if (anchor) suppressFocus.current = anchor;
    setSelection(null);
    window.requestAnimationFrame(() => {
      if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
      if (suppressFocus.current === anchor) suppressFocus.current = null;
    });
  }, []);
  useEffect(() => {
    const keyboardIntent = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !document.querySelector('dialog[open]')) recordFocusGuard.current = null;
    };
    document.addEventListener('keydown', keyboardIntent, true);
    return () => document.removeEventListener('keydown', keyboardIntent, true);
  }, []);

  const preparedRows = useMemo(() => data?.rows.map(row => {
    const hours = hourlyEntries(row, data.from, data.to);
    return { row: { ...row, entries: hours.flatMap(hour => hour.entries) }, hours };
  }) || [], [data]);
  const selectedRow = selection ? preparedRows.find(item => item.row.providerId === selection.providerId) : undefined;
  const selectedHour = selectedRow && selection ? selection.entryId
    ? selectedRow.hours.find(hour => hour.entries.some(entry => entry.id === selection.entryId))
    : selectedRow.hours.find(hour => hour.start === selection.hourStart) : undefined;
  const selectedEntry = selectedHour?.entries.find(entry => entry.id === selection?.entryId);
  const overlayId = `${regionId}-detail`;
  useEffect(() => {
    if (selection && (!selectedHour || (selection.entryId && !selectedEntry))) closeSelection(false);
  }, [selection, selectedHour, selectedEntry, closeSelection]);

  const openSelection = (provider: string, hourStart: number, entryId: string | null, anchor: HTMLElement, intent: 'hover' | 'focus' | 'activate' | 'hour') => {
    if (intent === 'focus' && (suppressFocus.current === anchor || recordFocusGuard.current === anchor)) return;
    if (intent === 'hover' && recordFocusGuard.current === anchor) return;
    if (intent === 'activate' || intent === 'hour' || intent === 'hover') recordFocusGuard.current = null;
    const compact = window.matchMedia('(max-width: 640px), (pointer: coarse)').matches;
    if (compact && (intent === 'hover' || intent === 'focus')) return;
    const mode = compact || intent === 'hour' ? 'sheet' : 'popover';
    setSelection(current => current?.providerId === provider && current.entryId === entryId && current.hourStart === hourStart && current.mode === mode && intent !== 'activate' ? current : { providerId: provider, hourStart, entryId, anchor, mode, takeFocus: intent === 'activate' });
  };

  return <section className="rh-history" aria-labelledby={`${regionId}-title`}>
    <header className="rh-heading"><h3 id={`${regionId}-title`}>逻辑推理 <span className="rh-window-label" title="保留最近24小时的全部记录，按实际完成时间归入整点小时；首尾小时仅展示窗口内记录。">24小时 · 整点分段</span></h3><button className="rh-refresh" aria-label="刷新推理历史" title="刷新推理历史" disabled={refreshing} onClick={() => refreshRequest.current()}><RefreshCw size={15} className={refreshing ? 'spinning' : ''} /></button></header>
    <div className="rh-legend" aria-label={`标准答案${data?.expectedAnswer || '21'}；每条代表一次非失败API调用；样例不计入`}><span className="rh-standard">标准 {data?.expectedAnswer || '21'}</span><span><i className="correct" />正确</span><span><i className="incorrect" />错误</span><span><i className="pending" />进行中</span><span><i className="unavailable" />暂无结果</span></div>
    {error && <div className="rh-error" role="alert"><p>{data ? `刷新失败，保留上次数据：${error}` : error}</p><button onClick={() => refreshRequest.current()}>重试</button></div>}
    {loading ? <div className="rh-loading" role="status"><LoaderCircle size={15} className="spinning" />正在读取记录…</div> : data && <>
      {preparedRows.length ? preparedRows.map(({ row, hours }) => {
        const isSelectedRow = selection?.providerId === row.providerId;
        return <div className="rh-api-row" key={row.providerId}>
          <header className="rh-api-heading"><h4 className="rh-provider-name" title={row.providerName}>{row.providerName || '未命名接口'}</h4><span className="rh-api-count">{row.entries.length} 次</span></header>
          <div className="rh-timeline-scroll" aria-label={`${row.providerName} 最近24小时，点击时段查看调用`}>
            <div className="rh-timeline">
              {hours.map(hour => <div className={`rh-hour ${hour.visibleEnd < hour.end ? 'rh-hour-current' : ''} ${isSelectedRow && selectedHour?.start === hour.start ? 'selected' : ''}`} key={hour.start}>
                <div className="rh-hour-bars">
                  {hour.entries.length ? hour.entries.map(entry => <button key={entry.id} className={`rh-entry ${selectedEntry?.id === entry.id ? 'selected' : ''}`} aria-label={`${entryTimeLabel(entry)} ${formattedTime(runResultAt(entry))}，${entry.modelName}，${verdictNames[entry.verdict]}，答案${entry.answer || '未记录'}`} aria-pressed={selectedEntry?.id === entry.id} aria-controls={overlayId} aria-haspopup="dialog" onPointerEnter={event => { if (event.pointerType !== 'touch') openSelection(row.providerId, hour.start, entry.id, event.currentTarget, 'hover'); }} onPointerLeave={event => { if (recordFocusGuard.current === event.currentTarget && !document.querySelector('dialog[open]')) recordFocusGuard.current = null; }} onFocus={event => openSelection(row.providerId, hour.start, entry.id, event.currentTarget, 'focus')} onClick={event => openSelection(row.providerId, hour.start, entry.id, event.currentTarget, 'activate')}><span className={`rh-bar ${entry.verdict}`} /></button>) : <button className="rh-entry rh-empty-entry" aria-label={`${formattedTime(hour.start)} 至 ${formattedTime(hour.end)}，暂无可展示结果`} aria-controls={overlayId} onClick={event => openSelection(row.providerId, hour.start, null, event.currentTarget, 'activate')}><span className="rh-empty-slot" /></button>}
                </div>
                <button className="rh-hour-open" aria-label={`查看 ${formattedTime(hour.start, hourFormat)} 至 ${formattedTime(hour.end, hourFormat)} 的 ${hour.entries.length} 次调用`} aria-expanded={isSelectedRow && selectedHour?.start === hour.start} aria-controls={overlayId} aria-haspopup="dialog" onClick={event => openSelection(row.providerId, hour.start, hour.entries.find(entry => entry.verdict === 'incorrect')?.id || hour.entries.at(-1)?.id || null, event.currentTarget, 'hour')} />
              </div>)}
            </div>
          </div>
        </div>;
      }) : <div className="rh-empty">没有匹配的 API 接口。</div>}
      {preparedRows.length > 0 && <div className="rh-shared-axis" aria-label={`按整点小时分段；实际范围 ${formattedTime(data.from)} 至 ${formattedTime(data.to)}`} title={`按完成时间统计 ${formattedTime(data.from)} 至 ${formattedTime(data.to)}；首尾小时仅含窗口内记录。`}>
        {preparedRows[0].hours.map((hour, index, hours) => <span className="rh-axis-slot" key={hour.start}>{[0, Math.round((hours.length - 1) / 4), Math.round((hours.length - 1) / 2), Math.round((hours.length - 1) * 3 / 4), hours.length - 1].includes(index) && <time dateTime={new Date(hour.start).toISOString()}>{formattedTime(hour.start, hourFormat)}</time>}</span>)}
      </div>}
    </>}
    {selection && <HistoryOverlay selection={selection} providerName={selectedRow?.row.providerName || '记录详情'} hour={selectedHour} entry={selectedEntry} id={overlayId} onClose={closeSelection} onOpen={recordId => { recordFocusGuard.current = selection.anchor; closeSelection(false); onOpen(recordId); }} onSelect={entryId => setSelection(current => current ? { ...current, entryId, takeFocus: false } : null)} />}
  </section>;
}

function HistoryOverlay({ selection, providerName, hour, entry, id, onClose, onOpen, onSelect }: { selection: Selection; providerName: string; hour?: HourSlot; entry?: ReasoningHistoryEntry; id: string; onClose: (restoreFocus?: boolean) => void; onOpen: (id: string) => void; onSelect: (id: string) => void }) {
  const popover = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDialogElement>(null);
  const callbacks = useRef({ onClose, onOpen });
  callbacks.current = { onClose, onOpen };
  const focusedActivation = useRef<Selection | null>(null);

  useLayoutEffect(() => {
    if (selection.mode === 'sheet') {
      const dialog = sheet.current;
      if (!dialog) return;
      const unlock = lockPageScroll();
      dialog.showModal();
      return () => { dialog.close(); unlock(); };
    }
    const panel = popover.current;
    if (!panel) return;
    panel.showPopover();
    return () => { if (panel.matches(':popover-open')) panel.hidePopover(); };
  }, [selection.mode]);

  useLayoutEffect(() => {
    if (selection.mode !== 'popover') return;
    const panel = popover.current;
    if (!panel) return;
    if (!selection.anchor.isConnected) { callbacks.current.onClose(false); return; }
    const bounds = selection.anchor.getBoundingClientRect();
    const availableBelow = window.innerHeight - bounds.bottom - 20;
    const availableAbove = bounds.top - 20;
    const below = panel.scrollHeight <= availableBelow || availableBelow >= availableAbove;
    panel.style.maxHeight = `${Math.max(120, below ? availableBelow : availableAbove)}px`;
    const width = panel.getBoundingClientRect().width;
    const height = panel.getBoundingClientRect().height;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, bounds.left + bounds.width / 2 - width / 2));
    const top = Math.max(12, Math.min(window.innerHeight - height - 12, below ? bounds.bottom + 9 : bounds.top - height - 9));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.dataset.side = below ? 'bottom' : 'top';
    panel.style.setProperty('--rh-arrow-x', `${Math.max(18, Math.min(width - 18, bounds.left + bounds.width / 2 - left))}px`);
    if (selection.takeFocus && focusedActivation.current !== selection) {
      focusedActivation.current = selection;
      (panel.querySelector<HTMLButtonElement>('[data-rh-primary-action]') || panel.querySelector<HTMLButtonElement>('.rh-close'))?.focus({ preventScroll: true });
    }
  }, [selection, entry, hour]);

  useEffect(() => {
    if (selection.mode !== 'popover') return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (popover.current?.contains(target) || selection.anchor.contains(target))) return;
      callbacks.current.onClose(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); callbacks.current.onClose(); } };
    const onScroll = (event: Event) => { if (!(event.target instanceof Node && popover.current?.contains(event.target))) callbacks.current.onClose(false); };
    const onResize = () => callbacks.current.onClose(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onResize); };
  }, [selection.mode, selection.anchor]);

  const content = <div className="rh-detail-surface">
    <header className="rh-detail-heading"><div><strong className="rh-detail-provider">{providerName}</strong><span className="rh-detail-hour">{hour ? `${formattedTime(hour.start, hourFormat)}–${formattedTime(hour.end, hourFormat)} · ${hour.entries.length} 次可展示结果` : '记录详情'}</span></div><button className="rh-close" aria-label="关闭推理详情" onClick={() => onClose()}><X size={16} /></button></header>
    {hour && (hour.visibleStart > hour.start || hour.visibleEnd < hour.end) && <p className="rh-partial-note">{hour.visibleStart === hour.visibleEnd ? '本小时刚开始。' : `此小时仅统计 ${formattedTime(hour.visibleStart, hourFormat)}–${formattedTime(hour.visibleEnd, hourFormat)}，保留最近24小时范围。`}</p>}
    {entry ? <EntryDetail entry={entry} onOpen={onOpen} /> : <p className="rh-no-records">{hour ? '该小时暂无可展示的结果。结果按实际完成时间统计，失败或取消的调用不在图中显示。' : '这条记录已移出当前视图。'}</p>}
    {hour && hour.entries.length > 1 && <div className="rh-call-chips" aria-label="此时段的所有记录">{hour.entries.map(item => <button key={item.id} className={`rh-call-chip ${item.verdict} ${entry?.id === item.id ? 'active' : ''}`} aria-pressed={entry?.id === item.id} onClick={() => onSelect(item.id)}><time dateTime={runResultAt(item) || undefined} title={entryTimeLabel(item)}>{formattedTime(runResultAt(item), clockFormat)}</time><span>{item.answer || verdictNames[item.verdict]}</span></button>)}</div>}
  </div>;
  return selection.mode === 'sheet' ? <dialog ref={sheet} id={id} className="rh-sheet" aria-label="推理记录详情" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>{content}</dialog> : <div ref={popover} id={id} className="rh-popover" popover="manual" role="dialog" aria-modal="false" aria-label="推理记录详情">{content}</div>;
}

function EntryDetail({ entry, onOpen }: { entry: ReasoningHistoryEntry; onOpen: (id: string) => void }) {
  return <section className="rh-entry-detail" aria-label="调用详情">
    <div className="rh-detail-result"><strong>{entry.answer || '未记录答案'}</strong><span className={`rh-verdict ${entry.verdict}`}>{verdictNames[entry.verdict]}</span></div>
    <p className="rh-no-records">{entryTimeLabel(entry)}</p>
    <time className="rh-detail-clock" dateTime={runResultAt(entry) || undefined}>{formattedTime(runResultAt(entry), clockFormat)}<span className="rh-detail-date">{formattedTime(runResultAt(entry), calendarFormat)}</span></time>
    <dl className="rh-detail-meta"><div><dt>模型</dt><dd>{entry.modelName || '未记录'}</dd></div><div><dt>思考强度</dt><dd>{entry.reasoningEffort?.trim() || '未记录'}</dd></div></dl>
    {(entry.status === 'queued' || entry.status === 'running') && <p className="rh-no-records">{statusNames[entry.status]}</p>}
    {entry.verdict === 'unavailable' && <p className="rh-no-records">{entry.error || '没有可判定的最终答案。'}</p>}
    <button className="rh-open-run" data-rh-primary-action onClick={() => onOpen(entry.id)}>查看原始记录 <ArrowUpRight size={14} /></button>
  </section>;
}
