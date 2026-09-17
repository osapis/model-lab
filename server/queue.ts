import { randomUUID } from 'node:crypto';
import type { Model, Prompt } from '../shared/types.ts';
import { normalizeReasoningEffort } from '../shared/reasoning.ts';
import { MAX_AUTO_RETRIES } from '../shared/retries.ts';
import { normalizeRequestTimeoutSeconds } from '../shared/timeouts.ts';
import { Store, type StoredProvider, type StoredRun } from './store.ts';
import { ArtifactWriteError, type ArtifactRepository } from './artifacts.ts';
import { callUpstream, UpstreamError } from './upstream.ts';

export class QueueError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'QueueError'; }
}

export class RunQueue {
  private pending: string[] = [];
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private waiting = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private retryBaseDelayMs: number;
  constructor(private store: Store, private timeoutMs: number | undefined = undefined, private concurrency = 2, private clock: () => number = Date.now, private artifacts: ArtifactRepository, retryBaseDelayMs = 5000, private upstreamFetch?: typeof fetch) {
    this.retryBaseDelayMs = Number.isFinite(retryBaseDelayMs) && retryBaseDelayMs > 0 ? Math.min(retryBaseDelayMs, 60_000) : 5000;
    for (const run of store.all<StoredRun>('runs')) {
      if (run.status === 'running' || run.status === 'queued') {
        store.put('runs', { ...run, status: 'failed', error: '服务在任务完成前重新启动；请手动重试。', finishedAt: this.timestamp() });
      }
    }
  }
  private timestamp() { return new Date(this.clock()).toISOString(); }
  private configuredTimeoutSeconds(): number {
    return typeof this.timeoutMs === 'number' && Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
      ? this.timeoutMs / 1000 : normalizeRequestTimeoutSeconds(this.store.settings().requestTimeoutSeconds);
  }
  private timeoutSeconds(run: StoredRun): number {
    return typeof run.requestTimeoutSeconds === 'number' && Number.isFinite(run.requestTimeoutSeconds) && run.requestTimeoutSeconds > 0
      ? run.requestTimeoutSeconds : this.configuredTimeoutSeconds();
  }
  size() { return this.pending.length + this.active.size + this.waiting.size; }
  create(prompt: Prompt, model: Model, provider: StoredProvider, batchId: string): StoredRun {
    const reasoningEffort = normalizeReasoningEffort(model.reasoningEffort);
    const id = randomUUID();
    return {
      id, batchId, promptId: prompt.id, modelId: model.id, providerId: provider.id,
      providerName: provider.name, modelName: model.name, modelSlug: model.modelId,
      promptTitle: prompt.title, promptContent: prompt.content, category: prompt.category,
      referenceAnswer: prompt.referenceAnswer, rubric: prompt.rubric,
      status: 'queued', source: 'api', sourceLabel: '配置 API 实际调用', output: '', html: '', reasoning: '', error: '',
      latencyMs: null, inputTokens: null, outputTokens: null,
      createdAt: this.timestamp(), finishedAt: null, hasHtml: false, artifactAvailable: false,
      retryLimit: this.store.settings().maxRetries, retryAttempt: 0, retryRootId: id,
      requestTimeoutSeconds: this.configuredTimeoutSeconds(),
      parameters: { protocol: provider.protocol, maxTokens: model.maxTokens, reasoningEffort },
      execution: { providerId: provider.id, baseUrl: provider.baseUrl, encryptedApiKey: provider.encryptedApiKey,
        protocol: provider.protocol, modelId: model.modelId, simulateCodexClient: provider.simulateCodexClient ?? false,
        maxTokens: model.maxTokens, reasoningEffort },
    };
  }
  enqueue(runs: StoredRun[]) {
    if (this.closed) throw new QueueError(503, '任务队列正在停止。');
    if (this.size() + runs.length > 200) throw new QueueError(429, '队列已满（最多 200 个待完成任务），请稍后重试。');
    this.store.transaction(() => { for (const run of runs) this.store.put('runs', run); });
    for (const run of runs) this.register(run);
    queueMicrotask(() => this.pump());
  }
  cancel(run: StoredRun) {
    const current = this.store.get<StoredRun>('runs', run.id);
    if (!current || !['queued', 'running'].includes(current.status)) return current || run;
    this.pending = this.pending.filter(id => id !== run.id);
    const timer = this.waiting.get(run.id); if (timer) clearTimeout(timer);
    this.waiting.delete(run.id);
    const updated: StoredRun = { ...current, status: 'cancelled', error: '管理员已取消该任务。', finishedAt: this.timestamp() };
    this.store.put('runs', updated);
    this.active.get(run.id)?.controller.abort();
    return updated;
  }
  retry(run: StoredRun): StoredRun {
    if (run.source !== 'api' || !run.execution) throw new QueueError(400, '样例不能重试，请选择配置模型创建新测试。');
    const reasoningEffort = normalizeReasoningEffort(run.execution?.reasoningEffort ?? run.parameters.reasoningEffort);
    const id = randomUUID();
    return { ...this.reset(run, id), batchId: randomUUID(),
      parameters: { ...run.parameters, reasoningEffort },
      execution: run.execution ? { ...run.execution, reasoningEffort } : undefined,
      retryLimit: this.store.settings().maxRetries, retryAttempt: 0, retryRootId: id, retryOf: run.id, retryKind: 'manual',
      requestTimeoutSeconds: this.configuredTimeoutSeconds() };
  }
  private reset(run: StoredRun, id: string): StoredRun {
    return { ...run, id, status: 'queued', output: '', html: '', reasoning: '', error: '',
      latencyMs: null, inputTokens: null, outputTokens: null,
      createdAt: this.timestamp(), finishedAt: null, artifact: undefined, artifactStorage: undefined, artifactAvailable: false,
      artifactExpiresAt: null, hasHtml: false, pendingArtifactDeletes: [], cleanupError: undefined, nextRetryId: undefined, retryAt: undefined };
  }
  private retryEnabled(run: StoredRun): boolean {
    const provider = this.store.get<StoredProvider>('providers', run.execution?.providerId || run.providerId || '');
    const model = this.store.get<Model>('models', run.modelId);
    return run.source === 'api' && Boolean(run.execution && provider?.enabled && model?.enabled);
  }
  private register(run: StoredRun) {
    const delay = run.retryKind === 'automatic' && run.retryAt ? Math.max(0, Date.parse(run.retryAt) - this.clock()) : 0;
    if (delay > 0) {
      const timer = setTimeout(() => {
        this.waiting.delete(run.id);
        if (this.closed) return;
        const current = this.store.get<StoredRun>('runs', run.id);
        if (current?.status !== 'queued') return;
        this.pending.push(run.id); this.pump();
      }, delay);
      timer.unref(); this.waiting.set(run.id, timer);
    } else this.pending.push(run.id);
  }
  private scheduleRetry(id: string) {
    if (this.closed || this.size() >= 200) return;
    const child = this.store.transaction(() => {
      const parent = this.store.get<StoredRun>('runs', id);
      if (!parent || parent.status !== 'failed' || parent.nextRetryId || !this.retryEnabled(parent)) return;
      const limit = parent.retryLimit;
      const attempt = parent.retryAttempt;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_AUTO_RETRIES
        || typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0 || attempt >= limit) return;
      const delay = Math.min(this.retryBaseDelayMs * 2 ** attempt, 60_000);
      const retry: StoredRun = { ...this.reset(parent, randomUUID()), retryAttempt: attempt + 1,
        retryKind: 'automatic', retryOf: parent.id, retryRootId: parent.retryRootId || parent.id,
        retryAt: new Date(this.clock() + delay).toISOString() };
      // Parent and child are committed together; a repeated callback cannot fork this chain.
      this.store.put('runs', { ...parent, nextRetryId: retry.id });
      this.store.put('runs', retry);
      return retry;
    });
    if (child) this.register(child);
  }
  private pump() {
    if (this.closed) return;
    while (this.active.size < this.concurrency && this.pending.length) {
      const id = this.pending.shift()!; const run = this.store.get<StoredRun>('runs', id);
      if (!run || run.status !== 'queued') continue;
      // Recheck eligibility when dispatching, including first attempts that waited
      // behind another request. Invalid snapshots still reach execute's diagnostic.
      if ((run.retryKind === 'automatic' || (run.source === 'api' && run.execution)) && !this.retryEnabled(run)) {
        this.store.put('runs', { ...run, status: 'cancelled', error: 'API 服务或模型已停用，待执行测试已取消。', finishedAt: this.timestamp() });
        continue;
      }
      const controller = new AbortController();
      const claimed: StoredRun = { ...run, status: 'running', requestTimeoutSeconds: this.timeoutSeconds(run) };
      this.store.put('runs', claimed);
      const promise = this.execute(claimed, controller).then(shouldRetry => {
        // Release the completed attempt before reserving its replacement queue slot.
        this.active.delete(id);
        if (shouldRetry) this.scheduleRetry(id);
      }).catch(() => {
        // Queue/storage failures must not fork a retry chain or expose internal exceptions.
      }).finally(() => { this.active.delete(id); this.pump(); });
      this.active.set(id, { controller, promise });
    }
  }
  private async execute(run: StoredRun, controller: AbortController): Promise<boolean> {
    const start = performance.now(); let timedOut = false;
    const timeoutSeconds = this.timeoutSeconds(run);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSeconds * 1000);
    try {
      if (!run.execution) throw new UpstreamError('任务缺少 API 参数快照，请重新创建测试。', false, 'invalid-response');
      const result = await callUpstream(run.execution, run.promptContent, this.store.decrypt(run.execution.encryptedApiKey), controller.signal,
        { stream: run.execution.protocol === 'responses', fetcher: this.upstreamFetch });
      const responseLatencyMs = Math.round(performance.now() - start);
      let current = this.store.get<StoredRun>('runs', run.id);
      if (this.closed || current?.status !== 'running') return false;
      const { output, html, reasoning, ...metadata } = result;
      let artifact;
      const pendingArtifactDeletes = [...(current.pendingArtifactDeletes || [])];
      if (output || html || reasoning) {
        try { artifact = await this.artifacts.put(run.id, { output, html, reasoning }); }
        catch (error) {
          if (error instanceof ArtifactWriteError) pendingArtifactDeletes.push(error.ref);
          artifact = this.artifacts.putMemory(run.id, { output, html, reasoning });
          metadata.error = [metadata.error, '模型已返回，但外部结果存储失败；内容暂存内存，重启后失效。'].filter(Boolean).join('；');
        }
      }
      current = this.store.get<StoredRun>('runs', run.id);
      if (this.closed || current?.status !== 'running') {
        if (artifact) pendingArtifactDeletes.push(artifact);
        // Persist every possible cloud object before attempting deletion. Shutdown or
        // a failed DELETE must not leave an untracked object behind.
        if (current && pendingArtifactDeletes.length) {
          this.store.put('runs', { ...current, pendingArtifactDeletes, cleanupError: '取消后的正文等待清理，系统将在下一轮自动重试。' });
          for (const pending of pendingArtifactDeletes) this.artifacts.ack(pending);
        }
        return false;
      }
      const provider = this.store.get<StoredProvider>('providers', current.providerId || '');
      const retentionDays = provider?.retentionDays ?? this.store.settings().retentionDays;
      this.store.put('runs', { ...current, ...metadata, artifact, pendingArtifactDeletes,
        cleanupError: pendingArtifactDeletes.length ? '正文写入状态不确定，系统将自动清理可能残留的文件或对象。' : current.cleanupError,
        artifactAvailable: Boolean(artifact), artifactStorage: artifact?.storage, hasHtml: Boolean(html),
        artifactExpiresAt: new Date(this.clock() + retentionDays * 86_400_000).toISOString(),
        status: metadata.error ? 'failed' : 'completed',
        latencyMs: responseLatencyMs, finishedAt: this.timestamp() });
      if (artifact) this.artifacts.ack(artifact);
      for (const pending of pendingArtifactDeletes) this.artifacts.ack(pending);
      return false;
    } catch (error) {
      const current = this.store.get<StoredRun>('runs', run.id);
      if (!this.closed && current?.status === 'running') {
        this.store.put('runs', { ...current, status: 'failed',
          error: timedOut ? `请求超时（${timeoutSeconds} 秒）；请重试或在全局设置中增加等待时间。`
            : error instanceof UpstreamError ? error.message : '无法完成测试，请检查 API 或结果存储配置。',
          latencyMs: Math.round(performance.now() - start), finishedAt: this.timestamp() });
        return timedOut || error instanceof UpstreamError && error.retryable;
      }
      return false;
    } finally { clearTimeout(timer); }
  }
  async close() {
    this.closed = true; this.pending = [];
    for (const timer of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.active.values()].map(task => task.promise));
  }
}
