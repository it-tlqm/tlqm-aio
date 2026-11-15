import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { acquireLmsStorage, unlockLmsStorage } from '../scripts/lms-storage-lock.js';
import { startLocalLms } from '../scripts/lms-local.js';
const path = '.local/lms/test/storage.lock.json';
test('Real local Worker storage is exclusive, cannot be unlocked while alive, and old dispose cannot remove a newer lock', async () => {
  let first: Awaited<ReturnType<typeof startLocalLms>> | undefined,
    second: Awaited<ReturnType<typeof startLocalLms>> | undefined;
  try {
    first = await startLocalLms(true, 0);
    const old = JSON.parse(await readFile(path, 'utf8')) as { nonce: string };
    await assert.rejects(() => startLocalLms(true, 0), /storage is locked/);
    await assert.rejects(() => unlockLmsStorage('test'), /still running/);
    await first.mf.dispose();
    second = await startLocalLms(true, 0);
    const current = await readFile(path, 'utf8');
    assert.notEqual(JSON.parse(current).nonce, old.nonce);
    await first.mf.dispose();
    assert.equal(await readFile(path, 'utf8'), current);
  } finally {
    await first?.mf.dispose();
    await second?.mf.dispose();
  }
  await assert.rejects(() => readFile(path), { code: 'ENOENT' });
});
test('Only an explicit unlock for a proven exited process removes a valid lock; unidentified locks are retained', async () => {
  const lease = await acquireLmsStorage('test');
  await lease.release();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const childPid = child.pid;
  assert.ok(childPid);
  await once(child, 'exit');
  const record =
    JSON.stringify({
      version: 1,
      purpose: 'tlqm-aio-lms-test',
      pid: childPid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    }) + '\n';
  await writeFile(path, record, { flag: 'wx', mode: 0o600 });
  await assert.rejects(() => acquireLmsStorage('test'), /storage is locked/);
  assert.equal(await readFile(path, 'utf8'), record);
  await unlockLmsStorage('test');
  await assert.rejects(() => readFile(path), { code: 'ENOENT' });
  const unknown = JSON.stringify({ purpose: 'unknown', testOwner: 'lms-storage-lock.test' });
  await writeFile(path, unknown, { flag: 'wx', mode: 0o600 });
  try {
    await assert.rejects(() => unlockLmsStorage('test'), /Unidentified storage lock/);
    assert.equal(await readFile(path, 'utf8'), unknown);
  } finally {
    if ((await readFile(path, 'utf8')) === unknown) await unlink(path);
  }
});
test('Offline inspection retains exclusive storage through Worker disposal and releases only when copying has finished', async () => {
  const worker = await startLocalLms(true, 0, { keepLockAfterDispose: true });
  try {
    await assert.rejects(() => worker.releaseStorage(), /Dispose the Worker/);
    await worker.mf.dispose();
    await assert.rejects(() => startLocalLms(true, 0), /storage is locked/);
  } finally {
    await worker.mf.dispose();
    await worker.releaseStorage();
  }
  const next = await startLocalLms(true, 0);
  await next.mf.dispose();
});
