// Runs the real Worker bundle in local workerd. No Cloudflare account or API
// credentials are used, and outbound network access from the Worker is blocked.
// Usage: npm run build && node tools/local-cloudflare-smoke.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'model-lab-workerd-smoke-'));
await chmod(directory, 0o700);
const origin = 'https://model-lab-smoke.example.test';
const password = randomBytes(32).toString('base64url');
const encryptionKey = randomBytes(32).toString('base64');
const apiKey = `sk-${randomBytes(32).toString('hex')}`;
let worker;
let assertions = 0;
let outboundRequests = 0;

function check(value, message) { assert.ok(value, message); assertions++; }
function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLOUDFLARE_|CF_|WRANGLER_)/.test(key)));
}
function createWorker() {
  return new Miniflare(convertV4MiniflareOptions({
    name: 'model-lab-smoke', modules: true, host: '127.0.0.1',
    rootPath: join(directory, 'bundle'), modulesRoot: join(directory, 'bundle'),
    scriptPath: join(directory, 'bundle', 'index.js'),
    compatibilityDate: '2026-09-11', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { LAB: { className: 'ModelLab', useSQLite: true } },
    unsafeInspectDurableObjects: true,
    resourcePersistencePath: join(directory, 'storage'),
    bindings: { ADMIN_TOKEN: password, ENCRYPTION_KEY: encryptionKey, APP_ORIGIN: origin,
      ADDITIONAL_ORIGINS: '', FRESH_INSTALL: 'true', AUTOMATION_ENABLED: 'true' },
    serviceBindings: { ASSETS: () => new Response('<!doctype html><title>Local asset fixture</title>', {
      headers: { 'Content-Type': 'text/html' },
    }) },
    outboundService: () => { outboundRequests++; throw new Error('Unexpected external request during local smoke'); },
    log: new Log(LogLevel.ERROR),
  }));
}
async function request(path, options = {}) {
  return worker.dispatchFetch(origin + path, { ...options,
    headers: { Origin: origin, 'Content-Type': 'application/json', ...options.headers },
  });
}
async function json(path, options) {
  const response = await request(path, options);
  const body = await response.json();
  return { response, body };
}
function noSecrets(body) {
  const text = JSON.stringify(body);
  for (const secret of [password, encryptionKey, apiKey]) check(!text.includes(secret), 'Response must not expose test credentials');
  check(!/"(?:encryptedApiKey|apiKeyPreview|baseUrl|execution)"\s*:/.test(text), 'Public responses must omit private provider fields');
}

try {
  assert.ok(existsSync(join(root, 'dist', 'index.html')), 'Run npm run build before the local Cloudflare smoke test.');
  const build = spawnSync(process.execPath, [join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'deploy', '--config', 'cloudflare/wrangler.jsonc', '--dry-run', '--outdir', join(directory, 'bundle')], {
    cwd: root, encoding: 'utf8', env: { ...cleanEnvironment(), WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  });
  assert.equal(build.status, 0, `Worker dry-run build failed:\n${build.stdout}\n${build.stderr}`);
  worker = createWorker();
  let result = await json('/api/health');
  check(result.response.ok && result.body.ok, 'Fresh Worker health endpoint responds');
  const storage = await worker.unsafeGetDurableObjectStorage('model-lab-smoke', 'ModelLab', { name: 'primary' });
  const bootState = await storage.exec('SELECT data FROM cloud_state WHERE id = ?', 'migration_complete');
  check(bootState[0]?.data === 'true', 'Fresh initialization unlocks automation in actual Durable Object storage');
  result = await json('/api/public/data');
  check(result.response.ok && result.body.prompts.length === 2, 'Fresh Worker initializes two built-in prompts');
  check(result.body.runs.length === 0 && result.body.providers.length === 0 && result.body.models.length === 0, 'Fresh install contains no private configuration or sample runs');
  noSecrets(result.body);
  result = await json('/api/admin/data');
  check(result.response.status === 401, 'Admin data requires authentication');
  result = await json('/api/_migration/status');
  check(result.response.status === 404, 'Fresh installation seals the migration endpoint');
  result = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: password }),
    headers: { Origin: 'https://untrusted.example.test' } });
  check(result.response.status === 403, 'Cross-origin login is rejected');
  result = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: password }) });
  check(result.response.ok, 'Administrator can log in with an explicitly supplied secret');
  const setCookie = result.response.headers.get('set-cookie') || '';
  check(/HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), 'Admin cookie is HttpOnly, Secure and SameSite=Strict');
  const cookie = setCookie.split(';')[0];
  result = await json('/api/admin/providers', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({
    name: 'Synthetic smoke API', baseUrl: 'https://provider.example.invalid/v1', protocol: 'responses', enabled: false, apiKey,
  }) });
  check(result.response.status === 201, 'Authenticated administrator can store a provider');
  check(!JSON.stringify(result.body).includes(apiKey), 'Admin save response masks the complete provider key');
  const providerId = result.body.provider.id;
  result = await json('/api/public/data?smoke=provider');
  check(result.body.providers.some(provider => provider.id === providerId), 'Public data exposes the provider display identity');
  noSecrets(result.body);
  // Let the persisted, one-minute alarm fire in the unmodified Worker. Reading
  // its cleanup marker proves automation ran; a healthy HTTP response alone does not.
  console.log('Waiting for the real local one-minute Durable Object alarm (external API requests are blocked)...');
  const deadline = Date.now() + 75_000;
  let alarmState = [];
  while (Date.now() < deadline) {
    alarmState = await storage.exec("SELECT id,data FROM cloud_state WHERE id IN ('last_cleanup','last_alarm_work')");
    if (alarmState.some(row => row.id === 'last_cleanup' && Number(row.data) > 0)) break;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  check(alarmState.some(row => row.id === 'last_alarm_work' && row.data === 'cleanup'), 'Fresh Worker actually executes its scheduled alarm');
  check(alarmState.some(row => row.id === 'last_cleanup' && Number(row.data) > 0), 'Scheduled cleanup completes without external API calls');
  await worker.dispose();
  worker = createWorker();
  result = await json('/api/admin/data', { headers: { Cookie: cookie } });
  check(result.response.ok, 'Administrator session survives a restart with unchanged credentials');
  check(result.body.providers.some(provider => provider.id === providerId && provider.hasApiKey), 'Stored encrypted provider survives a Durable Object restart');
  check(result.body.prompts.length === 2 && result.body.models.length === 0 && result.body.schedules.length === 0,
    'Restart does not duplicate seeds or add schedules');
  result = await json('/api/public/data?smoke=restarted');
  noSecrets(result.body);
  result = await json('/api/_migration/status');
  check(result.response.status === 404, 'Migration remains sealed after restart');
  check(outboundRequests === 0, 'The smoke test makes no external API requests');
  console.log(`Local Cloudflare workerd smoke passed: ${assertions} assertions, fresh bootstrap, real alarm execution, auth, private fields and persistent restart.`);
} finally {
  await worker?.dispose();
  await rm(directory, { recursive: true, force: true });
}
