import type { ReasoningHistoryEntry, ReasoningHistoryResponse, ReasoningHistoryRow } from '../shared/reasoning-history.ts';
import { extractNumericAnswer } from '../shared/answer.ts';
import { runFinishedAt, runResultAt, runResultTime } from '../shared/run-time.ts';
import type { ArtifactRepository, ArtifactRef, ArtifactPayload } from './artifacts.ts';
import { reasoningPrompt } from './seed.ts';
import type { Store, StoredProvider, StoredRun } from './store.ts';
import { createHash } from 'node:crypto';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 2048;
const CONCURRENCY = 4;
type Answer = Pick<ReasoningHistoryEntry, 'answer' | 'verdict' | 'error'>;
const unavailable = (): Answer => ({ verdict: 'unavailable', answer: '', error: '测试正文暂不可用。' });
const normalizeQuestion = (text: string) => text.normalize('NFKC').replace(/[\p{Z}\s]/gu, '').replace(/[。,:;!?？"'“”‘’()[\]{}【】、]/g, '');
const prefix = normalizeQuestion('不要使用任何工具或写代码，直接推理回答以下问题');
const suffix = normalizeQuestion('请只给出你的最终答案数字，并简述推理过程');
function questionCore(text: string): string {
  let normalized = normalizeQuestion(text);
  if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
  if (normalized.endsWith(suffix)) normalized = normalized.slice(0, -suffix.length);
  return normalized;
}
const CANDY_QUESTION = questionCore(reasoningPrompt);

/** Identify the actual prompt snapshot, including every count and condition, never its editable ID/title. */
export function isCandyRun(run: Pick<StoredRun, 'source' | 'category' | 'promptContent' | 'standardAnswer'>): boolean {
  return run.source === 'api' && run.category === 'reasoning'
    && (Boolean(run.standardAnswer?.trim()) || questionCore(run.promptContent) === CANDY_QUESTION);
}

const expectedAnswerOf = (run: Pick<StoredRun, 'standardAnswer' | 'promptContent'>): string | undefined =>
  typeof run.standardAnswer === 'string' && run.standardAnswer.trim()
    ? run.standardAnswer.trim()
    : questionCore(run.promptContent) === CANDY_QUESTION ? '21' : undefined;

export function extractAnswer(output: string, expectedAnswer?: string): Answer {
  const { verdict, answer, error } = extractNumericAnswer(output, expectedAnswer);
  if (verdict === 'ungraded') return { verdict: 'unavailable', answer, error: '未设置标准答案数字。' };
  return { verdict, answer, error: error || '' };
}

interface HistoryQuery { providerId?: string; q?: string }
const providerIdOf = (run: StoredRun) => run.providerId || run.execution?.providerId || '';
const matchesSearch = (run: StoredRun, q: string) => !q || [run.promptTitle, run.providerName, run.modelName, run.modelSlug].join(' ').toLocaleLowerCase().includes(q);
const cacheKey = (run: StoredRun) => JSON.stringify([run.id, run.createdAt, run.finishedAt, run.artifactAvailable, run.artifact]);

/** Read-only history projection. It retains only short verdicts in bounded process memory. */
export class ReasoningHistoryService {
  private cache = new Map<string, { expiresAt: number; value: Answer }>();
  private inFlight = new Map<string, Promise<Answer>>();
  private payloads = new Map<string, Promise<ArtifactPayload | null>>();
  private requests = new Set<Promise<ReasoningHistoryResponse>>();
  private activeReads = 0;
  private waiters: ((allowed: boolean) => void)[] = [];
  private closed = false;
  constructor(private store: Store, private artifacts: ArtifactRepository, private clock: () => number = Date.now) {}

  private acquire(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.activeReads < CONCURRENCY) { this.activeReads++; return Promise.resolve(true); }
    return new Promise(resolve => this.waiters.push(resolve));
  }
  private release() {
    const next = this.waiters.shift();
    if (next) next(!this.closed);
    else this.activeReads--;
  }
  private redact(output: string, run: StoredRun): string {
    const encrypted = new Set([run.execution?.encryptedApiKey,
      this.store.get<StoredProvider>('providers', providerIdOf(run))?.encryptedApiKey]);
    let safe = output;
    for (const value of encrypted) {
      if (!value) continue;
      try { const key = this.store.decrypt(value); if (key) safe = safe.split(key).join('[密钥已隐藏]'); }
      catch { /* Public output never reports decryption errors or credential values. */ }
    }
    return safe.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[密钥已隐藏]');
  }
  private summaryKey(run: StoredRun): string {
    return createHash('sha256').update(JSON.stringify([run.artifactAvailable, run.artifact,
      run.execution?.encryptedApiKey || '', this.store.get<StoredProvider>('providers', providerIdOf(run))?.encryptedApiKey || ''])).digest('hex');
  }
  private prune(runs: StoredRun[]) {
    const valid = new Set(runs.filter(run => run.status === 'completed' && run.artifact && this.artifacts.availability(run.artifact) !== false).map(run => this.summaryKey(run)));
    const now = this.clock();
    for (const [key, cached] of this.cache) if (!valid.has(key) || cached.expiresAt <= now) this.cache.delete(key);
  }
  private async payload(ref: ArtifactRef): Promise<ArtifactPayload | null> {
    const key = JSON.stringify([ref.storage, ref.configId, ref.key]);
    const existing = this.payloads.get(key);
    if (existing) return existing;
    const request = (async () => {
      if (!await this.acquire()) return null;
      try { return this.closed ? null : await this.artifacts.get(ref); }
      catch { return null; }
      finally { this.release(); }
    })();
    this.payloads.set(key, request);
    try { return await request; }
    finally { this.payloads.delete(key); }
  }
  private async answer(run: StoredRun): Promise<Answer> {
    if (!run.artifact || this.artifacts.availability(run.artifact) === false) return unavailable();
    const key = this.summaryKey(run);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.clock()) {
      this.cache.delete(key); this.cache.set(key, cached);
      return cached.value;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = (async () => {
      let result = unavailable();
      try {
        if (!this.closed) {
          const payload = await this.payload(run.artifact!);
          if (payload) result = extractAnswer(this.redact(payload.output, run), expectedAnswerOf(run));
        }
      } catch { /* Missing/failed artifact reads are not model mistakes. */ }
      if (!this.closed) {
        const current = this.store.get<StoredRun>('runs', run.id);
        const time = this.clock();
        if (current?.status === 'completed' && cacheKey(current) === cacheKey(run) && isCandyRun(current)
          && runResultAt(current) !== null && runResultTime(current) >= time - WINDOW_MS && runResultTime(current) <= time
          && current.artifact && this.artifacts.availability(current.artifact) !== false) {
          this.cache.delete(key);
          while (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, { value: result, expiresAt: time + (result.verdict === 'unavailable' ? 1000 : 60_000) });
        }
      }
      return result;
    })();
    this.inFlight.set(key, request);
    try { return await request; }
    finally { this.inFlight.delete(key); }
  }
  private async entry(run: StoredRun): Promise<ReasoningHistoryEntry> {
    const base = { id: run.id, createdAt: run.createdAt, finishedAt: runFinishedAt(run), modelName: run.modelName,
      reasoningEffort: typeof run.parameters?.reasoningEffort === 'string' ? run.parameters.reasoningEffort
        : typeof run.execution?.reasoningEffort === 'string' ? run.execution.reasoningEffort : '', status: run.status };
    if (run.status === 'queued' || run.status === 'running') return { ...base, verdict: 'pending', answer: '', error: '' };
    if (run.status === 'failed' || run.status === 'cancelled') return { ...base, verdict: 'failed', answer: '',
      error: run.status === 'cancelled' ? '该次测试已取消。' : '该次测试失败，请查看测试记录。' };
    return { ...base, ...await this.answer(run) };
  }
  read(query: HistoryQuery = {}): Promise<ReasoningHistoryResponse> {
    const request = this.readCurrent(query);
    this.requests.add(request);
    void request.finally(() => this.requests.delete(request)).catch(() => undefined);
    return request;
  }
  private async readCurrent(query: HistoryQuery): Promise<ReasoningHistoryResponse> {
    const to = this.clock(), from = to - WINDOW_MS;
    const response: ReasoningHistoryResponse = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), expectedAnswer: '21', rows: [] };
    if (this.closed) return response;
    const q = query.q?.trim().toLocaleLowerCase() || '';
    const inWindow = (run: StoredRun) => {
      const resultAt = runResultAt(run), resultTime = runResultTime(run), providerId = providerIdOf(run);
      return Boolean(providerId) && resultAt !== null && resultTime >= from && resultTime <= to && isCandyRun(run);
    };
    const inScope = (run: StoredRun) => inWindow(run) && (!query.providerId || providerIdOf(run) === query.providerId) && matchesSearch(run, q);
    const allRuns = this.store.all<StoredRun>('runs').filter(inWindow);
    this.prune(allRuns);
    const runs = allRuns.filter(inScope)
      .sort((a, b) => runResultTime(a) - runResultTime(b) || a.id.localeCompare(b.id));
    const projected = new Map<string, { snapshot: StoredRun; entry: ReasoningHistoryEntry }>();
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, runs.length) }, async () => {
      while (!this.closed && cursor < runs.length) {
        const run = runs[cursor++]!;
        const entry = await this.entry(run);
        const current = this.store.get<StoredRun>('runs', run.id);
        if (!current || !inScope(current)) continue;
        // A deletion or artifact replacement while awaiting I/O cannot revive stale results.
        if (current.status !== run.status || cacheKey(current) !== cacheKey(run)) {
          projected.set(run.id, { snapshot: current, entry: await this.entry(current) });
        } else if (current.artifact && this.artifacts.availability(current.artifact) === false && current.status === 'completed') {
          projected.set(run.id, { snapshot: run, entry: { ...entry, ...unavailable() } });
        } else projected.set(run.id, { snapshot: run, entry });
      }
    }));
    if (this.closed) return response;
    const rows = new Map<string, ReasoningHistoryRow>();
    for (const provider of this.store.all<StoredProvider>('providers')) {
      if ((!query.providerId || provider.id === query.providerId) && (!q || provider.name.toLocaleLowerCase().includes(q))) {
        rows.set(provider.id, { providerId: provider.id, providerName: provider.name, entries: [] });
      }
    }
    const providerNames = new Map(this.store.all<StoredProvider>('providers').map(provider => [provider.id, provider.name]));
    for (const snapshot of runs) {
      const current = this.store.get<StoredRun>('runs', snapshot.id), projection = projected.get(snapshot.id);
      if (!current || !projection || !inScope(current)) continue;
      const { entry, snapshot: projectedSnapshot } = projection;
      const providerId = providerIdOf(current);
      let row = rows.get(providerId);
      if (!row) { row = { providerId, providerName: providerNames.get(providerId) || current.providerName || '历史 API 接口', entries: [] }; rows.set(providerId, row); }
      if (!providerNames.has(providerId)) row.providerName = current.providerName || row.providerName;
      // Final existence/status checks are synchronous; no writes or body downloads follow them.
      let result = entry;
      if (current.status === 'queued' || current.status === 'running') result = { ...entry, verdict: 'pending', answer: '', error: '' };
      else if (current.status === 'failed' || current.status === 'cancelled') result = { ...entry, verdict: 'failed', answer: '',
        error: current.status === 'cancelled' ? '该次测试已取消。' : '该次测试失败，请查看测试记录。' };
      else if (entry.status !== current.status || cacheKey(current) !== cacheKey(projectedSnapshot)
        || !current.artifact || this.artifacts.availability(current.artifact) === false) result = { ...entry, ...unavailable() };
      row.entries.push({ ...result, createdAt: current.createdAt, finishedAt: runFinishedAt(current), modelName: current.modelName, status: current.status });
    }
    for (const row of rows.values()) row.entries.sort((a, b) => runResultTime(a) - runResultTime(b) || a.id.localeCompare(b.id));
    response.rows = [...rows.values()].sort((a, b) => a.providerName.localeCompare(b.providerName) || a.providerId.localeCompare(b.providerId));
    return response;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const resolve of this.waiters.splice(0)) resolve(false);
    await Promise.allSettled([...this.requests]);
    this.cache.clear(); this.inFlight.clear(); this.payloads.clear();
  }
}
