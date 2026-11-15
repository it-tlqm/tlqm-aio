import { LmsError, base64url } from './security.js';
export const LMS_PAGE_SIZE = 100;
export function encodeListCursor(
  kind: 'courses' | 'media' | 'history' | 'legacy',
  values: [number | string, string],
) {
  return base64url(new TextEncoder().encode(JSON.stringify([1, kind, ...values])));
}
function parse(value: string | undefined, kind: string): unknown[] | null {
  if (value === undefined) return null;
  try {
    if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    if (!Array.isArray(body) || body.length !== 4 || body[0] !== 1 || body[1] !== kind)
      throw new Error();
    return body.slice(2);
  } catch {
    throw new LmsError(400, 'INVALID_CURSOR');
  }
}
export function listCursor(
  value: string | undefined,
  kind: 'courses' | 'media' | 'history',
): [number, string] | null {
  const result = parse(value, kind);
  if (!result) return null;
  if (
    !Number.isSafeInteger(result[0]) ||
    Number(result[0]) < 0 ||
    typeof result[1] !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(result[1])
  )
    throw new LmsError(400, 'INVALID_CURSOR');
  return result as [number, string];
}
export function legacyCursor(value: string | undefined): [string, string] | null {
  const result = parse(value, 'legacy');
  if (!result) return null;
  if (
    !result.every(
      (item, index) =>
        typeof item === 'string' &&
        item.length < 160 &&
        (index === 1 || item.length > 0) &&
        !/[\u0000-\u001f]/.test(item),
    )
  )
    throw new LmsError(400, 'INVALID_CURSOR');
  return result as [string, string];
}
