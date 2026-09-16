import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { z } from 'zod';
import type { Model, Prompt, Schedule } from '../shared/types.ts';
import { REASONING_EFFORTS } from '../shared/reasoning.ts';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS, MIN_REQUEST_TIMEOUT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS } from '../shared/timeouts.ts';
import {
  CONFIG_BACKUP_MAX_BYTES, CONFIG_BACKUP_MAX_PASSWORD_LENGTH, CONFIG_BACKUP_MIN_PASSWORD_LENGTH,
  type ConfigBackupCounts, type ConfigBackupEnvelope, type ConfigBackupImportResult, type ConfigBackupPreview,
} from '../shared/config-backup.ts';
import { Store, type StoredProvider } from './store.ts';
import { validateStorageImport, type ArtifactConfiguration, type ArtifactRepository } from './artifacts.ts';
import { normalizeScheduleTiming, nextScheduleRunAt } from './schedule-time.ts';

const MAX_PLAINTEXT_BYTES = 4 * 1024 * 1024;
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 32 } as const;
const AAD = Buffer.from('model-lab-config:v1:aes-256-gcm:scrypt:N32768:r8:p1:key32');
const id = z.string().min(1).max(100);
const timestamp = z.string().datetime({ offset: true });
const retention = z.number().int().min(1).max(3650);
const baseUrl = z.string().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const providerSchema = z.object({
  id, name: z.string().trim().min(1).max(100), baseUrl, protocol: z.enum(['chat-completions', 'responses']),
  enabled: z.boolean(), retentionDays: retention.nullable(), apiKey: z.string().max(8192), createdAt: timestamp,
}).strict();
const modelSchema = z.object({
  id, providerId: id, name: z.string().trim().min(1).max(120), modelId: z.string().trim().min(1).max(200),
  enabled: z.boolean(), maxTokens: z.number().int().min(1).max(131072), reasoningEffort: z.enum(REASONING_EFFORTS), createdAt: timestamp,
}).strict();
const promptSchema = z.object({
  id, title: z.string().trim().min(1).max(120), description: z.string().max(1000), category: z.enum(['visual', 'reasoning', 'text']),
  content: z.string().min(1).max(100000).refine(value => Boolean(value.trim())), referenceAnswer: z.string().max(20000),
  rubric: z.string().max(20000), tags: z.array(z.string().trim().min(1).max(40)).max(15),
  enabled: z.boolean(), createdAt: timestamp, updatedAt: timestamp,
}).strict();
const scheduleSchema = z.object({
  id, name: z.string().trim().min(1).max(120), promptIds: z.array(id).min(1).max(50), modelIds: z.array(id).min(1).max(50),
  intervalMinutes: z.number().int().min(1).max(43200).optional(), enabled: z.boolean(), createdAt: timestamp,
  scheduleType: z.enum(['interval', 'cron']).default('interval'),
  cronExpression: z.string().trim().max(200).default(''), timezone: z.string().trim().max(100).default('Asia/Shanghai'),
}).strict();
const nativeStoragePrefixSchema = z.string().trim().max(500).transform(value => value.replace(/^\/+|\/+$/g, ''))
  .refine(value => !/[\x00-\x1f\x7f\\]/.test(value)
    && !value.split('/').some(segment => segment === '.' || segment === '..'));
const nativeStorageSchema = z.union([
  z.object({ mode: z.literal('s3'), driver: z.literal('r2-binding'), prefix: nativeStoragePrefixSchema }).strict(),
  z.object({ mode: z.literal('cloudflare'), driver: z.literal('cloudflare-binding'), prefix: nativeStoragePrefixSchema,
    backend: z.enum(['r2', 'durable-sqlite']).optional() }).strict(),
]);
const payloadSchema = z.object({
  version: z.literal(1), createdAt: timestamp,
  providers: z.array(providerSchema).max(200), models: z.array(modelSchema).max(1000),
  prompts: z.array(promptSchema).max(500), schedules: z.array(scheduleSchema).max(500),
  settings: z.object({ retentionDays: retention, maxRetries: z.number().int().min(0).max(10).default(5),
    requestTimeoutSeconds: z.number().int().min(MIN_REQUEST_TIMEOUT_SECONDS).max(MAX_REQUEST_TIMEOUT_SECONDS).default(DEFAULT_REQUEST_TIMEOUT_SECONDS) }).strict(), storage: z.unknown(),
}).strict();
const envelopeSchema = z.object({
  format: z.literal('model-lab-config'), version: z.literal(1), cipher: z.literal('aes-256-gcm'),
  kdf: z.object({ name: z.literal('scrypt'), N: z.literal(32768), r: z.literal(8), p: z.literal(1), keyLength: z.literal(32) }).strict(),
  salt: z.string().length(44), iv: z.string().length(16), tag: z.string().length(24),
  ciphertext: z.string().min(4).max(4 * Math.ceil(MAX_PLAINTEXT_BYTES / 3)),
}).strict();
type BackupSchedule = Omit<z.infer<typeof scheduleSchema>, keyof ReturnType<typeof normalizeScheduleTiming>> & ReturnType<typeof normalizeScheduleTiming>;
type ConfigPayload = Omit<z.infer<typeof payloadSchema>, 'storage' | 'schedules'> & {
  storage: ArtifactConfiguration; schedules: BackupSchedule[];
};

export class ConfigBackupError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ConfigBackupError'; }
}
const invalidBackup = () => new ConfigBackupError(400, '备份文件无效或不兼容，请选择完整的本站加密配置文件。');
const passwordSchema = z.string().min(CONFIG_BACKUP_MIN_PASSWORD_LENGTH).max(CONFIG_BACKUP_MAX_PASSWORD_LENGTH);
function requirePassword(value: unknown): string {
  const parsed = passwordSchema.safeParse(value);
  if (!parsed.success) throw new ConfigBackupError(400, '备份密码须为 10 至 1024 个字符。');
  return parsed.data;
}
function requireSize(value: unknown, maximum: number) {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw invalidBackup(); }
  if (serialized === undefined) throw invalidBackup();
  if (Buffer.byteLength(serialized, 'utf8') > maximum) throw new ConfigBackupError(413, '配置备份超过大小限制，请减少配置数量或内容长度。');
}
function decodeBase64(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalidBackup();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)) throw invalidBackup();
  return bytes;
}
function validatePayload(input: unknown): ConfigPayload {
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) throw invalidBackup();
  const payload = parsed.data;
  let storage: ArtifactConfiguration;
  try {
    const native = nativeStorageSchema.safeParse(payload.storage);
    storage = native.success ? native.data : validateStorageImport(payload.storage);
  } catch { throw invalidBackup(); }
  let schedules: BackupSchedule[];
  try { schedules = payload.schedules.map(schedule => ({ ...schedule, ...normalizeScheduleTiming(schedule) })); }
  catch { throw invalidBackup(); }
  const ids = (items: { id: string }[]) => {
    const result = new Set(items.map(item => item.id));
    if (result.size !== items.length) throw invalidBackup();
    return result;
  };
  const providers = ids(payload.providers); const models = ids(payload.models); const prompts = ids(payload.prompts);
  ids(schedules);
  if (payload.models.some(model => !providers.has(model.providerId))) throw invalidBackup();
  for (const schedule of schedules) {
    if (new Set(schedule.modelIds).size !== schedule.modelIds.length || new Set(schedule.promptIds).size !== schedule.promptIds.length
      || schedule.modelIds.length * schedule.promptIds.length > 50
      || schedule.modelIds.some(modelId => !models.has(modelId)) || schedule.promptIds.some(promptId => !prompts.has(promptId))) throw invalidBackup();
  }
  return { ...payload, storage, schedules };
}

let activeOperations = 0;
async function withOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeOperations >= 2) throw new ConfigBackupError(429, '配置备份正在处理，请稍后重试。');
  activeOperations++;
  try { return await operation(); }
  catch (error) {
    if (error instanceof ConfigBackupError) throw error;
    throw new ConfigBackupError(500, '配置备份处理失败，未修改目标配置，请稍后重试。');
  } finally { activeOperations--; }
}
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KDF.keyLength,
    { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}
function counts(payload: ConfigPayload): ConfigBackupCounts {
  return { providers: payload.providers.length, models: payload.models.length, prompts: payload.prompts.length, schedules: payload.schedules.length };
}

async function decryptConfig(password: unknown, backup: unknown): Promise<ConfigPayload> {
  const secret = requirePassword(password);
  requireSize(backup, CONFIG_BACKUP_MAX_BYTES);
  const parsed = envelopeSchema.safeParse(backup);
  if (!parsed.success) throw invalidBackup();
  const envelope = parsed.data;
  const salt = decodeBase64(envelope.salt, 32), iv = decodeBase64(envelope.iv, 12), tag = decodeBase64(envelope.tag, 16);
  const ciphertext = decodeBase64(envelope.ciphertext);
  if (ciphertext.byteLength > MAX_PLAINTEXT_BYTES) throw new ConfigBackupError(413, '配置备份超过大小限制。');
  const key = await deriveKey(secret, salt);
  let plaintext: Buffer | undefined;
  try {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(AAD); decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch { throw new ConfigBackupError(400, '无法解密备份，请检查密码或文件是否完整。'); }
    if (!plaintext) throw invalidBackup();
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(plaintext).toString('utf8')); } catch { throw invalidBackup(); }
    return validatePayload(payload);
  } finally { key.fill(0); plaintext?.fill(0); }
}

/** Only the encrypted envelope leaves this function; credentials stay in server memory. */
export function exportConfig(store: Store, artifacts: ArtifactRepository, password: unknown): Promise<ConfigBackupEnvelope> {
  return withOperation(async () => {
    const secret = requirePassword(password);
    const settings = store.settings();
    const raw = {
      version: 1, createdAt: new Date().toISOString(),
      providers: store.all<StoredProvider>('providers').map(provider => ({
        id: provider.id, name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol, enabled: provider.enabled,
        retentionDays: provider.retentionDays ?? null, apiKey: store.decrypt(provider.encryptedApiKey), createdAt: provider.createdAt,
      })),
      models: store.all<Model>('models').map(model => ({ id: model.id, providerId: model.providerId, name: model.name, modelId: model.modelId,
        enabled: model.enabled, maxTokens: model.maxTokens, reasoningEffort: model.reasoningEffort, createdAt: model.createdAt })),
      prompts: store.all<Prompt>('prompts').map(prompt => ({ id: prompt.id, title: prompt.title, description: prompt.description,
        category: prompt.category, content: prompt.content, referenceAnswer: prompt.referenceAnswer, rubric: prompt.rubric,
        tags: prompt.tags, enabled: prompt.enabled, createdAt: prompt.createdAt, updatedAt: prompt.updatedAt })),
      schedules: store.all<Schedule>('schedules').map(schedule => ({ id: schedule.id, name: schedule.name, promptIds: schedule.promptIds,
        modelIds: schedule.modelIds, intervalMinutes: schedule.intervalMinutes, enabled: schedule.enabled, createdAt: schedule.createdAt,
        scheduleType: schedule.scheduleType ?? 'interval', cronExpression: schedule.cronExpression ?? '', timezone: schedule.timezone ?? 'Asia/Shanghai' })),
      settings: { retentionDays: settings.retentionDays, maxRetries: settings.maxRetries,
        requestTimeoutSeconds: settings.requestTimeoutSeconds }, storage: artifacts.exportConfiguration(),
    };
    requireSize(raw, MAX_PLAINTEXT_BYTES);
    const payload = validatePayload(raw);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const salt = randomBytes(32), iv = randomBytes(12);
    const key = await deriveKey(secret, salt);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { format: 'model-lab-config', version: 1, cipher: 'aes-256-gcm', kdf: { ...KDF },
        salt: Buffer.from(salt).toString('base64'), iv: Buffer.from(iv).toString('base64'), tag: Buffer.from(cipher.getAuthTag()).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') };
    } finally { key.fill(0); plaintext.fill(0); }
  });
}

export function previewConfig(password: unknown, backup: unknown): Promise<{ preview: ConfigBackupPreview }> {
  return withOperation(async () => {
    const payload = await decryptConfig(password, backup);
    return { preview: { ...counts(payload), retentionDays: payload.settings.retentionDays, maxRetries: payload.settings.maxRetries,
      requestTimeoutSeconds: payload.settings.requestTimeoutSeconds,
      storageMode: payload.storage.mode, createdAt: payload.createdAt,
      scheduleDetails: payload.schedules.map(schedule => ({ name: schedule.name, scheduleType: schedule.scheduleType,
        intervalMinutes: schedule.intervalMinutes, cronExpression: schedule.cronExpression, timezone: schedule.timezone })) } };
  });
}

export function importConfig(store: Store, artifacts: ArtifactRepository, password: unknown, backup: unknown): Promise<ConfigBackupImportResult> {
  return withOperation(async () => {
    const payload = await decryptConfig(password, backup);
    const mapping = (items: { id: string }[]) => new Map(items.map(item => [item.id, randomUUID()]));
    const providerIds = mapping(payload.providers), modelIds = mapping(payload.models), promptIds = mapping(payload.prompts);
    // Build every new value, credential ciphertext and relationship before the first write.
    const providers: StoredProvider[] = payload.providers.map(({ apiKey, ...provider }) => ({ ...provider,
      id: providerIds.get(provider.id)!, encryptedApiKey: store.encrypt(apiKey) }));
    const models: Model[] = payload.models.map(model => ({ ...model, id: modelIds.get(model.id)!, providerId: providerIds.get(model.providerId)! }));
    const prompts: Prompt[] = payload.prompts.map(prompt => ({ ...prompt, id: promptIds.get(prompt.id)! }));
    const now = Date.now();
    const schedules: Schedule[] = payload.schedules.map(schedule => ({ ...schedule, id: randomUUID(),
      promptIds: schedule.promptIds.map(id => promptIds.get(id)!), modelIds: schedule.modelIds.map(id => modelIds.get(id)!),
      enabled: false, lastRunAt: null, lastError: '', nextRunAt: nextScheduleRunAt(schedule, now) }));
    store.transaction(() => {
      for (const provider of providers) store.put('providers', provider);
      for (const model of models) store.put('models', model);
      for (const prompt of prompts) store.put('prompts', prompt);
      for (const schedule of schedules) store.put('schedules', schedule);
      store.saveSettings(payload.settings);
      artifacts.importConfigurationInTransaction(payload.storage);
    });
    return { imported: counts(payload) };
  });
}
