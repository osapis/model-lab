import assert from 'node:assert/strict';
import test from 'node:test';
import { runFinishedAt, runResultAt, runResultTime } from '../shared/run-time.ts';

const createdAt = '2026-09-15T23:59:00+08:00';
const finishedAt = '2026-09-16T00:01:25+08:00';

test('terminal result time uses actual completion across midnight without changing stored timestamps', () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const run = Object.freeze({ status, createdAt, finishedAt });
    assert.equal(runFinishedAt(run), finishedAt);
    assert.equal(runResultAt(run), finishedAt);
    assert.equal(runResultTime(run), Date.parse('2026-09-15T16:01:25Z'));
    assert.equal(run.createdAt, createdAt);
  }
});

test('queued and running records never present an old completion timestamp as current completion', () => {
  for (const status of ['queued', 'running'] as const) {
    const run = { status, createdAt, finishedAt };
    assert.equal(runFinishedAt(run), null);
    assert.equal(runResultAt(run), createdAt);
    assert.equal(runResultTime(run), Date.parse(createdAt));
  }
});

test('legacy records without usable completion time fall back to their original creation time', () => {
  for (const value of [undefined, null, '', 'not a date']) {
    const run = { status: 'completed' as const, createdAt, finishedAt: value };
    assert.equal(runFinishedAt(run), null);
    assert.equal(runResultAt(run), createdAt);
    assert.equal(runResultTime(run), Date.parse(createdAt));
  }
});

test('valid completion survives invalid creation time, and unusable timestamps have a deterministic fallback', () => {
  assert.equal(runResultAt({ status: 'completed', createdAt: 'invalid', finishedAt }), finishedAt);
  for (const createdAt of ['', 'invalid']) {
    const run = { status: 'failed' as const, createdAt, finishedAt: null };
    assert.equal(runResultAt(run), null);
    assert.equal(runResultTime(run), 0);
  }
});
