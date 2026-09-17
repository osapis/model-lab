import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowLeft, ArrowRight, ArrowRightLeft, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronRight,
  Clock3, Code2, Copy, Database, FileText, FlaskConical, KeyRound, Layers3, LoaderCircle,
  LogOut, Pencil, Play, Plus, RefreshCw, Settings2, ShieldCheck, Square,
  Trash2, X, XCircle,
} from 'lucide-react';
import type { AdminData, Category, Model, Prompt, Provider, Run } from '../shared/types';
import { api, json } from './api';
import { REASONING_EFFORTS, normalizeReasoningEffort } from '../shared/reasoning';
import Preview from './Preview';
import { Schedules, StorageSettingsPanel } from './AdminAutomation';
import { RecordCleanup, useRecordCleanup } from './RecordCleanup';
import ConfigBackup from './ConfigBackup';
import RetryInfo from './RetryInfo';
import type { CleanupFilters } from './cleanup';
import './admin.css';

type Tab = 'workbench' | 'models' | 'prompts' | 'records' | 'schedules' | 'storage' | 'backup';
type Mutate = (key: string, path: string, options: RequestInit, message: string) => Promise<boolean>;

const categoryLabels: Record<Category, string> = { visual: '视觉创作', reasoning: '逻辑推理', text: '文本能力' };
const statusLabels: Record<Run['status'], string> = {
  queued: '等待中', running: '测试中', completed: '已完成', failed: '失败', cancelled: '已取消',
};
const isActive = (run: Run) => run.status === 'queued' || run.status === 'running';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';
const dateLabel = (date: string) => new Date(date).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const durationLabel = (ms: number | null) => ms === null ? '—' : `${(ms / 1000).toFixed(1)} 秒`;

function Spinner() { return <LoaderCircle size={16} className="admin-spin" aria-hidden="true" />; }

function StatusBadge({ run }: { run: Run }) {
  const Icon = run.status === 'completed' ? CheckCircle2 : run.status === 'failed' ? XCircle : Clock3;
  return <span className={`admin-status admin-status-${run.status}`}><Icon size={12} />{statusLabels[run.status]}</span>;
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="admin-empty"><span className="admin-empty-icon">{icon}</span><h3>{title}</h3>{children}</div>;
}

function ConfirmDelete({ onDelete, disabled, label = '删除', description = '确认删除？' }: {
  onDelete: () => Promise<boolean>; disabled: boolean; label?: string; description?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) return <button type="button" className="admin-icon-button admin-danger-icon" disabled={disabled}
    onClick={() => setConfirming(true)} aria-label={label} title={label}><Trash2 size={15} /></button>;
  return <div className="admin-delete-confirm"><span>{description}</span>
    <button type="button" className="admin-button admin-button-danger admin-button-small" disabled={disabled}
      onClick={async () => { if (await onDelete()) setConfirming(false); }}>删除</button>
    <button type="button" className="admin-icon-button" disabled={disabled} onClick={() => setConfirming(false)} aria-label="取消删除"><X size={15} /></button>
  </div>;
}

export default function Admin({ onResultsChanged }: { onResultsChanged: (deletedIds?: string[]) => void }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [data, setData] = useState<AdminData | null>(null);
  const [tab, setTab] = useState<Tab>('workbench');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);

  const loadData = useCallback(async () => {
    const next = await api<AdminData>('/api/admin/data');
    setData(next);
    return next;
  }, []);

  const recordsChanged = useCallback(async (deletedIds?: string[]) => {
    try { await loadData(); }
    finally { onResultsChanged(deletedIds); }
  }, [loadData, onResultsChanged]);

  useEffect(() => {
    let alive = true;
    api<{ authenticated: boolean }>('/api/auth/session').then(async (session) => {
      if (!alive) return;
      setAuthenticated(session.authenticated);
      if (session.authenticated) await loadData();
    }).catch((err) => {
      if (alive) { setAuthenticated(false); setError(errorMessage(err)); }
    });
    return () => { alive = false; };
  }, [loadData]);

  const activeCount = data?.runs.filter(isActive).length ?? 0;
  const hasEnabledSchedule = data?.schedules.some((schedule) => schedule.enabled) ?? false;
  useEffect(() => {
    if (!authenticated || (!activeCount && !hasEnabledSchedule)) return;
    let fetching = false;
    const interval = window.setInterval(async () => {
      if (fetching) return;
      fetching = true;
      try { await loadData(); } catch (err) { setError(errorMessage(err)); }
      finally { fetching = false; }
    }, activeCount ? 2000 : 15000);
    return () => window.clearInterval(interval);
  }, [authenticated, activeCount, hasEnabledSchedule, loadData]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const mutate: Mutate = async (key, path, options, message) => {
    setBusy(key); setError(''); setNotice('');
    try {
      await api(path, options);
      await loadData();
      const deletedRun = options.method === 'DELETE' ? /^\/api\/admin\/runs\/([^/]+)$/.exec(path) : null;
      onResultsChanged(deletedRun ? [decodeURIComponent(deletedRun[1])] : undefined);
      setNotice(message);
      return true;
    } catch (err) { setError(errorMessage(err)); return false; }
    finally { setBusy(''); }
  };

  async function login(event: FormEvent) {
    event.preventDefault(); setBusy('login'); setError('');
    try {
      await api('/api/auth/login', json('POST', { token }));
      setToken(''); setAuthenticated(true);
      await loadData();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(''); }
  }

  async function refresh() {
    setRefreshing(true); setError('');
    try { await loadData(); } catch (err) { setError(errorMessage(err)); }
    finally { setRefreshing(false); }
  }

  async function logout() {
    setBusy('logout'); setError('');
    try {
      await api('/api/auth/logout', json('POST'));
      setAuthenticated(false); setData(null); setToken(''); setNotice('');
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(''); }
  }

  if (authenticated === null) return <div className="admin-root admin-loading"><Spinner /><span>正在载入管理控制台…</span></div>;

  if (!authenticated) return <div className="admin-root admin-login-page">
    <a className="admin-back-link" href="/"><ArrowLeft size={15} />返回测试展厅</a>
    <div className="admin-login-card">
      <span className="admin-login-icon"><KeyRound size={25} /></span>
      <p className="admin-eyebrow">MODEL LAB / CONSOLE</p>
      <h1>管理你的模型实验室</h1>
      <p className="admin-muted">配置接口和提示词，持续测试并在前台查看每一次真实结果。</p>
      {error && <div className="admin-alert admin-alert-error" role="alert"><XCircle size={17} /><span>{error}</span></div>}
      <form onSubmit={login} className="admin-login-form">
        <label className="admin-field">管理口令
          <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="输入管理口令"
            autoComplete="current-password" required autoFocus />
        </label>
        <button className="admin-button admin-button-primary" disabled={!!busy || !token.trim()}>
          {busy ? <Spinner /> : <ShieldCheck size={17} />}进入控制台<ArrowRight size={16} />
        </button>
      </form>
      <div className="admin-login-help"><ShieldCheck size={16} /><p>首次启动时，管理口令保存在服务器的 <code>.data/admin-token</code> 文件中。API 密钥仅保存在后端。</p></div>
    </div>
    <p className="admin-login-footer">每一次测试，都有迹可循。</p>
  </div>;

  const tabs: { id: Tab; label: string; icon: typeof FlaskConical; count?: number }[] = [
    { id: 'workbench', label: '测试工作台', icon: FlaskConical },
    { id: 'models', label: '接口与模型', icon: Layers3, count: data?.models.length },
    { id: 'prompts', label: '提示词管理', icon: FileText, count: data?.prompts.length },
    { id: 'records', label: '历史记录', icon: Activity },
    { id: 'schedules', label: '定时任务', icon: CalendarClock, count: data?.schedules.length },
    { id: 'storage', label: '全局设置', icon: Settings2 },
    { id: 'backup', label: '配置迁移', icon: ArrowRightLeft },
  ];

  return <div className="admin-root">
    <div className="admin-main">
      <div className="admin-page-heading"><div><h1>{tabs.find(item => item.id === tab)?.label}</h1><p>{data?.providers.length ?? 0} 个接口 · {data?.models.length ?? 0} 个模型</p></div>
        <div className="admin-page-actions"><button className="admin-button admin-button-small" onClick={refresh} disabled={refreshing || !!busy || cleanupBusy || backupBusy}>
          {refreshing ? <Spinner /> : <RefreshCw size={14} />}刷新数据
        </button><button className="admin-icon-button" disabled={!!busy || cleanupBusy || backupBusy} onClick={logout} aria-label="退出登录" title="退出登录"><LogOut size={17} /></button></div>
      </div>
      <nav className="admin-tabs" aria-label="管理页面">
        {tabs.map(({ id, label, icon: Icon, count }) => <button key={id} type="button" className={tab === id ? 'active' : ''}
          aria-current={tab === id ? 'page' : undefined} disabled={cleanupBusy || backupBusy} onClick={() => { setTab(id); setError(''); }}>
          <Icon size={17} />{label}{count !== undefined && <span>{count}</span>}
        </button>)}
        {activeCount > 0 && <span className="admin-live"><span />{activeCount} 项运行中 · 自动刷新</span>}
      </nav>
      {error && <div className="admin-alert admin-alert-error" role="alert"><XCircle size={17} /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={16} /></button></div>}
      {notice && <div className="admin-alert admin-alert-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="关闭提示"><X size={16} /></button></div>}
      {!data ? <div className="admin-panel admin-loading"><Spinner /><span>正在读取配置…</span></div> : <>
        {tab === 'workbench' && <Workbench data={data} busy={busy} mutate={mutate} setTab={setTab} />}
        {tab === 'models' && <Models data={data} busy={busy} mutate={mutate} />}
        {tab === 'prompts' && <Prompts prompts={data.prompts} busy={busy} mutate={mutate} />}
        {tab === 'records' && <Records data={data} busy={busy} mutate={mutate} onChanged={recordsChanged} onCleanupBusy={setCleanupBusy} />}
        {tab === 'schedules' && <Schedules data={data} busy={busy} mutate={mutate} />}
        {tab === 'storage' && <StorageSettingsPanel data={data} busy={busy} mutate={mutate} />}
        {tab === 'backup' && <ConfigBackup data={data} disabled={!!busy || refreshing} onBusyChange={setBackupBusy} onChanged={recordsChanged} />}
      </>}
      <footer className="admin-footer"><span><ShieldCheck size={13} />接口配置仅管理员可见，全部测试自动展示</span><span>Model Lab / 可复现的模型观察</span></footer>
    </div>
  </div>;
}

function Workbench({ data, busy, mutate, setTab }: { data: AdminData; busy: string; mutate: Mutate; setTab: (tab: Tab) => void }) {
  const availablePrompts = data.prompts.filter((prompt) => prompt.enabled);
  const availableModels = data.models.filter((model) => model.enabled && data.providers.some((provider) => provider.id === model.providerId && provider.enabled));
  const [promptIds, setPromptIds] = useState<string[]>(() => availablePrompts.slice(0, 1).map((prompt) => prompt.id));
  const [modelIds, setModelIds] = useState<string[]>(() => availableModels.slice(0, 1).map((model) => model.id));
  const [repeats, setRepeats] = useState(1);
  const selectedPrompts = availablePrompts.filter((prompt) => promptIds.includes(prompt.id));
  const selectedModels = availableModels.filter((model) => modelIds.includes(model.id));
  const taskCount = selectedPrompts.length * selectedModels.length * repeats;
  const recentRuns = data.runs.slice(0, 4);

  function toggle(id: string, list: string[], setter: (ids: string[]) => void) {
    setter(list.includes(id) ? list.filter((current) => current !== id) : [...list, id]);
  }

  async function launch() {
    const success = await mutate('launch', '/api/admin/runs', json('POST', {
      promptIds: selectedPrompts.map((prompt) => prompt.id), modelIds: selectedModels.map((model) => model.id), repeats,
    }), `已创建 ${taskCount} 个测试任务，所有结果与失败记录将自动显示在前台。`);
    if (success) setTab('records');
  }

  return <div className="admin-workbench-layout">
    <div className="admin-stack">
      <section className="admin-panel"><div className="admin-section-heading"><div className="admin-step-heading"><span>01</span><div><h2>选择测试提示词</h2><p>同一题目，对比不同模型的真实表现。</p></div></div>
        {availablePrompts.length > 0 && <button className="admin-text-button" onClick={() => setPromptIds(selectedPrompts.length === availablePrompts.length ? [] : availablePrompts.map((prompt) => prompt.id))}>{selectedPrompts.length === availablePrompts.length ? '取消全选' : '全选'}</button>}
      </div>
        {availablePrompts.length === 0 ? <Empty icon={<FileText size={24} />} title="还没有可用的提示词"><p>添加一个提示词，开始第一次模型测试。</p><button className="admin-button admin-button-small" onClick={() => setTab('prompts')}>管理提示词<ArrowRight size={14} /></button></Empty> :
          <div className="admin-choice-list">{availablePrompts.map((prompt) => <label key={prompt.id} className={`admin-choice-card ${promptIds.includes(prompt.id) ? 'selected' : ''}`}>
            <input type="checkbox" checked={promptIds.includes(prompt.id)} onChange={() => toggle(prompt.id, promptIds, setPromptIds)} />
            <div className="admin-choice-content"><div className="admin-choice-title"><strong>{prompt.title}</strong><span className={`admin-category admin-category-${prompt.category}`}>{categoryLabels[prompt.category]}</span></div>
              <p>{prompt.description || prompt.content}</p></div>
          </label>)}</div>}
      </section>
      <section className="admin-panel"><div className="admin-section-heading"><div className="admin-step-heading"><span>02</span><div><h2>选择参测模型</h2><p>仅显示已启用的接口和模型。</p></div></div>
        {availableModels.length > 0 && <button className="admin-text-button" onClick={() => setModelIds(selectedModels.length === availableModels.length ? [] : availableModels.map((model) => model.id))}>{selectedModels.length === availableModels.length ? '取消全选' : '全选'}</button>}
      </div>
        {availableModels.length === 0 ? <Empty icon={<Layers3 size={25} />} title="先连接你的第一个 API"><p>配置兼容接口和模型，随后就能在这里选择参测。</p><button className="admin-button admin-button-primary admin-button-small" onClick={() => setTab('models')}><Plus size={15} />添加接口与模型</button></Empty> :
          <div className="admin-model-choices">{availableModels.map((model) => <label key={model.id} className={`admin-choice-card admin-model-choice ${modelIds.includes(model.id) ? 'selected' : ''}`}>
            <input type="checkbox" checked={modelIds.includes(model.id)} onChange={() => toggle(model.id, modelIds, setModelIds)} />
            <div className="admin-choice-content"><strong className="admin-choice-provider">{data.providers.find((provider) => provider.id === model.providerId)?.name}</strong><span className="admin-choice-model">{model.name}</span><p>{model.modelId}</p></div>
          </label>)}</div>}
      </section>
    </div>
    <aside className="admin-stack">
      <section className="admin-panel admin-launch-panel"><div className="admin-step-heading"><span>03</span><div><h2>准备运行</h2><p>每次调用独立生成一条记录。</p></div></div>
        <dl className="admin-launch-summary"><div><dt>已选提示词</dt><dd>{selectedPrompts.length}<small> 道</small></dd></div><div><dt>参测模型</dt><dd>{selectedModels.length}<small> 个</small></dd></div></dl>
        <label className="admin-field">每组重复次数<select value={repeats} onChange={(event) => setRepeats(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} 次{value === 1 ? ' · 单次测试' : ' · 观察结果稳定性'}</option>)}</select></label>
        <div className="admin-total"><span>本次任务总数</span><strong>{taskCount}<small>项</small></strong></div>
        {taskCount > 50 && <p className="admin-batch-limit" role="status">每批最多 50 项，请减少选项或重复次数。</p>}
        <button className="admin-button admin-button-primary admin-launch-button" disabled={!!busy || taskCount === 0 || taskCount > 50} onClick={launch}>{busy === 'launch' ? <Spinner /> : <Play size={16} fill="currentColor" />}开始测试<ArrowRight size={16} /></button>
        <p className="admin-note"><ShieldCheck size={14} />每次测试的真实输出与失败记录都会自动显示在前台，便于持续比较接口表现。</p>
      </section>
      <section className="admin-panel admin-recent-panel"><div className="admin-section-heading"><h2>最近活动</h2><button className="admin-text-button" onClick={() => setTab('records')}>查看全部<ArrowRight size={13} /></button></div>
        {recentRuns.length === 0 ? <p className="admin-muted">测试记录将在这里出现。</p> : recentRuns.map((run) => <div className="admin-recent-run" key={run.id}><div><strong>{run.providerName}</strong><span>{run.modelName} · {run.promptTitle}</span>{run.source === 'sample' && <small>会话子代理样例</small>}</div><StatusBadge run={run} /></div>)}
      </section>
    </aside>
  </div>;
}

function Models({ data, busy, mutate }: { data: AdminData; busy: string; mutate: Mutate }) {
  const [providerEditor, setProviderEditor] = useState<Provider | 'new' | null>(null);
  const [modelEditor, setModelEditor] = useState<Model | 'new' | null>(null);

  return <div className="admin-stack">
    <section className="admin-panel"><div className="admin-section-heading"><div><h2>API 接口<span className="admin-heading-count">{data.providers.length}</span></h2><p>支持兼容 Chat Completions 和 Responses 的接口。</p></div>
      <button className="admin-button admin-button-primary admin-button-small" onClick={() => setProviderEditor('new')} disabled={!!busy}><Plus size={15} />添加接口</button></div>
      {providerEditor && <ProviderEditor key={providerEditor === 'new' ? 'new' : providerEditor.id} provider={providerEditor === 'new' ? undefined : providerEditor} globalRetentionDays={data.settings.retentionDays} busy={busy} mutate={mutate} onClose={() => setProviderEditor(null)} />}
      {data.providers.length === 0 && !providerEditor ? <Empty icon={<KeyRound size={25} />} title="还没有配置接口"><p>添加 Base URL 与 API Key，然后为接口添加参测模型。</p></Empty> :
        <div className="admin-provider-list">{data.providers.map((provider) => <article key={provider.id} className="admin-provider-row"><div className="admin-provider-logo"><Layers3 size={20} /></div>
          <div className="admin-row-main"><div className="admin-row-title"><h3>{provider.name}</h3><span className={`admin-small-badge ${provider.enabled ? 'enabled' : ''}`}>{provider.enabled ? '已启用' : '已停用'}</span></div><p className="admin-mono admin-ellipsis" title={provider.baseUrl}>{provider.baseUrl}</p>
            <div className="admin-row-meta"><span>{provider.protocol === 'responses' ? 'Responses' : 'Chat Completions'}</span><span className={provider.apiKeyPreview ? 'admin-saved-key' : undefined} aria-label={provider.apiKeyPreview ? '已保存的 API Key（部分隐藏）' : undefined}><KeyRound size={12} />{provider.apiKeyPreview ? <code>{provider.apiKeyPreview}</code> : provider.hasApiKey ? '已配置密钥' : '未配置密钥'}</span><span>{data.models.filter((model) => model.providerId === provider.id).length} 个模型</span><span>历史保留 {provider.retentionDays ?? data.settings.retentionDays} 天{provider.retentionDays == null ? ' · 跟随全局' : ''}</span></div>
          </div>
          <div className="admin-row-actions"><button type="button" className={`admin-toggle ${provider.enabled ? 'on' : ''}`} role="switch" aria-checked={provider.enabled} aria-label={`${provider.enabled ? '停用' : '启用'}接口 ${provider.name}`} disabled={!!busy}
            onClick={() => mutate(`provider-toggle-${provider.id}`, `/api/admin/providers/${provider.id}`, json('PUT', { ...provider, enabled: !provider.enabled }), provider.enabled ? '接口已停用。' : '接口已启用。')}><span /></button>
            <button className="admin-icon-button" onClick={() => setProviderEditor(provider)} disabled={!!busy} aria-label={`编辑接口 ${provider.name}`} title="编辑接口"><Pencil size={15} /></button>
            <ConfirmDelete disabled={!!busy} label={`删除接口 ${provider.name}`} description="删除接口？" onDelete={() => mutate(`provider-delete-${provider.id}`, `/api/admin/providers/${provider.id}`, json('DELETE'), '接口已删除。')} />
          </div>
        </article>)}</div>}
    </section>
    <section className="admin-panel"><div className="admin-section-heading"><div><h2>参测模型<span className="admin-heading-count">{data.models.length}</span></h2><p>从接口自动获取模型，设置推理强度、输出长度和显示名称。</p></div>
      <button className="admin-button admin-button-small" onClick={() => setModelEditor('new')} disabled={!!busy || data.providers.length === 0}><Plus size={15} />添加模型</button></div>
      {modelEditor && <ModelEditor key={modelEditor === 'new' ? 'new' : modelEditor.id} model={modelEditor === 'new' ? undefined : modelEditor} providers={data.providers} busy={busy} mutate={mutate} onClose={() => setModelEditor(null)} />}
      {data.models.length === 0 && !modelEditor ? <Empty icon={<Settings2 size={25} />} title="让你的模型加入测试"><p>{data.providers.length ? '点击“添加模型”，自动读取并选择接口支持的模型。' : '先添加上方的 API 接口，再配置模型。'}</p></Empty> :
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>模型</th><th>所属接口</th><th>生成参数</th><th>状态</th><th className="admin-action-heading">操作</th></tr></thead>
          <tbody>{data.models.map((model) => { const provider = data.providers.find((item) => item.id === model.providerId); return <tr key={model.id}>
            <td><strong>{model.name}</strong><span className="admin-cell-sub admin-mono">{model.modelId}</span></td><td>{provider?.name || '接口已移除'}{provider && !provider.enabled && <span className="admin-cell-sub">接口已停用</span>}</td>
            <td><span className="admin-parameter">推理 {model.reasoningEffort || '默认'}</span><span className="admin-cell-sub">最大 {model.maxTokens.toLocaleString()} tokens</span></td>
            <td><button type="button" className={`admin-toggle ${model.enabled ? 'on' : ''}`} role="switch" aria-checked={model.enabled} aria-label={`${model.enabled ? '停用' : '启用'}模型 ${model.name}`} disabled={!!busy}
              onClick={() => mutate(`model-toggle-${model.id}`, `/api/admin/models/${model.id}`, json('PUT', {
                name: model.name, providerId: model.providerId, modelId: model.modelId,
                maxTokens: model.maxTokens, reasoningEffort: model.reasoningEffort, enabled: !model.enabled,
              }), model.enabled ? '模型已停用。' : '模型已启用。')}><span /></button></td>
            <td><div className="admin-row-actions"><button className="admin-icon-button" onClick={() => setModelEditor(model)} disabled={!!busy} aria-label={`编辑模型 ${model.name}`} title="编辑模型"><Pencil size={15} /></button><ConfirmDelete disabled={!!busy} label={`删除模型 ${model.name}`} onDelete={() => mutate(`model-delete-${model.id}`, `/api/admin/models/${model.id}`, json('DELETE'), '模型已删除。')} /></div></td>
          </tr>; })}</tbody>
        </table></div>}
    </section>
  </div>;
}

function EditorFrame({ title, children, busy, onClose }: { title: string; children: ReactNode; busy: boolean; onClose: () => void }) {
  return <div className="admin-editor"><div className="admin-editor-heading"><h3>{title}</h3><button type="button" className="admin-icon-button" disabled={busy} onClick={onClose} aria-label="关闭编辑表单"><X size={17} /></button></div>{children}</div>;
}

function FormActions({ busy, saving, disabled = false, onClose }: { busy: boolean; saving: boolean; disabled?: boolean; onClose: () => void }) {
  return <div className="admin-form-actions"><button type="button" className="admin-button admin-button-small" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="admin-button admin-button-primary admin-button-small" disabled={busy || disabled}>{saving ? <Spinner /> : <Check size={15} />}保存配置</button></div>;
}

function ProviderEditor({ provider, globalRetentionDays, busy, mutate, onClose }: { provider?: Provider; globalRetentionDays: number; busy: string; mutate: Mutate; onClose: () => void }) {
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [protocol, setProtocol] = useState<Provider['protocol']>(provider?.protocol ?? 'chat-completions');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [retentionDays, setRetentionDays] = useState(provider?.retentionDays == null ? '' : String(provider.retentionDays));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (await mutate('provider-save', `/api/admin/providers${provider ? `/${provider.id}` : ''}`, json(provider ? 'PUT' : 'POST', {
      name: name.trim(), baseUrl: baseUrl.trim(), protocol, apiKey: apiKey.trim(), enabled,
      retentionDays: retentionDays === '' ? null : Number(retentionDays),
    }), '接口配置已保存。')) onClose();
  }
  return <EditorFrame title={provider ? `编辑接口 · ${provider.name}` : '添加 API 接口'} busy={!!busy} onClose={onClose}><form onSubmit={save}>
    <div className="admin-form-grid"><label className="admin-field">接口名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的 API 中转" maxLength={100} required autoFocus /></label>
      <label className="admin-field">调用协议<select value={protocol} onChange={(event) => setProtocol(event.target.value as Provider['protocol'])}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select></label>
      <label className="admin-field admin-field-full">Base URL<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" maxLength={2048} required /><small>填写到 /v1（或服务商要求的版本路径），系统会自动添加接口端点。</small></label>
      <label className="admin-field admin-field-full">API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider?.hasApiKey ? '已设置密钥，留空保留原密钥' : '输入 API Key；无鉴权接口可留空'} autoComplete="new-password" />{provider?.apiKeyPreview && <small className="admin-current-key">当前已保存：<code className="admin-saved-key">{provider.apiKeyPreview}</code></small>}<small>密钥在服务器端加密保存，后台仅展示首尾缩略值。{provider?.hasApiKey ? '修改时留空会保留原值。' : ''}</small></label>
      <label className="admin-field admin-field-full">此接口的历史保留天数（可选）<input type="number" min={1} max={3650} step={1} value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} placeholder={`留空跟随全局：${globalRetentionDays} 天`} /><small>保存后按此期限自动清理过期历史及外部存储中的作品正文。留空使用全局设置。</small></label>
    </div><label className="admin-checkbox-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用此接口</label>
    <FormActions busy={!!busy} saving={busy === 'provider-save'} onClose={onClose} />
  </form></EditorFrame>;
}

const reasoningOptions = REASONING_EFFORTS;
type DiscoveredModel = { id: string; ownedBy?: string };

function ModelEditor({ model, providers, busy, mutate, onClose }: { model?: Model; providers: Provider[]; busy: string; mutate: Mutate; onClose: () => void }) {
  const [name, setName] = useState(model?.name ?? '');
  const [modelId, setModelId] = useState(model?.modelId ?? '');
  const [providerId, setProviderId] = useState(model?.providerId ?? providers[0]?.id ?? '');
  const nameCustomized = useRef(Boolean(model && model.name !== model.modelId));
  const [modelOptions, setModelOptions] = useState<DiscoveredModel[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [modelsRefresh, setModelsRefresh] = useState(0);
  const [manualModel, setManualModel] = useState(false);
  const requestVersion = useRef(0);
  const modelRequest = useRef<AbortController | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(model?.maxTokens ?? 8192));
  const [reasoningEffort, setReasoningEffort] = useState<string>(() => normalizeReasoningEffort(model?.reasoningEffort));
  const [enabled, setEnabled] = useState(model?.enabled ?? true);

  useEffect(() => {
    const controller = new AbortController();
    modelRequest.current = controller;
    const version = ++requestVersion.current;
    setModelsLoading(true); setModelsError(''); setModelsLoaded(false);
    if (!providerId) { setModelsLoading(false); return () => controller.abort(); }
    api<{ models: DiscoveredModel[] }>(`/api/admin/providers/${encodeURIComponent(providerId)}/models`, { signal: controller.signal })
      .then(({ models }) => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setModelOptions(models); setModelsLoaded(true);
      }).catch((error) => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setModelOptions([]); setModelsError(errorMessage(error));
      }).finally(() => {
        if (!controller.signal.aborted && version === requestVersion.current) setModelsLoading(false);
      });
    return () => controller.abort();
  }, [providerId, modelsRefresh]);

  function selectModel(value: string) {
    setModelId(value);
    if (!nameCustomized.current) setName(value.slice(0, 120));
  }

  function changeProvider(value: string) {
    modelRequest.current?.abort(); requestVersion.current++;
    setProviderId(value); selectModel(''); setModelOptions([]); setModelSearch('');
    setModelsError(''); setModelsLoaded(false); setModelsLoading(true); setManualModel(false);
  }

  const filteredModels = modelOptions.filter((option) => `${option.id} ${option.ownedBy || ''}`.toLowerCase().includes(modelSearch.trim().toLowerCase()));
  const selectedMissing = Boolean(modelId && modelsLoaded && !modelOptions.some((option) => option.id === modelId));
  const showSelectedOption = Boolean(modelId && !filteredModels.some((option) => option.id === modelId));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !modelId.trim() || !providerId) return;
    if (await mutate('model-save', `/api/admin/models${model ? `/${model.id}` : ''}`, json(model ? 'PUT' : 'POST', {
      name: name.trim(), modelId: modelId.trim(), providerId,
      maxTokens: Number(maxTokens), reasoningEffort: reasoningEffort.trim(), enabled,
    }), '模型配置已保存。')) onClose();
  }
  return <EditorFrame title={model ? `编辑模型 · ${model.name}` : '添加参测模型'} busy={!!busy} onClose={onClose}><form onSubmit={save}>
    <div className="admin-form-grid"><label className="admin-field">所属 API 接口<select value={providerId} onChange={(event) => changeProvider(event.target.value)} required disabled={!!busy}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{!provider.enabled && '（已停用）'}</option>)}</select></label>
      <label className="admin-field">显示名称<input value={name} onChange={(event) => { nameCustomized.current = Boolean(event.target.value); setName(event.target.value); }} placeholder="选择模型后自动填写，可自行修改" maxLength={120} required /><small>自定义名称会保留，不随模型切换覆盖。</small></label>
      <div className="admin-field admin-field-full admin-model-picker">
        <div className="admin-model-picker-heading"><label htmlFor="admin-model-id">模型 ID</label><button type="button" className="admin-text-button" disabled={!!busy || modelsLoading || !providerId} onClick={() => setModelsRefresh((value) => value + 1)}><RefreshCw size={13} />刷新模型</button></div>
        {modelsLoading && <p className="admin-model-picker-status" role="status"><Spinner />正在读取所选接口支持的模型…</p>}
        {modelsError && <p className="admin-model-picker-error" role="alert">无法自动获取模型：{modelsError}。可刷新重试；若接口不支持模型列表，请切换到手动输入。</p>}
        {modelsLoaded && modelOptions.length === 0 && <p className="admin-model-picker-error" role="status">此接口返回了空模型列表。可刷新重试，或手动填写该接口支持的模型 ID。</p>}
        {manualModel ? <input id="admin-model-id" aria-label="模型 ID（手动输入）" value={modelId} onChange={(event) => selectModel(event.target.value)} placeholder="填写接口支持的准确模型 ID" maxLength={200} required /> : <>
          <input aria-label="搜索接口支持的模型" type="search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="搜索模型 ID…" disabled={modelsLoading || !modelOptions.length} />
          <select id="admin-model-id" value={modelId} onChange={(event) => selectModel(event.target.value)} disabled={modelsLoading || (!modelOptions.length && !modelId)} required>
            <option value="">{modelsLoading ? '正在加载模型…' : modelOptions.length ? '选择接口支持的模型' : '暂无可选模型'}</option>
            {showSelectedOption && <option value={modelId}>{modelId}（当前选择）</option>}
            {filteredModels.map((option) => <option key={option.id} value={option.id}>{option.id}{option.ownedBy ? ` · ${option.ownedBy}` : ''}</option>)}
          </select>
          {modelsLoaded && modelOptions.length > 0 && <small>{modelSearch.trim() ? `匹配 ${filteredModels.length} 个模型，共 ${modelOptions.length} 个。` : `已从所选接口获取 ${modelOptions.length} 个模型。`}</small>}
        </>}
        {selectedMissing && <p className="admin-model-picker-error" role="status">当前模型 ID「{modelId}」不在接口返回的列表中，已保留该选择。请确认接口仍支持它。</p>}
        <div className="admin-model-picker-footer"><small>测试将使用此 ID，区分大小写。</small><button type="button" className="admin-text-button" disabled={!!busy} onClick={() => setManualModel((value) => !value)}>{manualModel ? '返回模型列表选择' : '手动输入模型 ID'}</button></div>
      </div>
      <label className="admin-field">最大输出 tokens<input type="number" min={1} max={131072} step={1} value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} required /></label>
      <div className="admin-field"><label htmlFor="admin-reasoning-effort">推理强度</label><select id="admin-reasoning-effort" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>{reasoningOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <small>服务器仅支持 low、medium、high、xhigh、max，默认 medium。</small>
      </div>
    </div><label className="admin-checkbox-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用此模型</label>
    <FormActions busy={!!busy} saving={busy === 'model-save'} disabled={!modelId.trim() || !providerId || !name.trim()} onClose={onClose} />
  </form></EditorFrame>;
}

function Prompts({ prompts, busy, mutate }: { prompts: Prompt[]; busy: string; mutate: Mutate }) {
  const [editor, setEditor] = useState<Prompt | 'new' | null>(null);
  return <section className="admin-panel"><div className="admin-section-heading"><div><h2>提示词库<span className="admin-heading-count">{prompts.length}</span></h2><p>保存原始题目、参考答案和观察要点，让测试可复现。</p></div><button className="admin-button admin-button-primary admin-button-small" disabled={!!busy} onClick={() => setEditor('new')}><Plus size={15} />新建提示词</button></div>
    {editor && <PromptEditor key={editor === 'new' ? 'new' : editor.id} prompt={editor === 'new' ? undefined : editor} busy={busy} mutate={mutate} onClose={() => setEditor(null)} />}
    {!prompts.length && !editor ? <Empty icon={<FileText size={25} />} title="从一个好问题开始"><p>可以测试 SVG 动画、逻辑推理，或任何你关心的能力。</p></Empty> : <div className="admin-prompt-list">{prompts.map((prompt) => <article className="admin-prompt-row" key={prompt.id}>
      <div className="admin-prompt-row-heading"><div className="admin-row-title"><h3>{prompt.title}</h3><span className={`admin-category admin-category-${prompt.category}`}>{categoryLabels[prompt.category]}</span>{!prompt.enabled && <span className="admin-small-badge">已停用</span>}</div>
        <div className="admin-row-actions"><button type="button" className={`admin-toggle ${prompt.enabled ? 'on' : ''}`} role="switch" aria-checked={prompt.enabled} aria-label={`${prompt.enabled ? '停用' : '启用'}提示词 ${prompt.title}`} disabled={!!busy}
          onClick={() => mutate(`prompt-toggle-${prompt.id}`, `/api/admin/prompts/${prompt.id}`, json('PUT', { ...prompt, enabled: !prompt.enabled }), prompt.enabled ? '提示词已停用。' : '提示词已启用。')}><span /></button>
          <button className="admin-icon-button" disabled={!!busy} onClick={() => setEditor(prompt)} aria-label={`编辑提示词 ${prompt.title}`} title="编辑提示词"><Pencil size={15} /></button>
          <ConfirmDelete disabled={!!busy} label={`删除提示词 ${prompt.title}`} onDelete={() => mutate(`prompt-delete-${prompt.id}`, `/api/admin/prompts/${prompt.id}`, json('DELETE'), '提示词已删除。历史测试保留原始提示词快照。')} />
        </div>
      </div>{prompt.description && <p className="admin-prompt-description">{prompt.description}</p>}<pre className="admin-prompt-excerpt">{prompt.content}</pre>
      <div className="admin-prompt-row-footer"><div className="admin-tags">{prompt.tags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div><span>{prompt.referenceAnswer ? '已设参考答案' : '未设参考答案'} · {prompt.content.length} 字符</span></div>
    </article>)}</div>}
  </section>;
}

function PromptEditor({ prompt, busy, mutate, onClose }: { prompt?: Prompt; busy: string; mutate: Mutate; onClose: () => void }) {
  const [title, setTitle] = useState(prompt?.title ?? '');
  const [description, setDescription] = useState(prompt?.description ?? '');
  const [category, setCategory] = useState<Category>(prompt?.category ?? 'visual');
  const [content, setContent] = useState(prompt?.content ?? '');
  const [referenceAnswer, setReferenceAnswer] = useState(prompt?.referenceAnswer ?? '');
  const [rubric, setRubric] = useState(prompt?.rubric ?? '');
  const [tags, setTags] = useState(prompt?.tags.join(', ') ?? '');
  const [enabled, setEnabled] = useState(prompt?.enabled ?? true);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (await mutate('prompt-save', `/api/admin/prompts${prompt ? `/${prompt.id}` : ''}`, json(prompt ? 'PUT' : 'POST', {
      title: title.trim(), description: description.trim(), category, content: content.trim(), referenceAnswer: referenceAnswer.trim(),
      rubric: rubric.trim(), tags: [...new Set(tags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean))], enabled,
    }), '提示词已保存。新的测试将使用此版本。')) onClose();
  }
  return <EditorFrame title={prompt ? `编辑提示词 · ${prompt.title}` : '新建测试提示词'} busy={!!busy} onClose={onClose}><form onSubmit={save}>
    <div className="admin-form-grid"><label className="admin-field">标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：鹈鹕骑自行车" maxLength={120} required autoFocus /></label>
      <label className="admin-field">能力分类<select value={category} onChange={(event) => setCategory(event.target.value as Category)}><option value="visual">视觉创作 · HTML / SVG</option><option value="reasoning">逻辑推理 · 计算与推理</option><option value="text">文本能力 · 文字输出</option></select></label>
      <label className="admin-field admin-field-full">一句话描述<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="介绍这个测试主要观察哪些能力" maxLength={1000} /></label>
      <label className="admin-field admin-field-full">测试提示词<textarea rows={7} value={content} onChange={(event) => setContent(event.target.value)} placeholder="输入原始提示词，系统将原文发送给模型…" maxLength={100000} required /><small>HTML / SVG 输出会在前台隔离预览；逻辑推理和文本输出以文字展示。</small></label>
      <label className="admin-field">参考答案（可选）<textarea rows={4} value={referenceAnswer} onChange={(event) => setReferenceAnswer(event.target.value)} placeholder="供结果对照使用，不会发送给参测模型" maxLength={20000} /></label>
      <label className="admin-field">观察要点（可选）<textarea rows={4} value={rubric} onChange={(event) => setRubric(event.target.value)} placeholder="例如：画面完整、动作自然、遵守题目约束。方便对照查看模型输出。" maxLength={20000} /></label>
      <label className="admin-field admin-field-full">标签<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔，例如：SVG, 动画, 创意" /><small>最多 15 个标签，每个不超过 40 字符。</small></label>
    </div><label className="admin-checkbox-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用此提示词</label>
    <FormActions busy={!!busy} saving={busy === 'prompt-save'} onClose={onClose} />
  </form></EditorFrame>;
}

function Records({ data, busy, mutate, onChanged, onCleanupBusy }: {
  data: AdminData; busy: string; mutate: Mutate; onChanged: (deletedIds?: string[]) => Promise<void>; onCleanupBusy: (busy: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('all');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [page, setPage] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [loadedHistoryKey, setLoadedHistoryKey] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasFilters = Boolean(query || providerId || modelId || status !== 'all' || source !== 'all');
  const filters = useMemo<CleanupFilters>(() => ({
    ...(providerId && { providerId }), ...(modelId && { modelId }),
    ...(status !== 'all' && { status }), ...(source !== 'all' && { source }), ...(query && { q: query }),
  }), [providerId, modelId, status, source, query]);
  const historyKey = JSON.stringify({ page, ...filters });
  const cleanup = useRecordCleanup({ filters, onChanged, onBusyChange: onCleanupBusy });
  const selectionUnavailable = loading || !!historyError || loadedHistoryKey !== historyKey || !!busy || search.trim() !== query;

  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(0); setOpenId(null); }, 300);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  const loadHistory = useCallback(async (background = false) => {
    const version = ++requestVersion.current;
    if (!background) setLoading(true);
    const params = new URLSearchParams({ offset: String(page * pageSize), limit: String(pageSize) });
    if (providerId) params.set('providerId', providerId);
    if (modelId) params.set('modelId', modelId);
    if (status !== 'all') params.set('status', status);
    if (source !== 'all') params.set('source', source);
    if (query) params.set('q', query);
    try {
      const result = await api<{ runs: Run[]; total: number }>(`/api/admin/runs?${params.toString()}`);
      if (version !== requestVersion.current) return;
      setRuns(result.runs); setTotal(result.total); setHistoryError(''); setLoadedHistoryKey(historyKey);
      if (page > 0 && page * pageSize >= result.total) setPage(Math.max(0, Math.ceil(result.total / pageSize) - 1));
    } catch (err) { if (version === requestVersion.current) setHistoryError(errorMessage(err)); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [page, providerId, modelId, status, source, query, historyKey]);

  const previousLoader = useRef<typeof loadHistory | null>(null);
  useEffect(() => {
    const background = previousLoader.current === loadHistory;
    previousLoader.current = loadHistory;
    void loadHistory(background);
  }, [data, loadHistory]);
  useEffect(() => () => { requestVersion.current++; }, []);

  const providerOptions = useMemo(() => {
    const options = new Map(data.providers.map((provider) => [provider.id, provider.name]));
    for (const run of [...data.runs, ...runs]) if (run.providerId && !options.has(run.providerId)) options.set(run.providerId, `${run.providerName}（历史接口）`);
    if (providerId && !options.has(providerId)) options.set(providerId, '已移除的接口');
    return [...options].map(([id, name]) => ({ id, name }));
  }, [data.providers, data.runs, runs, providerId]);

  const modelOptions = useMemo(() => {
    const options = new Map(data.models.filter((model) => !providerId || model.providerId === providerId).map((model) => [model.id, model.name]));
    for (const run of [...data.runs, ...runs]) if (run.source === 'api' && (!providerId || run.providerId === providerId) && !options.has(run.modelId)) options.set(run.modelId, `${run.modelName}（历史模型）`);
    if (modelId && !options.has(modelId)) options.set(modelId, '已移除的模型');
    return [...options].map(([id, name]) => ({ id, name }));
  }, [data.models, data.runs, runs, providerId, modelId]);

  function resetPage() { setPage(0); setOpenId(null); }
  function resetFilters() {
    cleanup.reset();
    setSearch(''); setQuery(''); setProviderId(''); setModelId(''); setStatus('all'); setSource('all'); resetPage();
  }

  const cleanupScope = [
    providerId && `接口：${providerOptions.find((provider) => provider.id === providerId)?.name || providerId}`,
    modelId && `模型：${modelOptions.find((model) => model.id === modelId)?.name || modelId}`,
    status !== 'all' && `状态：${statusLabels[status as Run['status']] || status}`,
    source !== 'all' && `来源：${source === 'api' ? 'API 测试' : '会话子代理样例'}`,
    query && `搜索：${query}`,
  ].filter(Boolean).join(' · ') || '全部历史（包括 API 测试和会话子代理样例）';

  return <section className="admin-panel"><div className="admin-section-heading admin-history-heading"><div><h2>历史测试记录<span className="admin-heading-count">{total}</span></h2><p>按接口和模型回看全部历史，每页 20 条。展开记录时加载完整作品。</p></div><div className="admin-history-heading-actions"><button type="button" className={`admin-button admin-button-small ${cleanup.enabled ? '' : 'admin-button-danger'}`} disabled={cleanup.locked || !!busy} onClick={cleanup.toggleMode}>{cleanup.enabled ? <X size={14} /> : <Trash2 size={14} />}{cleanup.enabled ? '退出批量清理' : '批量清理'}</button><button type="button" className="admin-button admin-button-small" disabled={loading || cleanup.locked || !!busy} onClick={() => loadHistory()}>{loading ? <Spinner /> : <RefreshCw size={13} />}刷新记录</button></div></div>
      <div className="admin-history-filters"><label className="admin-search"><span className="admin-sr-only">搜索模型或提示词</span><input value={search} disabled={cleanup.locked} onChange={(event) => { cleanup.reset(); setSearch(event.target.value); }} placeholder="搜索模型、接口或提示词…" /></label>
        <label><span className="admin-sr-only">按 API 接口筛选</span><select value={providerId} disabled={cleanup.locked} onChange={(event) => { cleanup.reset(); setProviderId(event.target.value); setModelId(''); resetPage(); }}><option value="">全部 API 接口</option>{providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
        <label><span className="admin-sr-only">按模型筛选</span><select value={modelId} disabled={cleanup.locked} onChange={(event) => { cleanup.reset(); setModelId(event.target.value); resetPage(); }}><option value="">全部模型</option>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
        <label><span className="admin-sr-only">筛选测试状态</span><select value={status} disabled={cleanup.locked} onChange={(event) => { cleanup.reset(); setStatus(event.target.value); resetPage(); }}><option value="all">全部运行状态</option><option value="queued">等待中</option><option value="running">测试中</option><option value="completed">已完成</option><option value="failed">失败</option><option value="cancelled">已取消</option></select></label>
        <label><span className="admin-sr-only">筛选结果来源</span><select value={source} disabled={cleanup.locked} onChange={(event) => { cleanup.reset(); setSource(event.target.value); resetPage(); }}><option value="all">全部来源</option><option value="api">API 测试</option><option value="sample">会话子代理样例</option></select></label>
      </div>
      {hasFilters && <div className="admin-history-filter-note"><span>当前筛选条件共 {total} 条历史记录</span><button type="button" className="admin-text-button" disabled={cleanup.locked} onClick={resetFilters}>清除筛选<X size={13} /></button></div>}
      <RecordCleanup cleanup={cleanup} runs={runs} scope={cleanupScope} hasFilters={hasFilters} unavailable={selectionUnavailable} />
      {historyError && <div className="admin-alert admin-alert-error" role="alert"><XCircle size={16} /><span>{historyError}</span></div>}
      {loading && !runs.length ? <div className="admin-history-loading"><Spinner /><span>正在读取历史记录…</span></div> : runs.length === 0 ? <Empty icon={<Activity size={25} />} title={hasFilters ? '没有符合条件的记录' : '测试从这里留下记录'}><p>{hasFilters ? '尝试其他关键词或筛选条件。' : '到测试工作台选择提示词和模型，开始第一次运行。'}</p></Empty> : <div className="admin-record-list" aria-busy={loading}>{runs.map((run) => <article key={run.id} className={`admin-record ${openId === run.id ? 'expanded' : ''} ${cleanup.enabled && cleanup.selected.has(run.id) ? 'admin-record-selected' : ''}`}>
        <div className="admin-record-summary">{cleanup.enabled && <label className={`admin-record-select ${isActive(run) ? 'disabled' : ''}`} title={isActive(run) ? '进行中的任务请先展开记录取消' : '选择此记录'}><input type="checkbox" checked={cleanup.selected.has(run.id)} disabled={cleanup.locked || selectionUnavailable || isActive(run)} onChange={() => cleanup.toggleRun(run)} aria-label={isActive(run) ? `${run.providerName} · ${run.promptTitle} 正在进行，请先取消任务` : `选择 ${run.providerName} · ${run.modelName} 的 ${run.promptTitle} 测试记录`} /></label>}<button className="admin-record-open" onClick={() => setOpenId(openId === run.id ? null : run.id)} aria-expanded={openId === run.id} aria-label={`${openId === run.id ? '收起' : '查看'} ${run.providerName} · ${run.modelName} 的 ${run.promptTitle} 测试详情`}>
          <span className="admin-record-chevron">{openId === run.id ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</span>
          <div className="admin-record-heading"><div><strong className="admin-record-provider">{run.source === 'sample' ? '会话子代理样例' : run.providerName || '未命名接口'}</strong><StatusBadge run={run} /></div><p className="admin-record-model">{run.modelName}{run.modelSlug && <span> · {run.modelSlug}</span>}</p><p>{run.promptTitle}</p><span className={`admin-source-label ${run.source === 'sample' ? 'sample' : ''}`}>{run.source === 'sample' ? '会话子代理样例' : 'API 实测'}{run.scheduleId && ' · 定时任务'}</span>{run.artifactAvailable === false && run.status === 'completed' && <span className="admin-artifact-expired">作品正文暂不可用 · 保留历史摘要</span>}{run.cleanupError && <span className="admin-cleanup-pending">正文清理待重试</span>}</div>
        </button><div className="admin-record-metrics"><span className="admin-record-time">{dateLabel(run.createdAt)}<small>{durationLabel(run.latencyMs)}</small></span><span className="admin-record-tokens">{run.outputTokens?.toLocaleString() ?? '—'}<small>输出 tokens</small></span></div></div>
        <RetryInfo run={run} compact />
        {openId === run.id && <RunDetailLoader summaryRun={run} busy={cleanup.locked ? 'bulk-cleanup' : busy} mutate={mutate} />}
      </article>)}</div>}
      <div className="admin-pagination"><span>{total ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)}` : 0} / {total} 条记录</span><div><button type="button" className="admin-button admin-button-small" disabled={loading || cleanup.locked || page === 0} onClick={() => { setPage((value) => value - 1); setOpenId(null); }}><ArrowLeft size={13} />上一页</button><span>第 {page + 1} / {pageCount} 页</span><button type="button" className="admin-button admin-button-small" disabled={loading || cleanup.locked || page + 1 >= pageCount} onClick={() => { setPage((value) => value + 1); setOpenId(null); }}>下一页<ArrowRight size={13} /></button></div></div>
      <div className="admin-record-footer"><span>过期历史按保留设置自动清理；作品完整内容的可用性取决于存储设置。</span></div>
    </section>;
}

function RunDetailLoader({ summaryRun, busy, mutate }: { summaryRun: Run; busy: string; mutate: Mutate }) {
  const [detail, setDetail] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    api<{ run: Run }>(`/api/admin/runs/${encodeURIComponent(summaryRun.id)}`).then(({ run }) => {
      if (alive) setDetail(run);
    }).catch((err) => { if (alive) setError(errorMessage(err)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [summaryRun.id, summaryRun.status, summaryRun.artifactAvailable, summaryRun.finishedAt, reload]);
  if (loading && !detail) return <div className="admin-history-loading"><Spinner /><span>正在加载完整记录…</span></div>;
  if (error) return <div className="admin-run-detail admin-detail-load-error"><div className="admin-alert admin-alert-error" role="alert"><XCircle size={16} /><span>{error}</span></div><button type="button" className="admin-button admin-button-small" onClick={() => setReload((value) => value + 1)}><RefreshCw size={13} />重新加载</button></div>;
  if (!detail) return null;
  const run = {
    ...detail, ...summaryRun,
    output: detail.output, html: detail.html, reasoning: detail.reasoning,
    artifactAvailable: detail.artifactAvailable,
  };
  return <RunDetail key={run.id} run={run} busy={busy} mutate={mutate} />;
}

function RunDetail({ run, busy, mutate }: { run: Run; busy: string; mutate: Mutate }) {
  const [outputTab, setOutputTab] = useState<'preview' | 'output' | 'html' | 'reasoning'>(run.html ? 'preview' : 'output');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const active = isActive(run);
  const artifactMissing = run.status === 'completed' && run.artifactAvailable === false;
  const selectedText = outputTab === 'html' ? run.html : outputTab === 'reasoning' ? run.reasoning : run.output;
  const runTabs = [
    ...(run.html ? [{ id: 'preview' as const, label: '效果预览' }, { id: 'html' as const, label: 'HTML 源码' }] : []),
    { id: 'output' as const, label: '原始回答' },
    ...(run.reasoning ? [{ id: 'reasoning' as const, label: '返回的推理内容' }] : []),
  ];

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copy() {
    try { await navigator.clipboard.writeText(selectedText); setCopied(true); setCopyError(''); }
    catch { setCopyError('浏览器无法访问剪贴板，请直接选中下方文本复制。'); }
  }

  return <div className="admin-run-detail">
    {run.source === 'sample' && <div className="admin-sample-note"><FileText size={16} /><span>这是会话子代理生成的展示样例，并非通过网站配置的 API 实测。{run.sourceLabel && `来源说明：${run.sourceLabel}`}</span></div>}
    {run.error && <div className="admin-alert admin-alert-error" role="alert"><XCircle size={16} /><span>{run.error}</span></div>}
    {run.cleanupError && <div className="admin-alert admin-cleanup-alert" role="status"><Clock3 size={16} /><span>作品正文尚未清理成功，历史记录暂时保留，系统将每分钟重试。{run.cleanupError}</span></div>}
    <RetryInfo run={run} />
    <div className="admin-run-meta"><span>API 接口 <strong>{run.providerName}</strong></span><span>模型 ID <code>{run.modelSlug}</code></span><span>输入 / 输出 tokens <strong>{run.inputTokens ?? '—'} / {run.outputTokens ?? '—'}</strong></span><span>协议 <strong>{run.parameters.protocol ?? '—'}</strong></span><span>推理强度 <strong>{run.parameters.reasoningEffort || '默认'}</strong></span><span>单次超时 <strong>{run.requestTimeoutSeconds ? `${run.requestTimeoutSeconds} 秒` : '未记录'}</strong></span><span>作品存储 <strong>{run.artifactStorage === 'cloudflare' ? 'Cloudflare 云端' : run.artifactStorage === 's3' ? 'R2 / S3 云端' : run.artifactStorage === 'disk' ? '本地硬盘' : '内存缓存'}</strong></span>{run.artifactExpiresAt && <span>保留至 <strong>{dateLabel(run.artifactExpiresAt)}</strong></span>}</div>
    <details className="admin-prompt-snapshot"><summary>查看本次测试的提示词与观察要点</summary><div><span className="admin-detail-label">原始提示词</span><pre>{run.promptContent}</pre>{run.referenceAnswer && <><span className="admin-detail-label">参考答案</span><pre>{run.referenceAnswer}</pre></>}{run.rubric && <><span className="admin-detail-label">观察要点</span><pre>{run.rubric}</pre></>}</div></details>
    <div className="admin-output-box"><div className="admin-output-toolbar"><div className="admin-output-tabs">{runTabs.map(({ id, label }) => <button type="button" key={id} className={outputTab === id ? 'active' : ''} onClick={() => setOutputTab(id)}>{id === 'html' && <Code2 size={13} />}{label}</button>)}</div>
      {outputTab !== 'preview' && selectedText && <button type="button" className="admin-icon-button" onClick={copy} aria-label={copied ? '已复制' : '复制内容'} title={copied ? '已复制' : '复制内容'}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>}
    </div>
      {copyError && <p className="admin-copy-error" role="status">{copyError}</p>}
      {artifactMissing ? <div className="admin-output-empty admin-cache-expired"><Database size={25} /><strong>{run.artifactStorage === 'cloudflare' ? '作品正文暂不可用，历史记录仍保留' : run.artifactStorage === 'disk' ? '本地作品暂不可用，历史记录仍保留' : '作品缓存已失效，历史记录仍保留'}</strong><p>{run.artifactStorage === 'cloudflare' ? '本次测试的接口、状态、耗时和参数仍可查看。可在结果存储设置中验证云端读写状态。' : run.artifactStorage === 'disk' ? '本次测试的接口、状态、耗时和参数仍可查看。请检查 DATA_DIR/artifacts 文件和目录权限。' : '本次测试的接口、状态、耗时和参数仍可查看。需要长期回看完整作品，请为后续测试配置本地硬盘或 Cloudflare R2 / S3 存储。'}</p></div> : outputTab === 'preview' && run.html ? <div className="admin-preview"><Preview html={run.html} title={run.promptTitle} /></div> : selectedText ? <pre className={`admin-raw-output ${outputTab === 'html' ? 'code' : ''}`}>{selectedText}</pre> : <div className="admin-output-empty">{active ? <><Spinner /><span>{run.status === 'queued' ? '任务正在排队，结果将自动更新。' : '模型正在生成，完成后会显示完整输出。'}</span></> : <span>{run.status === 'failed' ? '本次测试未获得有效输出，可检查错误后重试。' : '此记录没有返回内容。'}</span>}</div>}
    </div>
    <div className="admin-run-bottom-actions"><span className="admin-mono" title={run.id}>记录 {run.id.slice(0, 12)}</span><div className="admin-row-actions">
      <a className="admin-button admin-button-small" href={`/?run=${encodeURIComponent(run.id)}`} target="_blank" rel="noopener noreferrer">前台查看<ArrowRight size={14} /></a>
      {active ? <button className="admin-button admin-button-small" disabled={!!busy} onClick={() => mutate(`run-cancel-${run.id}`, `/api/admin/runs/${run.id}/cancel`, json('POST'), '任务已取消。')}>{busy === `run-cancel-${run.id}` ? <Spinner /> : <Square size={12} />}取消任务</button> : <>
        {run.source === 'api' && <button className="admin-button admin-button-small" disabled={!!busy} onClick={() => mutate(`run-retry-${run.id}`, `/api/admin/runs/${run.id}/retry`, json('POST'), '已创建新的重试任务，原记录保留。')}>{busy === `run-retry-${run.id}` ? <Spinner /> : <RefreshCw size={13} />}重新测试</button>}
        <ConfirmDelete disabled={!!busy} label="删除测试记录" description="永久删除此记录？" onDelete={() => mutate(`run-delete-${run.id}`, `/api/admin/runs/${run.id}`, json('DELETE'), '测试记录已删除。')} />
      </>}
    </div></div>
  </div>;
}
