/** Separate proof domain from subjects. Bind every query field, app, token and short time window. */
export type DirectoryQuery = {
  kind: 'units' | 'people';
  tenantId: string;
  orgUnitId?: string;
  accountIds?: string[];
  cursor?: string;
  search?: string;
};
export type DirectoryUnit = {
  id: string;
  code: string;
  name: string;
  legalEntityId: string;
  legalEntityName: string;
};
export type DirectoryPerson = {
  accountId: string;
  personId: string;
  displayName: string;
  units: { id: string; name: string; employeeCodes: string[] }[];
};
const encode = (value: string) => new TextEncoder().encode(value);
async function key(secret: string, appCode: string) {
  const source = await crypto.subtle.importKey('raw', encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encode(appCode),
      info: encode('aio-integration-directory-v1'),
    },
    source,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}
async function message(appCode: string, token: string, query: DirectoryQuery, time: number) {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encode(token))),
    (value) => value.toString(16).padStart(2, '0'),
  ).join('');
  return encode(
    JSON.stringify([
      'POST',
      'directory-v1',
      appCode,
      time,
      digest,
      query.kind,
      query.tenantId,
      query.orgUnitId ?? null,
      query.accountIds ? [...query.accountIds].sort() : null,
      query.cursor ?? null,
      query.search ?? '',
    ]),
  );
}
export async function directoryProof(
  secret: string,
  appCode: string,
  token: string,
  query: DirectoryQuery,
  time = Math.floor(Date.now() / 1000),
) {
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await key(secret, appCode),
      await message(appCode, token, query, time),
    ),
  );
  return time + '.' + Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
export async function verifyDirectoryProof(
  secret: string,
  appCode: string,
  token: string,
  query: DirectoryQuery,
  proof: string,
) {
  const match = /^(\d{10})\.([0-9a-f]{64})$/.exec(proof);
  if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 30) return false;
  return crypto.subtle.verify(
    'HMAC',
    await key(secret, appCode),
    Uint8Array.from(match[2]!.match(/../g)!, (value) => parseInt(value, 16)),
    await message(appCode, token, query, Number(match[1])),
  );
}
