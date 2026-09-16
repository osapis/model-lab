import type { Store } from '../server/store.ts';
import { defaultPrompts } from '../server/seed.ts';

/** Only the deployer can opt in through a Worker binding; HTTP cannot reset a store. */
export function initializeFreshStore(store: Store, enabled: boolean): boolean {
  if (!enabled) return false;
  store.db.exec('CREATE TABLE IF NOT EXISTS cloud_state (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const state = (id: string) => store.db.prepare('SELECT data FROM cloud_state WHERE id = ?').get(id)?.data;
  // A redeploy must never change configuration, credentials, history or migration status.
  if (state('migration_complete') === 'true') return false;
  if (store.db.prepare('SELECT id FROM cloud_state LIMIT 1').get()
    || (['providers', 'models', 'prompts', 'runs', 'schedules'] as const).some(table => store.all(table).length)
    || store.db.prepare("SELECT id FROM settings WHERE id != 'admin_token_version' LIMIT 1").get()) {
    throw new Error('Fresh initialization refused: existing data or incomplete migration.');
  }
  store.transaction(() => {
    for (const prompt of defaultPrompts()) store.put('prompts', prompt);
    for (const id of ['fresh_initialized', 'migration_complete', 'migration_sealed']) {
      store.db.prepare('INSERT INTO cloud_state(id,data) VALUES(?,?)').run(id, 'true');
    }
  });
  return true;
}
