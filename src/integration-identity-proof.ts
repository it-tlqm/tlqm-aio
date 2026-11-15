export type IdentityQuery = { tenantId: string; accountId: string; orgUnitId: string };
export type IntegrationIdentity = {
  accountId: string;
  personId: string;
  tenantId: string;
  orgUnitId: string;
  issuer: string;
  subject: string;
  displayName: string;
  unitName: string;
};
const encode = (value: string) => new TextEncoder().encode(value);
async function key(secret: string, app: string) {
  const source = await crypto.subtle.importKey('raw', encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encode(app),
      info: encode('aio-integration-identity-v1'),
    },
    source,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}
async function message(app: string, token: string, query: IdentityQuery, time: number) {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encode(token))),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
  return encode(
    JSON.stringify([
      'POST',
      'identity-v1',
      app,
      time,
      digest,
      query.tenantId,
      query.accountId,
      query.orgUnitId,
    ]),
  );
}
export async function identityProof(
  secret: string,
  app: string,
  token: string,
  query: IdentityQuery,
  time = Math.floor(Date.now() / 1000),
) {
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await key(secret, app),
      await message(app, token, query, time),
    ),
  );
  return time + '.' + Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
}
export async function verifyIdentityProof(
  secret: string,
  app: string,
  token: string,
  query: IdentityQuery,
  proof: string,
) {
  const match = /^(\d{10})\.([0-9a-f]{64})$/.exec(proof);
  if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 30) return false;
  return crypto.subtle.verify(
    'HMAC',
    await key(secret, app),
    Uint8Array.from(match[2]!.match(/../g)!, (v) => parseInt(v, 16)),
    await message(app, token, query, Number(match[1])),
  );
}
