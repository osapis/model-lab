import type { ReasoningHistoryEntry, ReasoningHistoryResponse, ReasoningHistoryRow } from '../shared/reasoning-history.ts';
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
export function isCandyRun(run: Pick<StoredRun, 'source' | 'category' | 'promptContent'>): boolean {
  return run.source === 'api' && run.category === 'reasoning' && questionCore(run.promptContent) === CANDY_QUESTION;
}
const shortText = (text: string) => [...text.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 80).join('');
function plainAnswerText(text: string): string {
  const finalOutput = text.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '');
  if (/<think\b/i.test(finalOutput)) return '';
  return finalOutput.normalize('NFKC').replace(/```[^\n]*\n?/g, '').replace(/\*\*|__/g, '').replace(/`|\$/g, '')
    .replace(/^\s*[#>]+\s*/gm, '').trim();
}
function numberAtStart(text: string): string | null {
  const match = text.trim().match(/^([+-]?\d+(?:\.\d+)?)([\s\S]*)$/);
  if (!match) return null;
  let tail = match[2]!.trimStart().replace(/^(?:颗|个|枚|粒)(?:糖果|糖)?/, '').trimStart();
  // A range, alternative, expression or numbered list is not a unique final answer.
  if (/^[,，、]?\s*(?:或|或者|和|及|到|至|\/|~|-)/.test(tail)) return null;
  if (tail && !/^[。.!！,，;；:：]/.test(tail)) return null;
  if (/^\.\s+\S/.test(tail)) return null;
  return match[1]!;
}

/** Only a leading answer or an explicit, unconditional conclusion can establish the result. */
export function extractCandyAnswer(output: string): Answer {
  const text = plainAnswerText(output);
  if (!text) return unavailable();
  const firstLine = text.split(/\r?\n/).find(line => line.trim())!.trim();
  let answer = numberAtStart(firstLine);
  let withdrawn = '';
  const conclusions = /(?:最终答案|最后答案|最终结论|结论|答案)(?:\s*(?:是|为|应为|等于))?\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)|(?:因此|所以|故)(?:[，,\s]*)(?:最少|至少)(?:需要|需|要)?(?:取出|取|抽取|抽出)?\s*([+-]?\d+(?:\.\d+)?)|(?:应为|应改为|应当是|改为|改成)\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)|(?:最终答案|最后答案|最终结论|结论)(?:是|为|:|：|\s)*(无法确定|不能确定|不确定|没有唯一答案|无唯一答案|无解)|(?:最终答案|最后答案|最终结论|结论)\s*[:：]?\s*(不是|并非|不应为|不应是)\s*([+-]?\d+(?:\.\d+)?)/g;
  for (const match of text.matchAll(conclusions)) {
    const position = match.index!;
    const sentenceStart = Math.max(text.lastIndexOf('\n', position), text.lastIndexOf('。', position), text.lastIndexOf('；', position));
    const context = text.slice(Math.max(0, sentenceStart + 1), position);
    const paragraphStart = text.lastIndexOf('\n\n', position);
    const paragraph = text.slice(paragraphStart < 0 ? 0 : paragraphStart + 2, position);
    const correction = /(?:更正|修正|纠正|改口|重新(?:检查|计算|推理|分析)|应当改)/.test(context);
    const reported = /(?:有人|别人|他人|错误|误答|引用|举例|示例|例如|声称|认为|不正确)/;
    const conditional = /(?:若|如果|假设|假如|倘若|否则|可能|取决于|另一种|(?:按|允许|可以).{0,40}(?:时|则)|在.{0,40}(?:情况下|条件下|解释下))/;
    if (reported.test(context) || conditional.test(context)) continue;
    if (answer !== null && !correction && (reported.test(paragraph) || conditional.test(paragraph))) continue;
    const before = text.slice(Math.max(0, sentenceStart + 1), position);
    if (before.lastIndexOf('“') > before.lastIndexOf('”')
      || before.lastIndexOf('「') > before.lastIndexOf('」') || (before.match(/"/g)?.length || 0) % 2) continue;
    if (match[4]) { withdrawn = match[4]; answer = null; continue; }
    if (match[5]) { withdrawn = shortText(text.slice(position).split(/\r?\n/, 1)[0]!); answer = null; continue; }
    const raw = match[1] || match[2] || match[3] || '';
    const start = position + match[0].lastIndexOf(raw);
    const candidate = numberAtStart(text.slice(start).split(/\r?\n/, 1)[0]!);
    const explicit = /^(?:最终|最后)/.test(match[0]);
    if (candidate === null) {
      if (explicit) { withdrawn = shortText(text.slice(position).split(/\r?\n/, 1)[0]!); answer = null; }
      continue;
    }
    if (answer !== null && !explicit && !correction && !(match[3] && /(?:最终|最后|结论)/.test(context))) continue;
    if (match[3] && !correction && !/(?:最终|结论)/.test(context)) continue;
    answer = candidate; withdrawn = '';
  }
  if (withdrawn) return { verdict: 'incorrect', answer: withdrawn, error: '' };
  if (answer === null) return { verdict: 'incorrect', answer: shortText(firstLine), error: '' };
  return { verdict: answer === '21' ? 'correct' : 'incorrect', answer: shortText(answer), error: '' };
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
          if (payload) result = extractCandyAnswer(this.redact(payload.output, run));
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
