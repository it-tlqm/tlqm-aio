import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { mediaMetadata, parseByteRange, serveMedia, validMediaHeader } from '../src/lms/media.js';
import type { MediaBucket, MediaRecord } from '../src/lms/types.js';

test('Media type and size metadata reject traversal, mismatched types, and oversized uploads', () => {
  const headers = {
    'content-type': 'video/mp4',
    'x-file-name': encodeURIComponent('Đào tạo.mp4'),
    'x-file-size': '64',
    'x-file-sha256': 'ab'.repeat(32),
    'x-media-id': randomUUID(),
    'x-owner-unit-id': randomUUID(),
  };
  const make = (patch: Record<string, string> = {}) =>
    new Request('http://127.0.0.1:4104/api/lms/media', {
      method: 'POST',
      headers: { ...headers, ...patch },
    });
  assert.equal(mediaMetadata(make()).kind, 'video');
  assert.equal(mediaMetadata(make()).name, 'Đào tạo.mp4');
  for (const patch of [
    { 'x-file-name': encodeURIComponent('../unsafe.mp4') },
    { 'x-file-name': 'evil.html' },
    { 'content-type': 'text/html' },
    { 'x-file-size': '0' },
    { 'x-file-size': String(100 * 1024 * 1024 + 1) },
    { 'x-file-sha256': 'not-a-hash' },
  ])
    assert.throws(() => mediaMetadata(make(patch)));
  assert.equal(validMediaHeader('video/mp4', new TextEncoder().encode('xxxxftypisom')), true);
  assert.equal(validMediaHeader('video/mp4', new TextEncoder().encode('<html>evil</html>')), false);
  assert.equal(
    validMediaHeader('image/png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    true,
  );
  assert.equal(validMediaHeader('application/pdf', new TextEncoder().encode('%PDF-1.7')), true);
});

test('Workerd serves verified legacy R2 ranges and rejects same-size replacement bytes', async () => {
  const { outputFiles } = await build({
    absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    stdin: {
      sourcefile: 'lms-media-worker-fixture.ts',
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      loader: 'ts',
      contents: `
        import { serveMedia } from './src/lms/media.ts';
        const cache = new Map();
        export default {
          async fetch(request, env) {
            const path = new URL(request.url).pathname;
            if (path === '/seed') {
              await env.MEDIA.put('fixture', await request.arrayBuffer());
              return new Response(null, { status: 204 });
            }
            try {
              return await serveMedia(
                { media: async () => env.ROW }, env.MEDIA, request, new Headers(),
                { cache, scan: async (content) => {
                  await new Response(content).arrayBuffer();
                  return 'clean';
                } },
              );
            } catch (error) {
              return new Response(null, { status: error.status ?? 500 });
            }
          }
        };
      `,
    },
    platform: 'browser',
    format: 'esm',
    bundle: true,
    write: false,
  });
  const bytes = Buffer.from('legacy fixture');
  const fixture = new Miniflare({
    modules: true,
    script: outputFiles[0]!.text,
    compatibilityDate: '2026-07-30',
    host: '127.0.0.1',
    port: 0,
    cf: false,
    r2Buckets: { MEDIA: 'legacy-media-fixture' },
    bindings: {
      ROW: {
        object_key: 'fixture',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        name: 'legacy.pdf',
        mime_type: 'application/pdf',
        kind: 'document',
      },
    },
  });
  try {
    await fixture.ready;
    const seed = async (body: Buffer) =>
      assert.equal(
        (await fixture.dispatchFetch('http://localhost/seed', { method: 'POST', body })).status,
        204,
      );
    await seed(bytes);
    const read = () =>
      fixture.dispatchFetch('http://localhost/api/lms/media/fixture', {
        headers: { range: 'bytes=0-5' },
      });
    const valid = await read();
    assert.equal(valid.status, 206);
    assert.equal(await valid.text(), 'legacy');
    await seed(Buffer.alloc(bytes.length, 65));
    assert.equal((await read()).status, 503);
  } finally {
    await fixture.dispose();
  }
});
test('Media byte ranges support open and suffix ranges without accepting malformed or huge offsets', () => {
  assert.equal(parseByteRange(null, 100), null);
  assert.deepEqual(parseByteRange('bytes=0-9', 100), { offset: 0, length: 10 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { offset: 90, length: 10 });
  assert.deepEqual(parseByteRange('bytes=-8', 100), { offset: 92, length: 8 });
  assert.deepEqual(parseByteRange('bytes=90-999', 100), { offset: 90, length: 10 });
  assert.deepEqual(parseByteRange('bytes=-999', 100), { offset: 0, length: 100 });
  for (const range of [
    'bytes=100-',
    'bytes=4-2',
    'bytes=-0',
    'bytes=',
    'bytes=0-1,8-9',
    'bytes=9007199254740992-',
    'items=0-2',
  ])
    assert.throws(() => parseByteRange(range, 100), { status: 416 });
});

test('Staging scans a legacy object before serving ranges and rechecks a replacement version', async () => {
  const bytes = Buffer.from('legacy fixture');
  const row: MediaRecord = {
    id: 'legacy-media',
    tenant_id: 'tenant',
    owner_unit_id: 'unit',
    kind: 'document',
    object_key: 'media/legacy',
    name: 'legacy.pdf',
    mime_type: 'application/pdf',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    created_by: 'fixture',
    created_at: 0,
  };
  let version = '1';
  let replaceBeforeServe = false;
  let storedBytes = bytes;
  let authorized = false;
  let verdict: 'clean' | 'infected' | 'unavailable' = 'clean';
  let scans = 0;
  const metadata = () => ({ key: row.object_key, size: bytes.length, version, etag: version });
  const bucket: MediaBucket = {
    async head() {
      return metadata();
    },
    async get(_key, options) {
      assert.equal(options?.onlyIf?.etagMatches, version);
      const range = options?.range;
      if (range && replaceBeforeServe) version = '3';
      const body = range
        ? storedBytes.subarray(range.offset, range.offset + range.length)
        : storedBytes;
      return { ...metadata(), body: new Response(body).body! };
    },
    async put() {
      throw new Error('Unexpected media write');
    },
    async delete() {
      throw new Error('Unexpected media delete');
    },
  };
  const courses = {
    async media() {
      if (!authorized) throw Object.assign(new Error('Fixture denied'), { status: 403 });
      return row;
    },
  };
  const cache = new Map<string, Promise<void>>();
  const load = () =>
    serveMedia(
      courses,
      bucket,
      new Request('https://aio.localhost/api/lms/media/legacy-media', {
        headers: { range: 'bytes=0-5' },
      }),
      new Headers(),
      {
        cache,
        async scan(content) {
          scans++;
          assert.ok(content instanceof ReadableStream);
          assert.equal(await new Response(content).text(), storedBytes.toString());
          if (verdict === 'unavailable') throw new Error('Scanner offline');
          return verdict;
        },
      },
    );
  class FixtureDigest extends WritableStream<Uint8Array> {
    digest: Promise<ArrayBuffer>;
    constructor() {
      const sha = createHash('sha256');
      let complete!: (value: ArrayBuffer) => void;
      let fail!: (reason: unknown) => void;
      const result = new Promise<ArrayBuffer>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      super({
        write(chunk) {
          sha.update(chunk);
        },
        close() {
          complete(Uint8Array.from(sha.digest()).buffer);
        },
        abort(reason: unknown) {
          fail(reason);
        },
      });
      this.digest = result;
    }
  }
  Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: FixtureDigest });
  try {
    await assert.rejects(load, { status: 403 });
    assert.equal(scans, 0);
    authorized = true;
    const responses = await Promise.all([load(), load()]);
    for (const response of responses) {
      assert.equal(response.status, 206);
      assert.equal(await response.text(), 'legacy');
    }
    assert.equal(scans, 1);
    version = '2';
    verdict = 'infected';
    await assert.rejects(load, { status: 422 });
    verdict = 'unavailable';
    await assert.rejects(load, { status: 503 });
    verdict = 'clean';
    assert.equal(await (await load()).text(), 'legacy');
    assert.equal(scans, 4);
    replaceBeforeServe = true;
    await assert.rejects(load, { status: 503 });
    replaceBeforeServe = false;
    storedBytes = Buffer.alloc(bytes.length, 65);
    await assert.rejects(load, { status: 503 });
    assert.equal(scans, 5);
  } finally {
    Reflect.deleteProperty(crypto, 'DigestStream');
  }
});
