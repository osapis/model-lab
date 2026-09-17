import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { providerDto, runDto, Store, type StoredProvider, type StoredRun } from '../server/store.ts';

test('provider DTO exposes only configured public fields even when internal credentials are added', () => {
  const decryptor = { decrypt: () => 'test-provider-key-with-hidden-middle-12345' };
  const provider = {
    id: 'provider', name: '接口', baseUrl: 'https://api.example.invalid/v1', protocol: 'responses',
    enabled: true, createdAt: '2026-09-13T00:00:00Z', encryptedApiKey: 'encrypted-provider-secret',
    apiKey: 'unknown-provider-secret', credentials: { apiKey: 'nested-provider-secret' },
    privateConfig: { secret: 'future-provider-secret' },
  } satisfies StoredProvider & Record<string, unknown>;
  assert.deepEqual(providerDto(provider, decryptor), {
    id: provider.id, name: provider.name, baseUrl: provider.baseUrl, protocol: 'responses',
    simulateCodexClient: false, enabled: true, createdAt: provider.createdAt,
    retentionDays: null, hasApiKey: true, apiKeyPreview: 'test...12345',
  });
  assert.equal(providerDto({ ...provider, encryptedApiKey: '', retentionDays: 7 }, decryptor).hasApiKey, false);
  assert.equal(providerDto({ ...provider, retentionDays: 7 }, decryptor).retentionDays, 7);
});

test('saved key previews mask long keys, fully hide short keys, and survive corrupted ciphertext', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-key-preview-security-'));
  const store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const base: StoredProvider = { id: 'provider', name: '接口', baseUrl: 'https://api.example.invalid/v1', protocol: 'responses',
    enabled: true, createdAt: '2026-09-13T00:00:00Z', encryptedApiKey: '' };
  const cases = [
    ['sk-TEST1-synthetic-fixture-only-TAIL5', 'sk-TEST...TAIL5'],
    ['abcd-private-middle-for-test-12345', 'abcd...12345'],
    ['sk-123456789012', '••••••••'], ['sk-1234567890123', 'sk-1234...90123'],
    ['123456789012', '••••••••'], ['1234567890123', '1234...90123'],
    ['sk-short', '••••••••'], ['tiny', '••••••••'], ['', ''],
  ];
  for (const [key, expected] of cases) {
    const provider = { ...base, encryptedApiKey: store.encrypt(key!) };
    const dto = providerDto(provider, store);
    assert.equal(dto.apiKeyPreview, expected);
    assert.equal(dto.hasApiKey, Boolean(key));
    if (key) assert.equal(JSON.stringify(dto).includes(key), false);
    store.put('providers', { ...provider, apiKeyPreview: 'stale-derived-preview' });
    const persisted = store.db.prepare('SELECT data FROM providers WHERE id = ?').get(base.id)!;
    assert.equal((persisted.data as string).includes('apiKeyPreview'), false);
    assert.equal((persisted.data as string).includes('stale-derived-preview'), false);
  }
  const broken = providerDto({ ...base, encryptedApiKey: 'corrupted-ciphertext' }, store);
  assert.equal(broken.hasApiKey, true);
  assert.equal(broken.apiKeyPreview, '');
  assert.equal(JSON.stringify(broken).includes('corrupted-ciphertext'), false);
});

test('run DTO drops private fields and nested credentials without rewriting historical public parameters', () => {
  const run = {
    id: 'run', batchId: 'batch', promptId: 'prompt', modelId: 'model',
    providerName: '接口', modelName: '模型', modelSlug: 'mock-model', promptTitle: '题目', promptContent: '原始提示词',
    category: 'reasoning', referenceAnswer: '参考答案', rubric: '', status: 'failed', source: 'api', sourceLabel: 'API 实测',
    output: 'private-unhydrated-output', html: 'private-unhydrated-html', reasoning: 'private-unhydrated-reasoning',
    error: '上游 HTTP 400', latencyMs: 120, inputTokens: 20, outputTokens: 5, requestTimeoutSeconds: 720,
    createdAt: '2026-09-13T00:00:00Z', finishedAt: '2026-09-13T00:00:01Z',
    parameters: { protocol: 'responses', maxTokens: 128, reasoningEffort: 'minimal',
      apiKey: 'parameter-api-secret', credentials: { secret: 'parameter-nested-secret' }, temperature: 0.1 },
    execution: { providerId: 'provider', baseUrl: 'https://private-api.example.invalid/v1', encryptedApiKey: 'execution-secret',
      protocol: 'responses', modelId: 'mock-model', maxTokens: 128, reasoningEffort: 'minimal' },
    artifact: { storage: 's3', key: 'private-object-key', configId: 'private-config-id', sizeBytes: 1 },
    pendingArtifactDeletes: [{ storage: 's3', key: 'pending-private-object', configId: 'private-config-id', sizeBytes: 1 }],
    apiKey: 'unknown-run-secret', credentials: { secret: 'nested-run-secret' },
    scheduleId: 'schedule', artifactAvailable: true, artifactExpiresAt: '2026-10-13T00:00:01Z',
    artifactStorage: 's3', hasHtml: false, cleanupError: '等待清理', score: 10, published: false,
  } satisfies StoredRun & Record<string, unknown> & { parameters: StoredRun['parameters'] & Record<string, unknown> };
  const safe = runDto(run);
  const serialized = JSON.stringify(safe);
  for (const fragment of ['secret', 'private-', 'apiKey', 'credentials', 'encryptedApiKey', 'execution', 'pendingArtifactDeletes', 'temperature', 'published', 'score']) {
    assert.equal(serialized.includes(fragment), false, `Public DTO must omit ${fragment}`);
  }
  assert.deepEqual(safe.parameters, { protocol: 'responses', maxTokens: 128, reasoningEffort: 'minimal' });
  assert.equal(safe.providerId, 'provider');
  assert.equal(safe.promptContent, run.promptContent);
  assert.equal(safe.status, 'failed');
  assert.equal(safe.requestTimeoutSeconds, 720);
  assert.equal(safe.error, run.error);
  assert.equal(safe.scheduleId, 'schedule');
  assert.equal(safe.cleanupError, '等待清理');
  assert.equal(safe.artifactAvailable, true);
  assert.equal(safe.artifactStorage, 's3');
  assert.equal(safe.artifactExpiresAt, run.artifactExpiresAt);
  assert.equal(safe.output, ''); assert.equal(safe.html, ''); assert.equal(safe.reasoning, '');
  assert.equal(run.parameters.reasoningEffort, 'minimal');
  const malformed = { ...run, parameters: { protocol: { apiKey: 'secret' }, maxTokens: { secret: true }, reasoningEffort: { secret: true } } };
  assert.deepEqual(runDto(malformed as unknown as StoredRun).parameters, {});
  for (const requestTimeoutSeconds of [0, -1, Infinity, '720', { apiKey: 'timeout-secret' }]) {
    assert.equal(runDto({ ...run, requestTimeoutSeconds } as unknown as StoredRun).requestTimeoutSeconds, undefined);
  }
});

test('settings expose only valid retention, retry and timeout values and never arbitrary stored secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-settings-security-'));
  const store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(store.settings(), { retentionDays: 30, maxRetries: 5, requestTimeoutSeconds: 600 });
  const write = store.db.prepare("INSERT INTO settings(id, data) VALUES ('global', ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data");
  for (const [retentionDays, expected] of [[7, 7], [3650, 3650], [0, 30], [3651, 30], ['7', 30], [{ apiKey: 'nested-settings-secret' }, 30]]) {
    write.run(JSON.stringify({ retentionDays, apiKey: 'settings-secret', credentials: { secret: 'future-settings-secret' } }));
    assert.deepEqual(store.settings(), { retentionDays: expected, maxRetries: 5, requestTimeoutSeconds: 600 });
  }
  for (const [maxRetries, expected] of [[0, 0], [10, 10], [-1, 5], [11, 5], ['7', 5], [{ apiKey: 'nested-settings-secret' }, 5]]) {
    write.run(JSON.stringify({ retentionDays: 7, maxRetries, apiKey: 'settings-secret' }));
    assert.deepEqual(store.settings(), { retentionDays: 7, maxRetries: expected, requestTimeoutSeconds: 600 });
  }
  for (const [requestTimeoutSeconds, expected] of [[30, 30], [720, 720], [29, 600], [721, 600], [30.5, 600], ['600', 600], [{ apiKey: 'nested-settings-secret' }, 600]]) {
    write.run(JSON.stringify({ retentionDays: 7, maxRetries: 2, requestTimeoutSeconds, apiKey: 'settings-secret' }));
    assert.deepEqual(store.settings(), { retentionDays: 7, maxRetries: 2, requestTimeoutSeconds: expected });
  }
});
