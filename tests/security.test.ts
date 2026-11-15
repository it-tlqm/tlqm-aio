import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { seal, unseal, csrfToken } from '../src/security.js';
import { OidcClient, verifyAccessToken } from '../src/oidc.js';
import { LmsOidc } from '../src/lms/oidc.js';
import type { LocalConfig } from '../src/config.js';

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
      typ: 'Bearer',
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
  assert.deepEqual(
    await verifyAccessToken(
      await token({ amr: ['pwd', 'otp'] }),
      keys,
      issuer,
      'aio-foundation-api',
      'aio-foundation',
    ),
    { issuer, subject: 'demo', authenticationMethods: ['pwd', 'otp'] },
  );
  assert.deepEqual(
    await verifyAccessToken(
      await token({ amr: 'pwd otp' }),
      keys,
      issuer,
      'aio-foundation-api',
      'aio-foundation',
    ),
    { issuer, subject: 'demo' },
  );
  for (const value of [
    await token({ iss: 'https://evil.example.test' }),
    await token({ aud: 'aio-probe-api' }),
    await token({ azp: 'aio-probe' }),
    await token({ exp: 1 }),
    await token({ typ: 'ID' }),
    await token({ typ: 'Logout' }),
    await token({ typ: 'Refresh' }),
    await token({ typ: undefined }),
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
  const token = await new SignJWT({ sub: 'demo', azp: 'aio-foundation', typ: 'Bearer' })
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

test('BFF and LMS require the signed Keycloak token type for login, refresh, access and logout', async (t) => {
  const issuer = 'http://127.0.0.1:8180/realms/aio-local';
  const endpoints = issuer + '/protocol/openid-connect';
  const key = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'fixture' };
  const authTime = Math.floor(Date.now() / 1000) - 2;
  const secret = 'a'.repeat(64);
  const instanceId = '12345678-1234-4234-8234-123456789abc';
  const metadata = {
    issuer,
    authorization_endpoint: endpoints + '/auth',
    token_endpoint: endpoints + '/token',
    introspection_endpoint: endpoints + '/token/introspect',
    jwks_uri: endpoints + '/certs',
    end_session_endpoint: endpoints + '/logout',
    id_token_signing_alg_values_supported: ['RS256'],
  };
  let grantResponse: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const address = input instanceof Request ? input.url : String(input);
    switch (address) {
      case issuer + '/.well-known/openid-configuration':
        return Response.json(metadata);
      case metadata.jwks_uri:
        return Response.json({ keys: [jwk] });
      case metadata.token_endpoint:
        return Response.json(grantResponse);
      case metadata.introspection_endpoint:
        return Response.json({ active: true, sub: 'fixture-subject' });
      default:
        throw new Error('Unexpected synthetic OIDC endpoint.');
    }
  });
  const runtime: LocalConfig = {
    mode: 'local',
    instanceId,
    issuer,
    databaseUrl: '',
    encryptionKey: secret,
    clients: [],
    users: [],
    keycloakAdmin: { username: '', password: '' },
  };
  async function checkGrantTypes<Session extends { subject: string }>(
    client: {
      complete: () => Promise<Session>;
      refresh: (session: Session) => Promise<Session>;
    },
    wrongIdToken: string,
  ) {
    const initial = await client.complete();
    assert.equal((await client.refresh(initial)).subject, 'fixture-subject');
    grantResponse.id_token = wrongIdToken;
    await assert.rejects(client.complete, { code: 'OIDC_CALLBACK_REJECTED' });
    await assert.rejects(() => client.refresh(initial), { code: 'SESSION_IDENTITY_CHANGED' });
  }
  for (const { clientId, baseUrl, create } of [
    {
      clientId: 'aio-foundation',
      baseUrl: 'http://127.0.0.1:4100',
      create: (clientId: string, baseUrl: string) =>
        OidcClient.create(runtime, {
          code: clientId,
          name: 'Foundation',
          port: 4100,
          baseUrl,
          clientId,
          clientSecret: secret,
          audience: clientId + '-api',
        }),
    },
    {
      clientId: 'aio-lms-sandbox',
      baseUrl: 'http://127.0.0.1:4104',
      create: (clientId: string, baseUrl: string) =>
        LmsOidc.create({
          mode: 'local',
          purpose: 'tlqm-aio-lms-test',
          instanceId,
          issuer,
          clientId,
          baseUrl,
          clientSecret: secret,
          audience: clientId + '-api',
          foundationUrl: 'http://127.0.0.1:4100/api/v1/integrations/aio-lms-sandbox/authorize',
          encryptionKey: secret,
        }),
    },
  ]) {
    const signed = (
      audience: string,
      claims: Record<string, unknown>,
      typ: string | null = 'JWT',
    ) =>
      new SignJWT({
        sub: 'fixture-subject',
        sid: 'fixture-session',
        azp: clientId,
        auth_time: authTime,
        iat: Math.floor(Date.now() / 1000),
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture', ...(typ === null ? {} : { typ }) })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime('5m')
        .sign(key.privateKey);
    const oidc = await create(clientId, baseUrl);
    const audience = clientId + '-api';
    const accessToken = await signed(audience, { typ: 'Bearer' });
    await oidc.access(accessToken);
    for (const type of ['ID', 'Logout', 'Refresh', undefined]) {
      const wrongType = await signed(audience, { typ: type });
      await assert.rejects(() => oidc.access(wrongType), { code: 'INVALID_ACCESS_TOKEN' });
    }
    const events = { 'http://schemas.openid.net/event/backchannel-logout': {} };
    const logoutClaims = { jti: 'fixture-logout', events, typ: 'Logout' };
    const logoutType = 'logout+jwt';
    const logoutToken = await signed(clientId, logoutClaims, logoutType);
    assert.equal((await oidc.logoutToken(logoutToken)).jti, 'fixture-logout');
    const rejectLogout = (value: string) =>
      assert.rejects(() => oidc.logoutToken(value), {
        code: clientId === 'aio-foundation' ? 'INVALID_LOGOUT_TOKEN' : 'LOGOUT_TOKEN_REJECTED',
      });
    for (const type of ['Bearer', 'ID', undefined]) {
      await rejectLogout(await signed(clientId, { ...logoutClaims, typ: type }, logoutType));
    }
    for (const header of ['JWT', 'at+jwt', null]) {
      await rejectLogout(await signed(clientId, logoutClaims, header));
    }
    for (const claims of [
      { events: {} },
      { nonce: 'fixture-nonce' },
      { iat: Math.floor(Date.now() / 1000) - 121 },
    ]) {
      await rejectLogout(await signed(clientId, { ...logoutClaims, ...claims }, logoutType));
    }
    const { transaction } = await oidc.begin();
    const callback = new URL(baseUrl + '/auth/callback');
    callback.searchParams.set('state', transaction.state);
    callback.searchParams.set('code', 'synthetic-code');
    const idClaims = { nonce: transaction.nonce };
    grantResponse = {
      access_token: accessToken,
      refresh_token: 'synthetic-refresh',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: await signed(clientId, { ...idClaims, typ: 'ID' }),
    };
    const wrongIdToken = await signed(clientId, { ...idClaims, typ: 'Bearer' });
    if (oidc instanceof OidcClient) {
      await checkGrantTypes(
        {
          complete: () => oidc.complete(callback, transaction),
          refresh: (session) => oidc.refresh(session),
        },
        wrongIdToken,
      );
    } else {
      await checkGrantTypes(
        {
          complete: () => oidc.complete(callback, transaction),
          refresh: (session) => oidc.refresh(session),
        },
        wrongIdToken,
      );
    }
  }
});
