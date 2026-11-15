import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseUnavailable } from '../src/dependencies.js';
import { HttpError } from '../src/security.js';
import { verifyAccessToken } from '../src/oidc.js';
import { generateKeyPair, SignJWT } from 'jose';

test('database downtime is distinguished from constraint, permission and application errors', () => {
  for (const code of ['ECONNREFUSED', '57P01', '57P03', '53300', '08006'])
    assert.equal(databaseUnavailable({ code }), true);
  for (const code of ['23505', '23503', '42501', '40001'])
    assert.equal(databaseUnavailable({ code }), false);
  assert.equal(databaseUnavailable(new Error('Connection terminated unexpectedly')), true);
  assert.equal(databaseUnavailable(new Error('Query read timeout')), true);
  assert.equal(databaseUnavailable({ code: '57014', message: 'statement timeout' }), false);
  assert.equal(databaseUnavailable(new Error('Synthetic arbitrary failure')), false);
});
test('JWKS dependency unavailability stays 503 while invalid access tokens stay 401', async () => {
  const key = await generateKeyPair('RS256');
  const token = await new SignJWT({ sub: 'fixture', azp: 'aio-foundation', typ: 'Bearer' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://example.test')
    .setAudience('aio-foundation-api')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);
  const unavailable = async () => {
    throw new HttpError(503, 'IDENTITY_UNAVAILABLE');
  };
  await assert.rejects(
    () =>
      verifyAccessToken(
        token,
        unavailable,
        'https://example.test',
        'aio-foundation-api',
        'aio-foundation',
      ),
    { statusCode: 503, code: 'IDENTITY_UNAVAILABLE' },
  );
  await assert.rejects(
    () =>
      verifyAccessToken(
        'not.a.token',
        unavailable,
        'https://example.test',
        'aio-foundation-api',
        'aio-foundation',
      ),
    { statusCode: 401, code: 'INVALID_ACCESS_TOKEN' },
  );
});
