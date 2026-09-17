import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ArtifactStore, type ArtifactRef } from '../server/artifacts.ts';
import { ConfigBackupError, exportConfig, importConfig, previewConfig } from '../server/config-backup.ts';
import { Store, type StoredProvider, type StoredRun } from '../server/store.ts';
import { CONFIG_BACKUP_MAX_BYTES, type ConfigBackupEnvelope } from '../shared/config-backup.ts';
import type { Model, Prompt, Schedule } from '../shared/types.ts';

const PASSWORD = '  配置迁移 secret password  ';
const API_SECRET = 'sk-backup-source-secret-a07f82';
const ACCESS_SECRET = 'r2-backup-access-key-9acf31';
const STORAGE_SECRET = 'r2-backup-secret-key-4cbfe3';
const ADMIN_SECRET = 'admin-token-excluded-from-backup-842c7';
const BODY_SENTINEL = 'GENERATED_BODY_EXCLUDED_FROM_CONFIGURATION_182dfe';
const CREATED_AT = '2026-09-13T00:00:00.000Z';
const COUNTS = { providers: 1, models: 1, prompts: 1, schedules: 1 };
// The envelope header is authenticated in addition to the encrypted payload.
const AAD = Buffer.from('model-lab-config:v1:aes-256-gcm:scrypt:N32768:r8:p1:key32');

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'model-lab-config-test-'));
  const store = new Store(dataDir, ADMIN_SECRET);
  const artifacts = new ArtifactStore(store);
  t.after(async () => {
    await artifacts.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, artifacts };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Payload = Record<string, unknown> & {
  version: 1; createdAt: string;
  providers: Record<string, unknown>[]; models: Record<string, unknown>[];
  prompts: Record<string, unknown>[]; schedules: Record<string, unknown>[];
  settings: { retentionDays: number; maxRetries?: number; requestTimeoutSeconds?: number }; storage: Record<string, unknown>;
};

function configure(f: Fixture, prefix = 'source') {
  const provider: StoredProvider = {
    id: randomUUID(), name: `${prefix} API`, baseUrl: 'https://api.example.invalid/v1',
    protocol: 'responses', simulateCodexClient: true, enabled: true, createdAt: CREATED_AT, retentionDays: 9,
    encryptedApiKey: f.store.encrypt(API_SECRET),
  };
  const model: Model = {
    id: randomUUID(), providerId: provider.id, name: `${prefix} 模型`, modelId: 'gpt-6',
    enabled: true, maxTokens: 8192, reasoningEffort: 'max', createdAt: CREATED_AT,
  };
  const prompt: Prompt = {
    id: randomUUID(), title: `${prefix} 鹈鹕测试`, description: '保留自定义提示词', category: 'visual',
    content: '\n创建一个 HTML，内容是SVG绘制一个鹈鹕骑自行车的 2D 动画 禁止测试\n保留  两个空格。\n',
    referenceAnswer: '', rubric: '', tags: ['SVG', '动画'], enabled: true,
    createdAt: CREATED_AT, updatedAt: CREATED_AT,
  };
  const schedule: Schedule = {
    id: randomUUID(), name: `${prefix} 定时测试`, promptIds: [prompt.id], modelIds: [model.id],
    intervalMinutes: 17, enabled: true, lastRunAt: CREATED_AT,
    nextRunAt: '2099-09-13T00:00:00.000Z', lastError: '旧计划运行错误不得迁移', createdAt: CREATED_AT,
  };
  f.store.put('providers', provider);
  f.store.put('models', model);
  f.store.put('prompts', prompt);
  f.store.put('schedules', schedule);
  f.store.saveSettings({ retentionDays: 17, maxRetries: 5 });
  return { provider, model, prompt, schedule };
}

function useCloud(f: Fixture, prefix = 'source') {
  f.artifacts.configure({
    mode: 's3', endpoint: `https://${prefix}.r2.cloudflarestorage.com`, region: 'auto',
    bucket: `${prefix}-results`, prefix: 'generated/results', accessKeyId: ACCESS_SECRET,
    secretAccessKey: STORAGE_SECRET,
  });
}

function insertHistoricalRun(f: Fixture, entities: ReturnType<typeof configure>, artifact: ArtifactRef) {
  const { provider, model, prompt } = entities;
  const run: StoredRun = {
    id: randomUUID(), batchId: randomUUID(), promptId: prompt.id, modelId: model.id, providerId: provider.id,
    providerName: provider.name, modelName: model.name, modelSlug: model.modelId,
    promptTitle: prompt.title, promptContent: prompt.content, category: prompt.category,
    referenceAnswer: '', rubric: '', status: 'completed', source: 'api', sourceLabel: 'API 实测',
    output: '', html: '', reasoning: '', error: '', latencyMs: 12, inputTokens: 12, outputTokens: 50,
    createdAt: CREATED_AT, finishedAt: CREATED_AT, parameters: { reasoningEffort: 'max' }, artifact,
    execution: { providerId: provider.id, baseUrl: provider.baseUrl, protocol: provider.protocol,
      encryptedApiKey: provider.encryptedApiKey, modelId: model.modelId, maxTokens: model.maxTokens, reasoningEffort: 'max' },
  };
  f.store.put('runs', run);
  return run;
}

function snapshot(f: Fixture) {
  return JSON.stringify(['providers', 'models', 'prompts', 'runs', 'schedules', 'settings', 'artifact_configs', 'artifact_pending', 'sessions']
    .map((table) => [table, f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

async function localContents(directory: string): Promise<string> {
  const files = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(files.map((entry) => entry.isDirectory()
    ? localContents(join(directory, entry.name)) : readFile(join(directory, entry.name), 'utf8')))).join('\n');
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}

async function decrypt(backup: ConfigBackupEnvelope, password = PASSWORD): Promise<Payload> {
  const key = await derive(password, Buffer.from(backup.salt, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(backup.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(backup.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(backup.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as Payload;
}

async function encrypt(payload: unknown, password = PASSWORD): Promise<ConfigBackupEnvelope> {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await derive(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: 'model-lab-config', version: 1, cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 32 },
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
  };
}

function rejectsWithStatus(status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof ConfigBackupError);
    assert.equal(error.status, status);
    for (const secret of [PASSWORD, API_SECRET, ACCESS_SECRET, STORAGE_SECRET, ADMIN_SECRET]) {
      assert.ok(!error.message.includes(secret), 'Error messages must not echo secrets');
    }
    return true;
  };
}

test('encrypted configuration transfers credentials and remaps IDs across distinct installation keys', async (t) => {
  const source = await fixture(t);
  const original = configure(source);
  source.store.saveSettings({ retentionDays: 17, maxRetries: 7, requestTimeoutSeconds: 720 });
  useCloud(source);
  const bodyRef = source.artifacts.putMemory('source-body', { output: BODY_SENTINEL, html: '', reasoning: '' });
  insertHistoricalRun(source, original, bodyRef);
  const backup = await exportConfig(source.store, source.artifacts, PASSWORD);
  assert.equal(backup.format, 'model-lab-config');
  assert.deepEqual(backup.kdf, { name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 32 });
  for (const [name, size] of [['salt', 32], ['iv', 12], ['tag', 16]] as const) {
    assert.equal(Buffer.from(backup[name], 'base64').byteLength, size);
    assert.equal(Buffer.from(backup[name], 'base64').toString('base64'), backup[name]);
  }
  const preview = await previewConfig(PASSWORD, backup);
  assert.deepEqual(preview.preview, { ...COUNTS, retentionDays: 17, maxRetries: 7, requestTimeoutSeconds: 720, storageMode: 's3', createdAt: preview.preview.createdAt,
    scheduleDetails: [{ name: original.schedule.name, scheduleType: 'interval', intervalMinutes: 17, cronExpression: '', timezone: 'Asia/Shanghai' }] });
  assert.ok(Number.isFinite(Date.parse(preview.preview.createdAt)));
  const payload = await decrypt(backup);
  assert.deepEqual(payload.settings, { retentionDays: 17, maxRetries: 7, requestTimeoutSeconds: 720 });
  assert.equal(payload.providers[0]!.apiKey, API_SECRET);
  assert.equal(payload.providers[0]!.simulateCodexClient, true);
  assert.equal(payload.storage.accessKeyId, ACCESS_SECRET);
  assert.equal(payload.storage.secretAccessKey, STORAGE_SECRET);
  assert.deepEqual(Object.keys(payload).sort(), ['createdAt', 'models', 'prompts', 'providers', 'schedules', 'settings', 'storage', 'version']);
  for (const field of ['lastRunAt', 'nextRunAt', 'lastError', 'autoPublish']) assert.equal(field in payload.schedules[0]!, false);
  for (const field of ['id', 'memoryUsedMb', 'hasSecretAccessKey']) assert.equal(field in payload.storage, false);
  assert.ok(!JSON.stringify(payload).includes(BODY_SENTINEL));
  assert.ok(!JSON.stringify(payload).includes(ADMIN_SECRET));

  const target = await fixture(t);
  const existing = configure(target, 'existing');
  useCloud(target, 'existing');
  const oldCloudRow = target.store.db.prepare('SELECT * FROM artifact_configs WHERE is_current = 1').get()!;
  const oldRef: ArtifactRef = { storage: 's3', configId: oldCloudRow.id as string, key: 'history/original.json', sizeBytes: 40 };
  const oldRun = insertHistoricalRun(target, existing, oldRef);
  const oldPending = { ...oldRef, key: 'history/pending-cleanup.json' };
  target.store.db.prepare('INSERT INTO artifact_pending(config_id, object_key, data, created_at) VALUES (?, ?, ?, ?)')
    .run(oldRef.configId!, oldPending.key, JSON.stringify(oldPending), CREATED_AT);
  assert.notDeepEqual(await readFile(join(source.dataDir, 'encryption-key')), await readFile(join(target.dataDir, 'encryption-key')));
  const imported = await importConfig(target.store, target.artifacts, PASSWORD, backup);
  assert.deepEqual(imported, { imported: COUNTS });
  const provider = target.store.all<StoredProvider>('providers').find((item) => item.name === original.provider.name)!;
  const model = target.store.all<Model>('models').find((item) => item.name === original.model.name)!;
  const prompt = target.store.all<Prompt>('prompts').find((item) => item.title === original.prompt.title)!;
  const schedule = target.store.all<Schedule>('schedules').find((item) => item.name === original.schedule.name)!;
  for (const [received, previous] of [[provider, original.provider], [model, original.model], [prompt, original.prompt], [schedule, original.schedule]]) {
    assert.ok(received);
    assert.notEqual(received.id, previous.id, 'Import must generate fresh IDs');
  }
  assert.equal(target.store.decrypt(provider.encryptedApiKey), API_SECRET);
  assert.equal(provider.simulateCodexClient, true);
  assert.notEqual(provider.encryptedApiKey, original.provider.encryptedApiKey);
  assert.equal(model.providerId, provider.id);
  assert.equal(model.reasoningEffort, 'max');
  assert.equal(prompt.content, original.prompt.content);
  assert.deepEqual(schedule.modelIds, [model.id]);
  assert.deepEqual(schedule.promptIds, [prompt.id]);
  assert.equal(schedule.enabled, false, 'Imported schedules must remain paused until explicitly enabled');
  assert.equal(schedule.lastRunAt, null);
  assert.equal(schedule.lastError, '');
  assert.notEqual(schedule.nextRunAt, original.schedule.nextRunAt);
  assert.equal(target.store.get<Schedule>('schedules', existing.schedule.id)?.enabled, true, 'Existing schedules must retain their state');
  assert.deepEqual(target.store.settings(), { retentionDays: 17, maxRetries: 7, requestTimeoutSeconds: 720 });
  assert.equal(target.artifacts.status().endpoint, 'https://source.r2.cloudflarestorage.com');
  const currentConfig = target.store.db.prepare('SELECT id, data FROM artifact_configs WHERE is_current = 1').get()!;
  const importedStorage = JSON.parse(target.store.decrypt(currentConfig.data as string)) as Record<string, unknown>;
  assert.equal(importedStorage.accessKeyId, ACCESS_SECRET);
  assert.equal(importedStorage.secretAccessKey, STORAGE_SECRET);
  assert.notEqual(currentConfig.id, oldCloudRow.id);
  assert.equal(target.store.db.prepare('SELECT data FROM artifact_configs WHERE id = ?').get(oldCloudRow.id)?.data, oldCloudRow.data);
  assert.deepEqual(target.store.get<StoredRun>('runs', oldRun.id)?.artifact, oldRef);
  assert.equal(target.store.all<StoredRun>('runs').length, 1, 'Source history must not be imported');
  assert.equal(target.store.db.prepare('SELECT data FROM artifact_pending WHERE config_id = ?').get(oldRef.configId!)?.data, JSON.stringify(oldPending));
  const visible = JSON.stringify([backup, preview, imported]);
  for (const secret of [PASSWORD, API_SECRET, ACCESS_SECRET, STORAGE_SECRET, ADMIN_SECRET, BODY_SENTINEL]) {
    assert.ok(!visible.includes(secret), 'The envelope and summaries must not disclose secrets or bodies');
  }
  for (const secret of [PASSWORD, API_SECRET, ACCESS_SECRET, STORAGE_SECRET, BODY_SENTINEL]) {
    assert.ok(!(await localContents(target.dataDir)).includes(secret), 'Imported credentials must stay encrypted on disk');
  }
});

test('wrong passwords and modified authenticated envelopes leave the destination unchanged', async (t) => {
  const source = await fixture(t); configure(source); useCloud(source);
  const target = await fixture(t); configure(target, 'existing');
  const backup = await exportConfig(source.store, source.artifacts, PASSWORD);
  const before = snapshot(target);
  await assert.rejects(() => importConfig(target.store, target.artifacts, PASSWORD.trim(), backup), rejectsWithStatus(400));
  const changed = Buffer.from(backup.ciphertext, 'base64'); changed[0] = changed[0]! ^ 1;
  await assert.rejects(() => importConfig(target.store, target.artifacts, PASSWORD,
    { ...backup, ciphertext: changed.toString('base64') }), rejectsWithStatus(400));
  const tag = Buffer.from(backup.tag, 'base64'); tag[0] = tag[0]! ^ 1;
  await assert.rejects(() => previewConfig(PASSWORD, { ...backup, tag: tag.toString('base64') }), rejectsWithStatus(400));
  assert.equal(snapshot(target), before, 'Authentication failure must not insert rows or replace settings/storage');
});

test('password, envelope size, canonical encoding and fixed KDF validation reject unsafe inputs', async (t) => {
  const source = await fixture(t); configure(source);
  await assert.rejects(() => exportConfig(source.store, source.artifacts, 'short'), rejectsWithStatus(400));
  await assert.rejects(() => exportConfig(source.store, source.artifacts, 'a'.repeat(1025)), rejectsWithStatus(400));
  const backup = await exportConfig(source.store, source.artifacts, PASSWORD);
  const variants: unknown[] = [
    { ...backup, kdf: { ...backup.kdf, N: 1 << 29 } },
    { ...backup, kdf: { ...backup.kdf, p: 100 } },
    { ...backup, version: 2 },
    { ...backup, cipher: 'aes-128-gcm' },
    { ...backup, salt: backup.salt + '\n' },
    { ...backup, iv: Buffer.alloc(11).toString('base64') },
    { ...backup, tag: Buffer.alloc(15).toString('base64') },
  ];
  for (const invalid of variants) {
    await assert.rejects(() => previewConfig(PASSWORD, invalid as ConfigBackupEnvelope), rejectsWithStatus(400));
  }
  const oversized = { ...backup, ciphertext: 'A'.repeat(CONFIG_BACKUP_MAX_BYTES) };
  await assert.rejects(() => previewConfig(PASSWORD, oversized), rejectsWithStatus(413));
  const oversizedPlaintext = { ...backup, ciphertext: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64') };
  await assert.rejects(() => previewConfig(PASSWORD, oversizedPlaintext), rejectsWithStatus(413));
});

test('encrypted imports enforce reference integrity before mutating destination records', async (t) => {
  const source = await fixture(t); configure(source); useCloud(source);
  const target = await fixture(t); configure(target, 'existing');
  const backup = await exportConfig(source.store, source.artifacts, PASSWORD);
  const valid = await decrypt(backup);
  const before = snapshot(target);
  const invalidModel = structuredClone(valid);
  invalidModel.models[0]!.providerId = randomUUID();
  const invalidSchedule = structuredClone(valid);
  invalidSchedule.schedules[0]!.modelIds = [randomUUID()];
  const duplicateId = structuredClone(valid);
  duplicateId.providers.push({ ...duplicateId.providers[0]! });
  const invalidPrompt = structuredClone(valid);
  invalidPrompt.schedules[0]!.promptIds = [randomUUID()];
  const duplicateReference = structuredClone(valid);
  duplicateReference.schedules[0]!.modelIds = [valid.models[0]!.id, valid.models[0]!.id];
  const invalidStorage = structuredClone(valid);
  invalidStorage.storage.secretAccessKey = '';
  for (const invalid of [invalidModel, invalidSchedule, duplicateId, invalidPrompt, duplicateReference, invalidStorage]) {
    const encrypted = await encrypt(invalid);
    await assert.rejects(() => importConfig(target.store, target.artifacts, PASSWORD, encrypted), rejectsWithStatus(400));
    assert.equal(snapshot(target), before, 'Invalid links or duplicate IDs must cause no partial import');
  }
});

test('configuration collection and plaintext limits apply before any import or export can complete', async (t) => {
  const source = await fixture(t); const original = configure(source);
  const target = await fixture(t); configure(target, 'existing');
  const backup = await exportConfig(source.store, source.artifacts, PASSWORD);
  const valid = await decrypt(backup);
  const before = snapshot(target);
  for (const [collection, maximum] of [['providers', 200], ['models', 1000], ['prompts', 500], ['schedules', 500]] as const) {
    const invalid = structuredClone(valid);
    invalid[collection] = [valid[collection][0]!, ...Array.from({ length: maximum }, (_, index) => ({
      ...valid[collection][0]!, id: `${collection}-${index}`,
    }))];
    const encrypted = await encrypt(invalid);
    await assert.rejects(() => importConfig(target.store, target.artifacts, PASSWORD, encrypted), rejectsWithStatus(400));
    assert.equal(snapshot(target), before, `${collection} over the collection limit must not be imported`);
  }
  for (let index = 0; index < 45; index++) {
    source.store.put('prompts', { ...original.prompt, id: randomUUID(), content: 'x'.repeat(100000) });
  }
  await assert.rejects(() => exportConfig(source.store, source.artifacts, PASSWORD), rejectsWithStatus(413));
  assert.equal(snapshot(target), before);
});

test('configuration import rolls back all changes when storage persistence fails', async (t) => {
  const source = await fixture(t); configure(source); useCloud(source);
  const target = await fixture(t); configure(target, 'existing'); useCloud(target, 'existing');
  target.store.saveSettings({ retentionDays: 99, maxRetries: 3 });
  const backup = await exportConfig(source.store, source.artifacts, PASSWORD);
  target.store.db.exec("CREATE TRIGGER reject_import_storage BEFORE INSERT ON artifact_configs BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQLITE_FAILURE_SENTINEL'); END");
  const before = snapshot(target);
  const previousStatus = target.artifacts.status();
  await assert.rejects(() => importConfig(target.store, target.artifacts, PASSWORD, backup), (error: unknown) => {
    rejectsWithStatus(500)(error);
    assert.ok(!(error as Error).message.includes('PRIVATE_SQLITE_FAILURE_SENTINEL'));
    return true;
  });
  assert.equal(snapshot(target), before, 'Failed storage save must roll back imported rows, retention and current storage');
  assert.deepEqual(target.artifacts.status(), previousStatus, 'ArtifactStore must continue using its original configuration');
});

test('expensive backup cryptography permits two concurrent operations and rejects excess work', async (t) => {
  const source = await fixture(t); configure(source);
  const backup = await exportConfig(source.store, source.artifacts, PASSWORD);
  const results = await Promise.allSettled([
    previewConfig(PASSWORD, backup), previewConfig(PASSWORD, backup), previewConfig(PASSWORD, backup),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  rejectsWithStatus(429)(rejected[0]!.reason);
  assert.deepEqual((await previewConfig(PASSWORD, backup)).preview, {
    ...COUNTS, retentionDays: 17, maxRetries: 5, requestTimeoutSeconds: 600, storageMode: 'memory', createdAt: (results.find((result) => result.status === 'fulfilled')!.value).preview.createdAt,
    scheduleDetails: [{ name: 'source 定时测试', scheduleType: 'interval', intervalMinutes: 17, cronExpression: '', timezone: 'Asia/Shanghai' }],
  }, 'Completed operations must release their concurrency slots');
});

test('version 1 backups without retry or timeout settings import with defaults', async t => {
  const source = await fixture(t); configure(source);
  const target = await fixture(t); configure(target, 'existing');
  target.store.saveSettings({ retentionDays: 99, maxRetries: 7, requestTimeoutSeconds: 30 });
  const current = await exportConfig(source.store, source.artifacts, PASSWORD);
  const legacy = await decrypt(current);
  delete legacy.settings.maxRetries;
  delete legacy.settings.requestTimeoutSeconds;
  const backup = await encrypt(legacy);
  assert.equal(backup.version, 1);
  const { preview } = await previewConfig(PASSWORD, backup);
  assert.equal(preview.maxRetries, 5);
  assert.equal(preview.requestTimeoutSeconds, 600);
  assert.equal(preview.retentionDays, 17);
  await importConfig(target.store, target.artifacts, PASSWORD, backup);
  assert.deepEqual(target.store.settings(), { retentionDays: 17, maxRetries: 5, requestTimeoutSeconds: 600 });
  const reexported = await decrypt(await exportConfig(target.store, target.artifacts, PASSWORD));
  assert.deepEqual(reexported.settings, { retentionDays: 17, maxRetries: 5, requestTimeoutSeconds: 600 });
});

test('backup retry settings accept zero and ten but reject invalid values without modifying the target', async t => {
  const source = await fixture(t); configure(source);
  const target = await fixture(t); configure(target, 'existing');
  const payload = await decrypt(await exportConfig(source.store, source.artifacts, PASSWORD));
  for (const maxRetries of [0, 10]) {
    const backup = await encrypt({ ...payload, settings: { ...payload.settings, maxRetries } });
    assert.equal((await previewConfig(PASSWORD, backup)).preview.maxRetries, maxRetries);
    await importConfig(target.store, target.artifacts, PASSWORD, backup);
    assert.equal(target.store.settings().maxRetries, maxRetries);
  }
  const before = snapshot(target);
  for (const maxRetries of [-1, 11, 1.5, '5', null]) {
    const backup = await encrypt({ ...payload, settings: { ...payload.settings, maxRetries } });
    await assert.rejects(() => importConfig(target.store, target.artifacts, PASSWORD, backup), rejectsWithStatus(400));
    assert.equal(snapshot(target), before);
  }
});

test('backup timeout settings preserve both bounds and reject invalid values before any writes', async t => {
  const source = await fixture(t); configure(source);
  const target = await fixture(t); configure(target, 'existing');
  const payload = await decrypt(await exportConfig(source.store, source.artifacts, PASSWORD));
  for (const requestTimeoutSeconds of [30, 720]) {
    const backup = await encrypt({ ...payload, settings: { ...payload.settings, requestTimeoutSeconds } });
    assert.equal((await previewConfig(PASSWORD, backup)).preview.requestTimeoutSeconds, requestTimeoutSeconds);
    await importConfig(target.store, target.artifacts, PASSWORD, backup);
    assert.equal(target.store.settings().requestTimeoutSeconds, requestTimeoutSeconds);
  }
  const before = snapshot(target);
  for (const requestTimeoutSeconds of [29, 721, 30.5, '600', null]) {
    const backup = await encrypt({ ...payload, settings: { ...payload.settings, requestTimeoutSeconds } });
    await assert.rejects(() => importConfig(target.store, target.artifacts, PASSWORD, backup), rejectsWithStatus(400));
    assert.equal(snapshot(target), before);
  }
});

test('Cron backup preserves expressions and timezones while importing paused plans with matching next occurrences', async t => {
  const source = await fixture(t); const original = configure(source);
  const target = await fixture(t); const existing = configure(target, 'existing');
  const previous = target.store.get<Schedule>('schedules', existing.schedule.id);
  const now = Date.parse('2026-09-14T03:20:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const newYork: Schedule = { ...original.schedule, name: '纽约工作日 09:15', scheduleType: 'cron',
    cronExpression: '15 9 * * 1-5', timezone: 'America/New_York', intervalMinutes: 60 };
  const shanghai: Schedule = { ...original.schedule, id: randomUUID(), name: '上海每两小时', scheduleType: 'cron',
    cronExpression: '0 */2 * * *', timezone: 'Asia/Shanghai', intervalMinutes: 60 };
  source.store.put('schedules', newYork); source.store.put('schedules', shanghai);
  const backup = await exportConfig(source.store, source.artifacts, PASSWORD);
  assert.equal(backup.version, 1);
  const payload = await decrypt(backup);
  const { preview } = await previewConfig(PASSWORD, backup);
  assert.equal(preview.schedules, 2);
  assert.equal(preview.scheduleDetails.length, 2);
  for (const schedule of [newYork, shanghai]) {
    const stored = payload.schedules.find(item => item.id === schedule.id)!;
    assert.equal(stored.scheduleType, 'cron');
    assert.equal(stored.cronExpression, schedule.cronExpression);
    assert.equal(stored.timezone, schedule.timezone);
    assert.deepEqual(preview.scheduleDetails.find(item => item.name === schedule.name), {
      name: schedule.name, scheduleType: 'cron', intervalMinutes: 60,
      cronExpression: schedule.cronExpression, timezone: schedule.timezone,
    });
  }
  await importConfig(target.store, target.artifacts, PASSWORD, backup);
  assert.deepEqual(target.store.get<Schedule>('schedules', existing.schedule.id), previous, 'An existing plan must remain byte-equivalent');
  const schedules = target.store.all<Schedule>('schedules');
  for (const [originalSchedule, expected] of [[newYork, '2026-09-14T13:15:00.000Z'], [shanghai, '2026-09-14T04:00:00.000Z']] as const) {
    const imported = schedules.find(item => item.name === originalSchedule.name)!;
    assert.notEqual(imported.id, originalSchedule.id);
    assert.equal(imported.scheduleType, 'cron');
    assert.equal(imported.cronExpression, originalSchedule.cronExpression);
    assert.equal(imported.timezone, originalSchedule.timezone);
    assert.equal(imported.nextRunAt, expected);
    assert.equal(imported.enabled, false);
    assert.equal(imported.lastRunAt, null);
    assert.equal(imported.lastError, '');
    assert.notEqual(imported.modelIds[0], originalSchedule.modelIds[0]);
    assert.notEqual(imported.promptIds[0], originalSchedule.promptIds[0]);
  }
  const reexported = await decrypt(await exportConfig(target.store, target.artifacts, PASSWORD));
  assert.equal(reexported.schedules.filter(item => item.scheduleType === 'cron').length, 2);
});

test('old v1 schedules without Cron fields remain interval plans and missing Cron timezone defaults to Shanghai', async t => {
  const source = await fixture(t); const original = configure(source);
  const target = await fixture(t);
  const now = Date.parse('2026-09-14T03:20:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const payload = await decrypt(await exportConfig(source.store, source.artifacts, PASSWORD));
  const legacy = payload.schedules[0]!;
  delete legacy.scheduleType; delete legacy.cronExpression; delete legacy.timezone;
  const backup = await encrypt(payload);
  const { preview } = await previewConfig(PASSWORD, backup);
  assert.deepEqual(preview.scheduleDetails, [{ name: original.schedule.name, scheduleType: 'interval',
    intervalMinutes: 17, cronExpression: '', timezone: 'Asia/Shanghai' }]);
  await importConfig(target.store, target.artifacts, PASSWORD, backup);
  const imported = target.store.all<Schedule>('schedules')[0]!;
  assert.equal(imported.scheduleType, 'interval');
  assert.equal(imported.intervalMinutes, 17);
  assert.equal(imported.nextRunAt, '2026-09-14T03:37:00.000Z');
  assert.equal(imported.enabled, false);
  const cronPayload = structuredClone(payload);
  Object.assign(cronPayload.schedules[0]!, { scheduleType: 'cron', cronExpression: '0 */2 * * *' });
  delete cronPayload.schedules[0]!.intervalMinutes;
  const cronBackup = await encrypt(cronPayload);
  const cronPreview = (await previewConfig(PASSWORD, cronBackup)).preview.scheduleDetails[0]!;
  assert.equal(cronPreview.scheduleType, 'cron');
  assert.equal(cronPreview.timezone, 'Asia/Shanghai');
  assert.equal(cronPreview.intervalMinutes, 60);
  await importConfig(target.store, target.artifacts, PASSWORD, cronBackup);
  const cron = target.store.all<Schedule>('schedules').find(item => item.scheduleType === 'cron')!;
  assert.equal(cron.nextRunAt, '2026-09-14T04:00:00.000Z');
  assert.equal(cron.enabled, false);
});

test('invalid Cron expressions and timezones are rejected before preview or import can change configuration', async t => {
  const source = await fixture(t); configure(source);
  const target = await fixture(t); configure(target, 'existing');
  const payload = await decrypt(await exportConfig(source.store, source.artifacts, PASSWORD));
  const before = snapshot(target);
  for (const timing of [
    { scheduleType: 'cron', cronExpression: '', timezone: 'Asia/Shanghai' },
    { scheduleType: 'cron', cronExpression: 'not a valid cron', timezone: 'Asia/Shanghai' },
    { scheduleType: 'cron', cronExpression: '0 0 * * * *', timezone: 'Asia/Shanghai' },
    { scheduleType: 'cron', cronExpression: '0 25 * * *', timezone: 'Asia/Shanghai' },
    { scheduleType: 'cron', cronExpression: '0 9 * * *', timezone: 'Invalid/Secret-Timezone' },
    { scheduleType: 'unknown', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai' },
  ]) {
    const invalid = structuredClone(payload);
    Object.assign(invalid.schedules[0]!, timing);
    const backup = await encrypt(invalid);
    await assert.rejects(() => previewConfig(PASSWORD, backup), rejectsWithStatus(400));
    await assert.rejects(() => importConfig(target.store, target.artifacts, PASSWORD, backup), rejectsWithStatus(400));
    assert.equal(snapshot(target), before);
  }
});
