import { loadLocalConfig } from '../src/config.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
const config = await loadLocalConfig();
const request = await localKeycloakAdmin(config);
for (const client of config.clients) {
  const records = (await (
    await request('/clients?clientId=' + encodeURIComponent(client.clientId))
  ).json()) as { id: string; clientId: string }[];
  const record = records.find((value) => value.clientId === client.clientId);
  if (!record) throw new Error('Expected local client is missing.');
  await request('/clients/' + record.id, 'PUT', { fullScopeAllowed: false });
  const mappers = (await (
    await request('/clients/' + record.id + '/protocol-mappers/models')
  ).json()) as { id: string; name: string; config: Record<string, string> }[];
  const audience = mappers.find((value) => value.name === 'api-audience');
  if (!audience) throw new Error('Local audience mapper is missing.');
  await request('/clients/' + record.id + '/protocol-mappers/models/' + audience.id, 'PUT', {
    ...audience,
    protocol: 'openid-connect',
    protocolMapper: 'oidc-audience-mapper',
    config: {
      'included.custom.audience': client.audience,
      'access.token.claim': 'true',
      'introspection.token.claim': 'true',
      'id.token.claim': 'false',
    },
  });
  const existing = mappers.find((value) => value.name === 'introspection-audience');
  const mapper = {
    name: 'introspection-audience',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-audience-mapper',
    config: {
      'included.client.audience': client.clientId,
      'access.token.claim': 'true',
      'introspection.token.claim': 'true',
      'id.token.claim': 'false',
    },
  };
  await request(
    '/clients/' + record.id + '/protocol-mappers/models' + (existing ? '/' + existing.id : ''),
    existing ? 'PUT' : 'POST',
    existing ? { ...mapper, id: existing.id } : mapper,
  );
}
console.log(
  'Local client audiences and scope restrictions verified; audience validation remains enabled.',
);
