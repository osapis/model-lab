import { useState, type ReactNode } from 'react';
import { ChevronDown, Clock3 } from 'lucide-react';
import type { Run } from '../shared/types';
import { runFinishedAt } from '../shared/run-time';
import { runBatchKey, runModelGroupKey, runBatchAt } from '../shared/result-groups';
import './hourly-results.css';

const calendarDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const hourLabel = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', hourCycle: 'h23' });
const batchClock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export default function HourlyResults({ runs, layout, sort, renderRun }: {
  runs: Run[];
  layout: string;
  sort: string;
  renderRun: (run: Run) => ReactNode;
}) {
  const gridClass = `results-grid ${layout === 'list' ? 'list-layout' : ''}`;
  if (sort === 'grouped') {
    const batches = new Map<string, Run[]>();
    for (const run of runs) {
      const key = runBatchKey(run);
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key)!.push(run);
    }
    return <div className="hourly-results">{[...batches].map(([key, batchRuns]) => {
      const batchAt = runBatchAt(batchRuns[0]!);
      const instant = batchAt ? new Date(batchAt) : null;
      const groups = new Map<string, Run[]>();
      for (const run of batchRuns) {
        const modelKey = runModelGroupKey(run);
        if (!groups.has(modelKey)) groups.set(modelKey, []);
        groups.get(modelKey)!.push(run);
      }
      return <HourSection key={key} date={instant && Number.isFinite(instant.getTime()) ? instant : null} count={batchRuns.length} batch label="测试批次" subtitle="触发时间未记录">
        {layout === 'list' ? <div className={gridClass}>{batchRuns.map(renderRun)}</div> : <div className={`${gridClass} paired-results-grid`}>{[...groups].map(([groupKey, group]) => <div key={groupKey} className={`results-grid result-model-group${group.length === 1 ? ' is-single' : ''}`} role="group" aria-label={`${group[0]!.providerName} · ${group[0]!.modelName} · 本轮测试`}>{group.map(renderRun)}</div>)}</div>}
      </HourSection>;
    })}</div>;
  }
  if (sort === 'latency') return <div className={gridClass}>{runs.map(renderRun)}</div>;
  const hours = new Map<string, { date: Date | null; runs: Run[] }>();
  const pending: Run[] = [];
  const undated: Run[] = [];
  for (const run of runs) {
    if (run.status === 'queued' || run.status === 'running') { pending.push(run); continue; }
    const finished = runFinishedAt(run);
    if (!finished) { undated.push(run); continue; }
    const date = new Date(finished);
    const valid = Number.isFinite(date.getTime());
    // Use the same browser timezone as each result's test timestamp.
    const start = valid ? date.getTime() - (date.getMinutes() * 60_000 + date.getSeconds() * 1000 + date.getMilliseconds()) : 0;
    const key = valid ? String(start) : 'unknown';
    let section = hours.get(key);
    if (!section) { section = { date: valid ? new Date(start) : null, runs: [] }; hours.set(key, section); }
    section.runs.push(run);
  }
  return <div className="hourly-results">
    {pending.length > 0 && <HourSection date={null} count={pending.length} label="进行中的测试" subtitle="等待完成"><div className={gridClass}>{pending.map(renderRun)}</div></HourSection>}
    {[...hours].map(([key, section]) => <HourSection key={key} date={section.date} count={section.runs.length}>
    <div className={gridClass}>{section.runs.map(renderRun)}</div>
  </HourSection>)}
    {undated.length > 0 && <HourSection date={null} count={undated.length} label="历史记录" subtitle="完成时间未记录"><div className={gridClass}>{undated.map(renderRun)}</div></HourSection>}
  </div>;
}

function HourSection({ date, count, children, label = '未知日期', subtitle = '未记录完成时间', batch = false }: { date: Date | null; count: number; children: ReactNode; label?: string; subtitle?: string; batch?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const hour = date ? hourLabel.formatToParts(date).find(part => part.type === 'hour')!.value : '';
  return <section className={`hour-section ${expanded ? '' : 'is-collapsed'}`}>
    <h3 className="hour-section-heading"><button type="button" className="hour-section-toggle" title={batch ? '本轮触发时间；卡片仍显示各自的完成时间' : date ? '按完成 / 结束时间分组' : subtitle} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="hour-section-icon"><Clock3 size={21} /></span>
      <span className="hour-section-time"><span className="hour-section-date">{date ? calendarDate.format(date) : label}</span><strong>{date ? batch ? `本轮 ${batchClock.format(date)}` : `${hour}:00–${hour}:59` : subtitle}</strong></span>
      <span className="hour-section-count">本页 {count} 项测试</span>
      <span className="hour-section-action">{expanded ? '收起' : '展开'}<ChevronDown size={17} /></span>
    </button></h3>
    {expanded && children}
  </section>;
}
