import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadStagingConfig, stagingTarget } from '../src/staging-config.js';
import type { StagingConfig } from '../src/staging-config.js';
import { readStagingSecret } from '../src/staging-secret-client.js';
import { startStagingSecretStore } from './staging-secret-store.js';

const root = await realpath('.');
const local = resolve(root, '.local');
await mkdir(local, { recursive: true });
assert.equal(await realpath(local), local);
const dir = join(local, 'runtime-secret-smoke-' + randomUUID().slice(0, 8));
await mkdir(dir);
const certFile = join(dir, 'cert.pem');
const keyFile = join(dir, 'key.pem');
const grantFile = join(dir, 'runtime-grant.json');
const fresh = () => randomBytes(32).toString('hex');
const slot = process.argv[2] ?? 'a';
if ((slot !== 'a' && slot !== 'b') || process.argv.length > 3)
  throw new Error('Usage: enterprise-secret-bootstrap-drill.ts [a|b]');
const target = stagingTarget(slot);
const config: StagingConfig = {
  mode: 'staging',
  slot,
  instanceId: randomUUID(),
  issuer: target.issuer,
  databaseUrl:
    'postgresql://aio_runtime:' + fresh() + '@127.0.0.1:' + target.dbPort + '/' + target.database,
  encryptionKey: fresh(),
  ingressKey: fresh(),
  clients: [
    ['aio-foundation', target.foundation],
    ['aio-probe', target.probe],
  ].map(([code, port]) => ({
    code: String(code),
    name: 'Synthetic app',
    port: Number(port),
    clientId: String(code),
    audience: code + '-api',
    baseUrl: 'https://127.0.0.1:' + port,
    clientSecret: fresh(),
  })),
};
const lms = { clientSecret: fresh(), encryptionKey: fresh() };
let store: Awaited<ReturnType<typeof startStagingSecretStore>> | undefined;
let phase = 'local TLS';
try {
  await promisify(execFile)(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        '$key = [System.Security.Cryptography.RSA]::Create(3072)',
        '$req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=127.0.0.1",$key,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)',
        '$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()',
        '$san.AddIpAddress([Net.IPAddress]::Loopback)',
        '$req.CertificateExtensions.Add($san.Build())',
        '$cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddHours(2))',
        '[IO.File]::WriteAllText((Join-Path $env:AIO_SECRET_DRILL_DIR "cert.pem"),$cert.ExportCertificatePem())',
        '[IO.File]::WriteAllText((Join-Path $env:AIO_SECRET_DRILL_DIR "key.pem"),$key.ExportPkcs8PrivateKeyPem())',
      ].join('; '),
    ],
    { env: { ...process.env, AIO_SECRET_DRILL_DIR: dir }, windowsHide: true, timeout: 15000 },
  );
  phase = 'OpenBao bootstrap';
  const ca = await readFile(certFile, 'utf8');
  const profile = JSON.parse(
    await readFile(join(root, 'infrastructure/release/openbao-aio.json'), 'utf8'),
  ) as { binarySha256: string };
  store = await startStagingSecretStore({
    slot,
    instanceId: config.instanceId,
    directory: dir,
    certFile,
    keyFile,
    ca,
    binarySha256: profile.binarySha256,
    values: { bff: config, lms },
  });
  phase = 'BFF one-use bootstrap';
  const grant = await store.grant('bff');
  await writeFile(grantFile, JSON.stringify(grant), { flag: 'wx', mode: 0o600 });
  const loaded = await loadStagingConfig(grantFile, slot, Buffer.from(ca));
  try {
    assert.deepEqual(loaded, config);
  } catch {
    throw new Error('Resolved BFF config did not match the synthetic fixture.');
  }
  await assert.rejects(loadStagingConfig(grantFile, slot, Buffer.from(ca)), /OpenBao staging/);
  phase = 'LMS role separation';
  const lmsGrant = await store.grant('lms');
  await assert.rejects(readStagingSecret({ ...lmsGrant, workload: 'bff' }, ca), /returned 403/);
  const resolvedLms = await readStagingSecret<typeof lms>(await store.grant('lms'), ca);
  try {
    assert.deepEqual(resolvedLms, lms);
  } catch {
    throw new Error('Resolved LMS config did not match the synthetic fixture.');
  }
  phase = 'rotate and destroy retired secret version';
  const replacement = { clientSecret: fresh(), encryptionKey: fresh() };
  const rotation = await store.rotate('lms', replacement);
  assert.deepEqual(rotation, { previous: 1, current: 2 });
  const rotated = await readStagingSecret<typeof lms>(await store.grant('lms'), ca);
  if (
    rotated.clientSecret !== replacement.clientSecret ||
    rotated.encryptionKey !== replacement.encryptionKey
  )
    throw new Error('Rotated LMS secret did not match its fixture.');
  await store.destroyRetired('lms', rotation.previous);
  phase = 'audit and destroy';
  const evidence = await store.evidence();
  await store.close();
  store = undefined;
  const receipt = {
    status: 'pass',
    scope: 'staging secret bootstrap component',
    ...evidence,
    replayedGrantDenied: true,
    crossRoleReadDenied: true,
    rotatedVersion: rotation.current,
    retiredVersionDestroyed: true,
    runnerSha256: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .digest('hex'),
    checkedAtVietnam: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
  };
  await writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(JSON.stringify(receipt));
  console.log(join(dir, 'receipt.json'));
} catch (error) {
  console.error('Staging secret bootstrap failed at ' + phase + '.');
  if (
    error instanceof Error &&
    /^OpenBao staging [A-Z]+ [a-z0-9_/?=-]+ returned \d+$/.test(error.message)
  )
    console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    await store?.close();
  } finally {
    for (const file of [keyFile, grantFile])
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
}
