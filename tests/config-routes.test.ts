import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { CONFIG_BACKUP_MAX_BYTES } from '../shared/config-backup.ts';

test('configuration routes require admin and Origin, return only ciphertext, and import with safe defaults', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'model-lab-config-routes-'));
  const token = 'route-test-admin-secret';
  const password = 'route-backup-password-12345';
  const providerSecret = 'sk-route-only-secret-never-public';
  const application = createApp({ dataDir: directory, adminToken: token, seed: false });
  const server = createServer(application.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  t.after(async () => {
    await application.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(cookie && { Cookie: cookie }), 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  for (const action of ['export', 'preview', 'import']) {
    assert.equal((await request(`/api/admin/config/${action}`, { password })).status, 401);
  }
  // Backup bodies are not parsed before session authorization.
  assert.equal((await request('/api/admin/config/import', { payload: 'x'.repeat(CONFIG_BACKUP_MAX_BYTES + 1) })).status, 401);
  const login = await request('/api/auth/login', { token });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request('/api/admin/config/export', { password }, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await request('/api/admin/config/export')).status, 404);
  const provider = await request('/api/admin/providers', {
    name: '可迁移的测试接口', baseUrl: 'https://example.invalid/v1', protocol: 'responses', apiKey: providerSecret,
  });
  assert.equal(provider.status, 201);
  const originalId = (await provider.json()).provider.id;
  const exported = await request('/api/admin/config/export', { password });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('cache-control')!, /no-store/);
  assert.match(exported.headers.get('content-disposition')!, /^attachment;/);
  const text = await exported.text();
  for (const secret of [token, password, providerSecret]) assert.ok(!text.includes(secret));
  const backup = JSON.parse(text);
  assert.equal(backup.format, 'model-lab-config');
  const wrong = await request('/api/admin/config/preview', { password: 'incorrect-password-value', backup });
  assert.equal(wrong.status, 400);
  assert.ok(!(await wrong.text()).includes(providerSecret));
  const preview = await request('/api/admin/config/preview', { password, backup });
  assert.equal(preview.status, 200);
  const summary = await preview.json();
  assert.equal(summary.preview.providers, 1);
  assert.ok(!JSON.stringify(summary).includes(providerSecret));
  const imported = await request('/api/admin/config/import', { password, backup });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).imported.providers, 1);
  const admin = await (await request('/api/admin/data')).json();
  assert.equal(admin.providers.length, 2);
  assert.ok(admin.providers.some((p: { id: string }) => p.id === originalId));
  assert.ok(admin.providers.every((p: { hasApiKey: boolean }) => p.hasApiKey));
  assert.ok(!JSON.stringify(admin).includes(providerSecret));
  const publicData = await (await request('/api/public/data', undefined, { Cookie: '' })).text();
  assert.ok(!publicData.includes(providerSecret));
  assert.ok(!publicData.includes('encryptedApiKey'));
  // Only backup routes may exceed the normal 1 MiB JSON limit.
  const larger = { password, backup: { ciphertext: 'x'.repeat(1024 * 1024 + 100) } };
  assert.equal((await request('/api/admin/config/preview', larger)).status, 400);
  assert.equal((await request('/api/admin/providers', larger)).status, 413);
  assert.equal((await request('/api/admin/config/preview', { password, backup: 'x'.repeat(CONFIG_BACKUP_MAX_BYTES) })).status, 413);
});
