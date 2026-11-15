import { stagingAppOrigin, stagingTarget } from '../staging-endpoints.js';
import type { StagingSlot } from '../staging-endpoints.js';

export class LmsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export type LocalLmsEnvironment = {
  mode: 'local';
  purpose: 'tlqm-aio-lms-local' | 'tlqm-aio-lms-test';
};
export type LmsConfig = {
  instanceId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  baseUrl: string;
  foundationUrl: string;
  encryptionKey: string;
} & (
  | LocalLmsEnvironment
  | { mode: 'staging'; purpose: 'tlqm-aio-lms-staging'; slot: StagingSlot; namedHosts?: true }
);

export function lmsEnvironment(config: LmsConfig) {
  return config.mode === 'staging'
    ? 'staging'
    : config.purpose === 'tlqm-aio-lms-test'
      ? 'test'
      : 'local';
}
export function validateLmsConfig<T extends LmsConfig>(value: T): T {
  const local = value?.mode === 'local';
  const config: LmsConfig = value;
  const staging = config?.mode === 'staging' ? config : null;
  const target =
    staging && (staging.slot === 'a' || staging.slot === 'b') ? stagingTarget(staging.slot) : null;
  const portal =
    staging && target
      ? stagingAppOrigin(staging.slot, 'aio-foundation', target.foundation, staging.namedHosts)
      : 'http://127.0.0.1:4100';
  const lms =
    staging && target
      ? stagingAppOrigin(staging.slot, 'aio-lms-sandbox', target.lms, staging.namedHosts)
      : 'http://127.0.0.1:4104';
  if (
    (!local && !target) ||
    (staging && staging.namedHosts !== undefined && staging.namedHosts !== true) ||
    !(local ? ['tlqm-aio-lms-local', 'tlqm-aio-lms-test'] : ['tlqm-aio-lms-staging']).includes(
      value.purpose,
    ) ||
    !/^[0-9a-f-]{36}$/.test(value.instanceId) ||
    value.issuer !== (target?.issuer ?? 'http://127.0.0.1:8180/realms/aio-local') ||
    value.clientId !== 'aio-lms-sandbox' ||
    value.baseUrl !== lms ||
    value.audience !== 'aio-lms-sandbox-api' ||
    value.foundationUrl !== portal + '/api/v1/integrations/aio-lms-sandbox/authorize' ||
    !/^[0-9a-f]{64}$/.test(value.clientSecret) ||
    !/^[0-9a-f]{64}$/.test(value.encryptionKey)
  )
    throw new LmsError(503, 'LMS_CONFIGURATION_INVALID');
  return value;
}
const encode = (value: string) => new TextEncoder().encode(value);
function hexBytes(value: string) {
  return Uint8Array.from(value.match(/.{2}/g)!.map((pair) => parseInt(pair, 16)));
}
export function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 100000)
    throw new LmsError(401, 'LMS_SESSION_INVALID');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) =>
    character.charCodeAt(0),
  );
}
export const opaque = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function hash(value: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(value))));
}
async function key(config: LmsConfig, purpose: 'payload' | 'csrf') {
  const material = await crypto.subtle.importKey(
    'raw',
    hexBytes(config.encryptionKey),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encode(config.instanceId),
      info: encode(config.clientId + ':' + config.purpose + ':' + purpose),
    },
    material,
    purpose === 'payload'
      ? { name: 'AES-GCM', length: 256 }
      : { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    purpose === 'payload' ? ['encrypt', 'decrypt'] : ['sign', 'verify'],
  );
}
export async function seal(config: LmsConfig, value: unknown, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encode(config.clientId + ':' + config.purpose + ':' + context),
    },
    await key(config, 'payload'),
    encode(JSON.stringify(value)),
  );
  return base64url(iv) + '.' + base64url(new Uint8Array(encrypted));
}
export async function unseal<T>(config: LmsConfig, value: string, context: string): Promise<T> {
  try {
    const [iv, encrypted, extra] = value.split('.');
    if (!iv || !encrypted || extra) throw new Error('Invalid envelope');
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decode(iv),
        additionalData: encode(config.clientId + ':' + config.purpose + ':' + context),
      },
      await key(config, 'payload'),
      decode(encrypted),
    );
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch {
    throw new LmsError(401, 'LMS_SESSION_INVALID');
  }
}
export async function csrf(config: LmsConfig, sessionHash: string) {
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', await key(config, 'csrf'), encode(sessionHash)),
    ),
  );
}
export async function verifyCsrf(config: LmsConfig, request: Request, sessionHash: string) {
  const value = request.headers.get('x-csrf-token');
  if (
    request.headers.get('origin') !== config.baseUrl ||
    !value ||
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    !(await crypto.subtle.verify(
      'HMAC',
      await key(config, 'csrf'),
      decode(value),
      encode(sessionHash),
    ))
  )
    throw new LmsError(403, 'CSRF_REJECTED');
}
export function cookie(request: Request, name: string) {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(name + '='));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export function cookieHeader(name: string, value: string, seconds: number, secure = false) {
  return (
    name +
    '=' +
    value +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
    seconds +
    (secure ? '; Secure' : '')
  );
}
