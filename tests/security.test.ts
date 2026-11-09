import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { seal, unseal, csrfToken } from '../src/security.js';
import { verifyAccessToken } from '../src/oidc.js';

test('encrypted session payload is bound to the application and detects tampering', () => {
  const key = randomBytes(32).toString('hex');
  const value = seal({ value: 'synthetic' }, key, 'session:aio-foundation');
  assert.deepEqual(unseal(value, key, 'session:aio-foundation'), { value: 'synthetic' });
  assert.throws(() => unseal(value, key, 'session:aio-probe'));
  const parts = value.split('.');
  parts[2] = 'AAAA' + parts[2]!.slice(4);
  assert.throws(() => unseal(parts.join('.'), key, 'session:aio-foundation'));
  assert.notEqual(
    csrfToken('session', key, 'aio-foundation'),
    csrfToken('session', key, 'aio-probe'),
  );
});
test('access tokens reject wrong issuer, audience, authorized party, expiry and signature', async () => {
  const first = await generateKeyPair('RS256'),
    second = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(first.publicKey)), kid: 'first' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const issuer = 'https://issuer.example.test/realm';
  const token = async (overrides: Record<string, unknown> = {}, otherKey = false) =>
    new SignJWT({
      sub: 'demo',
      azp: 'aio-foundation',
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'first' })
      .setIssuedAt()
      .setIssuer(typeof overrides.iss === 'string' ? overrides.iss : issuer)
      .setAudience(typeof overrides.aud === 'string' ? overrides.aud : 'aio-foundation-api')
      .setExpirationTime(typeof overrides.exp === 'number' ? overrides.exp : '5m')
      .sign(otherKey ? second.privateKey : first.privateKey);
  assert.deepEqual(
    await verifyAccessToken(await token(), keys, issuer, 'aio-foundation-api', 'aio-foundation'),
    { issuer, subject: 'demo' },
  );
  for (const value of [
    await token({ iss: 'https://evil.example.test' }),
    await token({ aud: 'aio-probe-api' }),
    await token({ azp: 'aio-probe' }),
    await token({ exp: 1 }),
    await token({}, true),
    'not.a.token',
  ])
    await assert.rejects(
      () => verifyAccessToken(value, keys, issuer, 'aio-foundation-api', 'aio-foundation'),
      { code: 'INVALID_ACCESS_TOKEN' },
    );
});
test('a rotated signing key works only after entering the trusted key set', async () => {
  const first = await generateKeyPair('RS256'),
    second = await generateKeyPair('RS256');
  const old = { ...(await exportJWK(first.publicKey)), kid: 'old' };
  const next = { ...(await exportJWK(second.publicKey)), kid: 'new' };
  const token = await new SignJWT({ sub: 'demo', azp: 'aio-foundation' })
    .setProtectedHeader({ alg: 'RS256', kid: 'new' })
    .setIssuer('https://issuer.example.test')
    .setAudience('aio-foundation-api')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(second.privateKey);
  await assert.rejects(() =>
    verifyAccessToken(
      token,
      createLocalJWKSet({ keys: [old] }),
      'https://issuer.example.test',
      'aio-foundation-api',
      'aio-foundation',
    ),
  );
  await verifyAccessToken(
    token,
    createLocalJWKSet({ keys: [old, next] }),
    'https://issuer.example.test',
    'aio-foundation-api',
    'aio-foundation',
  );
});
