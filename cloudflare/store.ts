import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { createHmac } from 'node:crypto';
import { Store, type DatabaseRow, type DatabaseValue, type SyncDatabase, type SyncStatement } from '../server/store.ts';

export type DurableSqlStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
export interface CloudStoreCredentials { encryptionKey: Uint8Array; adminToken: string }

function binding(value: DatabaseValue): string | number | null | ArrayBuffer {
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError('Durable Object SQL 不支持超出安全整数范围的 bigint 参数。');
    return number;
  }
  if (value instanceof Uint8Array) {
    // A Buffer/Uint8Array can be a small view into a much larger allocation.
    // Copy only its visible bytes, never the entire underlying backing buffer.
    return new Uint8Array(value).buffer;
  }
  return value;
}
function row(value: Record<string, unknown>): DatabaseRow {
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, field instanceof ArrayBuffer ? new Uint8Array(field) : field])) as DatabaseRow;
}

/** Fully consume every DO cursor synchronously; never keep a cursor across awaits. */
export class DurableObjectDatabase implements SyncDatabase {
  constructor(private storage: DurableSqlStorage) {}
  exec(sql: string): void { this.storage.sql.exec(sql).toArray(); }
  prepare(sql: string): SyncStatement {
    const execute = (parameters: DatabaseValue[]) => this.storage.sql.exec(sql, ...parameters.map(binding));
    return {
      all: (...parameters) => execute(parameters).toArray().map(row),
      get: (...parameters) => {
        // .one() would reject empty/multiple results; Node's .get() returns the first.
        const rows = execute(parameters).toArray();
        return rows.length ? row(rows[0]) : undefined;
      },
      run: (...parameters) => {
        execute(parameters).toArray();
        // Cursor rowsWritten is a billing counter (including index writes), not changes().
        const [result] = this.storage.sql.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').toArray();
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
      },
    };
  }
  // Durable Object storage belongs to the object context and has no close operation.
  close(): void {}
}

export class CloudStore extends Store {
  readonly deployment = 'cloudflare' as const;
  constructor(storage: DurableSqlStorage, credentials: CloudStoreCredentials) {
    super({
      database: new DurableObjectDatabase(storage),
      transaction: <T>(fn: () => T) => storage.transactionSync(fn),
      encryptionKey: credentials.encryptionKey,
      adminToken: credentials.adminToken,
    });
    // Bind persisted sessions to the current administrator secret. A Worker
    // secret update replaces the instance, but must also revoke its old cookies.
    // Use a keyed digest so a database copy is not a password-guessing oracle.
    const version = createHmac('sha256', credentials.encryptionKey)
      .update('model-lab/admin-session-version/v1\0').update(credentials.adminToken).digest('hex');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_auth_state (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.transaction(() => {
      const previous = this.db.prepare('SELECT data FROM cloud_auth_state WHERE id = ?').get('admin_token_version');
      if (previous?.data === version) return;
      this.db.exec('DELETE FROM sessions');
      this.db.prepare('INSERT INTO cloud_auth_state(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run('admin_token_version', version);
    });
  }
}
