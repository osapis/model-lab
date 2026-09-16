import { CronExpressionParser } from 'cron-parser';
import { DEFAULT_SCHEDULE_TIMEZONE } from '../shared/schedules.ts';

export interface ScheduleTimingInput {
  scheduleType?: 'interval' | 'cron'; intervalMinutes?: number; cronExpression?: string; timezone?: string;
}
export type ScheduleTiming = Required<ScheduleTimingInput>;
export class ScheduleTimingError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = 'ScheduleTimingError'; }
}
const months = /\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/g;
const weekdays = /\b(?:SUN|MON|TUE|WED|THU|FRI|SAT)\b/g;

function validateTimezone(value: unknown): string {
  const timezone = value === undefined ? DEFAULT_SCHEDULE_TIMEZONE : typeof value === 'string' ? value.trim() : '';
  if (!timezone || timezone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.\-]+)*$/.test(timezone)) {
    throw new ScheduleTimingError('时区无效，请填写 IANA 时区，例如 Asia/Shanghai。');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); }
  catch { throw new ScheduleTimingError('时区无效，请填写 IANA 时区，例如 Asia/Shanghai。'); }
  return timezone;
}
function validateExpression(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new ScheduleTimingError('Cron 表达式须为 5 段，依次是：分、时、日、月、星期。');
  const fields = value.trim().toUpperCase().split(/\s+/);
  if (fields.length !== 5) throw new ScheduleTimingError('Cron 只支持 5 段（分 时 日 月 星期），不支持秒字段。');
  for (const [index, field] of fields.entries()) {
    const checked = index === 3 ? field.replace(months, '1') : index === 4 ? field.replace(weekdays, '1') : field;
    if (!/^[\d*,/\-]+$/.test(checked)) throw new ScheduleTimingError('Cron 只支持标准 5 段的数值、*、逗号、范围和步长，以及月份或星期缩写。');
  }
  return fields.join(' ');
}
function readTiming(input: ScheduleTimingInput): ScheduleTiming {
  const scheduleType = input.scheduleType ?? 'interval';
  if (scheduleType !== 'interval' && scheduleType !== 'cron') throw new ScheduleTimingError('定时方式须为固定间隔或 Cron。');
  const intervalMinutes = input.intervalMinutes ?? (scheduleType === 'cron' ? 60 : undefined);
  if (typeof intervalMinutes !== 'number' || !Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 43200) {
    throw new ScheduleTimingError('测试间隔须为 1 至 43200 分钟。');
  }
  return { scheduleType, intervalMinutes, cronExpression: scheduleType === 'cron' ? validateExpression(input.cronExpression) : '',
    timezone: validateTimezone(input.timezone) };
}
function cronDates(cronExpression: string, timezone: string, from: number, count: number): string[] {
  if (!Number.isFinite(from) || !Number.isInteger(count) || count < 1 || count > 100) throw new ScheduleTimingError('无法计算计划时间，请检查起始时间。');
  try {
    // The library bounds iteration and handles IANA zones, calendar dates and DST.
    // Always supply both currentDate and tz, independent of the server's TZ setting.
    const expression = CronExpressionParser.parse(cronExpression, { currentDate: from, tz: timezone });
    return expression.take(count).map(date => date.toDate().toISOString());
  } catch { throw new ScheduleTimingError('Cron 表达式无效或无法计算下一次执行时间，请检查数值范围和日期组合。'); }
}
export function previewCron(cronExpression: string, timezone = DEFAULT_SCHEDULE_TIMEZONE, from = Date.now(), count = 3): string[] {
  return cronDates(validateExpression(cronExpression), validateTimezone(timezone), from, count);
}
export function normalizeScheduleTiming(input: ScheduleTimingInput, from = Date.now()): ScheduleTiming {
  const timing = readTiming(input);
  if (timing.scheduleType === 'cron') cronDates(timing.cronExpression, timing.timezone, from, 1);
  return timing;
}
export function nextScheduleRunAt(input: ScheduleTimingInput, from = Date.now()): string {
  const timing = readTiming(input);
  return timing.scheduleType === 'cron' ? cronDates(timing.cronExpression, timing.timezone, from, 1)[0]!
    : new Date(from + timing.intervalMinutes * 60_000).toISOString();
}
