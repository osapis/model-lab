import { z } from 'zod';
import type { ArtifactConfiguration, ArtifactPayload, ArtifactRef, ArtifactRepository, NativeCloudflareConfiguration, StorageInput } from '../server/artifacts.ts';
import type { Store } from '../server/store.ts';
import type { StorageSettings } from '../shared/types.ts';

// Keep the serialized-object limit aligned with server/artifacts.ts without
// importing the Node S3 implementation into the Worker bundle.
export const CLOUDFLARE_ARTIFACT_MAX_BYTES = 12 * 1024 * 1024;
export const CLOUDFLARE_ARTIFACT_CHUNK_BYTES = 256 * 1024;
const R2_CONFIG = 'cloudflare-r2';
const SQLITE_CONFIG = 'cloudflare-sqlite';
const DEFAULT_ORPHAN_GRACE_MS = 5 * 60_000;
const payloadSchema = z.object({ output: z.string(), html: z.string(), reasoning: z.string() });
const encoder = new TextEncoder();

/** The small part of an R2 binding used here; no credentials or public bucket URL. */
export interface NativeR2Bucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<{ key: string; size: number } | null>;
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
  delete(key: string): Promise<void>;
}
export interface CloudflareArtifactOptions {
  bucketName?: string; prefix?: string; clock?: () => number; orphanGraceMs?: number; operationTimeoutMs?: number;
}
export class CloudflareArtifactWriteError extends Error {
  constructor(readonly ref: ArtifactRef) {
    super('云端正文写入未确认，请检查存储状态；可能遗留的对象将自动清理。');
    this.name = 'CloudflareArtifactWriteError';
  }
}

function validPrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  if (value.length > 500 || /[\x00-\x1f\x7f\\]/.test(prefix) || prefix.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('云端存储前缀不能超过 500 字符，也不能包含控制字符或相对路径。');
  }
  return prefix;
}
function serialized(payload: ArtifactPayload): Uint8Array {
  const body = encoder.encode(JSON.stringify(payloadSchema.parse(payload)));
  if (body.byteLength > CLOUDFLARE_ARTIFACT_MAX_BYTES) throw new Error('测试正文超过 12 MB 存储上限，请降低模型输出长度。');
  return body;
}

/** R2 when bound, otherwise durable chunks in this Cloudflare Durable Object. */
export class CloudflareArtifactStore implements ArtifactRepository {
  private readonly now: () => number;
  private readonly orphanGraceMs: number;
  private readonly bucketName: string;
  private readonly operationTimeoutMs: number;
  private active = new Set<string>();
  private operations = new Set<Promise<unknown>>();
  private readers = new Set<AbortController>();
  private cleaning = false;
  private stopped = false;

  constructor(private readonly store: Pick<Store, 'db' | 'transaction'> & { deployment?: string }, private readonly bucket?: NativeR2Bucket, options: CloudflareArtifactOptions = {}) {
    if (store.deployment !== 'cloudflare') throw new Error('云端正文存储只能使用 Cloudflare Durable Object 数据库。');
    this.now = options.clock || Date.now;
    this.orphanGraceMs = Math.max(0, options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS);
    this.bucketName = options.bucketName || 'ARTIFACTS';
    this.operationTimeoutMs = Math.max(1, options.operationTimeoutMs ?? 30_000);
    store.db.exec(`CREATE TABLE IF NOT EXISTS cloud_artifact_settings (id INTEGER PRIMARY KEY CHECK(id = 1), prefix TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_artifact_objects (object_key TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, chunk_count INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_artifact_chunks (object_key TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(object_key, part));
      CREATE TABLE IF NOT EXISTS cloud_artifact_writes (object_key TEXT PRIMARY KEY, settled INTEGER NOT NULL, cleanup_after INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_pending (config_id TEXT NOT NULL, object_key TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(config_id, object_key));`);
    store.db.prepare('INSERT OR IGNORE INTO cloud_artifact_settings(id, prefix) VALUES (1, ?)').run(validPrefix(options.prefix ?? 'runs'));
  }

  private prefix(): string { return String(this.store.db.prepare('SELECT prefix FROM cloud_artifact_settings WHERE id = 1').get()!.prefix); }
  private identity(ref: ArtifactRef): string { return `${ref.configId}:${ref.key}`; }
  private ensureOpen(): void { if (this.stopped) throw new Error('云端正文存储正在关闭。'); }
  private nativeBackend(ref: ArtifactRef): 'r2' | 'durable-sqlite' {
    if (ref.configId === SQLITE_CONFIG && ref.storage === 'cloudflare') return 'durable-sqlite';
    if (ref.configId === R2_CONFIG && (ref.storage === 'cloudflare' || ref.storage === 's3')) return 'r2';
    throw new Error('该历史正文尚未迁移到当前 Cloudflare 存储。');
  }
  private makeRef(runId: string, body: Uint8Array): ArtifactRef {
    const prefix = this.prefix();
    const name = runId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'run';
    return { storage: 'cloudflare', configId: this.bucket ? R2_CONFIG : SQLITE_CONFIG,
      key: `${prefix ? `${prefix}/` : ''}${name}-${crypto.randomUUID()}.json`, sizeBytes: body.byteLength };
  }
  private journal(ref: ArtifactRef): void {
    this.store.db.prepare('INSERT OR IGNORE INTO artifact_pending(config_id, object_key, data, created_at) VALUES (?, ?, ?, ?)')
      .run(ref.configId!, ref.key, JSON.stringify(ref), new Date(this.now()).toISOString());
  }
  private async tracked<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    const promise = operation();
    this.operations.add(promise);
    try { return await promise; } finally { this.operations.delete(promise); }
  }
  private async bounded<T>(operation: Promise<T>, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(new Error('Cloud storage operation timed out')); }, this.operationTimeoutMs);
    });
    try { return await Promise.race([operation, timeout]); }
    finally { clearTimeout(timer!); }
  }

  status(): StorageSettings {
    return { mode: 'cloudflare', backend: this.bucket ? 'r2' : 'durable-sqlite',
      endpoint: this.bucket ? 'Cloudflare R2 原生绑定' : 'Cloudflare Durable Object SQLite',
      region: 'auto', bucket: this.bucket ? this.bucketName : 'Durable Object', prefix: this.prefix(),
      hasAccessKeyId: false, hasSecretAccessKey: false, memoryLimitMb: 0, memoryUsedMb: 0 };
  }
  configure(input: StorageInput): StorageSettings {
    if (input.mode !== 'cloudflare') throw new Error('Cloudflare 部署使用持久云端存储，不能切换为内存或外部 S3。');
    const current = this.status();
    if ((input.accessKeyId?.trim() || input.secretAccessKey?.trim()) ||
      (input.endpoint && input.endpoint !== current.endpoint) || (input.bucket && input.bucket !== current.bucket) ||
      (input.region && input.region !== 'auto')) throw new Error('云端存储由部署绑定管理，后台只能修改对象前缀。');
    if (input.prefix !== undefined) {
      if (typeof input.prefix !== 'string') throw new Error('云端存储前缀必须为字符串。');
      this.store.db.prepare('UPDATE cloud_artifact_settings SET prefix = ? WHERE id = 1').run(validPrefix(input.prefix));
    }
    return this.status();
  }
  exportConfiguration(): NativeCloudflareConfiguration {
    return { mode: 'cloudflare', driver: 'cloudflare-binding', prefix: this.prefix(), backend: this.bucket ? 'r2' : 'durable-sqlite' };
  }
  importConfigurationInTransaction(input: ArtifactConfiguration): void {
    // Restore naming preferences; bucket access and the selected cloud backend
    // belong to the target deployment, not an imported configuration file.
    this.store.db.prepare('UPDATE cloud_artifact_settings SET prefix = ? WHERE id = 1').run(validPrefix(input.prefix));
  }
  putMemory(_runId: string, _payload: ArtifactPayload): never {
    throw new Error('Cloudflare 部署必须将正文写入持久云端存储，不能暂存内存。');
  }

  private async write(ref: ArtifactRef, body: Uint8Array): Promise<void> {
    if (this.nativeBackend(ref) === 'r2') {
      if (!this.bucket) throw new Error('R2 绑定不可用。');
      this.store.db.prepare('INSERT INTO cloud_artifact_writes(object_key, settled, cleanup_after) VALUES (?, 0, ?)')
        .run(ref.key, this.now() + this.orphanGraceMs);
      const pending = this.bucket.put(ref.key, body, { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } }).then(saved => {
        if (!saved || saved.key !== ref.key || saved.size !== body.byteLength) throw new Error('R2 write was not confirmed');
        // This may run after our timeout. Preserve the journal and record that a
        // late PUT has settled so a later cleanup can safely remove its object.
        this.store.db.prepare('UPDATE cloud_artifact_writes SET settled = 1 WHERE object_key = ?').run(ref.key);
      });
      await this.bounded(pending);
      return;
    }
    this.store.transaction(() => {
      const count = Math.ceil(body.byteLength / CLOUDFLARE_ARTIFACT_CHUNK_BYTES);
      this.store.db.prepare('INSERT INTO cloud_artifact_objects(object_key, size_bytes, chunk_count, created_at) VALUES (?, ?, ?, ?)')
        .run(ref.key, body.byteLength, count, new Date(this.now()).toISOString());
      const insert = this.store.db.prepare('INSERT INTO cloud_artifact_chunks(object_key, part, data) VALUES (?, ?, ?)');
      for (let part = 0; part < count; part++) insert.run(ref.key, part, body.subarray(part * CLOUDFLARE_ARTIFACT_CHUNK_BYTES, (part + 1) * CLOUDFLARE_ARTIFACT_CHUNK_BYTES));
    });
  }
  async put(runId: string, payload: ArtifactPayload): Promise<ArtifactRef> {
    this.ensureOpen();
    const body = serialized(payload);
    const ref = this.makeRef(runId, body);
    this.journal(ref);
    this.active.add(this.identity(ref));
    try { await this.tracked(() => this.write(ref, body)); }
    catch { throw new CloudflareArtifactWriteError(ref); }
    finally { this.active.delete(this.identity(ref)); }
    return ref;
  }
  ack(ref: ArtifactRef): void {
    if (!ref.configId || ref.storage === 'memory') return;
    const write = this.store.db.prepare('SELECT settled FROM cloud_artifact_writes WHERE object_key = ?').get(ref.key);
    if (write && !write.settled) return;
    this.forget(ref);
  }
  private forget(ref: ArtifactRef): void {
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM artifact_pending WHERE config_id = ? AND object_key = ?').run(ref.configId!, ref.key);
      this.store.db.prepare('DELETE FROM cloud_artifact_writes WHERE object_key = ?').run(ref.key);
    });
  }
  availability(ref: ArtifactRef): boolean | null { return ref.storage === 'memory' ? false : null; }

  private async readBody(ref: ArtifactRef, signal: AbortSignal): Promise<Uint8Array | null> {
    if (this.nativeBackend(ref) === 'r2') {
      if (!this.bucket) throw new Error('R2 绑定不可用。');
      const object = await this.bucket.get(ref.key);
      if (!object) return null;
      if (signal.aborted) { await object.body.cancel().catch(() => undefined); throw new Error('Body read aborted'); }
      if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > CLOUDFLARE_ARTIFACT_MAX_BYTES) {
        await object.body.cancel().catch(() => undefined);
        throw new Error('Invalid body size');
      }
      const reader = object.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      const result = new Uint8Array(object.size);
      let offset = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (signal.aborted) throw new Error('Body read aborted');
          if (done) break;
          if (offset + value.byteLength > object.size) throw new Error('Body exceeds declared size');
          result.set(value, offset); offset += value.byteLength;
        }
        if (offset !== object.size) throw new Error('Truncated body');
        return result;
      } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    }
    const object = this.store.db.prepare('SELECT size_bytes, chunk_count FROM cloud_artifact_objects WHERE object_key = ?').get(ref.key);
    if (!object) return null;
    const size = Number(object.size_bytes), count = Number(object.chunk_count);
    if (!Number.isSafeInteger(size) || size < 0 || size > CLOUDFLARE_ARTIFACT_MAX_BYTES || count !== Math.ceil(size / CLOUDFLARE_ARTIFACT_CHUNK_BYTES)) throw new Error('Invalid cloud body metadata');
    const rows = this.store.db.prepare('SELECT part, data FROM cloud_artifact_chunks WHERE object_key = ? ORDER BY part').all(ref.key);
    if (rows.length !== count) throw new Error('Cloud body chunks are missing');
    const result = new Uint8Array(size);
    let offset = 0;
    for (const [part, row] of rows.entries()) {
      const chunk = row.data;
      if (Number(row.part) !== part || !(chunk instanceof Uint8Array) || chunk.byteLength > CLOUDFLARE_ARTIFACT_CHUNK_BYTES || offset + chunk.byteLength > size) throw new Error('Invalid cloud body chunk');
      result.set(chunk, offset); offset += chunk.byteLength;
    }
    if (offset !== size) throw new Error('Incomplete cloud body');
    return result;
  }
  async get(ref: ArtifactRef): Promise<ArtifactPayload | null> {
    if (ref.storage === 'memory') return null;
    const reader = new AbortController(); this.readers.add(reader);
    try {
      const body = await this.tracked(() => this.bounded(this.readBody(ref, reader.signal), () => reader.abort()));
      return body ? payloadSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))) : null;
    } catch { throw new Error('云端正文读取失败，请检查存储绑定及正文完整性。'); }
    finally { this.readers.delete(reader); }
  }
  async delete(ref: ArtifactRef): Promise<void> {
    if (ref.storage === 'memory') return;
    let unconfirmedWrite = false;
    try {
      await this.tracked(async () => {
        if (this.nativeBackend(ref) === 'r2') {
          if (!this.bucket) throw new Error('R2 绑定不可用。');
          const write = this.store.db.prepare('SELECT settled, cleanup_after FROM cloud_artifact_writes WHERE object_key = ?').get(ref.key);
          unconfirmedWrite = Boolean(write && !write.settled);
          if (write && !write.settled && this.now() < Number(write.cleanup_after)) throw new Error('The previous PUT may still be settling');
          // Delete individual keys and await confirmation before acknowledging.
          await this.bounded(this.bucket.delete(ref.key));
        } else this.store.transaction(() => {
          this.store.db.prepare('DELETE FROM cloud_artifact_chunks WHERE object_key = ?').run(ref.key);
          this.store.db.prepare('DELETE FROM cloud_artifact_objects WHERE object_key = ?').run(ref.key);
        });
      });
      if (unconfirmedWrite) {
        // A timeout is not evidence that the original PUT has stopped. Even a
        // successful DELETE may precede that PUT, so retain a durable tombstone
        // and repeat cleanup until its completion is actually observed.
        this.store.db.prepare('UPDATE cloud_artifact_writes SET cleanup_after = ? WHERE object_key = ? AND settled = 0')
          .run(this.now() + this.orphanGraceMs, ref.key);
      } else this.forget(ref);
    } catch { throw new Error('云端正文删除失败；保留引用以便下次重试。'); }
  }
  async cleanupPending(isReferenced: (ref: ArtifactRef) => boolean, maxObjects = 5): Promise<void> {
    if (this.cleaning || this.stopped) return;
    this.cleaning = true;
    try {
      const rows = this.store.db.prepare('SELECT data, created_at FROM artifact_pending ORDER BY created_at').all();
      let processed = 0;
      for (const row of rows) {
        if (this.stopped) break;
        const ref = JSON.parse(String(row.data)) as ArtifactRef;
        if (this.active.has(this.identity(ref))) continue;
        if (isReferenced(ref)) { this.ack(ref); continue; }
        // After a DO restart an earlier R2 PUT may still be settling. Keep a
        // durable grace period instead of immediately deleting an uncertain key.
        if (this.now() - Date.parse(String(row.created_at)) < this.orphanGraceMs) continue;
        const write = this.store.db.prepare('SELECT settled, cleanup_after FROM cloud_artifact_writes WHERE object_key = ?').get(ref.key);
        if (write && !write.settled && this.now() < Number(write.cleanup_after)) continue;
        if (processed >= maxObjects) break;
        processed++;
        try { await this.delete(ref); } catch { /* Keep the journal entry for the next alarm. */ }
      }
    } finally { this.cleaning = false; }
  }
  async test(): Promise<void> {
    this.ensureOpen();
    const payload = { output: `storage-check-${crypto.randomUUID()}`, html: '', reasoning: '' };
    const body = serialized(payload), ref = this.makeRef('connection-test', body);
    this.journal(ref); this.active.add(this.identity(ref));
    try {
      await this.tracked(() => this.write(ref, body));
      if ((await this.get(ref))?.output !== payload.output) throw new Error('Body verification failed');
    } catch { throw new Error('云端存储连接测试失败，请检查绑定和读写状态。'); }
    finally {
      try { await this.delete(ref); }
      catch { throw new Error('连接测试的临时正文清理失败，系统将自动重试。'); }
      finally { this.active.delete(this.identity(ref)); }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const reader of this.readers) reader.abort();
    await Promise.allSettled([...this.operations]);
  }
}
