import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const randomToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export function seal(value: unknown, keyHex: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString('base64url')).join('.');
}
export function unseal<T>(value: string, keyHex: string, context: string): T {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid ciphertext.');
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Invalid ciphertext.');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8')) as T;
}
export const csrfToken = (session: string, key: string, app: string): string =>
  createHmac('sha256', Buffer.from(key, 'hex'))
    .update('csrf:' + app + ':' + session)
    .digest('base64url');
export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
  ) {
    super(code);
  }
}
