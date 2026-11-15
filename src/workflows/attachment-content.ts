import { createHash } from 'node:crypto';
import { HttpError } from '../security.js';
import { verifyZipContents } from '../verified-zip.js';
import { attachmentFormats, maxAttachmentBytes } from '../forms/attachment-fields.js';
import type { AttachmentField, AttachmentFormat } from '../forms/attachment-fields.js';
import type { UploadScan } from '../upload-scan.js';

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngEnd = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const textDecoder = new TextDecoder('utf-8', { fatal: true });

async function scanWorkflowAttachment(scan: UploadScan, bytes: Buffer) {
  return scan(bytes).catch(() => {
    throw new HttpError(503, 'WORKFLOW_ATTACHMENT_SCANNER_UNAVAILABLE');
  });
}

export async function verifyStoredWorkflowAttachment(
  content: Buffer,
  checksum: string,
  scan: UploadScan,
) {
  if (createHash('sha256').update(content).digest('hex') !== checksum)
    throw new HttpError(503, 'WORKFLOW_ATTACHMENT_STORAGE_UNAVAILABLE');
  if ((await scanWorkflowAttachment(scan, content)) !== 'clean')
    throw new HttpError(404, 'WORKFLOW_ATTACHMENT_NOT_FOUND');
}

async function matchesFormat(format: AttachmentFormat, bytes: Buffer) {
  if (format === 'pdf')
    return (
      /^%PDF-\d\.\d/.test(bytes.toString('latin1', 0, 8)) &&
      bytes.subarray(-1024).toString('latin1').trimEnd().endsWith('%%EOF')
    );
  if (format === 'png')
    return (
      bytes.length >= 45 &&
      bytes.subarray(0, 8).equals(pngHeader) &&
      bytes.readUInt32BE(8) === 13 &&
      bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.subarray(-12).equals(pngEnd)
    );
  if (format === 'jpeg')
    return (
      bytes.length >= 8 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff &&
      bytes.at(-2) === 0xff &&
      bytes.at(-1) === 0xd9
    );
  if (format === 'txt' || format === 'csv')
    return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(textDecoder.decode(bytes));
  const entries = await verifyZipContents(new Uint8Array(bytes), () => {
    throw new Error('Invalid document archive');
  });
  return (
    entries.has('[Content_Types].xml') &&
    entries.has(format === 'docx' ? 'word/document.xml' : 'xl/workbook.xml') &&
    [...entries].every(
      (name) =>
        !/(?:vbaProject\.bin|activeX\/|embeddings\/|externalLinks\/|customUI\/)/i.test(name),
    )
  );
}

export async function inspectAttachment(
  name: string,
  encoded: string,
  policy: AttachmentField,
  scan?: UploadScan,
) {
  const fileName = typeof name === 'string' ? name.trim().normalize('NFC') : '';
  if (
    !fileName ||
    fileName.length > 180 ||
    fileName === '.' ||
    fileName === '..' ||
    /[\ud800-\udfff]/u.test(fileName) ||
    /[/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(fileName)
  )
    throw new HttpError(400, 'WORKFLOW_ATTACHMENT_NAME_INVALID');
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(maxAttachmentBytes / 3) * 4)
    throw new HttpError(413, 'WORKFLOW_ATTACHMENT_TOO_LARGE');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > policy.maxBytes) throw new HttpError(413, 'WORKFLOW_ATTACHMENT_TOO_LARGE');
  if (!bytes.length || bytes.toString('base64') !== encoded)
    throw new HttpError(400, 'WORKFLOW_ATTACHMENT_CONTENT_INVALID');
  const suffix = fileName.includes('.')
    ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
    : '';
  const extension = suffix === 'jpg' ? 'jpeg' : suffix;
  const format = attachmentFormats.find((item) => item === extension) ?? ('unknown' as const);
  let ready = false;
  try {
    ready =
      format !== 'unknown' &&
      policy.formats.includes(format) &&
      (await matchesFormat(format, bytes));
  } catch {
    // Invalid UTF-8 or a malformed archive fails the local structural gate.
  }
  if (ready && scan) ready = (await scanWorkflowAttachment(scan, bytes)) === 'clean';
  return {
    fileName,
    format,
    byteCount: bytes.length,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    status: ready ? ('ready' as const) : ('quarantined' as const),
    content: ready ? bytes : null,
  };
}

export function attachmentDisposition(name: string) {
  const filename = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16),
  );
  return 'attachment; filename="download"; filename*=UTF-8\'\'' + filename;
}
