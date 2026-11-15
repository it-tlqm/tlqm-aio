import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { loadLocalConfig } from '../src/config.js';

let stage = 'preflight';
let mf: Miniflare | undefined;
try {
  const runtime = await loadLocalConfig();
  const target = resolve('.local/lms-spike');
  const within = relative(resolve('.local'), target);
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error('Invalid local spike target.');
  await mkdir(target, { recursive: true });
  stage = 'bundle Web API-only worker';
  await build({
    entryPoints: ['src/lms/spike-worker.ts'],
    bundle: true,
    platform: 'browser',
    target: 'es2023',
    format: 'esm',
    outfile: target + '/worker.mjs',
    logLevel: 'silent',
  });
  stage = 'start local workerd and D1';
  mf = new Miniflare({
    modules: true,
    scriptPath: target + '/worker.mjs',
    compatibilityDate: '2026-07-30',
    host: '127.0.0.1',
    port: 0,
    d1Databases: { LMS_DB: runtime.instanceId },
    d1Persist: target + '/d1',
    bindings: {
      ISSUER: runtime.issuer,
      CLIENT_ID: 'aio-foundation',
      INSTANCE_ID: runtime.instanceId,
    },
    log: new Log(LogLevel.NONE),
  });
  stage = 'verify Worker cryptography, OIDC discovery and D1';
  const response = await mf.dispatchFetch('http://127.0.0.1/probe');
  const result = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200)
    console.error(
      'Worker spike error type: ' +
        (typeof result.type === 'string' && /^[A-Za-z]+$/.test(result.type)
          ? result.type
          : 'unknown'),
    );
  assert.equal(response.status, 200);
  assert.deepEqual(result, {
    worker: true,
    webCrypto: true,
    joseSignature: true,
    oidcDiscovery: true,
    pkce: true,
    d1: true,
  });
  await writeFile(
    '.local/evidence/lms-runtime-spike.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        node: process.version,
        runtime: 'Miniflare workerd without nodejs_compat',
        ...result,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: real local workerd, D1, Web Crypto AES-GCM/RSA, jose signature validation, openid-client discovery and PKCE.',
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    'LMS runtime spike failed at: ' +
      stage +
      (code && /^[A-Z0-9_]{1,60}$/.test(code) ? ' (' + code + ')' : '') +
      '. Environment and credentials omitted.',
  );
  process.exitCode = 1;
} finally {
  await mf?.dispose();
}
