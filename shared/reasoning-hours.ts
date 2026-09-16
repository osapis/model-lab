import type { ReasoningHistoryEntry, ReasoningHistoryRow } from './reasoning-history.ts';
import { runResultAt, runResultTime } from './run-time.ts';

export interface HourSlot {
  index: number;
  /** Stable local-hour boundary, also suitable as a React/selection key. */
  start: number;
  end: number;
  /** Portion of this hour inside the inclusive history window. */
  visibleStart: number;
  visibleEnd: number;
  entries: ReasoningHistoryEntry[];
}

const HOUR = 60 * 60_000;

function localHourStart(time: number): number {
  const instant = new Date(time);
  const floor = new Date(time);
  floor.setMinutes(0, 0, 0);
  // Date setters choose the earlier occurrence of a repeated clock hour.
  // Retain the current occurrence when clocks have moved back since then.
  const offsetChange = (instant.getTimezoneOffset() - floor.getTimezoneOffset()) * 60_000;
  const laterOccurrence = floor.getTime() + offsetChange;
  return offsetChange > 0 && laterOccurrence <= time && new Date(laterOccurrence).getHours() === instant.getHours()
    ? laterOccurrence : floor.getTime();
}

/**
 * Use local clock hours without moving records outside the exact API window.
 * Include the hour containing `to` even when it has just begun: all provider
 * rows keep identical columns and an entry exactly at `to` is never dropped.
 */
export function hourlyEntries(row: ReasoningHistoryRow, from: string, to: string): HourSlot[] {
  const fromTime = Date.parse(from), toTime = Date.parse(to);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime < fromTime) return [];

  const hours: HourSlot[] = [];
  const byStart = new Map<number, HourSlot>();
  for (let start = localHourStart(fromTime); start <= toTime;) {
    // Flooring the following elapsed hour also handles half-hour DST changes.
    const end = localHourStart(start + HOUR);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const slot: HourSlot = { index: hours.length, start, end,
      visibleStart: Math.max(fromTime, start), visibleEnd: Math.min(toTime, end), entries: [] };
    hours.push(slot); byStart.set(start, slot);
    start = end;
  }

  for (const entry of row.entries) {
    if (entry.status === 'failed' || entry.status === 'cancelled' || entry.verdict === 'failed' || runResultAt(entry) === null) continue;
    const time = runResultTime(entry);
    if (time < fromTime || time > toTime) continue;
    byStart.get(localHourStart(time))?.entries.push(entry);
  }
  for (const hour of hours) hour.entries.sort((a, b) => runResultTime(a) - runResultTime(b) || a.id.localeCompare(b.id));
  return hours;
}
