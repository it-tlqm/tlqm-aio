import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const manifestName = 'release-manifest.json';

export async function verifyArtifact(target, expected) {
  const payload = [];
  async function visit(directory, prefix = '') {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Invalid artifact directory.');
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const key = prefix + name;
      const entry = await lstat(path);
      if (entry.isDirectory()) await visit(path, key + '/');
      else if (entry.isFile()) payload.push(key);
      else throw new Error('Linked or unsupported artifact file.');
    }
  }
  await visit(target);
  if (!payload.includes(manifestName)) throw new Error('Artifact manifest missing.');
  const bytes = await readFile(join(target, manifestName));
  if (!/^[0-9a-f]{64}$/.test(expected) || sha256(bytes) !== expected)
    throw new Error('Artifact manifest digest does not match.');
  const manifest = JSON.parse(bytes);
  if (manifest.format !== 1 || manifest.product !== 'tlqm-aio' || !manifest.files)
    throw new Error('Invalid artifact manifest.');
  const paths = payload.filter((name) => name !== manifestName).sort();
  if (JSON.stringify(paths) !== JSON.stringify(Object.keys(manifest.files).sort()))
    throw new Error('Unexpected or missing artifact payload.');
  for (const path of paths) {
    if (sha256(await readFile(join(target, path))) !== manifest.files[path])
      throw new Error('Artifact file digest does not match: ' + path);
  }
  return paths.length;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [directory, expected] = process.argv.slice(2);
  console.log('Verified ' + (await verifyArtifact(directory, expected)) + ' artifact files.');
}
