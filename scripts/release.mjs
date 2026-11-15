import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  manifestName,
  sha256 as digest,
  verifyArtifact,
} from '../infrastructure/release/verify-artifact.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const releases = join(root, '.local', 'releases');

const buildInputs = [
  '.node-version',
  '.npmrc',
  '.prettierrc.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'frontend/package.json',
  'frontend/tsconfig.json',
  'frontend/vite.config.ts',
  'frontend/index.html',
  'frontend/components.json',
  'frontend/src',
  'frontend/public',
  'infrastructure',
  'public',
  'src',
  'scripts',
  'tests',
  'examples',
];
const releaseInputs = [
  'package.json',
  'package-lock.json',
  'frontend/package.json',
  'frontend/dist',
  'public',
  'dist/src',
  'dist/scripts/dev.js',
  'dist/scripts/staging.js',
  'dist/scripts/local-docker.js',
  'dist/scripts/work-center-runtime.js',
  'dist/lms/worker.mjs',
  'infrastructure',
  'sbom.cdx.json',
];

async function files(base, paths, include = () => true) {
  const result = [];
  async function visit(path) {
    const info = await lstat(join(base, path));
    if (info.isSymbolicLink()) throw new Error('Linked release input refused.');
    if (info.isDirectory()) {
      for (const name of (await readdir(join(base, path))).sort()) {
        if (include(name, path)) await visit(path + '/' + name);
      }
    } else if (info.isFile()) {
      result.push(path);
    } else {
      throw new Error('Unsupported release input.');
    }
  }
  for (const path of paths) await visit(path);
  return result.sort();
}

async function copy(from, to, paths) {
  const result = {};
  for (const path of paths) {
    const bytes = await readFile(join(from, path));
    result[path] = digest(bytes);
    const target = join(to, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return result;
}

function npm(cwd, args, capture = false) {
  if (!process.env.npm_execpath) throw new Error('Run the release command through npm.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    env: { ...process.env, CI: 'true', TZ: 'UTC' },
    encoding: 'utf8',
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('npm command failed: ' + args[0]);
  return result.stdout;
}

function sourceFile(name) {
  return !(
    /^(?:node_modules|dist|coverage|playwright-report|test-results)$/i.test(name) ||
    name.startsWith('.') ||
    /\.(?:key|pem|pfx|p12|dump|bak)$/i.test(name)
  );
}

async function build(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new Error('Invalid release name.');
  const nodeVersion = (await readFile(join(root, '.node-version'), 'utf8')).trim();
  if (!(
    process.versions.node === nodeVersion || process.versions.node.startsWith(nodeVersion + '.')
  ))
    throw new Error('Use the Node version pinned in .node-version.');
  await mkdir(join(root, '.local'), { recursive: true });
  const realRoot = await realpath(root);
  if ((await realpath(join(root, '.local'))) !== join(realRoot, '.local'))
    throw new Error('Local release directory must be inside the workspace.');
  await mkdir(releases, { recursive: true });
  if ((await realpath(releases)) !== join(realRoot, '.local', 'releases'))
    throw new Error('Release directory must be inside the workspace.');
  const target = join(releases, name);
  const snapshot = join(target, 'source');
  const artifact = join(target, 'artifact');
  await mkdir(target);
  await mkdir(snapshot);
  await mkdir(artifact);

  const sourceHashes = await copy(root, snapshot, await files(root, buildInputs, sourceFile));
  const sourceDigest = digest(JSON.stringify(sourceHashes));
  npm(snapshot, ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  npm(snapshot, ['run', 'format:check']);
  const audit = JSON.parse(
    npm(
      snapshot,
      ['audit', '--package-lock-only', '--omit=dev', '--audit-level=high', '--json'],
      true,
    ),
  );
  const advisories = audit.metadata?.vulnerabilities;
  if (
    !advisories ||
    !Number.isInteger(advisories.total) ||
    advisories.high !== 0 ||
    advisories.critical !== 0
  )
    throw new Error('Production npm audit did not return an acceptable result.');
  npm(snapshot, ['run', 'typecheck']);
  npm(snapshot, ['run', 'build']);

  const { build: bundle } = await import(
    pathToFileURL(join(snapshot, 'node_modules/esbuild/lib/main.js')).href
  );
  await bundle({
    absWorkingDir: snapshot,
    entryPoints: ['src/lms/worker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    outfile: 'dist/lms/worker.mjs',
  });

  const sbom = JSON.parse(
    npm(snapshot, ['sbom', '--sbom-format=cyclonedx', '--package-lock-only', '--omit=dev'], true),
  );
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components))
    throw new Error('Unexpected SBOM format.');
  delete sbom.serialNumber;
  delete sbom.metadata?.timestamp;
  await writeFile(join(snapshot, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2) + '\n', {
    flag: 'wx',
  });

  const payload = await files(snapshot, releaseInputs, (name) => !name.endsWith('.map'));
  const artifactFiles = await copy(snapshot, artifact, payload);
  const manifest =
    JSON.stringify(
      {
        format: 1,
        product: 'tlqm-aio',
        sourceDigest,
        toolchain: {
          node: process.version,
          npm: npm(snapshot, ['--version'], true).trim(),
          platform: process.platform,
          architecture: process.arch,
        },
        files: artifactFiles,
      },
      null,
      2,
    ) + '\n';
  const artifactDigest = digest(manifest);
  await writeFile(join(artifact, manifestName), manifest, { flag: 'wx' });
  const fileCount = await verifyArtifact(artifact, artifactDigest);
  const receipt = {
    status: 'pass',
    sourceDigest,
    artifactDigest,
    fileCount,
    sbomComponents: sbom.components.length,
    npmAudit: advisories,
    completedAt: new Date().toISOString(),
    completedAtVietnam: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
  };
  await writeFile(join(target, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(JSON.stringify(receipt));
}

const [command, value, expected, ...extra] = process.argv.slice(2);
try {
  if (command === 'build' && value && !expected && !extra.length) await build(value);
  else if (command === 'source-digest' && !value) {
    const sourceHashes = {};
    for (const path of await files(root, buildInputs, sourceFile))
      sourceHashes[path] = digest(await readFile(join(root, path)));
    console.log(digest(JSON.stringify(sourceHashes)));
  } else if (command === 'verify' && value && expected && !extra.length) {
    const target = resolve(value);
    const within = relative(releases, target);
    if (isAbsolute(within) || !/^[a-z0-9][a-z0-9-]{0,39}[\\/]artifact$/.test(within))
      throw new Error('Select a release artifact under .local/releases.');
    if ((await realpath(target)) !== join(await realpath(root), '.local', 'releases', within))
      throw new Error('Linked release directory refused.');
    console.log('Verified ' + (await verifyArtifact(target, expected)) + ' artifact files.');
  } else {
    throw new Error(
      'Use build <name>, source-digest, or verify <artifact-directory> <manifest-sha256>.',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release operation failed.');
  process.exitCode = 1;
}
