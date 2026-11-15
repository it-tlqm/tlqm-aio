import { open, readFile, unlink, mkdir, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
type Owner = { version: 1; purpose: string; pid: number; nonce: string; createdAt: string };
/** Cooperative local exclusivity for runtime, operators and offline storage work.
 * No stale timeout takeover: an existing lock always needs explicit dead-process review.
 */
export async function acquireLmsStorage(environment: 'local' | 'test') {
  if (!['local', 'test'].includes(environment)) throw new Error('Invalid LMS storage environment.');
  const base = resolve('.local'),
    target = resolve(base, 'lms', environment),
    within = relative(base, target);
  if (within.startsWith('..') || isAbsolute(within))
    throw new Error('Invalid isolated storage path.');
  for (const directory of [base, resolve(base, 'lms'), target]) {
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Linked LMS storage paths are refused.');
  }
  const path = resolve(target, 'storage.lock.json'),
    owner: Owner = {
      version: 1,
      purpose: 'tlqm-aio-lms-' + environment,
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        'LMS storage is locked. Stop its verified owner; use lms:unlock only after confirming the process has exited.',
      );
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(owner) + '\n');
    await handle.sync();
  } catch (error) {
    await handle.close();
    throw error;
  }
  let released = false;
  return {
    target,
    owner,
    async release() {
      if (released) return;
      const current = JSON.parse(await readFile(path, 'utf8')) as Owner;
      if (current.nonce !== owner.nonce || current.pid !== owner.pid)
        throw new Error('LMS storage lock ownership changed; no lock was removed.');
      await handle.close();
      await unlink(path);
      released = true;
    },
  };
}
export async function unlockLmsStorage(environment: 'local' | 'test') {
  if (!['local', 'test'].includes(environment)) throw new Error('Invalid LMS storage environment.');
  const base = resolve('.local'),
    target = resolve(base, 'lms', environment);
  for (const directory of [base, resolve(base, 'lms'), target]) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Linked LMS storage paths are refused.');
  }
  const path = resolve(target, 'storage.lock.json'),
    info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Unidentified storage lock.');
  const text = await readFile(path, 'utf8'),
    owner = JSON.parse(text) as Owner;
  if (
    owner.version !== 1 ||
    owner.purpose !== 'tlqm-aio-lms-' + environment ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    !/^[-0-9a-f]{36}$/.test(owner.nonce) ||
    typeof owner.createdAt !== 'string'
  )
    throw new Error('Unidentified storage lock.');
  try {
    process.kill(owner.pid, 0);
    throw new Error('Storage owner is still running.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  // Explicit operator command only; serialize unlock/start commands on this workstation.
  if ((await readFile(path, 'utf8')) !== text)
    throw new Error('Storage lock changed; nothing removed.');
  await unlink(path);
  return { environment, formerPid: owner.pid };
}
