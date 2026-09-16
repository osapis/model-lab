import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { hourlyEntries } from '../shared/reasoning-hours.ts';
import type { ReasoningHistoryEntry, ReasoningHistoryRow } from '../shared/reasoning-history.ts';

const iso = (time: number) => new Date(time).toISOString();
const local = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 8, day, hour, minute, second).getTime();
const row = (entries: ReasoningHistoryEntry[] = []): ReasoningHistoryRow => ({ providerId: 'api', providerName: '接口', entries });
function entry(id: string, finishedAt: number, fields: Partial<ReasoningHistoryEntry> = {}): ReasoningHistoryEntry {
  return { id, createdAt: iso(finishedAt - 60_000), finishedAt: iso(finishedAt), modelName: '模型',
    reasoningEffort: 'max', status: 'completed', verdict: 'correct', answer: '21', error: '', ...fields };
}

test('natural hours place screenshot completions in their own clock hours and stay stable on minute refresh', () => {
  const entries = [entry('completed-21', local(15, 21, 43, 37)), entry('completed-22', local(15, 22, 47, 59))];
  const first = hourlyEntries(row(entries), iso(local(15, 7, 44)), iso(local(16, 7, 44)));
  const refreshed = hourlyEntries(row(entries), iso(local(15, 7, 45)), iso(local(16, 7, 45)));
  assert.equal(first.length, 25);
  for (const [id, hour] of [['completed-21', 21], ['completed-22', 22]] as const) {
    const slot = first.find(slot => slot.entries.some(item => item.id === id))!;
    assert.equal(slot.start, local(15, hour));
    assert.equal(slot.end, local(15, hour + 1));
    assert.equal(refreshed.find(slot => slot.entries.some(item => item.id === id))!.start, slot.start);
  }
  assert.equal(first[0]!.visibleStart, local(15, 7, 44));
  assert.equal(first[0]!.start, local(15, 7));
  assert.equal(first.at(-1)!.visibleEnd, local(16, 7, 44));
  assert.equal(first.at(-1)!.end, local(16, 8));
});

test('exact window edges are inclusive without admitting other entries from partial edge hours', () => {
  const from = local(15, 7, 44), to = local(16, 7, 44);
  const slots = hourlyEntries(row([entry('before', from - 1), entry('start', from), entry('end', to), entry('after', to + 1)]), iso(from), iso(to));
  assert.deepEqual(slots.flatMap(slot => slot.entries.map(item => item.id)), ['start', 'end']);
});

test('an exact endpoint hour is identical across all providers, even if empty or containing an endpoint record', () => {
  const from = local(15, 8), to = local(16, 8);
  const populated = hourlyEntries(row([entry('just-completed', to)]), iso(from), iso(to));
  const empty = hourlyEntries(row(), iso(from), iso(to));
  assert.equal(populated.length, 25);
  assert.deepEqual(populated.map(({ entries, ...slot }) => slot), empty.map(({ entries, ...slot }) => slot));
  assert.equal(populated.at(-1)!.visibleStart, to);
  assert.equal(populated.at(-1)!.visibleEnd, to);
  assert.deepEqual(populated.at(-1)!.entries.map(item => item.id), ['just-completed']);
  assert.ok(populated.every(slot => slot.start <= to), 'Never add a future hour');
});

test('hour keys survive a day-window shift; completion order is deterministic and source entries are unmodified', () => {
  const time = local(16, 7, 20);
  const source = row([entry('z', time), entry('earlier', time - 1000), entry('a', time)]);
  const before = JSON.stringify(source);
  const initial = hourlyEntries(source, iso(local(15, 7, 59)), iso(local(16, 7, 59)));
  const shifted = hourlyEntries(source, iso(local(15, 8, 1)), iso(local(16, 8, 1)));
  const current = initial.find(slot => slot.entries.length)!;
  const remaining = shifted.find(slot => slot.start === current.start)!;
  assert.notEqual(current.index, remaining.index);
  assert.deepEqual(remaining.entries.map(item => item.id), ['earlier', 'a', 'z']);
  assert.equal(JSON.stringify(source), before);
});

test('hidden failures remain hidden while active and legacy records use creation time', () => {
  const from = local(15, 7), to = local(16, 7);
  const source = row([
    entry('failed', to, { status: 'failed' }), entry('cancelled', to, { status: 'cancelled' }),
    entry('failed-verdict', to, { verdict: 'failed' }),
    entry('pending', to + 1000, { status: 'running', verdict: 'pending', createdAt: iso(to - 1000) }),
    entry('legacy', to, { finishedAt: null, createdAt: iso(to - 2000) }),
    entry('invalid', to, { finishedAt: 'invalid', createdAt: 'invalid' }),
  ]);
  assert.deepEqual(hourlyEntries(source, iso(from), iso(to)).flatMap(slot => slot.entries.map(item => item.id)), ['legacy', 'pending']);
});

test('invalid or backwards windows return no slots; a zero-width window can contain its exact endpoint', () => {
  const time = local(16, 7);
  for (const [from, to] of [['invalid', iso(time)], [iso(time), 'invalid'], [iso(time), iso(time - 1)]]) {
    assert.deepEqual(hourlyEntries(row(), from!, to!), []);
  }
  const exact = hourlyEntries(row([entry('now', time)]), iso(time), iso(time));
  assert.equal(exact.length, 1);
  assert.deepEqual(exact[0]!.entries.map(item => item.id), ['now']);
});

function timezoneSlots(tz: string, from: string, to: string, entries: ReasoningHistoryEntry[] = []) {
  const moduleUrl = new URL('../shared/reasoning-hours.ts', import.meta.url).href;
  const code = `import { hourlyEntries } from ${JSON.stringify(moduleUrl)};
    const slots = hourlyEntries(${JSON.stringify(row(entries))}, ${JSON.stringify(from)}, ${JSON.stringify(to)});
    process.stdout.write(JSON.stringify(slots.map(slot => ({ ...slot, hour: new Date(slot.start).getHours(),
      minute: new Date(slot.start).getMinutes(), offset: new Date(slot.start).getTimezoneOffset() }))));`;
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' })) as (ReturnType<typeof hourlyEntries>[number] & { hour: number; minute: number; offset: number })[];
}

test('local hour alignment works for Shanghai and a non-whole-hour UTC offset', () => {
  for (const tz of ['Asia/Shanghai', 'Asia/Kathmandu']) {
    const slots = timezoneSlots(tz, '2026-09-15T00:44:00Z', '2026-09-16T00:44:00Z');
    assert.equal(slots.length, 25);
    assert.ok(slots.every(slot => slot.minute === 0));
    assert.ok(slots.every(slot => slot.end - slot.start === 3_600_000));
  }
});

test('DST skips missing clock hours and preserves both repeated hours as distinct stable slots', () => {
  const spring = timezoneSlots('America/New_York', '2026-03-08T05:30:00Z', '2026-03-08T09:30:00Z');
  assert.deepEqual(spring.map(slot => slot.hour), [0, 1, 3, 4, 5]);
  const first = Date.parse('2026-11-01T05:30:00Z'), second = Date.parse('2026-11-01T06:30:00Z');
  const fall = timezoneSlots('America/New_York', '2026-11-01T04:30:00Z', '2026-11-01T08:30:00Z', [entry('first', first), entry('second', second)]);
  assert.deepEqual(fall.map(slot => slot.hour), [0, 1, 1, 2, 3]);
  assert.deepEqual(fall.filter(slot => slot.hour === 1).map(slot => slot.entries.map(item => item.id)), [['first'], ['second']]);
  assert.equal(new Set(fall.map(slot => slot.start)).size, fall.length);
});

test('half-hour DST transitions keep valid local boundaries and never lose records', () => {
  const springTimes = ['2026-10-03T15:15:00Z', '2026-10-03T15:35:00Z', '2026-10-03T16:15:00Z'];
  const spring = timezoneSlots('Australia/Lord_Howe', '2026-10-03T14:35:00Z', '2026-10-03T17:35:00Z',
    springTimes.map((time, index) => entry(`spring-${index}`, Date.parse(time))));
  assert.deepEqual(spring.map(slot => [slot.hour, slot.minute]), [[1, 0], [2, 30], [3, 0], [4, 0]]);
  assert.deepEqual(spring.flatMap(slot => slot.entries.map(item => item.id)), ['spring-0', 'spring-1', 'spring-2']);
  const fallTimes = ['2026-04-04T14:45:00Z', '2026-04-04T15:15:00Z', '2026-04-04T15:45:00Z'];
  const fall = timezoneSlots('Australia/Lord_Howe', '2026-04-04T14:35:00Z', '2026-04-04T17:35:00Z',
    fallTimes.map((time, index) => entry(`fall-${index}`, Date.parse(time))));
  assert.deepEqual(fall.map(slot => [slot.hour, slot.minute]), [[1, 0], [1, 30], [2, 0], [3, 0], [4, 0]]);
  assert.deepEqual(fall.flatMap(slot => slot.entries.map(item => item.id)), ['fall-0', 'fall-1', 'fall-2']);
});
