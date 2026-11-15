import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const [name, prior, priorDigest, ...extra] = process.argv.slice(2);
const releaseName = /^[a-z0-9][a-z0-9-]{0,39}$/;
const sha256 = /^[a-f0-9]{64}$/;
assert.ok(
  releaseName.test(name ?? '') &&
    name.length <= 33 &&
    releaseName.test(prior ?? '') &&
    sha256.test(priorDigest ?? '') &&
    prior !== name &&
    prior !== name + '-repeat' &&
    !extra.length,
  'Usage: release:e1 -- <new-release> <prior-release> <prior-manifest-sha256>',
);
assert.ok(process.env.npm_execpath, 'Run the release gate through npm.');
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const local = join(root, '.local');
await mkdir(local, { recursive: true });
assert.equal(await realpath(local), local);
const evidence = join(local, 'evidence');
await mkdir(evidence, { recursive: true });
assert.equal(await realpath(evidence), evidence);
const receiptPath = join(evidence, 'enterprise-e1-pipeline-' + name + '.json');
const unitPath = join(evidence, 'enterprise-e1-pipeline-' + name + '-unit.log');
const steps = [];
const now = () => {
  const time = new Date();
  return {
    at: time.toISOString(),
    vietnam: time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
  };
};
const load = async (path) => JSON.parse(await readFile(path, 'utf8'));
const dir = (release) => join(local, 'releases', release);

async function run(step, args, log) {
  const record = { step, started: now() };
  steps.push(record);
  const child = spawn(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.pipe(process.stderr, { end: false });
  const [exitCode] = await once(child, 'close');
  record.finished = now();
  record.exitCode = exitCode;
  if (log) await writeFile(log, output, { flag: 'wx' });
  if (exitCode !== 0) throw new Error(step + ' failed');
  return output;
}

const reportedReceipt = (output, gate, parent, pattern) => {
  const match = output.match(new RegExp('^PASS ' + gate + ' gate\\. Receipt: ([^\\r\\n]+)$', 'm'));
  const path = match?.[1]?.trim();
  assert.ok(path && pattern.test(relative(parent, path)), 'Missing matching ' + gate + ' receipt.');
  return path;
};

let build, image, staging;
let status = 'fail';
try {
  await run('verify rollback artifact', [
    'run',
    'release',
    '--',
    'verify',
    join(dir(prior), 'artifact'),
    priorDigest,
  ]);
  await run('build and verify release', ['run', 'release', '--', 'build', name]);
  await run('rebuild from independent snapshot', [
    'run',
    'release',
    '--',
    'build',
    name + '-repeat',
  ]);
  build = await load(join(dir(name), 'receipt.json'));
  const repeat = await load(join(dir(name + '-repeat'), 'receipt.json'));
  assert.equal(build.artifactDigest, repeat.artifactDigest);
  assert.equal(build.sourceDigest, repeat.sourceDigest);
  const sourceDigest = async () =>
    (
      await run('verify current test source', ['run', '--silent', 'release', '--', 'source-digest'])
    ).trim();
  assert.equal(await sourceDigest(), build.sourceDigest);
  await run('synthetic local unit and integration regression', ['test'], unitPath);
  assert.equal(await sourceDigest(), build.sourceDigest);
  const scanned = await run('build and scan exact image', [
    'run',
    'release:image',
    '--',
    name,
    build.artifactDigest,
  ]);
  const imagePath = reportedReceipt(
    scanned,
    'image',
    dir(name),
    /^image-[0-9a-f]{8}[\\/]receipt\.json$/,
  );
  image = await load(imagePath);
  assert.equal(image.status, 'pass');
  assert.equal(image.artifactDigest, build.artifactDigest);
  assert.equal(image.blockingCount, 0);
  assert.equal(image.secretFindingCount, 0);
  const staged = await run('staging TLS, business suite and rollback', [
    'run',
    'test:staging',
    '--',
    name,
    build.artifactDigest,
    prior,
    priorDigest,
    image.imageDigest,
    '--suite',
  ]);
  const stagePath = reportedReceipt(
    staged,
    'staging',
    evidence,
    /^enterprise-e1-staging-suite-[0-9a-f]{8}\.json$/,
  );
  staging = await load(stagePath);
  assert.equal(staging.status, 'pass');
  assert.equal(staging.artifactDigest, build.artifactDigest);
  assert.equal(staging.imageDigest, image.imageDigest);
  assert.deepEqual(
    staging.results.map((result) => result.slot),
    ['a', 'b'],
  );
  assert.ok(
    staging.results.every(
      (result) => result.business && result.lms && result.upgrade?.rollbackOnUpgradedSchema,
    ),
  );
  status = 'pass';
  console.log('PASS integrated E1 pipeline.');
} catch (error) {
  console.error('E1 pipeline failed (' + (error instanceof Error ? error.name : 'unknown') + ').');
  process.exitCode = 1;
} finally {
  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        status,
        release: name,
        prior,
        priorDigest,
        sourceDigest: build?.sourceDigest,
        artifactDigest: build?.artifactDigest,
        imageDigest: image?.imageDigest,
        stagingCheckedAt: staging?.checkedAt,
        checked: now(),
        steps,
        unitLog: relative(root, unitPath),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log('E1 pipeline receipt: ' + receiptPath);
}
