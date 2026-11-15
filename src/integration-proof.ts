/** Read-only service proof: binds a confidential adapter, caller token, exact IDs and 30s window.
 * The endpoint also revalidates the caller token and current grants on every request, including retries.
 */
const encode = (value: string) => new TextEncoder().encode(value);
async function key(secret: string, appCode: string) {
  const source = await crypto.subtle.importKey('raw', encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encode(appCode),
      info: encode('aio-integration-subjects-v1'),
    },
    source,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}
async function message(appCode: string, token: string, ids: string[], time: number) {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encode(token))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  return encode(JSON.stringify(['POST', 'subjects-v1', appCode, time, digest, [...ids].sort()]));
}
export async function subjectProof(
  secret: string,
  appCode: string,
  token: string,
  ids: string[],
  time = Math.floor(Date.now() / 1000),
) {
  const signed = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await key(secret, appCode),
      await message(appCode, token, ids, time),
    ),
  );
  return time + '.' + Array.from(signed, (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function verifySubjectProof(
  secret: string,
  appCode: string,
  token: string,
  ids: string[],
  proof: string,
) {
  const match = /^(\d{10})\.([0-9a-f]{64})$/.exec(proof);
  if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 30) return false;
  const bytes = Uint8Array.from(match[2]!.match(/../g)!, (value) => parseInt(value, 16));
  return crypto.subtle.verify(
    'HMAC',
    await key(secret, appCode),
    bytes,
    await message(appCode, token, ids, Number(match[1])),
  );
}
