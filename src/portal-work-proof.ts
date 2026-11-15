/** Read-only delegated work feed. Separate proof domain from Directory/identity/onboarding. */
export type PortalWorkQuery = {
  instanceId: string;
  environment: 'local' | 'test' | 'staging';
  tenantId: string;
  sessionHash: string;
  cursor?: string;
};
const encode = (value: string) => new TextEncoder().encode(value);
async function key(secret: string, appCode: string) {
  const source = await crypto.subtle.importKey('raw', encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encode(appCode),
      info: encode('aio-portal-work-read-v1'),
    },
    source,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}
async function message(
  purpose: 'request' | 'authorize',
  appCode: string,
  token: string,
  q: PortalWorkQuery,
  time: number,
) {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encode(token))),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
  return encode(
    JSON.stringify([
      'POST',
      'portal-work-read-v1',
      purpose,
      appCode,
      time,
      digest,
      q.instanceId,
      q.environment,
      q.tenantId,
      q.sessionHash,
      q.cursor ?? null,
    ]),
  );
}
export async function portalWorkProof(
  secret: string,
  appCode: string,
  token: string,
  query: PortalWorkQuery,
  purpose: 'request' | 'authorize',
  time = Math.floor(Date.now() / 1000),
) {
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await key(secret, appCode),
      await message(purpose, appCode, token, query, time),
    ),
  );
  return time + '.' + Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
}
export async function verifyPortalWorkProof(
  secret: string,
  appCode: string,
  token: string,
  query: PortalWorkQuery,
  purpose: 'request' | 'authorize',
  proof: string,
) {
  const m = /^(\d{10})\.([0-9a-f]{64})$/.exec(proof);
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 30) return false;
  return crypto.subtle.verify(
    'HMAC',
    await key(secret, appCode),
    Uint8Array.from(m[2]!.match(/../g)!, (v) => parseInt(v, 16)),
    await message(purpose, appCode, token, query, Number(m[1])),
  );
}
