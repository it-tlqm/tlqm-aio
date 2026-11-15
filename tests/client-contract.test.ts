import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalClient, assertLocalClients, bffClients } from '../src/config.js';
import {
  clientRepresentation,
  manifestClient,
  parseClientManifest,
  verifyClientRegistration,
} from '../scripts/client-contract.js';

const manifest = {
  version: 1,
  code: 'aio-contract-test',
  name: 'Synthetic independent client',
  port: 4112,
} as const;
const client = manifestClient(manifest, 'a'.repeat(64));
test('external manifest v3 preserves OIDC constraints and is never served as a Foundation BFF', () => {
  const manifest = {
    version: 3,
    kind: 'external-application',
    code: 'aio-lms-sandbox',
    name: 'LMS sandbox',
    port: 4104,
  } as const;
  const external = manifestClient(parseClientManifest(manifest), 'a'.repeat(64));
  assert.equal(external.kind, 'external-application');
  assert.deepEqual(bffClients({ clients: [client, external] }), [client]);
  assert.deepEqual(clientRepresentation(external, 'instance').redirectUris, [
    'http://127.0.0.1:4104/auth/callback',
  ]);
  for (const input of [
    { ...manifest, kind: 'application' },
    { ...manifest, redirectUri: 'https://example.test' },
    { ...manifest, port: 4100 },
  ])
    assert.throws(() => parseClientManifest(input));
});

test('application manifest v2 remains strict and keeps the OIDC isolation contract', () => {
  const forms = {
    version: 2,
    kind: 'application',
    code: 'aio-forms',
    name: 'AIO Forms',
    port: 4103,
  } as const;
  const parsed = parseClientManifest(forms);
  const config = manifestClient(parsed, 'a'.repeat(64));
  assert.equal(config.kind, 'application');
  assert.equal(config.audience, 'aio-forms-api');
  assert.deepEqual(clientRepresentation(config, 'instance').redirectUris, [
    'http://127.0.0.1:4103/auth/callback',
  ]);
  for (const value of [
    { ...forms, kind: 'core' },
    { ...forms, callback: 'https://example.test' },
    { ...forms, version: 1 },
    { ...forms, code: 'aio-foundation', port: 4100 },
  ])
    assert.throws(() => parseClientManifest(value));
});
const core = (code: string, port: number) => ({
  code,
  name: code,
  port,
  baseUrl: 'http://127.0.0.1:' + port,
  clientId: code,
  audience: code + '-api',
  clientSecret: 'b'.repeat(64),
});

test('onboarding manifest supports new client names while rejecting arbitrary URLs, credentials, core ports and identifiers', () => {
  assert.deepEqual(parseClientManifest(manifest), manifest);
  assertLocalClients([core('aio-foundation', 4100), core('aio-probe', 4101), client]);
  for (const value of [
    null,
    { ...manifest, version: 2 },
    { ...manifest, issuer: 'http://example.test' },
    { ...manifest, clientSecret: 'arbitrary' },
    { ...manifest, port: 4100 },
    { ...manifest, port: 4200 },
    { ...manifest, port: '4112' },
    { ...manifest, code: '../escape' },
    { ...manifest, code: 'aio-foundation' },
  ])
    assert.throws(() => parseClientManifest(value));
  for (const value of [
    { ...client, baseUrl: 'http://localhost:4112' },
    { ...client, baseUrl: client.baseUrl + '/?x=1' },
    { ...client, audience: 'aio-foundation-api' },
    { ...client, clientId: 'aio-probe' },
    { ...client, clientSecret: 'invalid' },
  ])
    assert.throws(() => assertLocalClient(value));
  assert.throws(() =>
    assertLocalClients([
      core('aio-foundation', 4100),
      core('aio-probe', 4101),
      client,
      { ...client },
    ]),
  );
});

test('live client verification rejects contract drift including audience widening, grants, PKCE, callback and credential mismatch', () => {
  verifyClientRegistration(client, 'instance', clientRepresentation(client, 'instance'));
  const mutations: ((value: ReturnType<typeof clientRepresentation>) => void)[] = [
    (v) => {
      v.publicClient = true;
    },
    (v) => {
      v.implicitFlowEnabled = true;
    },
    (v) => {
      v.directAccessGrantsEnabled = true;
    },
    (v) => {
      v.serviceAccountsEnabled = true;
    },
    (v) => {
      v.fullScopeAllowed = true;
    },
    (v) => {
      v.enabled = false;
    },
    (v) => {
      v.redirectUris.push('http://127.0.0.1:4112/*');
    },
    (v) => {
      v.attributes['pkce.code.challenge.method'] = 'plain';
    },
    (v) => {
      v.attributes['aio.local.instance'] = 'different';
    },
    (v) => {
      v.protocolMappers[0]!.config['included.custom.audience'] = 'aio-foundation-api';
    },
    (v) => {
      v.protocolMappers[0]!.config['included.client.audience'] = 'aio-foundation';
    },
    (v) => {
      v.protocolMappers.pop();
    },
    (v) => {
      v.secret = 'c'.repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const value = clientRepresentation(client, 'instance');
    mutate(value);
    assert.throws(() => verifyClientRegistration(client, 'instance', value));
  }
  const disabled = clientRepresentation(client, 'instance');
  disabled.enabled = false;
  verifyClientRegistration(client, 'instance', disabled, true);
});
