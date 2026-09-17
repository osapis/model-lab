import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store } from '../server/store.ts';

// The Node store loads its filesystem module through createRequire, so the same
// module instance can be mocked to simulate host filesystems that reject chmod.
const nodeFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

function permissionError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: operation not permitted, chmod`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'model-lab-data-dir-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('data directories on bind mounts tolerate rejected chmod calls', t => {
  const directory = temporaryDirectory(t);
  const chmod = t.mock.method(nodeFs, 'chmodSync', () => { throw permissionError('EPERM'); });
  let first: Store | undefined;
  let second: Store | undefined;
  try {
    first = new Store(directory, 'bind-mount-admin-token');
    assert.equal(first.adminToken, 'bind-mount-admin-token');
    assert.equal(readFileSync(join(directory, 'encryption-key')).byteLength, 32);
    assert.equal(existsSync(join(directory, 'app.db')), true);
    assert.equal(first.settings().retentionDays, 30);

    // Reopening must also succeed when every file already exists.
    second = new Store(directory, 'bind-mount-admin-token');
    assert.equal(second.settings().retentionDays, 30);
  } finally {
    first?.close();
    second?.close();
    // Windows removes read-only files through chmod, so restore before cleanup.
    chmod.mock.restore();
  }
});

test('an unwritable data directory reports the host permission fix', t => {
  const directory = temporaryDirectory(t);
  t.mock.method(nodeFs, 'writeFileSync', () => { throw permissionError('EACCES'); });

  assert.throws(() => new Store(directory, 'bind-mount-admin-token'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /数据目录不可写/);
    assert.ok(error.message.includes(directory), 'the message must name the failing directory');
    return true;
  });
});
