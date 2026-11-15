import { randomBytes } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { loadLocalConfig } from '../src/config.js';
import { validateLmsConfig } from '../src/lms/security.js';
import type { LmsConfig, LocalLmsEnvironment } from '../src/lms/security.js';
import type { D1Database } from '../src/lms/types.js';
import { acquireLmsStorage } from './lms-storage-lock.js';

export { migrateLms } from '../src/lms/database.js';

export async function localLmsConfig(test: boolean): Promise<LmsConfig & LocalLmsEnvironment> {
  const runtime = await loadLocalConfig();
  const client = runtime.clients.find(
    (client) => client.code === 'aio-lms-sandbox' && client.kind === 'external-application',
  );
  if (!client) throw new Error('Provision the local external LMS client first.');
  let config: { instanceId: string; encryptionKey: string };
  try {
    config = JSON.parse(await readFile('.local/lms-adapter.json', 'utf8')) as typeof config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Invalid local LMS secret configuration.');
    const exists = await readdir('.local/lms').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw new Error('Cannot inspect local LMS target.');
    });
    if (exists.length)
      throw new Error(
        'Existing LMS storage has no matching key configuration; never regenerate it.',
      );
    config = { instanceId: runtime.instanceId, encryptionKey: randomBytes(32).toString('hex') };
    await writeFile('.local/lms-adapter.json', JSON.stringify(config, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (config.instanceId !== runtime.instanceId)
    throw new Error('LMS configuration belongs to another local instance.');
  return validateLmsConfig({
    ...config,
    mode: 'local',
    purpose: test ? 'tlqm-aio-lms-test' : 'tlqm-aio-lms-local',
    issuer: runtime.issuer,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    audience: client.audience,
    baseUrl: client.baseUrl,
    foundationUrl: 'http://127.0.0.1:4100/api/v1/integrations/aio-lms-sandbox/authorize',
  });
}
export async function startLocalLms(
  test: boolean,
  port = 4104,
  options: { keepLockAfterDispose?: boolean } = {},
) {
  if (port !== 4104 && port !== 0)
    throw new Error('Only the isolated LMS port or ephemeral test listener is allowed.');
  if (options.keepLockAfterDispose && port !== 0)
    throw new Error('Offline storage work requires an ephemeral inspection listener.');
  const config = await localLmsConfig(test);
  const lease = await acquireLmsStorage(test ? 'test' : 'local'),
    target = lease.target;
  let mf: Miniflare | undefined;
  try {
    await build({
      entryPoints: ['src/lms/worker.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2023',
      outfile: target + '/worker.mjs',
      logLevel: 'silent',
    });
    mf = new Miniflare({
      modules: true,
      scriptPath: target + '/worker.mjs',
      compatibilityDate: '2026-07-30',
      host: '127.0.0.1',
      port,
      d1Databases: { LMS_DB: config.instanceId },
      d1Persist: target + '/d1',
      r2Buckets: { LMS_MEDIA: config.instanceId + '-media' },
      r2Persist: target + '/r2',
      bindings: { LMS_CONFIG: JSON.stringify(config) },
      assets: {
        directory: resolve('frontend/dist'),
        binding: 'ASSETS',
        routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      },
      log: new Log(LogLevel.NONE),
    });
    await mf.ready;
    const db = (await mf.getD1Database('LMS_DB')) as unknown as D1Database;
    const dispose = mf.dispose.bind(mf);
    let disposed = false;
    let closing: Promise<void> | undefined;
    mf.dispose = () =>
      (closing ??= (async () => {
        await dispose();
        disposed = true;
        if (!options.keepLockAfterDispose) await lease.release();
      })());
    return {
      mf,
      db,
      config,
      target,
      async releaseStorage() {
        if (!disposed) throw new Error('Dispose the Worker before releasing storage.');
        await lease.release();
      },
    };
  } catch {
    await mf?.dispose();
    await lease.release();
    throw new Error('Local LMS worker failed to initialize.');
  }
}
