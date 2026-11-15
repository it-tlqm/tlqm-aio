import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertLocalDocker } from './local-docker.js';

const execute = promisify(execFile);
const trivy =
  'aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa';
const scanCache = 'tlqm-aio-release-trivy-cache';
const platform = 'linux/amd64';
const [release, expected, ...extra] = process.argv.slice(2);
const sha256 = /^sha256:[a-f0-9]{64}$/;
let step = 'preflight';

function docker(args: string[], timeout = 480000) {
  return execute('docker', ['--context', 'desktop-linux', ...args], {
    timeout,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

try {
  if (
    !release ||
    !/^[a-z0-9][a-z0-9-]{0,39}$/.test(release) ||
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    extra.length
  )
    throw new Error('Usage: release:image -- <release-name> <manifest-sha256>');
  await assertLocalDocker();
  const root = await realpath('.');
  const directory = join(root, '.local', 'releases', release);
  const artifact = join(directory, 'artifact');
  await execute(process.execPath, ['scripts/release.mjs', 'verify', artifact, expected], {
    timeout: 15000,
    windowsHide: true,
  });
  const runId = randomUUID().slice(0, 8);
  const target = join(directory, 'image-' + runId);
  await mkdir(target);
  const metadataPath = join(target, 'build-metadata.json');
  const tag = 'tlqm-aio-candidate:' + release + '-' + runId;

  step = 'build image from verified artifact';
  await docker([
    'buildx',
    'build',
    '--load',
    '--platform',
    platform,
    '--metadata-file',
    metadataPath,
    '--build-arg',
    'ARTIFACT_SHA256=' + expected,
    '--tag',
    tag,
    '--file',
    join(artifact, 'infrastructure/release/Dockerfile'),
    artifact,
  ]);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const imageDigest = metadata['containerimage.digest'];
  assert.match(imageDigest, sha256);
  const image = JSON.parse(
    (await docker(['image', 'inspect', '--format', '{{json .}}', tag])).stdout,
  );
  assert.equal(image.Descriptor.digest, imageDigest);
  assert.equal(image.Config.Labels['io.tlqm.aio.artifact-sha256'], expected);
  assert.equal(image.Config.User, 'node');
  const platformDigest = (
    await docker([
      'image',
      'inspect',
      '--platform',
      platform,
      '--format',
      '{{.Descriptor.Digest}}',
      tag,
    ])
  ).stdout.trim();
  assert.match(platformDigest, sha256);

  step = 'non-root runtime smoke';
  const smoke = await docker([
    'run',
    '--rm',
    '--pull=never',
    '--read-only',
    '--network=none',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--entrypoint=node',
    imageDigest,
    '--input-type=module',
    '-e',
    "await import('./dist/src/app.js'); await import('./dist/lms/worker.mjs'); if (!process.getuid()) process.exit(1); console.log(process.version);",
  ]);

  step = 'scan exact image';
  const archive = join(target, 'image.tar');
  await docker(['image', 'save', '--platform', platform, '--output', archive, tag]);
  const manifest = (
    await execute(
      'tar',
      ['-xOf', archive, 'blobs/sha256/' + platformDigest.slice('sha256:'.length)],
      { timeout: 15000, windowsHide: true },
    )
  ).stdout;
  assert.equal('sha256:' + createHash('sha256').update(manifest).digest('hex'), platformDigest);
  const imageConfigDigest = JSON.parse(manifest).config.digest;
  assert.match(imageConfigDigest, sha256);
  await docker([
    'volume',
    'create',
    '--driver',
    'local',
    '--label',
    'io.tlqm.aio.purpose=release-advisory-cache',
    scanCache,
  ]);
  const cache = (
    await docker([
      'volume',
      'inspect',
      '--format',
      '{{.Driver}} {{index .Labels "io.tlqm.aio.purpose"}}',
      scanCache,
    ])
  ).stdout.trim();
  assert.equal(cache, 'local release-advisory-cache');
  const scan = JSON.parse(
    (
      await docker(
        [
          'run',
          '--rm',
          '--pull=never',
          '--label',
          'io.tlqm.aio.scan=' + runId,
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--mount',
          'type=bind,source=' + archive + ',target=/scan/image.tar,readonly',
          '--mount',
          'type=volume,source=' + scanCache + ',target=/cache',
          trivy,
          'image',
          '--cache-dir=/cache',
          '--timeout=14m',
          '--no-progress',
          '--list-all-pkgs=false',
          '--scanners=vuln,secret',
          '--image-config-scanners=secret',
          '--format=json',
          '--input=/scan/image.tar',
        ],
        900000,
      )
    ).stdout,
  );
  assert.equal(scan.Metadata.ImageID, imageConfigDigest);
  assert.ok(
    Array.isArray(scan.Results) &&
      scan.Results.some((r: { Class: string }) => r.Class === 'os-pkgs'),
  );
  const results = scan.Results as {
    Class: string;
    Type: string;
    Secrets?: unknown[];
    Vulnerabilities?: {
      VulnerabilityID: string;
      PkgName: string;
      InstalledVersion: string;
      FixedVersion?: string;
      Severity: string;
    }[];
  }[];
  const findings = results.flatMap(({ Class, Type, Vulnerabilities = [] }) =>
    Vulnerabilities.map(
      ({ VulnerabilityID, PkgName, InstalledVersion, FixedVersion, Severity }) => ({
        class: Class,
        type: Type,
        id: VulnerabilityID,
        package: PkgName,
        installed: InstalledVersion,
        fixed: FixedVersion,
        severity: Severity,
      }),
    ),
  );
  const secretFindingCount = results.reduce(
    (count, result) => count + (result.Secrets?.length ?? 0),
    0,
  );
  const blockingCount = findings.filter(({ severity }) =>
    ['CRITICAL', 'HIGH'].includes(severity),
  ).length;
  const now = new Date();
  const receipt = {
    status: blockingCount || secretFindingCount ? 'fail' : 'pass',
    release,
    artifactDigest: expected,
    imageDigest,
    platformDigest,
    imageConfigDigest,
    platform,
    scanner: trivy,
    scannedAt: now.toISOString(),
    scannedAtVietnam: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    runtimeNode: smoke.stdout.trim(),
    nonRootReadOnlySmoke: true,
    blockingCount,
    secretFindingCount,
    findings,
  };
  const path = join(target, 'receipt.json');
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(receipt.status.toUpperCase() + ' image gate. Receipt: ' + path);
  if (receipt.status === 'fail') process.exitCode = 1;
} catch (error) {
  const detail =
    error && typeof error === 'object' && 'killed' in error && error.killed
      ? 'command timeout'
      : error instanceof Error
        ? error.name
        : 'unknown';
  console.error('Image gate failed at ' + step + ' (' + detail + ').');
  process.exitCode = 1;
}
