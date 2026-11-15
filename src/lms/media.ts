import type { Courses, CourseCommand } from './courses.js';
import type { D1Database, MediaBucket, MediaObject, MediaRecord } from './types.js';
import { LmsError } from './security.js';
import type { UploadScan } from '../upload-scan.js';

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const formats: Record<string, { kind: MediaRecord['kind']; extensions: string[]; max: number }> = {
  'video/mp4': { kind: 'video', extensions: ['mp4', 'm4v'], max: MAX_VIDEO_BYTES },
  'video/webm': { kind: 'video', extensions: ['webm'], max: MAX_VIDEO_BYTES },
  'video/ogg': { kind: 'video', extensions: ['ogg', 'ogv'], max: MAX_VIDEO_BYTES },
  'video/quicktime': { kind: 'video', extensions: ['mov'], max: MAX_VIDEO_BYTES },
  'application/pdf': { kind: 'document', extensions: ['pdf'], max: 20 * 1024 * 1024 },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'document',
    extensions: ['docx'],
    max: 20 * 1024 * 1024,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'document',
    extensions: ['xlsx'],
    max: 20 * 1024 * 1024,
  },
  'image/png': { kind: 'image', extensions: ['png'], max: 10 * 1024 * 1024 },
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'], max: 10 * 1024 * 1024 },
  'image/webp': { kind: 'image', extensions: ['webp'], max: 10 * 1024 * 1024 },
};
export function mediaMetadata(request: Request) {
  const mimeType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  const format = Object.hasOwn(formats, mimeType) ? formats[mimeType]! : undefined;
  let name: string;
  try {
    name = decodeURIComponent(request.headers.get('x-file-name') ?? '').normalize('NFC');
  } catch {
    throw new LmsError(400, 'LMS_MEDIA_NAME_INVALID');
  }
  if (!name || name.length > 180 || /[\\/\u0000-\u001f\u007f]/.test(name))
    throw new LmsError(400, 'LMS_MEDIA_NAME_INVALID');
  if (!format || !format.extensions.includes(name.split('.').at(-1)!.toLowerCase()))
    throw new LmsError(415, 'LMS_MEDIA_TYPE_INVALID');
  const rawSize = request.headers.get('x-file-size') ?? '';
  if (!/^[1-9]\d{0,9}$/.test(rawSize)) throw new LmsError(400, 'LMS_MEDIA_SIZE_INVALID');
  const size = Number(rawSize);
  if (size > format.max) throw new LmsError(413, 'PAYLOAD_TOO_LARGE');
  const sha256 = request.headers.get('x-file-sha256') ?? '';
  const id = request.headers.get('x-media-id') ?? '',
    ownerUnitId = request.headers.get('x-owner-unit-id') ?? '';
  if (
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !/^[0-9a-f-]{36}$/.test(id) ||
    !/^[0-9a-f-]{36}$/.test(ownerUnitId)
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  return { id, ownerUnitId, name, mimeType, size, sha256, kind: format.kind };
}
/** Sniff the container, not just a filename/MIME supplied by the browser. No claim of virus scanning. */
export function validMediaHeader(mime: string, bytes: Uint8Array) {
  const text = (offset: number, length: number) =>
    new TextDecoder().decode(bytes.slice(offset, offset + length));
  if (mime === 'video/mp4' || mime === 'video/quicktime')
    return bytes.length >= 12 && text(4, 4) === 'ftyp';
  if (mime === 'video/webm')
    return (
      bytes.length >= 4 && [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)
    );
  if (mime === 'video/ogg') return text(0, 4) === 'OggS';
  if (mime === 'application/pdf') return text(0, 5) === '%PDF-';
  if (mime.endsWith('.document') || mime.endsWith('.sheet'))
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  if (mime === 'image/png')
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP';
  return false;
}
type FixedStream = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
type Digest = WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
function mediaDigest() {
  const DigestStream = (crypto as Crypto & { DigestStream?: new (algorithm: string) => Digest })
    .DigestStream;
  if (!DigestStream) throw new LmsError(503, 'LMS_MEDIA_RUNTIME_UNAVAILABLE');
  return new DigestStream('SHA-256');
}
const digestHex = (digest: ArrayBuffer) =>
  Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
async function streamToBucket(
  request: Request,
  bucket: MediaBucket,
  key: string,
  metadata: ReturnType<typeof mediaMetadata>,
) {
  if (!request.body) throw new LmsError(400, 'LMS_MEDIA_SIZE_INVALID');
  const FixedLength = (
    globalThis as typeof globalThis & { FixedLengthStream: new (size: number) => FixedStream }
  ).FixedLengthStream;
  if (!FixedLength) throw new LmsError(503, 'LMS_MEDIA_RUNTIME_UNAVAILABLE');
  const reader = request.body.getReader();
  const first: Uint8Array[] = [];
  const prefix = new Uint8Array(32);
  let prefixSize = 0,
    total = 0;
  try {
    while (prefixSize < Math.min(32, metadata.size)) {
      const chunk = await reader.read();
      if (chunk.done) throw new LmsError(400, 'LMS_MEDIA_SIZE_INVALID');
      total += chunk.value.length;
      if (total > metadata.size) throw new LmsError(400, 'LMS_MEDIA_SIZE_INVALID');
      first.push(chunk.value);
      const count = Math.min(chunk.value.length, 32 - prefixSize);
      prefix.set(chunk.value.subarray(0, count), prefixSize);
      prefixSize += count;
    }
    if (!validMediaHeader(metadata.mimeType, prefix.subarray(0, prefixSize)))
      throw new LmsError(415, 'LMS_MEDIA_TYPE_INVALID');
    const fixed = new FixedLength(metadata.size),
      digest = mediaDigest();
    const writer = fixed.writable.getWriter(),
      hashWriter = digest.getWriter();
    const stored = bucket.put(key, fixed.readable, {
      httpMetadata: { contentType: metadata.mimeType },
      sha256: metadata.sha256,
    });
    void stored.catch(() => {});
    void digest.digest.catch(() => {});
    try {
      const write = (bytes: Uint8Array) =>
        Promise.all([writer.write(bytes), hashWriter.write(bytes)]);
      for (const bytes of first) await write(bytes);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.length;
        if (total > metadata.size) throw new LmsError(400, 'LMS_MEDIA_SIZE_INVALID');
        await write(chunk.value);
      }
      if (total !== metadata.size) throw new LmsError(400, 'LMS_MEDIA_SIZE_INVALID');
      await Promise.all([writer.close(), hashWriter.close()]);
      const actual = digestHex(await digest.digest);
      if (actual !== metadata.sha256) throw new LmsError(400, 'LMS_MEDIA_CHECKSUM_INVALID');
      const object = await stored;
      const verified = await bucket.head(key);
      if (!object || !verified || verified.size !== metadata.size)
        throw new LmsError(503, 'LMS_MEDIA_STORAGE_UNAVAILABLE');
    } catch (error) {
      await Promise.allSettled([writer.abort(), hashWriter.abort(), stored]);
      throw error;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function uploadMedia(
  courses: Courses,
  db: D1Database,
  bucket: MediaBucket,
  request: Request,
  scan?: UploadScan,
) {
  const actor = await courses.mediaUploadActor();
  const metadata = mediaMetadata(request);
  const command: CourseCommand = {
    key: request.headers.get('idempotency-key') ?? '',
    reason: 'Tải tài liệu đào tạo',
  };
  if (!/^[A-Za-z0-9-]{16,80}$/.test(command.key)) throw new LmsError(400, 'INVALID_REQUEST');
  // A unique storage key per attempt prevents a concurrent retry overwriting a committed object.
  const key = 'media/' + actor.link.tenant_id + '/' + metadata.id + '/' + crypto.randomUUID();
  try {
    await streamToBucket(request, bucket, key, metadata);
    if (scan) {
      const object = await bucket.get(key);
      if (!object?.body || object.size !== metadata.size)
        throw new LmsError(503, 'LMS_MEDIA_STORAGE_UNAVAILABLE');
      await scanLmsUpload(scan, object.body);
    }
    return await courses.registerMedia(metadata, key, command);
  } finally {
    // An uncertain D1 outcome keeps the object; never delete an object a successful commit references.
    try {
      const reference = await db
        .prepare('SELECT object_key FROM lms_media WHERE id=? AND tenant_id=?')
        .bind(metadata.id, actor.link.tenant_id)
        .first<{ object_key: string }>();
      if (reference?.object_key !== key) await bucket.delete(key);
    } catch {
      /* A later operator reconciliation can remove an unreferenced object safely. */
    }
  }
}

export async function scanLmsUpload(scan: UploadScan, content: Parameters<UploadScan>[0]) {
  const verdict = await scan(content).catch(() => {
    throw new LmsError(503, 'LMS_UPLOAD_SCANNER_UNAVAILABLE');
  });
  if (verdict !== 'clean') throw new LmsError(422, 'LMS_UPLOAD_QUARANTINED');
}

type MediaScanCache = Map<string, Promise<void>>;
const cleanMediaByInstance = new Map<string, MediaScanCache>();
export function lmsMediaScanCache(instanceId: string) {
  let cache = cleanMediaByInstance.get(instanceId);
  if (!cache) {
    if (cleanMediaByInstance.size >= 8)
      cleanMediaByInstance.delete(cleanMediaByInstance.keys().next().value!);
    cache = new Map();
    cleanMediaByInstance.set(instanceId, cache);
  }
  return cache;
}

async function verifyStoredMedia(
  bucket: MediaBucket,
  row: MediaRecord,
  object: MediaObject,
  scan: UploadScan,
  cache: MediaScanCache,
) {
  if (!object.version) throw new LmsError(503, 'LMS_MEDIA_STORAGE_UNAVAILABLE');
  const key = JSON.stringify([row.object_key, row.sha256, object.version]);
  const known = cache.get(key);
  if (known) return known;
  const verify = async () => {
    const stored = await bucket.get(row.object_key, { onlyIf: { etagMatches: object.etag } });
    if (!stored?.body || stored.size !== row.size || stored.version !== object.version) {
      await stored?.body?.cancel().catch(() => {});
      throw new LmsError(503, 'LMS_MEDIA_STORAGE_UNAVAILABLE');
    }
    const digest = mediaDigest();
    void digest.digest.catch(() => {});
    const [hashBody, scanBody] = stored.body.tee();
    const abort = new AbortController();
    const hash = hashBody.pipeTo(digest, { signal: abort.signal }).then(() => digest.digest);
    const scanned = scanLmsUpload(scan, scanBody);
    try {
      const [actual] = await Promise.all([hash, scanned]);
      if (digestHex(actual) !== row.sha256)
        throw new LmsError(503, 'LMS_MEDIA_STORAGE_UNAVAILABLE');
    } finally {
      abort.abort();
      await Promise.allSettled([hashBody.cancel(), scanBody.cancel()]);
    }
  };
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  const pending = verify().catch((error: unknown) => {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}
export function parseByteRange(
  value: string | null,
  size: number,
): { offset: number; length: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new LmsError(416, 'LMS_MEDIA_RANGE_INVALID');
  const start = match[1] ? Number(match[1]) : null,
    end = match[2] ? Number(match[2]) : null;
  if (
    (start !== null && !Number.isSafeInteger(start)) ||
    (end !== null && !Number.isSafeInteger(end))
  )
    throw new LmsError(416, 'LMS_MEDIA_RANGE_INVALID');
  if (start === null) {
    if (!end) throw new LmsError(416, 'LMS_MEDIA_RANGE_INVALID');
    const length = Math.min(end, size);
    return { offset: size - length, length };
  }
  if (start >= size || (end !== null && end < start))
    throw new LmsError(416, 'LMS_MEDIA_RANGE_INVALID');
  return { offset: start, length: Math.min(end ?? size - 1, size - 1) - start + 1 };
}
export async function serveMedia(
  courses: Pick<Courses, 'media'>,
  bucket: MediaBucket,
  request: Request,
  outputHeaders: Headers,
  protection?: { scan: UploadScan; cache: MediaScanCache },
) {
  const url = new URL(request.url),
    mediaId = url.pathname.slice('/api/lms/media/'.length);
  const row = await courses.media(mediaId, url.searchParams.get('versionId') ?? undefined);
  const object = await bucket.head(row.object_key);
  if (!object || object.size !== row.size) throw new LmsError(503, 'LMS_MEDIA_STORAGE_UNAVAILABLE');
  if (protection) await verifyStoredMedia(bucket, row, object, protection.scan, protection.cache);
  const headers = new Headers(outputHeaders),
    etag = '"' + row.sha256 + '"';
  headers.set('content-type', row.mime_type);
  headers.set('accept-ranges', 'bytes');
  headers.set('etag', etag);
  headers.set(
    'content-disposition',
    (row.kind === 'document' ? 'attachment' : 'inline') +
      "; filename*=UTF-8''" +
      encodeURIComponent(row.name).replace(
        /['()*]/g,
        (char) => '%' + char.charCodeAt(0).toString(16),
      ),
  );
  let range: ReturnType<typeof parseByteRange>;
  try {
    range =
      request.method === 'HEAD' ||
      (request.headers.has('if-range') && request.headers.get('if-range') !== etag)
        ? null
        : parseByteRange(request.headers.get('range'), row.size);
  } catch (error) {
    if (error instanceof LmsError && error.status === 416) {
      headers.set('content-range', 'bytes */' + row.size);
      return new Response(null, { status: 416, headers });
    }
    throw error;
  }
  headers.set('content-length', String(range?.length ?? row.size));
  if (range)
    headers.set(
      'content-range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`,
    );
  if (request.method === 'HEAD') return new Response(null, { headers });
  const result = await bucket.get(row.object_key, {
    ...(range && { range }),
    ...(protection && { onlyIf: { etagMatches: object.etag } }),
  });
  if (!result?.body || (protection && result.version !== object.version)) {
    await result?.body?.cancel().catch(() => {});
    throw new LmsError(503, 'LMS_MEDIA_STORAGE_UNAVAILABLE');
  }
  return new Response(result.body, { status: range ? 206 : 200, headers });
}
