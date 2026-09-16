import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Boxes, Braces, Check, ChevronRight, Clock3, Code2, Copy, Cpu, ExternalLink, FlaskConical, GalleryHorizontalEnd, GitCompareArrows, Grid2X2, LayoutList, Lightbulb, LoaderCircle, Menu, Play, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, X } from 'lucide-react';
import type { Category, Prompt, PublicData, Run } from '../shared/types';
import { runFinishedAt } from '../shared/run-time';
import { api } from './api';
import Preview from './Preview';
import HourlyResults from './HourlyResults';
import RetryInfo from './RetryInfo';
import CandyPreview from './CandyPreview';
import ReasoningHistory from './ReasoningHistory';
import './mobile-results.css';
import { forgetArtifacts, useArtifact, useVisible } from './useArtifact';
import { lockPageScroll, scrollPageToTop } from './dialog-scroll';

const Admin = lazy(() => import('./Admin'));
const categories: Record<Category, string> = { visual: 'SVG 动画', reasoning: '逻辑推理', text: '文本创作' };
const statusNames: Record<Run['status'], string> = { completed: '已完成', failed: '失败', running: '生成中', queued: '排队中', cancelled: '已取消' };
const emptyData: PublicData = { prompts: [], models: [], runs: [], providers: [], stats: { apiRuns: 0, sampleRuns: 0, modelCount: 0, promptCount: 0 } };
const pageSize = 12;
const activePollMs = 15_000;
const idlePollMs = 60_000;
type Page = 'gallery' | 'compare' | 'prompts' | 'admin';
function pageFromLocation(): Page {
  return location.pathname.startsWith('/admin') ? 'admin' : location.pathname.startsWith('/compare') ? 'compare' : location.pathname.startsWith('/prompts') ? 'prompts' : 'gallery';
}
const time = (ms: number | null) => ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`;
const calendarDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const clockTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const date = (value: string) => `${calendarDate.format(new Date(value))} ${clockTime.format(new Date(value))}`;

function TestTimestamp({ run, className = '' }: { run: Run; className?: string }) {
  const value = runFinishedAt(run);
  const active = run.status === 'queued' || run.status === 'running';
  const label = run.status === 'failed' || run.status === 'cancelled' ? '结束时间' : '完成时间';
  const created = Number.isFinite(Date.parse(run.createdAt)) ? `创建时间：${date(run.createdAt)}` : '创建时间未记录';
  if (!value) return <div className={`test-timestamp ${className}`} title={`${active ? '尚未完成' : `${label}未记录`}；${created}`} aria-label={`${label}：${active ? '尚未完成' : '未记录'}`}>
    <span className="test-timestamp-label"><Clock3 size={12} aria-hidden="true" /><span className="test-timestamp-caption">{label}</span></span>
    <span className="test-timestamp-date">{active ? statusNames[run.status] : label}</span>
    <strong className="test-timestamp-clock">{active ? '尚未完成' : '未记录'}</strong>
  </div>;
  const instant = new Date(value);
  return <time className={`test-timestamp ${className}`} dateTime={value} aria-label={`${label}：${date(value)}`} title={`${label}：${date(value)}；${created}`}>
    <span className="test-timestamp-label"><Clock3 size={12} aria-hidden="true" /><span className="test-timestamp-caption">{label}</span></span>
    <span className="test-timestamp-date">{calendarDate.format(instant)}</span>
    <strong className="test-timestamp-clock">{clockTime.format(instant)}</strong>
  </time>;
}

function Logo() {
  return <span className="logo-mark"><FlaskConical size={22} strokeWidth={1.8} /></span>;
}

export default function App() {
  const [page, setPage] = useState<Page>(pageFromLocation);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [data, setData] = useState<PublicData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [source, setSource] = useState('all');
  const [providerId, setProviderId] = useState('all');
  const [sort, setSort] = useState('grouped');
  const [layout, setLayout] = useState('grid');
  const [pageIndex, setPageIndex] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runTotal, setRunTotal] = useState(0);
  const [runPageCount, setRunPageCount] = useState(1);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState('');
  const lastResultsQuery = useRef('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [historyRefreshVersion, setHistoryRefreshVersion] = useState(0);
  const lastDataSignature = useRef('');
  const dataRefreshInFlight = useRef<Promise<void> | null>(null);
  const forceResultsRefresh = useRef(false);
  const refreshResults = useRef<() => void>(() => {});
  const lastResultsVersion = useRef(refreshVersion);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [selected, setSelected] = useState<Run | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get('run'));
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [compareRuns, setCompareRuns] = useState<Run[]>([]);
  const [toast, setToast] = useState('');
  const compareIds = compareRuns.map(run => run.id);
  const allRunTotal = data.stats.apiRuns + data.stats.sampleRuns;
  const totalPages = Math.max(1, sort === 'grouped' ? runPageCount : Math.ceil(runTotal / pageSize));

  const refresh = async (quiet = false, forceRuns = false) => {
    if (document.hidden) return;
    if (!quiet) { setLoading(true); setHistoryRefreshVersion(version => version + 1); }
    forceResultsRefresh.current ||= !quiet || forceRuns;
    if (dataRefreshInFlight.current) return dataRefreshInFlight.current;
    const pending = (async () => {
      try {
        const result = await api<PublicData>('/api/public/data');
        const signature = JSON.stringify(result);
        const changed = signature !== lastDataSignature.current;
        if (changed) { lastDataSignature.current = signature; setData(result); }
        setError('');
        if (changed || forceResultsRefresh.current) setRefreshVersion(version => version + 1);
      } catch (err) { setError((err as Error).message); }
      finally { forceResultsRefresh.current = false; dataRefreshInFlight.current = null; setLoading(false); }
    })();
    dataRefreshInFlight.current = pending;
    return pending;
  };
  useEffect(() => {
    void refresh(true);
    const onVisibility = () => { if (!document.hidden && pageRef.current !== 'gallery') void refresh(true); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    if (!mobileMenu) return;
    const unlock = lockPageScroll();
    const media = window.matchMedia('(max-width: 640px)');
    const closeOnResize = () => { if (!media.matches) setMobileMenu(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileMenu(false); };
    document.querySelector<HTMLButtonElement>('.main-nav button')?.focus({ preventScroll: true });
    media.addEventListener('change', closeOnResize);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      unlock(); media.removeEventListener('change', closeOnResize); document.removeEventListener('keydown', closeOnEscape);
      document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus({ preventScroll: true });
    };
  }, [mobileMenu]);
  const hasActiveTests = [...data.runs, ...runs].some(run => run.status === 'queued' || run.status === 'running');
  useEffect(() => {
    if (page !== 'gallery') return;
    let stopped = false;
    let timer: number | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = window.setTimeout(() => { void tick(); }, hasActiveTests ? activePollMs : idlePollMs);
    };
    const tick = async (forceRuns = hasActiveTests) => {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      await refresh(true, forceRuns);
      schedule();
    };
    const onVisibility = () => { if (document.hidden) clearTimeout(timer); else void tick(true); };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [page, hasActiveTests]);
  useEffect(() => {
    if (page !== 'gallery') return;
    const controller = new AbortController();
    let cancelled = false;
    let inFlight = false;
    let queued = false;
    let timer: number | undefined;
    const queryKey = JSON.stringify([providerId, category, source, query, sort, pageIndex]);
    if (queryKey !== lastResultsQuery.current) setRunsLoading(true);
    lastResultsQuery.current = queryKey;
    setRunsError('');
    const request = async () => {
      if (cancelled || document.hidden) return;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (inFlight) { queued = true; return; }
      inFlight = true;
      setRunsError('');
      const params = new URLSearchParams({ limit: String(pageSize), sort });
      if (sort === 'grouped') params.set('page', String(pageIndex));
      else params.set('offset', String(pageIndex * pageSize));
      if (providerId !== 'all') params.set('providerId', providerId);
      if (category !== 'all') params.set('category', category);
      if (source !== 'all') params.set('source', source);
      if (query.trim()) params.set('q', query.trim());
      await api<{ runs: Run[]; total: number; page?: number; pageCount?: number }>(`/api/public/runs?${params}`, { signal: controller.signal })
        .then(result => {
          if (controller.signal.aborted) return;
          setRuns(result.runs); setRunTotal(result.total);
          const pages = sort === 'grouped' ? result.pageCount ?? Math.ceil(result.total / pageSize) : Math.ceil(result.total / pageSize);
          setRunPageCount(pages);
          if (sort === 'grouped' && typeof result.page === 'number' && result.page !== pageIndex) setPageIndex(result.page);
          else if (pageIndex >= Math.max(1, pages)) setPageIndex(Math.max(0, pages - 1));
        })
        .catch(err => { if (!controller.signal.aborted) setRunsError((err as Error).message); })
        .finally(() => {
          inFlight = false;
          if (!cancelled) { setRunsLoading(false); if (queued) { queued = false; void request(); } }
        });
    };
    refreshResults.current = () => { void request(); };
    timer = window.setTimeout(() => { timer = undefined; void request(); }, 180);
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); refreshResults.current = () => {}; };
  }, [page, providerId, category, source, query, sort, pageIndex]);
  useEffect(() => {
    if (lastResultsVersion.current === refreshVersion) return;
    lastResultsVersion.current = refreshVersion;
    refreshResults.current();
  }, [refreshVersion]);
  useEffect(() => {
    if (!selectedId || selected?.id === selectedId) return;
    const controller = new AbortController();
    setDetailLoading(true); setDetailError('');
    api<{ run: Run }>(`/api/public/runs/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(({ run }) => { if (!controller.signal.aborted) setSelected(run); })
      .catch(err => { if (!controller.signal.aborted) setDetailError((err as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId, selected?.id]);
  useEffect(() => {
    const handler = () => { setPage(pageFromLocation()); setSelected(null); setSelectedId(new URLSearchParams(location.search).get('run')); setDetailError(''); setSelectedPrompt(null); };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = (next: Page) => {
    history.pushState({}, '', next === 'gallery' ? '/' : `/${next}`);
    setPage(next); setMobileMenu(false); setSelected(null); setSelectedId(null); setDetailError(''); setSelectedPrompt(null); scrollPageToTop();
  };
  const showRun = (run: Run) => { setSelected(run); setSelectedId(run.id); setDetailError(''); setDetailLoading(false); history.replaceState({}, '', `${location.pathname}?run=${encodeURIComponent(run.id)}`); };
  const showHistoryRun = (id: string) => { setSelected(null); setSelectedId(id); setDetailError(''); setDetailLoading(true); history.replaceState({}, '', `${location.pathname}?run=${encodeURIComponent(id)}`); };
  const closeRun = () => { setSelected(null); setSelectedId(null); setDetailError(''); history.replaceState({}, '', location.pathname); };
  const toggleCompare = (run: Run) => {
    setCompareRuns(current => current.some(item => item.id === run.id) ? current.filter(item => item.id !== run.id) : current.length < 3 ? [...current, run] : current);
    if (!compareIds.includes(run.id) && compareIds.length >= 3) setToast('最多同时对比 3 个结果');
  };
  const clearFilters = () => { setQuery(''); setSource('all'); setCategory('all'); setProviderId('all'); setPageIndex(0); };
  const title = { gallery: '结果广场', compare: 'API 对比', prompts: '提示词题库', admin: '后台管理' }[page];

  return <div className={`app-shell page-${page} ${compareIds.length && page === 'gallery' ? 'has-comparisons' : ''}`}>
    {mobileMenu && <button className="sidebar-overlay" aria-label="关闭导航" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`}>
      <a className="brand" href="/" onClick={e => { e.preventDefault(); navigate('gallery'); }}><Logo /><span>Model Lab<small>AI 智商测试</small></span></a>
      <div className="workspace-label">工作区</div>
      <nav className="main-nav" aria-label="主导航">
        <button className={page === 'gallery' ? 'active' : ''} onClick={() => navigate('gallery')}><GalleryHorizontalEnd size={18} />结果广场<span className="nav-count">{allRunTotal}</span></button>
        <button className={page === 'compare' ? 'active' : ''} onClick={() => navigate('compare')}><GitCompareArrows size={18} />API 对比{compareIds.length > 0 && <span className="nav-count">{compareIds.length}</span>}</button>
        <button className={page === 'prompts' ? 'active' : ''} onClick={() => navigate('prompts')}><BookOpen size={18} />提示词题库</button>
        <div className="nav-divider" />
        <span className="nav-caption">管理</span>
        <button className={page === 'admin' ? 'active' : ''} onClick={() => navigate('admin')}><SlidersHorizontal size={18} />后台管理<ChevronRight size={14} className="nav-arrow" /></button>
      </nav>
      <div className="sidebar-bottom"><span className={`status-dot ${error ? 'offline' : ''}`} /><span>{error ? '连接异常' : loading ? '正在连接…' : '已连接'}</span><span className="version">v1.0</span></div>
    </aside>

    <div className="main-shell" inert={mobileMenu}>
      <header className="topbar">
        <div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="打开导航" aria-expanded={mobileMenu} onClick={() => setMobileMenu(true)}><Menu size={20} /></button><span className="topbar-product">Model Lab</span><ChevronRight size={14} /><strong>{title}</strong></div>
        <div className="topbar-actions">{page === 'gallery' && <button className="icon-button mobile-layout-toggle" aria-label={layout === 'grid' ? '切换为列表视图' : '切换为卡片视图'} onClick={() => setLayout(value => value === 'grid' ? 'list' : 'grid')}>{layout === 'grid' ? <LayoutList size={19} /> : <Grid2X2 size={19} />}</button>}<button className="icon-button" title="刷新数据" aria-label="刷新数据" onClick={() => void refresh()}><RefreshCw size={19} className={loading ? 'spinning' : ''} /></button>{page !== 'admin' && <button className="icon-button topbar-create" aria-label="新建测试" onClick={() => navigate('admin')}><Plus size={23} /></button>}</div>
      </header>

      <main className={`main-content ${page === 'admin' ? 'admin-content' : ''}`}>
        {page === 'admin' ? <Suspense fallback={<Loading />}><Admin onResultsChanged={(deletedIds?: string[]) => {
          if (deletedIds?.length) {
            const removed = new Set(deletedIds);
            forgetArtifacts(deletedIds);
            setCompareRuns(runs => runs.filter(run => !removed.has(run.id)));
            if (selectedId && removed.has(selectedId)) closeRun();
          }
          void refresh(true);
        }} /></Suspense> : <>
          <section className="page-heading">
            <div><h1>{title}</h1><p>{page === 'gallery' ? `${data.providers.length} 个接口 · ${data.stats.modelCount} 个模型 · ${data.stats.apiRuns} 次实测` : page === 'compare' ? '同一道题，并排查看不同接口的表现。' : `${data.prompts.length} 道测试题 · 每次执行保留原始提示词`}</p></div>
            <button className="button primary" onClick={() => navigate('admin')}><Plus size={17} />新建测试</button>
          </section>

          {error && <div className="error-banner" role="alert">{error}<button onClick={() => void refresh()}>重新连接</button></div>}

          {page === 'gallery' && <>
            <div className="section-header gallery-section-header"><div><h2>测试记录 <span>{allRunTotal}</span></h2></div><div className="view-toggle"><button className={layout === 'grid' ? 'active' : ''} aria-label="卡片视图" onClick={() => setLayout('grid')}><Grid2X2 size={16} /></button><button className={layout === 'list' ? 'active' : ''} aria-label="列表视图" onClick={() => setLayout('list')}><LayoutList size={17} /></button></div></div>
            <div className="gallery-controls"><div className="filter-row"><div className="category-tabs" role="group" aria-label="结果分类">{(['all', 'visual', 'reasoning', 'text'] as const).map(cat => <button className={category === cat ? 'active' : ''} key={cat} onClick={() => { setCategory(cat); setPageIndex(0); }}>{cat === 'all' ? <Boxes size={14} /> : cat === 'visual' ? <Code2 size={14} /> : cat === 'reasoning' ? <Lightbulb size={14} /> : <Braces size={14} />}{cat === 'all' ? '全部结果' : categories[cat]}</button>)}</div><label className="search-box"><Search size={16} /><input aria-label="搜索 API 接口、模型或测试题" placeholder="搜索接口、模型…" value={query} onChange={e => { setQuery(e.target.value); setPageIndex(0); }} /></label></div>
            <div className="provider-filter"><label htmlFor="provider-filter">API 接口</label><select id="provider-filter" value={providerId} onChange={e => { setProviderId(e.target.value); setPageIndex(0); }}><option value="all">全部 API 接口</option>{data.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></div></div>
            {category === 'reasoning' && source !== 'sample' && <ReasoningHistory providerId={providerId} query={query} refreshVersion={historyRefreshVersion} onOpen={showHistoryRun} />}
            <div className="results-meta"><span aria-live="polite">{runsLoading ? '查询中…' : `${runTotal} 份结果`}</span><div><select aria-label="结果来源" value={source} onChange={e => { setSource(e.target.value); setPageIndex(0); }}><option value="all">全部来源</option><option value="api">API 实测</option><option value="sample">会话样例</option></select><select aria-label="结果排序" value={sort} onChange={e => { setSort(e.target.value); setPageIndex(0); }}><option value="grouped">接口 / 模型成组</option><option value="newest">最新完成</option><option value="oldest">最早完成</option><option value="latency">耗时最短</option></select></div></div>
            {runsLoading ? <Loading /> : runsError ? <div className="error-banner" role="alert">{runsError}<button onClick={() => setRefreshVersion(version => version + 1)}>重新加载</button></div> : runs.length ? <HourlyResults key={`${providerId}:${category}:${source}:${query}:${sort}:${pageIndex}`} runs={runs} layout={layout} sort={sort} renderRun={run => <ResultCard key={run.id} run={run} selected={compareIds.includes(run.id)} onOpen={() => showRun(run)} onCompare={() => toggleCompare(run)} onResultChanged={() => void refresh(true, true)} />} /> : <Empty icon={<Search size={28} />} title="还没有符合条件的结果" description={providerId !== 'all' ? '此 API 接口在当前筛选条件下没有测试记录。' : allRunTotal ? '试试其他接口、关键词、分类或结果来源。' : '前往后台添加接口和模型，开始你的第一次测试。'}><button className="button secondary" onClick={() => { if (!allRunTotal && providerId === 'all') navigate('admin'); else clearFilters(); }}>{!allRunTotal && providerId === 'all' ? '配置第一个接口' : '清除筛选'}</button></Empty>}
            {!runsError && totalPages > 1 && <nav className="result-pagination" aria-label="历史结果分页"><button className="button secondary" disabled={runsLoading || pageIndex === 0} onClick={() => setPageIndex(index => index - 1)}>上一页</button><span>第 {pageIndex + 1} / {totalPages} 页</span><button className="button secondary" disabled={runsLoading || pageIndex + 1 >= totalPages} onClick={() => setPageIndex(index => index + 1)}>下一页 <ChevronRight size={14} /></button></nav>}
            {data.stats.apiRuns === 0 && !loading && <div className="connect-callout"><div className="connect-icon"><Terminal size={22} /></div><div><strong>轮到你的模型登场了</strong><p>添加 API 接口和模型，用同一道题开始你的第一次实测。</p></div><button className="button secondary" onClick={() => navigate('admin')}>配置 API <ArrowUpRight size={15} /></button></div>}
          </>}

          {page === 'prompts' && <div className="prompt-grid">{data.prompts.map((prompt, i) => <article className="prompt-card" key={prompt.id}><div className="prompt-card-top"><span className={`prompt-symbol ${prompt.category}`}>{prompt.category === 'visual' ? <Code2 /> : <Lightbulb />}</span><span className="prompt-number">PROMPT / {String(i + 1).padStart(2, '0')}</span></div><span className="pill">{categories[prompt.category]}</span><h2>{prompt.title}</h2><p>{prompt.description}</p><div className="prompt-excerpt">{prompt.content}</div><div className="prompt-tags">{prompt.tags.map(tag => <span key={tag}>#{tag}</span>)}</div><button className="button secondary" onClick={() => setSelectedPrompt(prompt)}>查看完整提示词 <ArrowRight size={15} /></button></article>)}<button className="add-prompt-card" onClick={() => navigate('admin')}><span><Plus size={26} /></span><strong>下一道好问题，由你定义。</strong><p>添加自定义提示词、参考答案与参考说明</p></button></div>}

          {page === 'compare' && <Compare runs={compareRuns} onRemove={id => setCompareRuns(current => current.filter(run => run.id !== id))} onOpen={showRun} onBrowse={() => navigate('gallery')} />}
          <footer className="page-footer"><span>Model Lab</span><span>原始输出 · 独立观察</span></footer>
        </>}
      </main>
    </div>
    {compareIds.length > 0 && page === 'gallery' && !mobileMenu && <div className="compare-dock"><GitCompareArrows size={18} /><span>已选 <strong>{compareIds.length}</strong> 份结果</span><button className="text-button" onClick={() => setCompareRuns([])}>清空</button><button className="button primary" onClick={() => navigate('compare')}>开始对比 <ArrowRight size={15} /></button></div>}
    {selectedId && !selected && <Modal title="测试结果" onClose={closeRun}>{detailLoading ? <Loading /> : <div className="detail-body"><div className="error-banner" role="alert">{detailError || '正在读取测试记录…'}</div></div>}</Modal>}
    {selected && <RunDetail key={selected.id} run={selected} onClose={closeRun} onToast={setToast} />}
    {selectedPrompt && <PromptDetail prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onTest={() => navigate('admin')} onToast={setToast} />}
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
  </div>;
}

function Loading({ label = '正在打开实验室…' }: { label?: string }) { return <div className="loading"><LoaderCircle className="spinning" size={22} />{label}</div>; }
function Empty({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children?: React.ReactNode }) { return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{description}</p>{children}</div>; }

function RunState({ run, loadError }: { run: Run; loadError?: string }) {
  const active = run.status === 'queued' || run.status === 'running';
  return <div className={`run-state ${run.status}`} role="status">{active ? <LoaderCircle size={26} className="spinning" /> : <Activity size={26} />}<strong>{statusNames[run.status]}</strong><p>{run.error || (run.status === 'queued' ? '等待执行。' : run.status === 'running' ? '正在等待接口返回。' : run.status === 'cancelled' ? '本次测试已取消，没有完成的模型输出。' : '接口未返回可用结果。')}</p>{active && <p>{loadError ? `状态更新失败：${loadError}。请刷新页面重试。` : '此处会自动更新测试状态。'}</p>}</div>;
}

function ResultCard({ run: metadata, selected, onOpen, onCompare, onResultChanged }: { run: Run; selected: boolean; onOpen: () => void; onCompare: () => void; onResultChanged: () => void }) {
  const { ref, visible } = useVisible();
  const { run, loading, error, hydrated } = useArtifact(metadata, visible);
  const superseded = run.source === 'api' && run.status === 'failed' && !!run.nextRetryId && run.nextRetryId !== run.id;
  const notifiedRetry = useRef('');
  const notifiedCompletion = useRef('');
  useEffect(() => {
    // Detail polling can see a retry before the paginated gallery refreshes.
    if (superseded && notifiedRetry.current !== run.nextRetryId) {
      notifiedRetry.current = run.nextRetryId!;
      onResultChanged();
    }
  }, [superseded, run.nextRetryId, onResultChanged]);
  useEffect(() => {
    // A detail response may complete before the gallery poll; refresh its hour and position too.
    const finished = runFinishedAt(run);
    if (finished && (metadata.status !== run.status || metadata.finishedAt !== finished)
      && notifiedCompletion.current !== `${run.id}:${finished}`) {
      notifiedCompletion.current = `${run.id}:${finished}`;
      onResultChanged();
    }
  }, [run.id, run.status, run.finishedAt, metadata.status, metadata.finishedAt, onResultChanged]);
  if (superseded) return null;
  const candyAnswer = /糖果/.test(run.promptContent) && run.output.match(/^\s*(?:\*\*)?(\d+)/)?.[1];
  return <article ref={ref} className={`result-card ${selected ? 'is-selected' : ''}`}>
    <div className={`result-art ${run.category}`}>
      {run.status !== 'completed' ? <RunState run={run} loadError={error} /> : loading || (!hydrated && !error) ? <Loading label="正在加载作品…" /> : error || run.artifactAvailable === false ? <div className="artifact-missing"><Clock3 size={27} /><strong>{error ? '作品暂时无法加载' : run.artifactStorage === 'cloudflare' ? '云端作品暂不可用' : '作品缓存已失效'}</strong><span>{error || '测试记录与请求参数仍然保留'}</span></div> : run.html ? <Preview html={run.html} title={run.promptTitle} compact /> : run.category === 'reasoning' && candyAnswer ? <CandyPreview answer={candyAnswer} seed={run.id} /> : <div className="text-art"><Braces size={32} /><p>{run.output.slice(0, 260) || '此记录没有文本输出。'}</p></div>}
      <span className={`art-category ${run.category}`}><span />{categories[run.category]}</span>
    </div>
    <div className="result-card-body">
      <div className="result-provider-heading"><span className={`provider-caption ${run.source}`}>{run.source === 'sample' ? '会话样例 · 非 API 实测' : 'API 接口'}</span><span className={`status-pill ${run.status}`}><span />{statusNames[run.status]}</span></div>
      <div className="result-title-line"><h3 className="provider-name"><button onClick={onOpen}>{run.source === 'sample' ? '会话子代理样例' : run.providerName || '未命名接口'}</button></h3></div>
      <div className="result-model-time"><div className="result-model-info"><div className="model-line"><span className="model-avatar">{run.source === 'sample' ? <Sparkles size={12} /> : <Cpu size={12} />}</span><strong>{run.modelName}</strong>{run.modelSlug && run.modelSlug !== run.modelName && <span className="model-slug">{run.modelSlug}</span>}</div><div className="model-reasoning" title={`思考强度：${run.parameters.reasoningEffort?.trim() || '未记录'}`}><span>思考强度</span><strong>{run.parameters.reasoningEffort?.trim() || '未记录'}</strong></div></div><TestTimestamp run={run} /></div>
      <div className="result-prompt-row"><h4 className="result-prompt-title">{run.promptTitle}</h4><RetryInfo run={run} compact /></div>
      <div className="card-metrics"><span className="run-duration" title={`耗时 ${time(run.latencyMs)}`}><Clock3 size={13} aria-hidden="true" /><span className="metric-label">耗时</span><strong>{time(run.latencyMs)}</strong></span><span className="token-metric" title={`输出 Token：${run.outputTokens ?? '未记录'}`}><Braces size={13} aria-hidden="true" /><span>{run.outputTokens === null ? '—' : run.outputTokens.toLocaleString()}<span className="metric-unit"> tokens</span></span></span></div>
    </div>
    <div className="result-card-footer"><button className={`compare-checkbox ${selected ? 'checked' : ''}`} aria-pressed={selected} onClick={onCompare}><span>{selected && <Check size={11} />}</span>加入对比</button><button className="open-result" onClick={onOpen}>查看结果 <ArrowUpRight size={15} /></button></div>
  </article>;
}

function Compare({ runs, onRemove, onOpen, onBrowse }: { runs: Run[]; onRemove: (id: string) => void; onOpen: (run: Run) => void; onBrowse: () => void }) {
  const samePrompt = runs.every(run => run.promptContent === runs[0]?.promptContent);
  return <section className="compare-section"><div className="section-header"><div><h2>并排观察 <span>{runs.length} / 3</span></h2><p>对照接口名称与原始输出，观察同一道题的真实表现。</p></div><button className="button secondary" onClick={onBrowse}><Plus size={15} />选择结果</button></div>{runs.length > 0 && !samePrompt && <div className="notice"><Lightbulb size={16} />当前结果的提示词不同，请结合各自的题目观察输出。</div>}{runs.length ? <div className="comparison-grid" style={{ gridTemplateColumns: `repeat(${runs.length}, minmax(0, 1fr))` }}>{runs.map(run => <CompareItem key={run.id} metadata={run} onRemove={() => onRemove(run.id)} onOpen={() => onOpen(run)} />)}</div> : <Empty icon={<GitCompareArrows size={30} />} title="选几份结果，一起看看" description="在结果广场点击「加入对比」，可以跨页选择，最多并排查看 3 份结果。"><button className="button primary" onClick={onBrowse}>去选择结果 <ArrowRight size={15} /></button></Empty>}</section>;
}

function CompareItem({ metadata, onRemove, onOpen }: { metadata: Run; onRemove: () => void; onOpen: () => void }) {
  const { run, loading, error, hydrated } = useArtifact(metadata);
  return <article className="comparison-card"><div className="comparison-heading"><div><span className={`provider-caption ${run.source}`}>{run.source === 'sample' ? '会话样例 · 非 API 实测' : 'API 接口'}</span><h3 className="provider-name">{run.source === 'sample' ? '会话子代理样例' : run.providerName || '未命名接口'}</h3><span className="comparison-model">{run.modelName}</span></div><button className="icon-button" aria-label={`移除 ${run.providerName} ${run.modelName}`} onClick={onRemove}><X size={16} /></button></div><RetryInfo run={run} compact /><p className="comparison-prompt">{run.promptTitle}</p>{run.status !== 'completed' ? <RunState run={run} loadError={error} /> : loading || (!hydrated && !error) ? <Loading label="正在加载作品…" /> : error || run.artifactAvailable === false ? <pre className="comparison-output">{error || (run.artifactStorage === 'cloudflare' ? '云端作品暂不可用，测试记录仍保留。' : '作品缓存已失效，测试记录仍保留。')}</pre> : run.html ? <Preview html={run.html} title={run.promptTitle} compact /> : <pre className="comparison-output">{run.output || '此记录没有文本输出。'}</pre>}<dl className="comparison-metrics"><div><dt>耗时</dt><dd>{time(run.latencyMs)}</dd></div><div><dt>输出 Token</dt><dd>{run.outputTokens ?? '—'}</dd></div><div><dt>运行状态</dt><dd>{statusNames[run.status]}</dd></div><div className="comparison-test-time"><dt>完成 / 结束时间</dt><dd><TestTimestamp run={run} /></dd></div></dl><button className="button secondary full-width" onClick={onOpen}>完整结果 <ExternalLink size={14} /></button></article>;
}

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; const unlock = lockPageScroll(); element?.showModal(); return () => { element?.close(); unlock(); }; }, []);
  return <dialog className={`modal ${wide ? 'wide' : ''}`} ref={dialog} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal-inner"><div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={20} /></button></div>{children}</div></dialog>;
}
async function copyText(text: string, onToast: (message: string) => void) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement('textarea'); input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
      (document.querySelector('dialog[open]') || document.body).append(input); input.select();
      const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error('copy');
    }
    onToast('已复制到剪贴板');
  } catch { onToast('复制失败，请在原始输出中手动复制'); }
}
function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function RunDetail({ run: metadata, onClose, onToast }: { run: Run; onClose: () => void; onToast: (text: string) => void }) {
  const { run, loading, error, hydrated } = useArtifact(metadata);
  const [tab, setTab] = useState(metadata.status === 'completed' && (metadata.html || metadata.hasHtml) ? 'preview' : 'output');
  const requestParameters = { model: run.modelSlug, protocol: run.parameters.protocol, maxTokens: run.parameters.maxTokens, reasoningEffort: run.parameters.reasoningEffort, requestTimeoutSeconds: run.requestTimeoutSeconds };
  return <Modal title="测试结果" onClose={onClose} wide>
    <div className="detail-identity"><span className={`provider-caption ${run.source}`}>{run.source === 'sample' ? '会话子代理样例 · 非 API 实测' : 'API 接口'}</span><h3 className="provider-name">{run.source === 'sample' ? '会话子代理样例' : run.providerName || '未命名接口'}</h3><p>{run.promptTitle}</p></div>
    <div className="detail-meta"><span className="model-avatar"><Cpu size={14} /></span><strong>{run.modelName}</strong><span className={`status-pill ${run.status}`}><span />{statusNames[run.status]}</span><TestTimestamp run={run} className="detail-test-time" /></div>
    <RetryInfo run={run} />
    <div className="detail-tabs">{[...(run.html || run.hasHtml ? [['preview', '作品预览']] : []), ['output', '原始输出'], ['prompt', '提示词'], ['reference', '参考与参数']].map(([value, label]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}<div className="detail-tools"><button className="icon-button" title="复制原始输出" aria-label="复制原始输出" disabled={loading || !run.output} onClick={() => void copyText(run.output, onToast)}><Copy size={15} /></button><button className="icon-button" title="下载结果" aria-label="下载结果" disabled={loading || (!run.html && !run.output)} onClick={() => download(run.html || run.output, `model-lab-${run.id}.${run.html ? 'html' : 'txt'}`, run.html ? 'text/html' : 'text/plain')}><ArrowDownToLine size={16} /></button></div></div>
    <div className="detail-body">
      {(tab === 'preview' || tab === 'output') && (run.status !== 'completed' ? <RunState run={run} loadError={error} /> : loading || (!hydrated && !error) ? <Loading label="正在加载作品…" /> : (run.artifactAvailable === false || error) && <div className="notice"><Clock3 size={17} />{error || (run.artifactStorage === 'cloudflare' ? '云端作品正文暂不可用，测试记录与请求参数仍然保留。管理员可在存储设置中验证云端读写状态。' : '完整作品已从内存缓存中移除。测试记录和请求参数仍然保留；配置对象存储可长期保留后续作品。')}</div>)}
      {tab === 'preview' && run.html && <Preview html={run.html} title={run.promptTitle} />}
      {tab === 'output' && <>{run.output ? <pre className="raw-output">{run.output}</pre> : run.status === 'completed' && hydrated && !loading && !error && run.artifactAvailable !== false && <pre className="raw-output">此记录没有文本输出。</pre>}{run.reasoning && <details><summary>接口返回的推理文本</summary><pre className="raw-output">{run.reasoning}</pre></details>}</>}
      {tab === 'prompt' && <><span className="field-caption">本次测试使用的提示词快照</span><pre className="prompt-full">{run.promptContent}</pre></>}
      {tab === 'reference' && <div className="reference-panel"><div className="reference-stats"><div><span>运行状态</span><strong>{statusNames[run.status]}</strong></div><div><span>请求总耗时</span><strong>{time(run.latencyMs)}</strong></div><div><span>输入 / 输出 Token</span><strong>{run.inputTokens ?? '—'} / {run.outputTokens ?? '—'}</strong></div></div><h3>参考答案</h3><p className="preserve-text">{run.referenceAnswer || '开放题，请直接观察原始作品与输出。'}</p><h3>参考说明</h3><p className="preserve-text">{run.rubric || '尚未设置参考说明。'}</p><h3>本次请求参数</h3><pre className="parameter-json">{run.source === 'sample' ? '会话子代理生成，没有本站 API 请求参数。' : JSON.stringify(requestParameters, null, 2)}</pre><div className="notice"><ShieldCheck size={16} />所有测试按原样展示。请求完成仅表示收到了接口输出，请结合题目和原始结果判断实际表现。</div></div>}
    </div><div className="modal-footer"><span><ShieldCheck size={14} />保留原始输出 · 预览与站点隔离</span><button className="button secondary" onClick={onClose}>完成</button></div>
  </Modal>;
}
function PromptDetail({ prompt, onClose, onTest, onToast }: { prompt: Prompt; onClose: () => void; onTest: () => void; onToast: (text: string) => void }) {
  return <Modal title={prompt.title} onClose={onClose}><div className="prompt-detail"><span className="pill mint">{categories[prompt.category]}</span><p>{prompt.description}</p><div className="field-title"><span>原始提示词</span><button className="text-button" onClick={() => void copyText(prompt.content, onToast)}><Copy size={13} />复制</button></div><pre className="prompt-full">{prompt.content}</pre>{prompt.referenceAnswer && <details><summary>参考答案与取法说明</summary><p className="preserve-text">{prompt.referenceAnswer}</p></details>}{prompt.rubric && <details><summary>参考说明</summary><p className="preserve-text">{prompt.rubric}</p></details>}</div><div className="modal-footer"><span>每次测试保留独立的提示词快照</span><button className="button primary" onClick={onTest}><Play size={14} />使用这道题</button></div></Modal>;
}
