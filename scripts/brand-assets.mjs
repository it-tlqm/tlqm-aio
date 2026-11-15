import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const source = 'brand/tlqm-2026/source/png/';
const destinations = [
  'frontend/src/assets/brand',
  'infrastructure/keycloak/themes/tlqm/login/resources/img/brand',
];
const manifest = JSON.parse(await readFile('brand/tlqm-2026/source-manifest.json', 'utf8'));
const variants = [
  ['emblem-color', 'TA LUNG_2026_logo.png', 256],
  ['emblem-white', 'TA LUNG_2026_logo-13.png', 256],
  ['lockup-color', 'TA LUNG_2026_logo-01.png', 720],
  ['lockup-white', 'TA LUNG_2026_logo-05.png', 720],
  ['wordmark-color', 'TA LUNG_2026_logo-17.png', 640],
  ['wordmark-white', 'TA LUNG_2026_logo-21.png', 640],
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const generated = [];
for (const destination of destinations) await mkdir(destination, { recursive: true });
for (const [name, filename, width] of variants) {
  const bytes = await readFile(source + filename);
  assert.equal(
    digest(bytes),
    manifest.files.find((file) => file.path === source + filename)?.sha256,
    'Original brand file checksum changed.',
  );
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] !== 0) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  assert.ok(right >= left && bottom >= top);
  const bounds = { left, top, width: right - left + 1, height: bottom - top + 1 };
  const output = await sharp(bytes)
    .extract(bounds)
    .resize({ width, withoutEnlargement: true })
    .png()
    .toBuffer();
  for (const destination of destinations)
    await writeFile(destination + '/' + name + '.png', output);
  generated.push({
    name,
    source: source + filename,
    sourceSha256: digest(bytes),
    alphaBounds: bounds,
    outputSha256: digest(output),
    width,
  });
  if (name === 'emblem-color') {
    const favicon = await sharp(bytes)
      .extract(bounds)
      .resize({ width: 52, height: 52, fit: 'contain', background: '#ffffff00' })
      .extend({ top: 6, bottom: 6, left: 6, right: 6, background: '#ffffff00' })
      .png()
      .toBuffer();
    for (const destination of destinations) await writeFile(destination + '/favicon.png', favicon);
    generated.push({
      name: 'favicon',
      source: source + filename,
      outputSha256: digest(favicon),
      width: 64,
    });
  }
}
await writeFile(
  'brand/tlqm-2026/web-manifest.json',
  JSON.stringify(
    {
      operation:
        'Trim fully transparent outer canvas, preserve aspect ratio, resize PNG for web. No recoloring or redrawing. Clear space is provided by UI layout.',
      destinations,
      assets: generated,
    },
    null,
    2,
  ) + '\n',
);
console.log('Prepared 7 TLQM brand assets for AIO and SSO from verified originals.');
