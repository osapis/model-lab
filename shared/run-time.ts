import type { Run } from './types.ts';

type RunFinish = Pick<Run, 'status'> & { finishedAt?: string | null };
type RunTime = RunFinish & Pick<Run, 'createdAt'>;

function validTimestamp(value?: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Active attempts have no completion time, even if legacy data contains one. */
export function runFinishedAt(run: RunFinish): string | null {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
    ? validTimestamp(run.finishedAt) : null;
}

/** Public results use completion time; active or legacy records use creation time. */
export function runResultAt(run: RunTime): string | null {
  return runFinishedAt(run) ?? validTimestamp(run.createdAt);
}

export function runResultTime(run: RunTime): number {
  const timestamp = runResultAt(run);
  return timestamp === null ? 0 : Date.parse(timestamp);
}
