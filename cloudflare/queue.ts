import { randomUUID } from 'node:crypto';
import type { Model, Prompt } from '../shared/types.ts';
import { normalizeReasoningEffort } from '../shared/reasoning.ts';
import { MAX_AUTO_RETRIES, normalizeMaxRetries } from '../shared/retries.ts';
import { MAX_REQUEST_TIMEOUT_SECONDS, normalizeRequestTimeoutSeconds } from '../shared/timeouts.ts';
import type { Store, StoredProvider, StoredRun } from '../server/store.ts';
import type { ArtifactRef, ArtifactRepository } from '../server/artifacts.ts';
import { callUpstream, UpstreamError } from '../server/upstream.ts';
import { QueueError } from '../server/queue.ts';
import { CloudflareArtifactWriteError } from './artifacts.ts';

type QueueStore = Pick<Store, 'all' | 'get' | 'put' | 'transaction' | 'settings' | 'decrypt'>;
export interface CloudRunQueueOptions {
  wake: () => void; timeoutMs?: number; concurrency?: number; now?: () => number; retryBaseDelayMs?: number;
}
export interface QueueLease { owner: string; token: string; expiresAt: number }
export interface CloudStoredRun extends StoredRun { queueLease?: QueueLease }
export class CloudQueueError extends QueueError {
  constructor(status: number, message: string) { super(status, message); this.name = 'CloudQueueError'; }
}
const activeStatus = (run: StoredRun) => run.status === 'queued' || run.status === 'running';
const sameRef = (a: ArtifactRef, b: ArtifactRef) => a.storage === b.storage && a.configId === b.configId && a.key === b.key;

/** Persistent attempts execute only from an awaited DO alarm, never from HTTP enqueue. */
export class CloudRunQueue {
  private readonly owner = randomUUID();
  private readonly timeoutMs: number | undefined;
  private readonly concurrency: number;
  private readonly clock: () => number;
  private readonly retryBaseDelayMs: number;
  private readonly active = new Map<string, { token: string; controller: AbortController }>();
  private wave?: Promise<void>;
  private closed = false;

  constructor(private readonly store: QueueStore, private readonly artifacts: ArtifactRepository, private readonly options: CloudRunQueueOptions) {
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
      ? Math.min(options.timeoutMs!, MAX_REQUEST_TIMEOUT_SECONDS * 1000) : undefined;
    this.concurrency = Math.max(1, Math.min(2, Math.floor(options.concurrency || 2)));
    this.clock = options.now || Date.now;
    this.retryBaseDelayMs = Number.isFinite(options.retryBaseDelayMs) && options.retryBaseDelayMs! > 0
      ? Math.min(options.retryBaseDelayMs!, 60_000) : 5000;
    this.recoverInterrupted();
  }
  private timestamp() { return new Date(this.clock()).toISOString(); }
  private configuredTimeoutSeconds(): number {
    return this.timeoutMs !== undefined ? this.timeoutMs / 1000 : normalizeRequestTimeoutSeconds(this.store.settings().requestTimeoutSeconds);
  }
  private timeoutSeconds(run: StoredRun): number {
    return typeof run.requestTimeoutSeconds === 'number' && Number.isFinite(run.requestTimeoutSeconds) && run.requestTimeoutSeconds > 0
      ? Math.min(run.requestTimeoutSeconds, MAX_REQUEST_TIMEOUT_SECONDS) : this.configuredTimeoutSeconds();
  }
  private notify() { if (!this.closed) this.options.wake(); }
  size(): number { return this.store.all<CloudStoredRun>('runs').filter(activeStatus).length; }

  /** An unconfirmed, already-sent request is deliberately never replayed after reconstruction. */
  recoverInterrupted(): number {
    if (this.closed) return 0;
    return this.store.transaction(() => {
      let recovered = 0;
      for (const run of this.store.all<CloudStoredRun>('runs')) {
        if (run.status !== 'running') continue;
        const local = this.active.get(run.id);
        if (run.queueLease?.owner === this.owner && local?.token === run.queueLease.token) continue;
        this.store.put('runs', { ...run, queueLease: undefined, status: 'failed', finishedAt: this.timestamp(),
          error: '执行环境在响应确认前重建；请求可能已发出，为避免重复调用，未自动重放，请手动重试。' });
        recovered++;
      }
      return recovered;
    });
  }

  create(prompt: Prompt, model: Model, provider: StoredProvider, batchId: string): StoredRun {
    const id = randomUUID(), reasoningEffort = normalizeReasoningEffort(model.reasoningEffort);
    return {
      id, batchId, promptId: prompt.id, modelId: model.id, providerId: provider.id,
      providerName: provider.name, modelName: model.name, modelSlug: model.modelId,
      promptTitle: prompt.title, promptContent: prompt.content, category: prompt.category,
      referenceAnswer: prompt.referenceAnswer, rubric: prompt.rubric,
      status: 'queued', source: 'api', sourceLabel: '配置 API 实际调用', output: '', html: '', reasoning: '', error: '',
      standardAnswer: prompt.standardAnswer?.trim() || undefined,
      latencyMs: null, inputTokens: null, outputTokens: null, createdAt: this.timestamp(), finishedAt: null,
      hasHtml: false, artifactAvailable: false, retryLimit: normalizeMaxRetries(this.store.settings().maxRetries), retryAttempt: 0, retryRootId: id,
      requestTimeoutSeconds: this.configuredTimeoutSeconds(),
      parameters: { protocol: provider.protocol, maxTokens: model.maxTokens, reasoningEffort },
      execution: { providerId: provider.id, baseUrl: provider.baseUrl, encryptedApiKey: provider.encryptedApiKey,
        protocol: provider.protocol, modelId: model.modelId, simulateCodexClient: provider.simulateCodexClient ?? false,
        maxTokens: model.maxTokens, reasoningEffort },
    };
  }
  enqueue(runs: StoredRun[]): void {
    if (this.closed) throw new CloudQueueError(503, '任务队列正在停止。');
    this.store.transaction(() => {
      if (this.size() + runs.length > 200) throw new CloudQueueError(429, '队列已满（最多 200 个待完成任务），请稍后重试。');
      const ids = new Set<string>();
      for (const run of runs) {
        if (run.status !== 'queued' || ids.has(run.id) || this.store.get('runs', run.id)) throw new CloudQueueError(409, '测试记录已存在或不能加入队列。');
        ids.add(run.id);
      }
      for (const run of runs) this.store.put('runs', { ...run, queueLease: undefined } as CloudStoredRun);
    });
    this.notify();
  }
  cancel(run: StoredRun): StoredRun {
    const cancelled = this.store.transaction(() => {
      const current = this.store.get<CloudStoredRun>('runs', run.id);
      if (!current || !activeStatus(current)) return current || run;
      const updated: CloudStoredRun = { ...current, queueLease: undefined, status: 'cancelled',
        error: '管理员已取消该任务。', finishedAt: this.timestamp() };
      this.store.put('runs', updated); return updated;
    });
    this.active.get(run.id)?.controller.abort();
    this.notify(); return cancelled;
  }
  retry(run: StoredRun): StoredRun {
    if (run.source !== 'api' || !run.execution) throw new CloudQueueError(400, '样例不能重试，请选择配置模型创建新测试。');
    const id = randomUUID(), reasoningEffort = normalizeReasoningEffort(run.execution.reasoningEffort ?? run.parameters.reasoningEffort);
    return { ...this.reset(run, id), batchId: randomUUID(), parameters: { ...run.parameters, reasoningEffort },
      execution: { ...run.execution, reasoningEffort }, retryLimit: normalizeMaxRetries(this.store.settings().maxRetries),
      retryAttempt: 0, retryRootId: id, retryOf: run.id, retryKind: 'manual', requestTimeoutSeconds: this.configuredTimeoutSeconds() };
  }
  private reset(run: StoredRun, id: string): CloudStoredRun {
    return { ...run, id, queueLease: undefined, status: 'queued', output: '', html: '', reasoning: '', error: '',
      latencyMs: null, inputTokens: null, outputTokens: null, createdAt: this.timestamp(), finishedAt: null,
      artifact: undefined, artifactStorage: undefined, artifactAvailable: false, artifactExpiresAt: null,
      hasHtml: false, pendingArtifactDeletes: [], cleanupError: undefined, nextRetryId: undefined, retryAt: undefined };
  }
  private enabled(run: StoredRun): boolean {
    const provider = this.store.get<StoredProvider>('providers', run.execution?.providerId || run.providerId || '');
    const model = this.store.get<Model>('models', run.modelId);
    return run.source === 'api' && Boolean(run.execution && provider?.enabled && model?.enabled);
  }
  private dueAt(run: StoredRun): number {
    if (run.retryKind === 'automatic' && run.retryAt) {
      const retryAt = Date.parse(run.retryAt);
      if (Number.isFinite(retryAt)) return retryAt;
    }
    return this.clock();
  }

  /** Epoch milliseconds. During a wave, its lease deadline is the recovery alarm. */
  nextWakeAt(): number | null {
    if (this.closed) return null;
    let next = Infinity;
    for (const run of this.store.all<CloudStoredRun>('runs')) {
      if (run.status === 'running') next = Math.min(next, run.queueLease?.expiresAt ?? this.clock());
      else if (run.status === 'queued' && !this.wave) next = Math.min(next, this.dueAt(run));
    }
    return Number.isFinite(next) ? Math.max(this.clock(), next) : null;
  }
  processWave(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.wave) return this.wave;
    this.wave = Promise.resolve().then(() => this.runWave()).finally(() => {
      this.wave = undefined;
      if (this.nextWakeAt() !== null) this.notify();
    });
    return this.wave;
  }
  private async runWave(): Promise<void> {
    if (this.closed) return;
    this.recoverInterrupted();
    const claimed = this.store.transaction(() => {
      const due = this.store.all<CloudStoredRun>('runs').filter(run => run.status === 'queued' && this.dueAt(run) <= this.clock())
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
      const picked: CloudStoredRun[] = [];
      for (const run of due) {
        if (picked.length >= this.concurrency) break;
        if (!this.enabled(run)) {
          this.store.put('runs', { ...run, queueLease: undefined, status: 'cancelled',
            error: 'API 服务或模型已停用，待执行测试已取消。', finishedAt: this.timestamp() });
          continue;
        }
        const requestTimeoutSeconds = this.timeoutSeconds(run);
        const claimed: CloudStoredRun = { ...run, status: 'running', requestTimeoutSeconds, queueLease: {
          owner: this.owner, token: randomUUID(), expiresAt: this.clock() + requestTimeoutSeconds * 1000 + 60_000,
        } };
        this.store.put('runs', claimed); picked.push(claimed);
      }
      return picked;
    });
    await Promise.allSettled(claimed.map(run => {
      const controller = new AbortController(), token = run.queueLease!.token;
      this.active.set(run.id, { controller, token });
      return this.execute(run, controller).finally(() => this.active.delete(run.id));
    }));
  }
  private owned(run: CloudStoredRun): CloudStoredRun | undefined {
    if (this.closed) return undefined;
    const current = this.store.get<CloudStoredRun>('runs', run.id);
    return current?.status === 'running' && current.queueLease?.owner === this.owner
      && current.queueLease.token === run.queueLease?.token ? current : undefined;
  }
  private automaticRetry(parent: CloudStoredRun): CloudStoredRun | undefined {
    const limit = parent.retryLimit, attempt = parent.retryAttempt;
    if (this.closed || parent.nextRetryId || !this.enabled(parent) || this.size() >= 200
      || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_AUTO_RETRIES
      || typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0 || attempt >= limit) return;
    const retry: CloudStoredRun = { ...this.reset(parent, randomUUID()), retryAttempt: attempt + 1, retryKind: 'automatic',
      retryOf: parent.id, retryRootId: parent.retryRootId || parent.id,
      retryAt: new Date(this.clock() + Math.min(this.retryBaseDelayMs * 2 ** attempt, 60_000)).toISOString() };
    this.store.put('runs', { ...parent, nextRetryId: retry.id }); this.store.put('runs', retry); return retry;
  }
  private async abandonedArtifacts(runId: string, refs: ArtifactRef[]): Promise<void> {
    if (!refs.length) return;
    const persisted = this.store.transaction(() => {
      const current = this.store.get<CloudStoredRun>('runs', runId);
      if (!current) return false;
      const pending = [...(current.pendingArtifactDeletes || [])];
      for (const ref of refs) if (!pending.some(previous => sameRef(previous, ref))) pending.push(ref);
      this.store.put('runs', { ...current, pendingArtifactDeletes: pending, cleanupError: '迟到的测试正文等待清理，系统将自动重试。' });
      return true;
    });
    if (persisted) { for (const ref of refs) this.artifacts.ack(ref); }
    else {
      // The native store journal remains durable when DELETE fails; never recreate a deleted run.
      for (const ref of refs) { try { await this.artifacts.delete(ref); } catch { /* Alarm cleanup will retry. */ } }
    }
  }
  private async execute(run: CloudStoredRun, controller: AbortController): Promise<void> {
    const start = performance.now(); let timedOut = false;
    const timeoutSeconds = this.timeoutSeconds(run);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSeconds * 1000);
    try {
      if (!run.execution) throw new UpstreamError('任务缺少 API 参数快照，请重新创建测试。', false, 'invalid-response');
      const result = await callUpstream(run.execution, run.promptContent, this.store.decrypt(run.execution.encryptedApiKey), controller.signal, { stream: true });
      const latencyMs = Math.round(performance.now() - start);
      if (!this.owned(run)) return;
      const { output, html, reasoning, ...metadata } = result;
      let artifact: ArtifactRef | undefined;
      const uncertain: ArtifactRef[] = [];
      if (output || html || reasoning) {
        try { artifact = await this.artifacts.put(run.id, { output, html, reasoning }); }
        catch (error) {
          if (error instanceof CloudflareArtifactWriteError) uncertain.push(error.ref);
          metadata.error = [metadata.error, '模型已返回，但云端正文保存失败；已停止自动重试以避免重复生成。'].filter(Boolean).join('；');
        }
      }
      const saved = this.store.transaction(() => {
        const current = this.owned(run);
        if (!current) return false;
        const provider = this.store.get<StoredProvider>('providers', current.providerId || current.execution?.providerId || '');
        const retentionDays = provider?.retentionDays ?? this.store.settings().retentionDays;
        this.store.put('runs', { ...current, ...metadata, queueLease: undefined, artifact,
          pendingArtifactDeletes: [...(current.pendingArtifactDeletes || []), ...uncertain],
          cleanupError: uncertain.length ? '云端写入结果未确认，系统将安全清理可能残留的正文。' : current.cleanupError,
          artifactAvailable: Boolean(artifact), artifactStorage: artifact?.storage, hasHtml: Boolean(html),
          artifactExpiresAt: new Date(this.clock() + retentionDays * 86_400_000).toISOString(),
          status: metadata.error ? 'failed' : 'completed', latencyMs, finishedAt: this.timestamp() });
        return true;
      });
      if (!saved) await this.abandonedArtifacts(run.id, [...uncertain, ...(artifact ? [artifact] : [])]);
      else { if (artifact) this.artifacts.ack(artifact); for (const ref of uncertain) this.artifacts.ack(ref); }
    } catch (error) {
      this.store.transaction(() => {
        const current = this.owned(run);
        if (!current) return;
        const failed: CloudStoredRun = { ...current, queueLease: undefined, status: 'failed',
          error: timedOut ? `请求超时（${timeoutSeconds} 秒）；请重试或在全局设置中增加等待时间。`
            : error instanceof UpstreamError ? error.message : '无法完成测试，请检查 API 或云端存储配置。',
          latencyMs: Math.round(performance.now() - start), finishedAt: this.timestamp() };
        this.store.put('runs', failed);
        if (timedOut || error instanceof UpstreamError && error.retryable) this.automaticRetry(failed);
      });
    } finally { clearTimeout(timer); }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.active.values()) task.controller.abort();
    await this.wave?.catch(() => undefined);
  }
}
