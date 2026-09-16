import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { initializeFreshStore } from '../cloudflare/bootstrap.ts';
import { Store } from '../server/store.ts';
import type { Prompt } from '../shared/types.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-bootstrap-'));
  const store = new Store(directory, 'local-bootstrap-test-password');
  store.db.exec('CREATE TABLE IF NOT EXISTS cloud_state (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  t.after(async () => { store.db.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}

function snapshot(store: Store) {
  const tables = ['providers', 'models', 'prompts', 'runs', 'schedules', 'settings', 'cloud_state'];
  return tables.map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

test('Cloudflare fresh initialization requires explicit opt-in and seeds only two prompts', async (t) => {
  const store = await fixture(t);
  const before = snapshot(store);
  assert.equal(initializeFreshStore(store, false), false);
  assert.deepEqual(snapshot(store), before);
  assert.equal(initializeFreshStore(store, true), true);
  const prompts = store.all<Prompt>('prompts');
  assert.deepEqual(prompts.map(prompt => prompt.id).sort(), ['prompt-candy', 'prompt-pelican']);
  assert.ok(prompts.every(prompt => prompt.enabled && prompt.content.length > 20));
  for (const table of ['providers', 'models', 'runs', 'schedules'] as const) assert.equal(store.all(table).length, 0);
  const state = Object.fromEntries(store.db.prepare('SELECT id,data FROM cloud_state').all().map(row => [row.id, row.data]));
  assert.deepEqual(state, { fresh_initialized: 'true', migration_complete: 'true', migration_sealed: 'true' });
});

test('redeploy preserves edited prompts, settings and existing configuration without reseeding', async (t) => {
  const store = await fixture(t);
  initializeFreshStore(store, true);
  const prompt = store.get<Prompt>('prompts', 'prompt-candy')!;
  store.put('prompts', { ...prompt, title: 'Custom question', content: 'This is my question.' });
  store.delete('prompts', 'prompt-pelican');
  store.saveSettings({ retentionDays: 14, maxRetries: 3, requestTimeoutSeconds: 300 });
  const before = snapshot(store);
  assert.equal(initializeFreshStore(store, true), false);
  assert.deepEqual(snapshot(store), before);
});

test('completed legacy migration is preserved without adding fresh-install markers', async (t) => {
  const store = await fixture(t);
  store.db.prepare('INSERT INTO cloud_state(id,data) VALUES(?,?)').run('migration_complete', 'true');
  const before = snapshot(store);
  assert.equal(initializeFreshStore(store, true), false);
  assert.deepEqual(snapshot(store), before);
});

for (const table of ['providers', 'models', 'prompts', 'runs', 'schedules'] as const) {
  test(`fresh initialization refuses preexisting ${table} without changing data`, async (t) => {
    const store = await fixture(t);
    store.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`).run('existing', JSON.stringify({ id: 'existing' }));
    const before = snapshot(store);
    assert.throws(() => initializeFreshStore(store, true), /existing data|incomplete migration/);
    assert.deepEqual(snapshot(store), before);
  });
}

for (const state of ['migration_manifest', 'migration_complete', 'migration_sealed']) {
  test(`fresh initialization refuses incomplete migration state ${state}`, async (t) => {
    const store = await fixture(t);
    store.db.prepare('INSERT INTO cloud_state(id,data) VALUES(?,?)').run(state, 'false');
    const before = snapshot(store);
    assert.throws(() => initializeFreshStore(store, true), /existing data|incomplete migration/);
    assert.deepEqual(snapshot(store), before);
  });
}

test('fresh initialization does not replace settings from an existing installation', async (t) => {
  const store = await fixture(t);
  store.saveSettings({ retentionDays: 90, maxRetries: 2, requestTimeoutSeconds: 720 });
  const before = snapshot(store);
  assert.throws(() => initializeFreshStore(store, true), /existing data|incomplete migration/);
  assert.deepEqual(snapshot(store), before);
});

test('failed fresh initialization rolls back prompts and completion markers atomically', async (t) => {
  const store = await fixture(t);
  store.db.exec("CREATE TRIGGER fail_bootstrap BEFORE INSERT ON cloud_state WHEN NEW.id = 'migration_complete' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
  const before = snapshot(store);
  assert.throws(() => initializeFreshStore(store, true), /simulated storage failure/);
  assert.deepEqual(snapshot(store), before);
  store.db.exec('DROP TRIGGER fail_bootstrap');
  assert.equal(initializeFreshStore(store, true), true, 'A clean retry can initialize after transaction rollback');
});
