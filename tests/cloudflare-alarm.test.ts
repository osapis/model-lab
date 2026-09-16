import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Execute the actual alarm orchestration with platform imports stubbed locally.
// No Worker instance, real alarms, network calls or deployment is required.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = specifier === 'cloudflare:workers' ? 'workers'
      : specifier === 'cloudflare:node' ? 'node'
        : specifier === './cleanup.ts' && context.parentURL?.includes('/cloudflare/index.ts') ? 'cleanup' : null;
    return stub ? { url: `model-lab-alarm-test:${stub}`, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('model-lab-alarm-test:')) return nextLoad(url, context);
    const source = url.endsWith(':workers') ? 'export class DurableObject {}'
      : url.endsWith(':node') ? 'export function httpServerHandler() { throw new Error("HTTP is outside this alarm test"); }'
        : 'export async function cleanupCloudBatch(store) { return store.cleanup(); }';
    return { format: 'module', source, shortCircuit: true };
  },
});
let alarm: () => Promise<void>;
try {
  // Dynamic import ensures the Cloudflare-only imports use the temporary hooks.
  // Worker globals are typechecked separately by typecheck:cloudflare.
  const moduleUrl = new URL('../cloudflare/index.ts', import.meta.url).href;
  const { ModelLab } = await import(moduleUrl);
  alarm = ModelLab.prototype.alarm;
} finally { hooks.deregister(); }

test('long request waves and incomplete cleanup alternate in separate bounded alarms', async t => {
  let now = 7_200_000, queueWaves = 0, cleanups = 0, armed = 0, deleted = 0;
  let cleanupCompletes = false;
  const state = new Map<string, string>(), watchdogs: number[] = [];
  t.mock.method(Date, 'now', () => now);
  const instance = {
    enabled: () => true, scheduled: () => true,
    state: (key: string) => state.get(key), setState: (key: string, value: string) => state.set(key, value),
    ctx: { storage: {
      async setAlarm(time: number) { watchdogs.push(time); }, async deleteAlarm() { deleted++; },
    } },
    application: { ready: Promise.resolve(), scheduler: { tick() {} } },
    store: { async cleanup() { cleanups++; now += 390_000; return cleanupCompletes; } }, artifacts: {},
    queue: { async processWave() { queueWaves++; now += 720_000; } },
    async arm() { armed++; },
  };
  let start = now; await alarm.call(instance);
  assert.equal(cleanups, 1); assert.equal(queueWaves, 0); assert.equal(now - start, 390_000);
  assert.equal(state.get('last_alarm_work'), 'cleanup'); assert.equal(state.has('last_cleanup'), false);
  assert.equal(watchdogs[0], start + 780_000);

  start = now; await alarm.call(instance);
  assert.equal(cleanups, 1); assert.equal(queueWaves, 1); assert.equal(now - start, 720_000);
  assert.equal(state.get('last_alarm_work'), 'queue');

  cleanupCompletes = true;
  start = now; await alarm.call(instance);
  assert.equal(cleanups, 2); assert.equal(queueWaves, 1); assert.equal(now - start, 390_000);
  assert.equal(state.get('last_cleanup'), String(now));
  await alarm.call(instance);
  assert.equal(cleanups, 2); assert.equal(queueWaves, 2);
  assert.equal(armed, 4); assert.equal(deleted, 4);
});

test('failed cleanup still rearms and lets the next alarm execute queued requests', async () => {
  let queued = 0, armed = 0;
  const state = new Map<string, string>();
  const instance = {
    enabled: () => true, scheduled: () => true,
    state: (key: string) => state.get(key), setState: (key: string, value: string) => state.set(key, value),
    ctx: { storage: { async setAlarm() {}, async deleteAlarm() {} } },
    application: { ready: Promise.resolve(), scheduler: { tick() {} } },
    store: { async cleanup() { throw new Error('synthetic cleanup interruption'); } }, artifacts: {},
    queue: { async processWave() { queued++; } }, async arm() { armed++; },
  };
  await assert.rejects(alarm.call(instance), /synthetic cleanup interruption/);
  assert.equal(armed, 1); assert.equal(state.get('last_alarm_work'), 'cleanup');
  await alarm.call(instance);
  assert.equal(queued, 1); assert.equal(armed, 2);
});
