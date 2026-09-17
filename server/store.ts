import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { ArtifactRef } from './artifacts.ts';
import type { Provider, Model, Prompt, Run, Schedule, LabSettings } from '../shared/types.ts';
import { normalizeReasoningEffort } from '../shared/reasoning.ts';
import { normalizeMaxRetries, MAX_AUTO_RETRIES } from '../shared/retries.ts';
import { normalizeRequestTimeoutSeconds } from '../shared/timeouts.ts';

export interface StoredProvider extends Omit<Provider, 'hasApiKey' | 'apiKeyPreview'> { encryptedApiKey: string }
export interface ExecutionSnapshot {
  providerId: string; baseUrl: string; encryptedApiKey: string;
  protocol: Provider['protocol']; modelId: string;
  maxTokens: number; reasoningEffort: string;
}
export interface StoredRun extends Run { execution?: ExecutionSnapshot; artifact?: ArtifactRef; pendingArtifactDeletes?: ArtifactRef[] }
type Entity = StoredProvider | Model | Prompt | StoredRun | Schedule;
type Table = 'providers' | 'models' | 'prompts' | 'runs' | 'schedules';

/** The synchronous SQL surface shared by Node SQLite and Durable Object SQL. */
export type DatabaseValue = string | number | bigint | null | Uint8Array;
export type DatabaseRow = Record<string, DatabaseValue>;
export interface SyncStatement {
  all(...parameters: DatabaseValue[]): DatabaseRow[];
  get(...parameters: DatabaseValue[]): DatabaseRow | undefined;
  run(...parameters: DatabaseValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface SyncDatabase {
  exec(sql: string): void;
  prepare(sql: string): SyncStatement;
  close(): void;
}
export type SyncTransaction = <T>(fn: () => T) => T;
export interface InjectedStoreOptions {
  database: SyncDatabase;
  transaction: SyncTransaction;
  encryptionKey: Uint8Array;
  adminToken: string;
  dataDir?: string;
}

function localStoreOptions(directory: string, adminToken?: string): InjectedStoreOptions {
  // Keep Node-only loading inside the local constructor path. A Worker importing
  // Store with an injected database must never load SQLite or touch the filesystem.
  const nodeLoader = createRequire(import.meta.url);
  const { DatabaseSync } = nodeLoader('node:sqlite') as typeof import('node:sqlite');
  const { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } = nodeLoader('node:fs') as typeof import('node:fs');
  const { join } = nodeLoader('node:path') as typeof import('node:path');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const keyPath = join(directory, 'encryption-key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  chmodSync(keyPath, 0o600);
  const encryptionKey = readFileSync(keyPath);
  if (encryptionKey.length !== 32) throw new Error('数据加密密钥无效，请恢复原来的 encryption-key 文件。');
  const tokenPath = join(directory, 'admin-token');
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, Buffer.from(randomBytes(32)).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(tokenPath, 0o600);
  const token = adminToken || readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error('管理口令不能为空。');
  const databasePath = join(directory, 'app.db');
  const database = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  return {
    database, encryptionKey, adminToken: token, dataDir: directory,
    transaction: <T>(fn: () => T): T => {
      database.exec('BEGIN');
      try { const value = fn(); database.exec('COMMIT'); return value; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

// Remove retired controls and normalize active model settings. Keep historical
// reasoning snapshots, artifact references and legacy bodies intact.
function normalizeEntity<T extends Entity>(table: Table, entity: T): T {
  const value = { ...entity } as T & Record<string, unknown>;
  if (table === 'providers') delete value.apiKeyPreview;
  if (table === 'models') {
    delete value.temperature;
    value.reasoningEffort = normalizeReasoningEffort(value.reasoningEffort);
  }
  if (table === 'schedules') delete value.autoPublish;
  if (table === 'runs') {
    for (const key of ['score', 'notes', 'published', 'autoPublish']) delete value[key];
    for (const key of ['parameters', 'execution']) {
      if (value[key] && typeof value[key] === 'object') {
        const nested = { ...(value[key] as Record<string, unknown>) };
        delete nested.temperature;
        (value as Record<string, unknown>)[key] = nested;
      }
    }
  }
  return value;
}

export class Store {
  db: SyncDatabase;
  readonly dataDir?: string;
  private key: Buffer;
  private transactionSync: SyncTransaction;
  adminToken: string;
  constructor(directory: string, adminToken?: string);
  constructor(options: InjectedStoreOptions);
  constructor(directoryOrOptions: string | InjectedStoreOptions, adminToken?: string) {
    const options = typeof directoryOrOptions === 'string' ? localStoreOptions(directoryOrOptions, adminToken) : directoryOrOptions;
    if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32) {
      throw new Error('数据加密密钥必须是 32 字节。');
    }
    if (!options.adminToken) throw new Error('管理口令不能为空。');
    if (typeof options.transaction !== 'function') throw new Error('存储层必须提供同步事务适配器。');
    this.db = options.database;
    this.dataDir = typeof directoryOrOptions === 'string' ? directoryOrOptions : options.dataDir;
    // Copy the supplied bytes so later mutation by the caller cannot rotate the key.
    this.key = Buffer.from(options.encryptionKey);
    this.adminToken = options.adminToken;
    this.transactionSync = options.transaction;
    for (const table of ['providers', 'models', 'prompts', 'runs', 'schedules']) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    this.transaction(() => {
      for (const table of ['models', 'runs', 'schedules'] as const) {
        for (const row of this.db.prepare(`SELECT id, data FROM ${table}`).all()) {
          const normalized = JSON.stringify(normalizeEntity(table, JSON.parse(row.data as string) as Entity));
          if (normalized !== row.data) this.db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(normalized, row.id);
        }
      }
    });
  }
  all<T extends Entity>(table: Table): T[] {
    return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all().map(row => normalizeEntity(table, JSON.parse(row.data as string) as T));
  }
  get<T extends Entity>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return row ? normalizeEntity(table, JSON.parse(row.data as string) as T) : undefined;
  }
  put<T extends Entity>(table: Table, entity: T) {
    // Generated bodies belong in the selected artifact backend, never SQLite.
    const normalized = normalizeEntity(table, entity);
    const stored = table === 'runs' ? { ...normalized, output: '', html: '', reasoning: '' } : normalized;
    this.db.prepare(`INSERT INTO ${table}(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(entity.id, JSON.stringify(stored));
    return entity;
  }
  delete(table: Table, id: string) { this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); }
  transaction<T>(fn: () => T): T {
    return this.transactionSync(fn);
  }
  settings(): Required<LabSettings> {
    const row = this.db.prepare("SELECT data FROM settings WHERE id = 'global'").get();
    const settings = row ? JSON.parse(row.data as string) : null;
    const days = settings?.retentionDays;
    return { retentionDays: typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 30,
      maxRetries: normalizeMaxRetries(settings?.maxRetries),
      requestTimeoutSeconds: normalizeRequestTimeoutSeconds(settings?.requestTimeoutSeconds) };
  }
  saveSettings(settings: LabSettings) {
    const current = this.settings();
    const next = { retentionDays: settings.retentionDays, maxRetries: normalizeMaxRetries(settings.maxRetries ?? current.maxRetries),
      requestTimeoutSeconds: normalizeRequestTimeoutSeconds(settings.requestTimeoutSeconds ?? current.requestTimeoutSeconds) };
    this.db.prepare("INSERT INTO settings(id, data) VALUES ('global', ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(next));
    return next;
  }
  encrypt(secret: string): string {
    if (!secret) return '';
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
  }
  decrypt(encrypted: string): string {
    if (!encrypted) return '';
    const [iv, tag, ciphertext] = encrypted.split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
  close() { this.db.close(); }
}
function maskedApiKey(apiKey: string): string {
  if (!apiKey) return '';
  const prefixLength = apiKey.startsWith('sk-') ? 7 : 4;
  // Hide at least four characters; short credentials must not reveal overlapping slices.
  if (apiKey.length < prefixLength + 5 + 4) return '••••••••';
  return `${apiKey.slice(0, prefixLength)}...${apiKey.slice(-5)}`;
}
/** Call only for authenticated management responses, never for public provider lists. */
export function providerDto(provider: StoredProvider, store: Pick<Store, 'decrypt'>): Provider {
  let apiKeyPreview = '';
  if (provider.encryptedApiKey) {
    try { apiKeyPreview = maskedApiKey(store.decrypt(provider.encryptedApiKey)); }
    catch { /* A damaged credential must not break the rest of the management page. */ }
  }
  return {
    id: provider.id, name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol,
    enabled: provider.enabled, createdAt: provider.createdAt,
    retentionDays: provider.retentionDays ?? null, hasApiKey: Boolean(provider.encryptedApiKey), apiKeyPreview,
  };
}
export function runDto(run: StoredRun): Run {
  // Project the public contract explicitly, including nested request parameters.
  // Future internal fields must never become public just by being added to storage.
  const parameters = run.parameters;
  return {
    id: run.id, batchId: run.batchId, promptId: run.promptId, modelId: run.modelId,
    providerId: run.providerId || run.execution?.providerId || '',
    providerName: run.providerName, modelName: run.modelName, modelSlug: run.modelSlug,
    promptTitle: run.promptTitle, promptContent: run.promptContent, category: run.category,
    referenceAnswer: run.referenceAnswer, rubric: run.rubric,
    status: run.status, source: run.source, sourceLabel: run.sourceLabel,
    output: '', html: '', reasoning: '', error: run.error,
    latencyMs: run.latencyMs, inputTokens: run.inputTokens, outputTokens: run.outputTokens,
    createdAt: run.createdAt, finishedAt: run.finishedAt,
    parameters: {
      ...(parameters?.protocol === 'responses' || parameters?.protocol === 'chat-completions' ? { protocol: parameters.protocol } : {}),
      ...(typeof parameters?.maxTokens === 'number' && Number.isFinite(parameters.maxTokens) ? { maxTokens: parameters.maxTokens } : {}),
      ...(typeof parameters?.reasoningEffort === 'string' ? { reasoningEffort: parameters.reasoningEffort } : {}),
    },
    scheduleId: run.scheduleId, artifactAvailable: run.artifactAvailable,
    artifactExpiresAt: run.artifactExpiresAt, artifactStorage: run.artifactStorage,
    hasHtml: run.hasHtml, cleanupError: run.cleanupError,
    ...(typeof run.requestTimeoutSeconds === 'number' && Number.isFinite(run.requestTimeoutSeconds) && run.requestTimeoutSeconds > 0
      ? { requestTimeoutSeconds: run.requestTimeoutSeconds } : {}),
    ...(typeof run.retryLimit === 'number' && Number.isInteger(run.retryLimit) && run.retryLimit >= 0 && run.retryLimit <= MAX_AUTO_RETRIES ? { retryLimit: run.retryLimit } : {}),
    ...(typeof run.retryAttempt === 'number' && Number.isInteger(run.retryAttempt) && run.retryAttempt >= 0 && run.retryAttempt <= MAX_AUTO_RETRIES ? { retryAttempt: run.retryAttempt } : {}),
    ...(typeof run.retryRootId === 'string' ? { retryRootId: run.retryRootId } : {}),
    ...(typeof run.retryOf === 'string' ? { retryOf: run.retryOf } : {}),
    ...(run.retryKind === 'automatic' || run.retryKind === 'manual' ? { retryKind: run.retryKind } : {}),
    ...(typeof run.nextRetryId === 'string' ? { nextRetryId: run.nextRetryId } : {}),
    ...(typeof run.retryAt === 'string' ? { retryAt: run.retryAt } : {}),
  };
}
