import { assertLocalClient } from '../src/config.js';
import type { ClientConfig } from '../src/config.js';
import { equalSecret } from '../src/security.js';

export type ClientManifest =
  | { version: 1; code: string; name: string; port: number }
  | { version: 2; code: string; name: string; port: number; kind: 'application' }
  | { version: 3; code: string; name: string; port: number; kind: 'external-application' };
export function parseClientManifest(input: unknown): ClientManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid client manifest.');
  const value = input as ClientManifest;
  const valid =
    value.version === 1
      ? Object.keys(value).sort().join(',') === 'code,name,port,version'
      : ((value.version === 2 && value.kind === 'application') ||
          (value.version === 3 && value.kind === 'external-application')) &&
        Object.keys(value).sort().join(',') === 'code,kind,name,port,version';
  if (!valid) throw new Error('Client manifest must match the versioned local contract.');
  manifestClient(value, '0'.repeat(64));
  return value;
}
export function manifestClient(manifest: ClientManifest, secret: string): ClientConfig {
  const client: ClientConfig = {
    kind: manifest.version === 1 ? 'integration-probe' : manifest.kind,
    code: manifest.code,
    name: manifest.name,
    port: manifest.port,
    baseUrl: 'http://127.0.0.1:' + manifest.port,
    clientId: manifest.code,
    audience: manifest.code + '-api',
    clientSecret: secret,
  };
  assertLocalClient(client);
  return client;
}
export function clientRepresentation(client: ClientConfig, instanceId: string) {
  assertLocalClient(client);
  return {
    clientId: client.clientId,
    name: client.name,
    secret: client.clientSecret,
    enabled: true,
    protocol: 'openid-connect',
    publicClient: false,
    bearerOnly: false,
    consentRequired: false,
    clientAuthenticatorType: 'client-secret',
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    fullScopeAllowed: false,
    redirectUris: [client.baseUrl + '/auth/callback'],
    webOrigins: [],
    attributes: {
      'aio.local.instance': instanceId,
      'aio.local.contract': '1',
      'pkce.code.challenge.method': 'S256',
      'post.logout.redirect.uris': client.baseUrl + '/',
      'backchannel.logout.url':
        'http://host.docker.internal:' + client.port + '/auth/backchannel-logout',
      'backchannel.logout.session.required': 'true',
    },
    protocolMappers: [
      {
        name: 'api-audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.custom.audience': client.audience,
          'access.token.claim': 'true',
          'introspection.token.claim': 'true',
          'id.token.claim': 'false',
        },
      },
      {
        name: 'introspection-audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.client.audience': client.clientId,
          'access.token.claim': 'true',
          'introspection.token.claim': 'true',
          'id.token.claim': 'false',
        },
      },
      {
        name: 'aio-authentication-methods',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-amr-mapper',
        config: { 'access.token.claim': 'true', 'id.token.claim': 'true' },
      },
    ],
  };
}
export function verifyClientRegistration(
  client: ClientConfig,
  instanceId: string,
  actual: Record<string, unknown>,
  allowDisabled = false,
) {
  const expected = clientRepresentation(client, instanceId);
  for (const field of [
    'clientId',
    'protocol',
    'publicClient',
    'bearerOnly',
    'standardFlowEnabled',
    'implicitFlowEnabled',
    'directAccessGrantsEnabled',
    'serviceAccountsEnabled',
    'fullScopeAllowed',
    'clientAuthenticatorType',
  ] as const)
    if (actual[field] !== expected[field])
      throw new Error('Client registration security settings do not match the contract.');
  if ((!allowDisabled && actual.enabled !== true) || typeof actual.enabled !== 'boolean')
    throw new Error('Client is disabled; explicit activation is required.');
  for (const field of ['redirectUris', 'webOrigins'] as const)
    if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field]))
      throw new Error('Client callback/origin contract mismatch.');
  const attributes = actual.attributes as Record<string, string> | undefined;
  for (const [key, value] of Object.entries(expected.attributes))
    if (attributes?.[key] !== value)
      throw new Error('Client ownership or protocol attribute mismatch.');
  const mappers = actual.protocolMappers as
    | { name: string; protocol: string; protocolMapper: string; config: Record<string, string> }[]
    | undefined;
  if (!Array.isArray(mappers) || mappers.length !== expected.protocolMappers.length)
    throw new Error('Unexpected client protocol mappers.');
  for (const mapper of expected.protocolMappers) {
    const matches = mappers.filter((value) => value.name === mapper.name);
    const found = matches[0];
    if (
      matches.length !== 1 ||
      !found ||
      found.protocol !== mapper.protocol ||
      found.protocolMapper !== mapper.protocolMapper ||
      Object.entries(mapper.config).some(([key, value]) => found.config[key] !== value)
    )
      throw new Error('Client audience or MFA mapper mismatch.');
    if (
      Object.keys(found.config).some(
        (key) => key.startsWith('included.') && !Object.hasOwn(mapper.config, key),
      )
    )
      throw new Error('Client mapper contains an unexpected audience.');
  }
  if (typeof actual.secret !== 'string' || !equalSecret(actual.secret, client.clientSecret))
    throw new Error('Client credential does not match the local provisioning receipt.');
}
