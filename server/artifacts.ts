import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { StorageSettings } from '../shared/types.ts';
import type { Store } from './store.ts';

export interface ArtifactPayload { output: string; html: string; reasoning: string }
export interface ArtifactRef {
  storage: 'memory' | 's3' | 'cloudflare'; key: string; configId?: string; sizeBytes: number;
}
export class ArtifactWriteError extends Error {
  constructor(readonly ref: ArtifactRef) {
    super('对象存储写入结果未确认，请检查存储服务、连接和写入权限；可能遗留的对象将自动清理。');
    this.name = 'ArtifactWriteError';
  }
}
export interface StorageInput {
  mode: 'memory' | 's3' | 'cloudflare'; endpoint?: string; region?: string; bucket?: string;
  prefix?: string; accessKeyId?: string; secretAccessKey?: string;
}
export interface NativeR2Configuration { mode: 's3'; driver: 'r2-binding'; prefix: string }
export interface NativeCloudflareConfiguration { mode: 'cloudflare'; driver: 'cloudflare-binding'; prefix: string; backend?: 'r2' | 'durable-sqlite' }
export type ArtifactConfiguration = Required<StorageInput> | NativeR2Configuration | NativeCloudflareConfiguration;
/** Public storage contract shared by the Node and Cloudflare implementations. */
export type ArtifactRepository = Omit<Pick<ArtifactStore, keyof ArtifactStore>, 'exportConfiguration' | 'importConfigurationInTransaction'> & {
  exportConfiguration(): ArtifactConfiguration;
  importConfigurationInTransaction(input: ArtifactConfiguration): void;
};

// HTML is also preserved in the raw output; a 4 MB upstream response can expand here.
export const ARTIFACT_MAX_BYTES = 12 * 1024 * 1024;
export const ARTIFACT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 30_000;
const inputSchema = z.object({
  mode: z.enum(['memory', 's3']), endpoint: z.string().trim().max(2048).optional(),
  region: z.string().trim().max(100).optional(), bucket: z.string().trim().max(255).optional(),
  prefix: z.string().trim().max(500).optional(), accessKeyId: z.string().trim().max(512).optional(),
  secretAccessKey: z.string().trim().max(1024).optional(),
});
const payloadSchema = z.object({ output: z.string(), html: z.string(), reasoning: z.string() });
interface Config extends Required<StorageInput> { id: string }

function serialize(payload: ArtifactPayload): Buffer {
  const body = Buffer.from(JSON.stringify(payloadSchema.parse(payload)), 'utf8');
  if (body.byteLength > ARTIFACT_MAX_BYTES) throw new Error('测试正文超过 12 MB 存储上限，请降低模型输出长度。');
  return body;
}

function validateConfig(config: Config): Config {
  if (config.endpoint) {
    let endpoint: URL;
    try { endpoint = new URL(config.endpoint); }
    catch { throw new Error('对象存储 Endpoint 必须是有效的 HTTPS 地址。'); }
    const localHttp = endpoint.protocol === 'http:' &&
      (endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(endpoint.hostname));
    if ((endpoint.protocol !== 'https:' && !localHttp) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('对象存储 Endpoint 需使用 HTTPS（本机测试可用 HTTP），且不能包含账号、密码、查询参数或片段。');
    }
    config.endpoint = endpoint.toString().replace(/\/$/, '');
  }
  config.region ||= 'auto';
  config.prefix = config.prefix.replace(/^\/+|\/+$/g, '');
  if (!/^[a-zA-Z0-9-]+$/.test(config.region)) throw new Error('对象存储 Region 格式无效。');
  if (config.bucket && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(config.bucket)) throw new Error('对象存储 Bucket 格式无效。');
  if (/[\x00-\x1f\x7f\\]/.test(config.prefix) || config.prefix.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('对象存储 Prefix 不能包含控制字符或相对路径。');
  }
  if (/[\x00-\x20\x7f]/.test(config.accessKeyId) || /[\x00-\x20\x7f]/.test(config.secretAccessKey)) {
    throw new Error('对象存储密钥不能包含空格或控制字符。');
  }
  if (config.mode === 's3' && (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey)) {
    throw new Error('请完整配置对象存储 Endpoint、Bucket、Access Key ID 和 Secret Access Key。');
  }
  return config;
}

/** Validate a complete imported configuration without inheriting target credentials. */
export function validateStorageImport(input: unknown): Required<StorageInput> {
  const parsed = inputSchema.required().strict().safeParse(input);
  if (!parsed.success) throw new Error('对象存储配置格式无效。');
  const { id: _id, ...config } = validateConfig({ id: '', ...parsed.data });
  return config;
}

function missingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { name?: string };
  return details.name === 'NoSuchKey' || details.name === 'NotFound';
}

/** Metadata and encrypted configuration persist; generated bodies never touch local files. */
export class ArtifactStore {
  private memory = new Map<string, Buffer>();
  private memoryBytes = 0;
  private operations = new Set<AbortController>();
  private inFlight = new Set<string>();
  private cleaningPending = false;
  private closed = false;

  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS artifact_configs (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS artifact_configs_current ON artifact_configs(is_current) WHERE is_current = 1;
    CREATE TABLE IF NOT EXISTS artifact_pending (
      config_id TEXT NOT NULL, object_key TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (config_id, object_key)
    );`);
    if (!store.db.prepare('SELECT id FROM artifact_configs WHERE is_current = 1').get()) {
      this.save({ id: randomUUID(), mode: 'memory', endpoint: '', region: 'auto', bucket: '', prefix: 'model-lab', accessKeyId: '', secretAccessKey: '' });
    }
  }

  private save(config: Config, withinTransaction = false): void {
    const encrypted = this.store.encrypt(JSON.stringify(config));
    const write = () => {
      this.store.db.prepare('UPDATE artifact_configs SET is_current = 0 WHERE is_current = 1').run();
      this.store.db.prepare('INSERT INTO artifact_configs(id, data, is_current, created_at) VALUES (?, ?, 1, ?)')
        .run(config.id, encrypted, new Date().toISOString());
    };
    if (withinTransaction) write();
    else this.store.transaction(write);
  }

  private config(id?: string): Config {
    const row = id
      ? this.store.db.prepare('SELECT data FROM artifact_configs WHERE id = ?').get(id)
      : this.store.db.prepare('SELECT data FROM artifact_configs WHERE is_current = 1').get();
    if (!row) throw new Error('历史正文的对象存储配置不可用。');
    try { return JSON.parse(this.store.decrypt(row.data as string)) as Config; }
    catch { throw new Error('对象存储配置无法解密，请检查服务器加密密钥。'); }
  }

  status(): StorageSettings {
    const config = this.config();
    return {
      mode: config.mode, endpoint: config.endpoint, region: config.region, bucket: config.bucket, prefix: config.prefix,
      hasAccessKeyId: Boolean(config.accessKeyId), hasSecretAccessKey: Boolean(config.secretAccessKey),
      memoryLimitMb: ARTIFACT_MEMORY_LIMIT_BYTES / 1024 / 1024,
      memoryUsedMb: Math.round(this.memoryBytes / 1024 / 1024 * 100) / 100,
    };
  }

  configure(input: StorageInput): StorageSettings {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new Error('对象存储配置格式无效，请检查字段类型和长度。');
    const previous = this.config();
    const next = validateConfig({ ...previous, ...parsed.data,
      accessKeyId: parsed.data.accessKeyId || previous.accessKeyId,
      secretAccessKey: parsed.data.secretAccessKey || previous.secretAccessKey,
    });
    if (JSON.stringify(next) !== JSON.stringify(previous)) this.save({ ...next, id: randomUUID() });
    return this.status();
  }

  /** Internal encrypted-backup input only. Never expose this result through an API. */
  exportConfiguration(): Required<StorageInput> {
    const { id: _id, ...config } = this.config();
    return config;
  }

  /** Caller owns the outer transaction; previous cloud configurations stay addressable. */
  importConfigurationInTransaction(input: ArtifactConfiguration): void {
    // Native cloud bindings cannot be transferred to a Node process. Preserve the
    // target storage while the surrounding transaction restores the other settings.
    if ('driver' in input) return;
    const config = validateStorageImport(input);
    this.save({ ...config, id: randomUUID() }, true);
    // Configuration is read from SQLite, with no cache to pollute on rollback.
  }

  private key(runId: string, prefix = ''): string {
    const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'run';
    return `${prefix ? `${prefix}/` : ''}${safeId}-${randomUUID()}.json`;
  }

  private refId(ref: ArtifactRef): string { return `${ref.configId}:${ref.key}`; }

  /** Register the remote key before any network write, including writes whose response may be lost. */
  private journal(ref: ArtifactRef): void {
    if (ref.storage !== 's3' || !ref.configId) return;
    this.store.db.prepare('INSERT OR IGNORE INTO artifact_pending(config_id, object_key, data, created_at) VALUES (?, ?, ?, ?)')
      .run(ref.configId, ref.key, JSON.stringify(ref), new Date().toISOString());
  }

  /** Call only after the run has durably saved its artifact reference. */
  ack(ref: ArtifactRef): void {
    if (ref.storage !== 's3' || !ref.configId) return;
    this.store.db.prepare('DELETE FROM artifact_pending WHERE config_id = ? AND object_key = ?').run(ref.configId, ref.key);
  }

  async cleanupPending(isReferenced: (ref: ArtifactRef) => boolean, maxObjects = Infinity): Promise<void> {
    if (this.cleaningPending || this.closed) return;
    this.cleaningPending = true;
    try {
      const rows = this.store.db.prepare('SELECT data FROM artifact_pending ORDER BY created_at').all();
      let processed = 0;
      for (const row of rows) {
        if (this.closed) break;
        const ref = JSON.parse(row.data as string) as ArtifactRef;
        if (this.inFlight.has(this.refId(ref))) continue;
        if (isReferenced(ref)) { this.ack(ref); continue; }
        if (processed >= maxObjects) break;
        processed++;
        try { await this.delete(ref); }
        catch { /* Keep the durable reference and retry on the next cleanup pass. */ }
      }
    } finally { this.cleaningPending = false; }
  }

  putMemory(runId: string, payload: ArtifactPayload): ArtifactRef {
    const body = serialize(payload);
    while (this.memoryBytes + body.byteLength > ARTIFACT_MEMORY_LIMIT_BYTES) {
      const oldest = this.memory.keys().next().value;
      if (!oldest) break;
      this.memoryBytes -= this.memory.get(oldest)!.byteLength;
      this.memory.delete(oldest);
    }
    const key = this.key(runId);
    this.memory.set(key, body);
    this.memoryBytes += body.byteLength;
    return { storage: 'memory', key, sizeBytes: body.byteLength };
  }

  private async withS3<T>(config: Config, operation: (client: S3Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('对象存储服务正在关闭。');
    const controller = new AbortController();
    this.operations.add(controller);
    const timeout = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
    timeout.unref();
    const client = new S3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestHandler: { connectionTimeout: 20_000, requestTimeout: OPERATION_TIMEOUT_MS, throwOnRequestTimeout: true },
    });
    try { return await operation(client, controller.signal); }
    finally { clearTimeout(timeout); this.operations.delete(controller); client.destroy(); }
  }

  async put(runId: string, payload: ArtifactPayload): Promise<ArtifactRef> {
    const config = this.config();
    if (config.mode === 'memory') return this.putMemory(runId, payload);
    const body = serialize(payload);
    const key = this.key(runId, config.prefix);
    const ref: ArtifactRef = { storage: 's3', key, configId: config.id, sizeBytes: body.byteLength };
    this.journal(ref);
    this.inFlight.add(this.refId(ref));
    try {
      await this.withS3(config, (client, signal) => client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: body, ContentType: 'application/json; charset=utf-8', CacheControl: 'no-store',
      }), { abortSignal: signal }));
    } catch { throw new ArtifactWriteError(ref); }
    finally { this.inFlight.delete(this.refId(ref)); }
    return ref;
  }

  availability(ref: ArtifactRef): boolean | null {
    return ref.storage === 'memory' ? this.memory.has(ref.key) : null;
  }

  async get(ref: ArtifactRef): Promise<ArtifactPayload | null> {
    if (ref.storage === 'memory') {
      const body = this.memory.get(ref.key);
      return body ? JSON.parse(Buffer.from(body).toString('utf8')) as ArtifactPayload : null;
    }
    if (!ref.configId) throw new Error('历史正文缺少对象存储配置引用。');
    const config = this.config(ref.configId);
    try {
      return await this.withS3(config, async (client, signal) => {
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: ref.key }), { abortSignal: signal });
        if (!response.Body || (response.ContentLength ?? 0) > ARTIFACT_MAX_BYTES) throw new Error('Invalid artifact body');
        const parts: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          const part = Buffer.from(chunk);
          size += part.byteLength;
          if (size > ARTIFACT_MAX_BYTES) throw new Error('Artifact too large');
          parts.push(part);
        }
        return payloadSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
      });
    } catch (error) {
      if (missingObject(error)) return null;
      throw new Error('对象存储正文读取失败，请检查存储服务、读取权限和正文格式。');
    }
  }

  async delete(ref: ArtifactRef): Promise<void> {
    if (ref.storage === 'memory') {
      const body = this.memory.get(ref.key);
      if (body) { this.memoryBytes -= body.byteLength; this.memory.delete(ref.key); }
      return;
    }
    if (!ref.configId) throw new Error('历史正文缺少对象存储配置引用。');
    const config = this.config(ref.configId);
    try {
      await this.withS3(config, (client, signal) => client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: ref.key }), { abortSignal: signal }));
    } catch (error) {
      if (!missingObject(error)) throw new Error('对象存储正文删除失败，请检查存储服务和删除权限。');
    }
    this.ack(ref);
  }

  async test(): Promise<void> {
    const config = this.config();
    if (config.mode === 'memory') return;
    const payload = { output: `storage-test-${randomUUID()}`, html: '', reasoning: '' };
    const body = serialize(payload);
    const ref: ArtifactRef = { storage: 's3', key: this.key('connection-test', config.prefix), configId: config.id, sizeBytes: body.byteLength };
    this.journal(ref);
    this.inFlight.add(this.refId(ref));
    try {
      await this.withS3(config, (client, signal) => client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: ref.key, Body: body, ContentType: 'application/json', CacheControl: 'no-store',
      }), { abortSignal: signal }));
      const result = await this.get(ref);
      if (result?.output !== payload.output) throw new Error('Artifact verification failed');
    } catch { throw new Error('对象存储连接测试失败，请检查配置及对象写入、读取权限。'); }
    finally {
      try { await this.delete(ref); }
      catch { throw new Error('对象存储连接测试的临时对象清理失败，请检查删除权限。'); }
      finally { this.inFlight.delete(this.refId(ref)); }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const operation of this.operations) operation.abort();
    this.memory.clear();
    this.memoryBytes = 0;
  }
}
