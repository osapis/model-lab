import { randomUUID } from 'node:crypto';
import type { Model, Prompt, Schedule } from '../shared/types.ts';
import { Store, type StoredProvider, type StoredRun } from './store.ts';
import { RunQueue } from './queue.ts';
import { nextScheduleRunAt, normalizeScheduleTiming, ScheduleTimingError } from './schedule-time.ts';
import { resolveScheduleSelection } from '../shared/schedule-availability.ts';

export class SchedulerError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface SchedulerOptions {
  now?: () => number; schedulerIntervalMs?: number; cleanupIntervalMs?: number;
  removeArtifact?: (id: string) => Promise<void>;
  cleanupPendingArtifacts?: (id: string) => Promise<void>;
  cleanupOrphanArtifacts?: () => Promise<void>;
}
export class Scheduler {
  private tickTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private now: () => number;
  private cleaning?: Promise<void>;
  private closed = false;
  constructor(private store: Store, private queue: RunQueue, private options: SchedulerOptions = {}) {
    this.now = options.now || Date.now;
  }
  start() {
    this.tick(); void this.cleanup();
    this.tickTimer = setInterval(() => this.tick(), this.options.schedulerIntervalMs ?? 30_000);
    this.cleanupTimer = setInterval(() => { void this.cleanup(); }, this.options.cleanupIntervalMs ?? 60_000);
    this.tickTimer.unref(); this.cleanupTimer.unref();
  }
  validate(promptIds: string[], modelIds: string[], previous?: Pick<Schedule, 'promptIds' | 'modelIds'>) {
    const selectedPromptIds = [...new Set(promptIds)];
    const selectedModelIds = [...new Set(modelIds)];
    const prompts = selectedPromptIds.map(id => this.store.get<Prompt>('prompts', id));
    const models = selectedModelIds.map(id => this.store.get<Model>('models', id));
    if (prompts.length * models.length > 50) throw new SchedulerError(400, '每次计划最多创建 50 个测试任务。');
    // Existing deleted references may be retained while pausing or editing a plan.
    // New selections must still refer to real configuration records.
    if (!prompts.length || prompts.some((prompt, index) => !prompt && !previous?.promptIds.includes(selectedPromptIds[index]!))) {
      throw new SchedulerError(400, '计划中的提示词不存在。');
    }
    if (!models.length || models.some((model, index) => !model && !previous?.modelIds.includes(selectedModelIds[index]!))) {
      throw new SchedulerError(400, '计划中的模型不存在。');
    }
    return { prompts: prompts.filter((prompt): prompt is Prompt => Boolean(prompt)), models: models.filter((model): model is Model => Boolean(model)) };
  }
  run(schedule: Schedule, automatic = false): StoredRun[] {
    if (this.closed) throw new SchedulerError(503, '调度器正在停止。');
    normalizeScheduleTiming(schedule, this.now());
    const active = this.store.all<StoredRun>('runs').some(run => run.scheduleId === schedule.id && ['queued', 'running'].includes(run.status));
    if (active) throw new SchedulerError(409, '该计划仍有任务未完成，本次执行已跳过。');
    const { prompts, pairs, runnableCount } = resolveScheduleSelection(schedule,
      this.store.all<Prompt>('prompts'), this.store.all<Model>('models'), this.store.all<StoredProvider>('providers'));
    if (!runnableCount) throw new SchedulerError(400, '当前没有可执行的测试组合，本轮已跳过；启用计划中的提示词、模型和 API 后，将在下次计划时间自动继续。');
    if (runnableCount > 50) throw new SchedulerError(400, '每次计划最多创建 50 个测试任务。');
    if (this.queue.size() + runnableCount > 200) throw new SchedulerError(429, '队列已满，本次计划执行已跳过。');
    const batchId = randomUUID(); const runs: StoredRun[] = [];
    for (const { model, provider } of pairs) {
      for (const prompt of prompts) runs.push({ ...this.queue.create(prompt, model, provider, batchId), scheduleId: schedule.id });
    }
    this.queue.enqueue(runs);
    const current = this.store.get<Schedule>('schedules', schedule.id) || schedule;
    this.store.put('schedules', { ...current, lastRunAt: new Date(this.now()).toISOString(), lastError: '',
      // Manual execution does not reset the automatic cadence.
      nextRunAt: automatic ? schedule.nextRunAt : current.nextRunAt });
    return runs;
  }
  tick() {
    if (this.closed) return;
    const time = this.now();
    for (const schedule of this.store.all<Schedule>('schedules')) {
      if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > time) continue;
      // Persist the next slot before enqueueing. An overdue schedule runs once after restart.
      let updated: Schedule;
      try { updated = { ...schedule, nextRunAt: nextScheduleRunAt(schedule, time) }; }
      catch (error) {
        storeInvalidSchedule(this.store, schedule, error);
        continue;
      }
      this.store.put('schedules', updated);
      try { this.run(updated, true); }
      catch (error) {
        this.store.put('schedules', { ...updated, lastError: error instanceof SchedulerError || error instanceof ScheduleTimingError ? error.message : '计划执行失败，请检查服务配置。' });
      }
    }
  }
  cleanup(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.performCleanup().finally(() => { this.cleaning = undefined; });
    return this.cleaning;
  }
  private async performCleanup() {
    try { await this.options.cleanupOrphanArtifacts?.(); } catch { /* Keep journal rows for the next cleanup pass. */ }
    const time = this.now(); const defaults = this.store.settings();
    for (const snapshot of this.store.all<StoredRun>('runs')) {
      if (this.closed) return;
      if (snapshot.pendingArtifactDeletes?.length) {
        try { await this.options.cleanupPendingArtifacts?.(snapshot.id); } catch { /* Retry next minute. */ }
      }
      const run = this.store.get<StoredRun>('runs', snapshot.id);
      if (!run) continue;
      if (this.closed || run.source === 'sample' || ['queued', 'running'].includes(run.status)) continue;
      const provider = this.store.get<StoredProvider>('providers', run.providerId || run.execution?.providerId || '');
      const retention = provider?.retentionDays ?? defaults.retentionDays;
      const finished = Date.parse(run.finishedAt || run.createdAt);
      if (!Number.isFinite(finished) || finished >= time - retention * 86_400_000) continue;
      try {
        await this.options.removeArtifact?.(run.id);
        this.store.delete('runs', run.id);
      } catch {
        // Keep the reference and retry next minute if external deletion fails.
        const current = this.store.get<StoredRun>('runs', run.id);
        if (current) this.store.put('runs', { ...current, cleanupError: '作品正文删除失败；保留历史记录并在下一轮自动重试。' });
      }
    }
  }
  async close() {
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.cleaning;
  }
}

function storeInvalidSchedule(store: Store, schedule: Schedule, error: unknown) {
  store.put('schedules', { ...schedule, enabled: false,
    lastError: error instanceof ScheduleTimingError ? error.message : '无法计算计划时间，已暂停该计划，请检查定时配置。' });
}
