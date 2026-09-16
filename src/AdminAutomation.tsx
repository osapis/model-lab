import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity, Archive, CalendarClock, Check, Clock3, Cloud, Database, FileText, HardDrive,
  Info, Layers3, LoaderCircle, Pencil, Play, Plus, RefreshCw, ShieldCheck, Trash2, X,
} from 'lucide-react';
import type { AdminData, Schedule, StorageSettings } from '../shared/types';
import { DEFAULT_AUTO_RETRIES, MAX_AUTO_RETRIES, normalizeMaxRetries } from '../shared/retries';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS, MIN_REQUEST_TIMEOUT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS, normalizeRequestTimeoutSeconds } from '../shared/timeouts';
import { DEFAULT_SCHEDULE_TIMEZONE, EXAMPLE_SCHEDULE_CRON, type CronPreview } from '../shared/schedules';
import { resolveScheduleSelection } from '../shared/schedule-availability';
import { api, json } from './api';
import './admin-automation.css';

type Mutate = (key: string, path: string, options: RequestInit, message: string) => Promise<boolean>;
type PanelProps = { data: AdminData; busy: string; mutate: Mutate };
const intervals = [5, 30, 60, 360, 1440];
const intervalLabel = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
const timezoneOptions = [
  { value: DEFAULT_SCHEDULE_TIMEZONE, label: '北京时间 · Asia/Shanghai' },
  { value: 'UTC', label: 'UTC · 协调世界时' },
  { value: 'Asia/Tokyo', label: '东京时间 · Asia/Tokyo' },
  { value: 'America/New_York', label: '纽约时间 · America/New_York' },
  { value: 'Europe/London', label: '伦敦时间 · Europe/London' },
];
const timezoneLabel = (timezone: string) => timezone === DEFAULT_SCHEDULE_TIMEZONE ? '北京时间 · Asia/Shanghai' : timezone;
const dateLabel = (value: string | null, timezone = DEFAULT_SCHEDULE_TIMEZONE) => {
  if (!value) return '尚未执行';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间无效';
  try { return date.toLocaleString('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
  catch { return '时区无效，请编辑计划'; }
};
function cronDescription(expression: string) {
  const normalized = expression.trim().replace(/\s+/g, ' ');
  if (normalized === EXAMPLE_SCHEDULE_CRON) return '每天 07:00 至次日 01:00，每小时整点触发，共 19 轮。';
  if (normalized === '0 * * * *') return '每天每小时整点执行。';
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(normalized);
  if (daily && Number(daily[1]) < 60 && Number(daily[2]) < 24) return `每天 ${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')} 执行。`;
  const parts = normalized.split(' ');
  if (parts.length !== 5) return '请填写五段 Cron 表达式。';
  return ['分钟', '小时', '日期', '月份', '星期'].map((label, index) => `${label}：${parts[index] === '*' ? '不限' : parts[index]}`).join(' · ');
}
function Spinner() { return <LoaderCircle size={15} className="admin-spin" aria-hidden="true" />; }
const schedulePayload = (schedule: Schedule) => ({ name: schedule.name, promptIds: schedule.promptIds,
  modelIds: schedule.modelIds, intervalMinutes: schedule.intervalMinutes, enabled: schedule.enabled,
  scheduleType: schedule.scheduleType ?? 'interval', cronExpression: schedule.cronExpression ?? '', timezone: schedule.timezone || DEFAULT_SCHEDULE_TIMEZONE });

export function Schedules({ data, busy, mutate }: PanelProps) {
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [deleting, setDeleting] = useState('');
  const enabledCount = data.schedules.filter((schedule) => schedule.enabled).length;

  return <div className="admin-stack">
    <div className="admin-automation-intro"><span className="admin-automation-intro-icon"><CalendarClock size={23} /></span>
      <div><h2>让同一道题，持续观察模型的变化。</h2><p>按固定间隔或指定时区的 Cron 规则执行，所有测试与失败记录自动显示在前台。</p></div>
      <span className="admin-small-badge enabled">{enabledCount} 个计划已启用</span>
    </div>
    <section className="admin-panel">
      <div className="admin-section-heading"><div><h2>定时任务<span className="admin-heading-count">{data.schedules.length}</span></h2><p>服务器运行时自动执行；同一计划的上一轮未结束时，会跳过本轮。</p></div>
        <button type="button" className="admin-button admin-button-primary admin-button-small" disabled={!!busy} onClick={() => setEditing('new')}><Plus size={15} />新建计划</button>
      </div>
      {editing && <ScheduleEditor key={typeof editing === 'string' ? 'new' : editing.id} data={data} schedule={editing === 'new' ? null : editing}
        busy={busy} mutate={mutate} onClose={() => setEditing(null)} />}
      {data.schedules.length === 0 ? <div className="admin-empty"><span className="admin-empty-icon"><CalendarClock size={25} /></span><h3>还没有定时计划</h3><p>选好提示词和模型，设置固定间隔或 Cron 规则。</p>
        {!editing && <button type="button" className="admin-button admin-button-small" onClick={() => setEditing('new')} disabled={!!busy}><Plus size={14} />创建第一个计划</button>}
      </div> : <div className="admin-schedule-list">{data.schedules.map((schedule) => {
        const activeCount = data.runs.filter((run) => run.scheduleId === schedule.id && ['queued', 'running'].includes(run.status)).length;
        const isCron = schedule.scheduleType === 'cron';
        const scheduleTimezone = schedule.timezone || DEFAULT_SCHEDULE_TIMEZONE;
        const selection = resolveScheduleSelection(schedule, data.prompts, data.models, data.providers);
        const sourcesAvailable = selection.runnableCount > 0;
        const skipped = [selection.skippedPromptCount ? `${selection.skippedPromptCount} 个提示词` : '', selection.skippedModelCount ? `${selection.skippedModelCount} 个模型` : ''].filter(Boolean).join('、');
        return <article className="admin-schedule-card" key={schedule.id}>
          <div className="admin-schedule-card-heading"><div className="admin-row-title"><h3>{schedule.name}</h3><span className={`admin-small-badge ${schedule.enabled ? 'enabled' : ''}`}>{schedule.enabled ? '已启用' : '已暂停'}</span>
            {activeCount > 0 && <span className="admin-status admin-status-running"><Clock3 size={11} />{activeCount} 项运行中</span>}</div>
            <div className="admin-row-actions"><button type="button" className={`admin-toggle ${schedule.enabled ? 'on' : ''}`} role="switch" aria-checked={schedule.enabled}
              aria-label={`${schedule.enabled ? '暂停' : '启用'}计划 ${schedule.name}`} title={schedule.enabled ? '暂停自动执行' : '启用自动执行'} disabled={!!busy}
              onClick={() => { void mutate(`schedule-toggle-${schedule.id}`, `/api/admin/schedules/${schedule.id}`, json('PUT', { ...schedulePayload(schedule), enabled: !schedule.enabled }), schedule.enabled ? '已暂停计划，进行中的测试仍会继续。' : '计划已启用，将按设定规则执行。'); }}><span /></button>
              <button type="button" className="admin-button admin-button-small" disabled={!!busy || activeCount > 0 || !sourcesAvailable}
                title={!sourcesAvailable ? '当前没有可执行的组合，启用所选项或编辑计划后可执行' : `立即执行当前可用的 ${selection.runnableCount} 项测试，停用项自动跳过，不改变下一次定时执行时间`}
                onClick={() => { void mutate(`schedule-run-${schedule.id}`, `/api/admin/schedules/${schedule.id}/run`, json('POST'), '已创建一轮测试，可在测试记录中查看进度。'); }}>
                {busy === `schedule-run-${schedule.id}` ? <Spinner /> : <Play size={13} />}立即执行</button>
              <button type="button" className="admin-icon-button" disabled={!!busy} aria-label={`编辑计划 ${schedule.name}`} title="编辑计划" onClick={() => setEditing(schedule)}><Pencil size={14} /></button>
              <button type="button" className="admin-icon-button admin-danger-icon" disabled={!!busy} aria-label={`删除计划 ${schedule.name}`} title="删除计划" onClick={() => setDeleting(schedule.id)}><Trash2 size={14} /></button>
            </div>
          </div>
          <div className="admin-schedule-facts"><span><Clock3 size={13} />{isCron ? 'Cron 定时' : `每 ${intervalLabel(schedule.intervalMinutes)}`}</span><span><Layers3 size={13} />每轮 {selection.runnableCount} 项测试</span><span><Activity size={13} />全部测试自动展示</span></div>
          {isCron && <div className="admin-schedule-cron-rule"><code>{schedule.cronExpression}</code><span>{timezoneLabel(scheduleTimezone)}</span><p>{cronDescription(schedule.cronExpression || '')}</p></div>}
          <div className="admin-schedule-selection"><div><FileText size={13} /><span>{schedule.promptIds.map((id) => { const prompt = data.prompts.find(item => item.id === id); return prompt ? `${prompt.title}${prompt.enabled ? '' : '（本轮跳过）'}` : '已删除的提示词（本轮跳过）'; }).join('、')}</span></div>
            <div><Layers3 size={13} /><span>{schedule.modelIds.map((id) => { const model = data.models.find((item) => item.id === id); return model ? `${data.providers.find((provider) => provider.id === model.providerId)?.name || '已删除的接口'} · ${model.name}${selection.models.some(item => item.id === id) ? '' : '（本轮跳过）'}` : '已删除的模型（本轮跳过）'; }).join('、')}</span></div></div>
          <div className="admin-schedule-times"><span>下次执行<strong>{schedule.enabled ? dateLabel(schedule.nextRunAt, scheduleTimezone) : '已暂停'}</strong></span><span>上次执行<strong>{dateLabel(schedule.lastRunAt, scheduleTimezone)}</strong></span><span>以上时间：{timezoneLabel(scheduleTimezone)}</span></div>
          {skipped && <p className="admin-automation-warning"><Info size={13} />{sourcesAvailable ? `当前跳过 ${skipped}，其余 ${selection.runnableCount} 项测试照常执行。停用项重新启用后自动参与后续轮次。` : '当前没有可执行的提示词和模型组合，本轮暂不调用；启用所选项后将按原计划继续，也可编辑计划调整选择。'}</p>}
          {schedule.lastError && <p className="admin-automation-warning" role="status"><Info size={13} />上次执行：{schedule.lastError}</p>}
          {deleting === schedule.id && <div className="admin-schedule-delete"><p>删除此计划？已有测试记录和正在运行的测试会保留。</p><div className="admin-row-actions">
            <button type="button" className="admin-button admin-button-small" disabled={!!busy} onClick={() => setDeleting('')}>取消</button>
            <button type="button" className="admin-button admin-button-danger admin-button-small" disabled={!!busy} onClick={async () => {
              if (await mutate(`schedule-delete-${schedule.id}`, `/api/admin/schedules/${schedule.id}`, json('DELETE'), '定时计划已删除，已有测试记录仍然保留。')) {
                setDeleting(''); if (editing !== 'new' && editing?.id === schedule.id) setEditing(null);
              }
            }}>{busy === `schedule-delete-${schedule.id}` ? <Spinner /> : <Trash2 size={13} />}确认删除</button>
          </div></div>}
        </article>;
      })}</div>}
    </section>
  </div>;
}

function ScheduleEditor({ data, schedule, busy, mutate, onClose }: PanelProps & { schedule: Schedule | null; onClose: () => void }) {
  const prompts = data.prompts;
  const models = data.models;
  const [name, setName] = useState(schedule?.name || '');
  const [promptIds, setPromptIds] = useState(schedule?.promptIds || []);
  const [modelIds, setModelIds] = useState(schedule?.modelIds || []);
  const [intervalMinutes, setIntervalMinutes] = useState(String(schedule?.intervalMinutes ?? 60));
  const [customInterval, setCustomInterval] = useState(!intervals.includes(schedule?.intervalMinutes ?? 60));
  const [scheduleType, setScheduleType] = useState<'interval' | 'cron'>(schedule?.scheduleType === 'cron' ? 'cron' : 'interval');
  const [cronExpression, setCronExpression] = useState(schedule?.cronExpression || '');
  const [timezone, setTimezone] = useState(schedule?.timezone || DEFAULT_SCHEDULE_TIMEZONE);
  const [customTimezone, setCustomTimezone] = useState(!timezoneOptions.some((option) => option.value === (schedule?.timezone || DEFAULT_SCHEDULE_TIMEZONE)));
  const [cronPreview, setCronPreview] = useState<{ key: string; loading: boolean; nextRuns: string[]; error: string }>({ key: '', loading: false, nextRuns: [], error: '' });
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const previewVersion = useRef(0);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const selection = resolveScheduleSelection({ promptIds, modelIds }, prompts, models, data.providers);
  const count = selection.runnableCount;
  const configuredCount = selection.selectedPromptCount * selection.selectedModelCount;
  const missingPromptIds = [...new Set(promptIds)].filter(id => !prompts.some(prompt => prompt.id === id));
  const missingModelIds = [...new Set(modelIds)].filter(id => !models.some(model => model.id === id));
  const hasSkipped = selection.skippedPromptCount > 0 || selection.skippedModelCount > 0;
  const interval = Number(intervalMinutes);
  const validInterval = Number.isInteger(interval) && interval >= 1 && interval <= 43200;
  const previewKey = JSON.stringify([scheduleType, cronExpression.trim(), timezone.trim()]);
  const previewCurrent = cronPreview.key === previewKey;
  const previewLoading = scheduleType === 'cron' && !!cronExpression.trim() && !!timezone.trim() && (!previewCurrent || cronPreview.loading);
  const validCron = previewCurrent && !cronPreview.loading && !cronPreview.error && cronPreview.nextRuns.length === 3;
  const valid = !!name.trim() && configuredCount > 0 && configuredCount <= 50 && (scheduleType === 'cron' ? validCron : validInterval);
  const toggle = (id: string, ids: string[]) => ids.includes(id) ? ids.filter((current) => current !== id) : [...ids, id];

  useEffect(() => {
    const version = ++previewVersion.current;
    const controller = new AbortController();
    const expression = cronExpression.trim();
    const zone = timezone.trim();
    if (scheduleType !== 'cron' || !expression || !zone) {
      setCronPreview({ key: previewKey, loading: false, nextRuns: [], error: '' });
      return () => controller.abort();
    }
    setCronPreview({ key: previewKey, loading: true, nextRuns: [], error: '' });
    const timer = window.setTimeout(() => {
      api<CronPreview>('/api/admin/schedules/preview', { ...json('POST', { cronExpression: expression, timezone: zone }), signal: controller.signal })
        .then(({ nextRuns }) => {
          if (controller.signal.aborted || version !== previewVersion.current) return;
          setCronPreview({ key: previewKey, loading: false, nextRuns, error: nextRuns.length === 3 ? '' : '未能计算未来三次执行时间，请检查表达式后重试。' });
        }).catch((error: unknown) => {
          if (controller.signal.aborted || version !== previewVersion.current) return;
          setCronPreview({ key: previewKey, loading: false, nextRuns: [], error: error instanceof Error ? error.message : '无法预览执行时间，请稍后重试。' });
        });
    }, 450);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [scheduleType, cronExpression, timezone, previewKey, previewRefresh]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    if (await mutate('schedule-save', schedule ? `/api/admin/schedules/${schedule.id}` : '/api/admin/schedules', json(schedule ? 'PUT' : 'POST', {
      name: name.trim(), promptIds: [...new Set(promptIds)], modelIds: [...new Set(modelIds)],
      intervalMinutes: validInterval ? interval : 60, enabled, scheduleType,
      cronExpression: scheduleType === 'cron' ? cronExpression.trim() : '',
      timezone: scheduleType === 'cron' ? timezone.trim() : schedule?.timezone || DEFAULT_SCHEDULE_TIMEZONE,
    }), schedule ? '定时计划已更新。' : '定时计划已创建。')) onClose();
  }
  return <div className="admin-editor"><div className="admin-editor-heading"><h3>{schedule ? '编辑定时计划' : '新建定时计划'}</h3><button type="button" className="admin-icon-button" onClick={onClose} disabled={!!busy} aria-label="关闭计划编辑器"><X size={16} /></button></div>
    <form onSubmit={save}>
      <div className="admin-form-grid"><label className="admin-field">计划名称<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="例如：每日视觉能力观察" required /></label>
        <label className="admin-field">执行方式<select value={scheduleType} disabled={!!busy} onChange={(event) => setScheduleType(event.target.value as 'interval' | 'cron')}><option value="interval">固定间隔</option><option value="cron">Cron 表达式</option></select></label>
        {scheduleType === 'interval' ? <div className="admin-field admin-field-full"><label htmlFor="schedule-interval">执行间隔</label><div className="admin-schedule-interval"><select id="schedule-interval" value={customInterval ? 'custom' : intervalMinutes} onChange={(event) => {
          setCustomInterval(event.target.value === 'custom'); if (event.target.value !== 'custom') setIntervalMinutes(event.target.value);
        }}>{intervals.map((value) => <option key={value} value={value}>每 {intervalLabel(value)}</option>)}<option value="custom">自定义间隔</option></select>
          {customInterval && <label className="admin-custom-minutes"><input type="number" aria-label="自定义间隔分钟数" min={1} max={43200} step={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} required /><span>分钟</span></label>}</div><small>最短 1 分钟，最长 30 天。首次启用后等待一个间隔再执行。</small></div> : <div className="admin-field-full admin-cron-editor">
          <button type="button" className="admin-cron-preset" disabled={!!busy} onClick={() => { setCronExpression(EXAMPLE_SCHEDULE_CRON); setTimezone(DEFAULT_SCHEDULE_TIMEZONE); setCustomTimezone(false); }}><CalendarClock size={17} /><span><strong>快捷填入：北京时间 07:00 至次日 01:00</strong><small>每小时整点触发，每天共 19 轮</small><code>{EXAMPLE_SCHEDULE_CRON}</code></span></button>
          <label className="admin-field">Cron 表达式<input className="admin-cron-input" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} placeholder="例如：0 0-1,7-23 * * *" maxLength={200} disabled={!!busy} required autoComplete="off" spellCheck={false} /><small>五段格式：分钟 小时 日期 月份 星期。支持 *、逗号、范围和步长，不含秒。</small></label>
          <div className="admin-field"><label htmlFor="schedule-timezone">执行时区</label><select id="schedule-timezone" value={customTimezone ? 'custom' : timezone} disabled={!!busy} onChange={(event) => { setCustomTimezone(event.target.value === 'custom'); if (event.target.value !== 'custom') setTimezone(event.target.value); }}>{timezoneOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}<option value="custom">自定义 IANA 时区</option></select>
            {customTimezone && <input aria-label="自定义执行时区" value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="例如：Asia/Singapore" maxLength={100} disabled={!!busy} required autoComplete="off" spellCheck={false} />}<small>Cron 按该时区计算执行时间；支持夏令时的地区会跟随其当地时间。</small>
          </div>
          <div className="admin-cron-preview" aria-live="polite"><div className="admin-cron-preview-heading"><strong>未来三次计划时间</strong><button type="button" className="admin-text-button" disabled={!!busy || previewLoading || !cronExpression.trim() || !timezone.trim()} onClick={() => setPreviewRefresh((value) => value + 1)}><RefreshCw size={12} />刷新预览</button></div>
            {previewLoading ? <p className="admin-cron-preview-status"><Spinner />正在校验规则并计算时间…</p> : previewCurrent && cronPreview.error ? <p className="admin-cron-error" role="alert">{cronPreview.error}</p> : validCron ? <><p className="admin-cron-description">{cronDescription(cronExpression)}</p><p className="admin-cron-zone">以下时间均为：{timezoneLabel(timezone.trim())}</p><ol>{cronPreview.nextRuns.map((nextRun) => <li key={nextRun}><time dateTime={nextRun}>{dateLabel(nextRun, timezone.trim())}</time></li>)}</ol><p className="admin-cron-zone">以上为计划时间，实际开始可能稍晚；每轮测试按所选提示词和模型组合执行。</p></> : <p className="admin-cron-preview-status">填写表达式和时区后自动校验，不会创建或执行测试。</p>}
          </div>
        </div>}
        <fieldset className="admin-schedule-options"><legend>测试提示词 <span>已选 {selection.selectedPromptCount} 项 · 当前 {selection.prompts.length} 项可执行</span></legend><div className="admin-schedule-option-list">
          {prompts.map((prompt) => <label key={prompt.id}><input type="checkbox" checked={promptIds.includes(prompt.id)} onChange={() => setPromptIds(toggle(prompt.id, promptIds))} /><span>{prompt.title}{!prompt.enabled && <small className="admin-choice-paused">已停用 · 执行时跳过，保留勾选</small>}</span></label>)}
          {missingPromptIds.map(id => <label key={id}><input type="checkbox" checked onChange={() => setPromptIds(toggle(id, promptIds))} /><span>已删除的提示词<small>不会执行，可取消勾选移出计划。</small></span></label>)}
          {!prompts.length && !missingPromptIds.length && <p className="admin-muted">暂无提示词，请先在提示词管理中添加。</p>}
        </div></fieldset>
        <fieldset className="admin-schedule-options"><legend>参测模型 <span>已选 {selection.selectedModelCount} 项 · 当前 {selection.models.length} 项可执行</span></legend><div className="admin-schedule-option-list">
          {models.map((model) => <label key={model.id}><input type="checkbox" checked={modelIds.includes(model.id)} onChange={() => setModelIds(toggle(model.id, modelIds))} /><span><strong className="admin-choice-provider">{data.providers.find((provider) => provider.id === model.providerId)?.name}</strong><small>{model.name} · {model.modelId}</small>{!selection.models.some(item => item.id === model.id) && (!model.enabled || !data.providers.some(provider => provider.id === model.providerId && provider.enabled)) && <small className="admin-choice-paused">{!model.enabled ? '模型已停用' : 'API 已停用或删除'} · 执行时跳过，保留勾选</small>}</span></label>)}
          {missingModelIds.map(id => <label key={id}><input type="checkbox" checked onChange={() => setModelIds(toggle(id, modelIds))} /><span>已删除的模型<small>不会执行，可取消勾选移出计划。</small></span></label>)}
          {!models.length && !missingModelIds.length && <p className="admin-muted">暂无模型，请先在接口与模型中添加。</p>}
        </div></fieldset>
      </div>
      {hasSkipped && <p className="admin-automation-warning"><Info size={13} />{count ? `当前可执行 ${count} 项测试，停用或删除的选项会跳过，勾选状态仍会保存。` : '当前没有可执行的组合，可以保存计划等待所选项恢复。'}停用项重新启用后自动参与；取消勾选才会将其移出计划。</p>}
      <div className="admin-schedule-switches"><label className="admin-checkbox-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用定时执行</label>
      </div><p className="admin-schedule-results-note">每轮测试的真实输出与失败记录都会自动出现在前台，便于持续观察 API 表现。</p>
      <div className="admin-form-actions admin-schedule-save"><span className={configuredCount > 50 ? 'over-limit' : ''}>当前每轮 {count} 项测试{configuredCount > 50 ? ' · 选择的组合最多 50 项' : ` · 已选 ${configuredCount} 个组合`}</span><button type="button" className="admin-button admin-button-small" disabled={!!busy} onClick={onClose}>取消</button>
        <button className="admin-button admin-button-primary admin-button-small" disabled={!!busy || !valid}>{busy === 'schedule-save' ? <Spinner /> : <Check size={14} />}保存计划</button></div>
    </form>
  </div>;
}

const storageDraft = (storage: StorageSettings) => ({ mode: storage.mode, endpoint: storage.endpoint, region: storage.region || 'auto', bucket: storage.bucket, prefix: storage.prefix ?? 'model-lab' });

function RequestTimeoutSettings({ data, busy, mutate }: PanelProps) {
  const currentTimeout = normalizeRequestTimeoutSeconds(data.settings.requestTimeoutSeconds);
  const [timeout, setTimeout] = useState(String(currentTimeout));
  useEffect(() => { setTimeout(String(currentTimeout)); }, [currentTimeout]);
  const seconds = Number(timeout);
  const valid = timeout.trim() !== '' && Number.isInteger(seconds) && seconds >= MIN_REQUEST_TIMEOUT_SECONDS && seconds <= MAX_REQUEST_TIMEOUT_SECONDS;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy || seconds === currentTimeout) return;
    await mutate('request-timeout-save', '/api/admin/settings', json('PATCH', { requestTimeoutSeconds: seconds }),
      `新测试与手动重试每次最多等待 ${seconds} 秒，已有任务仍使用创建时的设置。`);
  }

  return <section className="admin-panel admin-auto-retry-panel"><div className="admin-section-heading"><div className="admin-step-heading"><span><Clock3 size={16} /></span><div><h2>请求超时</h2><p>为高思考强度的模型留出足够的回答时间。</p></div></div><span className="admin-small-badge">当前：{currentTimeout} 秒</span></div>
    <form onSubmit={save} className="admin-auto-retry-form"><div className="admin-auto-retry-input"><label className="admin-field">单次请求最长等待<div className="admin-auto-retry-number"><input type="number" min={MIN_REQUEST_TIMEOUT_SECONDS} max={MAX_REQUEST_TIMEOUT_SECONDS} step={1} value={timeout} onChange={event => setTimeout(event.target.value)} aria-invalid={!valid} aria-describedby="admin-request-timeout-help" disabled={!!busy} required /><span>秒</span></div><small id="admin-request-timeout-help">默认 {DEFAULT_REQUEST_TIMEOUT_SECONDS} 秒（10 分钟），可设 {MIN_REQUEST_TIMEOUT_SECONDS}–{MAX_REQUEST_TIMEOUT_SECONDS} 秒。</small></label>
      <div className="admin-auto-retry-presets">{[180, 300, 600, 720].map(value => <button type="button" key={value} className={valid && seconds === value ? 'selected' : ''} disabled={!!busy} onClick={() => setTimeout(String(value))}>{value / 60} 分钟</button>)}</div>
    </div><div className="admin-auto-retry-explanation"><p>{valid ? `每次调用最多等待 ${seconds} 秒；max / xhigh 可先使用 10 分钟。自动重试的每一次调用单独计时。` : `请输入 ${MIN_REQUEST_TIMEOUT_SECONDS}–${MAX_REQUEST_TIMEOUT_SECONDS} 之间的整数。`}</p><p>修改应用于新测试与手动重试，正在执行的任务和自动重试保留原设置。上游接口自身的超时限制仍然有效，旧失败记录需要手动重试。</p></div>
      <button type="submit" className="admin-button admin-button-primary admin-button-small" disabled={!!busy || !valid || seconds === currentTimeout}>{busy === 'request-timeout-save' ? <Spinner /> : <Check size={14} />}保存超时设置</button>
    </form>
  </section>;
}

function AutoRetrySettings({ data, busy, mutate }: PanelProps) {
  const currentRetries = normalizeMaxRetries(data.settings.maxRetries);
  const [maxRetries, setMaxRetries] = useState(String(currentRetries));
  useEffect(() => { setMaxRetries(String(currentRetries)); }, [currentRetries]);
  const retries = Number(maxRetries);
  const valid = maxRetries.trim() !== '' && Number.isInteger(retries) && retries >= 0 && retries <= MAX_AUTO_RETRIES;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid || !!busy || retries === currentRetries) return;
    await mutate('auto-retries-save', '/api/admin/settings', json('PATCH', { maxRetries: retries }), retries === 0
      ? '已关闭新测试的失败自动重试，已有任务仍按创建时的设置执行。'
      : `新测试失败后最多额外自动重试 ${retries} 次，首次调用另计。`);
  }

  return <section className="admin-panel admin-auto-retry-panel"><div className="admin-section-heading"><div className="admin-step-heading"><span><RefreshCw size={16} /></span><div><h2>失败自动重试</h2><p>为所有 API 的新测试设置统一的失败重试次数。</p></div></div><span className="admin-small-badge">当前：{currentRetries === 0 ? '已关闭' : `最多 ${currentRetries} 次`}</span></div>
    <form onSubmit={save} className="admin-auto-retry-form"><div className="admin-auto-retry-input"><label className="admin-field">失败后额外重试次数<div className="admin-auto-retry-number"><input type="number" min={0} max={MAX_AUTO_RETRIES} step={1} value={maxRetries} onChange={(event) => setMaxRetries(event.target.value)} aria-invalid={!valid} aria-describedby="admin-auto-retry-help" disabled={!!busy} required /><span>次</span></div><small id="admin-auto-retry-help">默认 {DEFAULT_AUTO_RETRIES} 次，可设置 0–{MAX_AUTO_RETRIES} 次；0 表示关闭。</small></label>
      <div className="admin-auto-retry-presets">{[0, 3, DEFAULT_AUTO_RETRIES, MAX_AUTO_RETRIES].map((value) => <button type="button" key={value} className={valid && retries === value ? 'selected' : ''} disabled={!!busy} onClick={() => setMaxRetries(String(value))}>{value === 0 ? '关闭' : `${value} 次`}</button>)}</div>
    </div><div className="admin-auto-retry-explanation"><p>{valid ? retries === 0 ? '新测试调用失败后会保留失败记录，不自动创建重试。' : `首次调用另计：额外重试最多 ${retries} 次，共最多调用 ${retries + 1} 次。每次尝试都保留独立记录。` : `请输入 0–${MAX_AUTO_RETRIES} 之间的整数。`}</p><p>仅网络错误、超时及 HTTP 408、429、5xx 会自动重试。设置在创建新任务时保存；修改不会改变已有任务，也不会补跑历史失败记录。</p></div>
      <button type="submit" className="admin-button admin-button-primary admin-button-small" disabled={!!busy || !valid || retries === currentRetries}>{busy === 'auto-retries-save' ? <Spinner /> : <Check size={14} />}保存重试设置</button>
    </form>
  </section>;
}

export function StorageSettingsPanel({ data, busy, mutate }: PanelProps) {
  const [retentionDays, setRetentionDays] = useState(String(data.settings.retentionDays));
  const [draft, setDraft] = useState(() => storageDraft(data.storage));
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  useEffect(() => { setRetentionDays(String(data.settings.retentionDays)); }, [data.settings.retentionDays]);
  useEffect(() => { setDraft(storageDraft(data.storage)); }, [data.storage.mode, data.storage.endpoint, data.storage.region, data.storage.bucket, data.storage.prefix]);
  const days = Number(retentionDays);
  const validRetention = Number.isInteger(days) && days >= 1 && days <= 3650;
  const nativeCloud = data.storage.mode === 'cloudflare';
  const cloudBackend = data.storage.backend === 'r2' ? 'R2 对象存储' : data.storage.backend === 'durable-sqlite' ? 'Durable Object SQLite' : 'Cloudflare 原生存储';
  const validStorage = nativeCloud || draft.mode === 'memory' || (!!draft.endpoint.trim() && !!draft.region.trim() && !!draft.bucket.trim()
    && (!!accessKeyId.trim() || data.storage.hasAccessKeyId) && (!!secretAccessKey.trim() || data.storage.hasSecretAccessKey));
  const storageDirty = nativeCloud ? draft.prefix !== storageDraft(data.storage).prefix : JSON.stringify(draft) !== JSON.stringify(storageDraft(data.storage)) || !!accessKeyId || !!secretAccessKey;
  const memoryPercent = data.storage.memoryLimitMb > 0 ? Math.min(100, Math.max(0, data.storage.memoryUsedMb / data.storage.memoryLimitMb * 100)) : 0;
  async function saveRetention(event: FormEvent) {
    event.preventDefault(); if (!validRetention) return;
    await mutate('retention-save', '/api/admin/settings', json('PATCH', { retentionDays: days }), `默认历史保留时间已设置为 ${days} 天，过期记录与正文将自动清理。`);
  }
  async function saveStorage(event: FormEvent) {
    event.preventDefault(); if (!validStorage) return;
    if (await mutate('storage-save', '/api/admin/storage', json('PATCH', nativeCloud ? { mode: 'cloudflare', prefix: draft.prefix } : { ...draft, accessKeyId, secretAccessKey }), '结果存储配置已保存。')) {
      setAccessKeyId(''); setSecretAccessKey('');
    }
  }
  return <div className="admin-stack"><RequestTimeoutSettings data={data} busy={busy} mutate={mutate} /><AutoRetrySettings data={data} busy={busy} mutate={mutate} /><div className="admin-storage-layout">
    <section className="admin-panel"><div className="admin-section-heading"><div className="admin-step-heading"><span><Database size={16} /></span><div><h2>结果正文存储</h2><p>选择完整回答、推理过程和 HTML / SVG 作品的保存方式。</p></div></div></div>
      <form onSubmit={saveStorage}>
        {nativeCloud ? <div className="admin-storage-info"><div><Cloud size={20} /><p><strong>Cloudflare 云端存储 · {cloudBackend}</strong><br />完整回答、推理文本与 HTML / SVG 作品持久保存在 Cloudflare，按管理员设置的期限与历史记录同步清理。当前部署已绑定存储后端，无需填写 S3 凭据。</p></div><div className="admin-form-grid"><label className="admin-field admin-field-full">作品前缀<input value={draft.prefix} onChange={event => setDraft({ ...draft, prefix: event.target.value })} placeholder="model-lab" maxLength={500} /><small>用于区分当前部署的作品。更改前缀不会迁移或重新生成已有作品。</small></label></div></div> : <><div className="admin-storage-modes" role="group" aria-label="结果存储方式"><button type="button" className={`admin-storage-mode ${draft.mode === 'memory' ? 'selected' : ''}`} aria-pressed={draft.mode === 'memory'} disabled={!!busy} onClick={() => setDraft({ ...draft, mode: 'memory' })}>
          <HardDrive size={20} /><span><strong>服务器内存</strong><small>默认模式 · 临时查看作品</small></span>{draft.mode === 'memory' && <Check size={15} />}</button>
          <button type="button" className={`admin-storage-mode ${draft.mode === 's3' ? 'selected' : ''}`} aria-pressed={draft.mode === 's3'} disabled={!!busy} onClick={() => setDraft({ ...draft, mode: 's3' })}>
            <Cloud size={21} /><span><strong>Cloudflare R2</strong><small>也支持 S3 兼容对象存储</small></span>{draft.mode === 's3' && <Check size={15} />}</button></div>
        {draft.mode === 'memory' ? <div className="admin-storage-info"><div><Info size={17} /><p><strong>完整作品只保存在服务器内存中。</strong>服务重启或缓存淘汰后，完整回答与作品将无法回看，仅保留测试历史摘要。需要持续展示和回看，请配置 R2 / S3。</p></div>
          <div className="admin-memory-usage"><span>当前内存缓存</span><strong>{data.storage.memoryUsedMb.toFixed(1)} / {data.storage.memoryLimitMb} MB</strong><div className="admin-memory-track" role="progressbar" aria-label="结果内存缓存用量" aria-valuenow={Math.round(memoryPercent)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${memoryPercent}%` }} /></div></div>
        </div> : <div className="admin-storage-s3"><p className="admin-storage-explanation">将后续测试的完整结果存入你自己的私有存储桶。已失效的内存作品不会恢复；过期结果仍按保留时间清理。</p><div className="admin-form-grid">
          <label className="admin-field admin-field-full">Endpoint<input type="url" placeholder="https://你的账户.r2.cloudflarestorage.com" value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} maxLength={2048} required /><small>填写对象存储的 S3 API 地址，不是公开访问域名。</small></label>
          <label className="admin-field">Region<input value={draft.region} onChange={(event) => setDraft({ ...draft, region: event.target.value })} placeholder="auto" maxLength={100} required /><small>Cloudflare R2 使用 auto。</small></label>
          <label className="admin-field">Bucket<input value={draft.bucket} onChange={(event) => setDraft({ ...draft, bucket: event.target.value })} placeholder="例如：model-lab-results" maxLength={255} required /></label>
          <label className="admin-field admin-field-full">对象前缀<input value={draft.prefix} onChange={(event) => setDraft({ ...draft, prefix: event.target.value })} placeholder="model-lab" maxLength={500} /><small>用于区分存储桶内的作品，例如 model-lab。</small></label>
          <label className="admin-field">Access Key ID<input type="password" autoComplete="new-password" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} placeholder={data.storage.hasAccessKeyId ? '已配置，留空保持现有值' : '输入 Access Key ID'} maxLength={512} required={!data.storage.hasAccessKeyId} /><small>{data.storage.hasAccessKeyId ? '已保存的凭据不会回显。' : '请输入具有该存储桶读写和删除权限的凭据。'}</small></label>
          <label className="admin-field">Secret Access Key<input type="password" autoComplete="new-password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} placeholder={data.storage.hasSecretAccessKey ? '已配置，留空保持现有值' : '输入 Secret Access Key'} maxLength={1024} required={!data.storage.hasSecretAccessKey} /><small>凭据仅提交至后端保存。</small></label>
        </div></div>}</>}
        <p className="admin-note"><ShieldCheck size={14} />浏览器不使用 localStorage 或 IndexedDB 保存作品。</p>
        <div className="admin-form-actions admin-storage-actions"><span className="admin-muted">当前生效：{nativeCloud ? `Cloudflare · ${cloudBackend}` : data.storage.mode === 'memory' ? '服务器内存' : 'R2 / S3'}</span>
          {(nativeCloud || draft.mode === 's3') && <button type="button" className="admin-button admin-button-small" disabled={!!busy || (!nativeCloud && data.storage.mode !== 's3') || storageDirty} title={storageDirty || (!nativeCloud && data.storage.mode !== 's3') ? '请先保存配置，再验证读写' : '验证已保存配置的写入、读取和删除能力'}
            onClick={() => { void mutate('storage-test', '/api/admin/storage/test', json('POST'), '结果存储验证通过，读写与删除正常。'); }}>{busy === 'storage-test' ? <Spinner /> : <Cloud size={14} />}{nativeCloud ? '验证云端读写' : '测试连接'}</button>}
          <button className="admin-button admin-button-primary admin-button-small" disabled={!!busy || !validStorage || !storageDirty}>{busy === 'storage-save' ? <Spinner /> : <Check size={14} />}保存存储配置</button>
        </div>{(nativeCloud || draft.mode === 's3') && (storageDirty || (!nativeCloud && data.storage.mode !== 's3')) && <p className="admin-storage-test-note">先保存配置，再测试对象存储连接。</p>}
      </form>
    </section>
    <aside className="admin-stack"><section className="admin-panel admin-retention-panel"><div className="admin-section-heading"><div className="admin-step-heading"><span><Archive size={16} /></span><div><h2>历史保留时间</h2><p>控制测试记录和正文的保存期限。</p></div></div></div>
      <form onSubmit={saveRetention}><label className="admin-field">默认保留天数<div className="admin-retention-input"><input type="number" min={1} max={3650} step={1} value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} required /><span>天</span></div><small>可设置 1–3650 天，默认 30 天。</small></label>
        <div className="admin-retention-presets">{[7, 30, 90, 365].map((value) => <button type="button" key={value} className={days === value ? 'selected' : ''} onClick={() => setRetentionDays(String(value))} disabled={!!busy}>{value} 天</button>)}</div>
        <div className="admin-retention-explanation"><Clock3 size={16} /><p>保存后，系统会按保留时间自动清理过期历史及其完整正文，前台会同步移除这些结果。外部文件删除成功后再删除历史；清理失败会保留记录并自动重试。<br />各 API 单独设置的保留时间优先于此默认值。</p></div>
        {validRetention && days < data.settings.retentionDays && <p className="admin-automation-warning"><Info size={13} />缩短保留时间后，超过 {days} 天的历史会自动删除，无法恢复。</p>}
        <button className="admin-button admin-button-primary admin-retention-save" disabled={!!busy || !validRetention || days === data.settings.retentionDays}>{busy === 'retention-save' ? <Spinner /> : <Check size={14} />}保存保留时间</button>
      </form>
    </section><div className="admin-storage-footnote"><ShieldCheck size={16} /><p>{nativeCloud ? '云端完整作品与测试历史按照保留设置一起清理，无需在本机保存作品文件。' : '历史保留与完整作品存储分别生效。使用内存模式时，作品可能早于历史保留期限失效。'}</p></div></aside>
  </div></div>;
}
