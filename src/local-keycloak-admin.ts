import type { LocalConfig } from './config.js';

// This helper is deliberately limited to the newly created local realm.
// It is never imported by the application server.
export async function localKeycloakAdmin(config: LocalConfig) {
  if (config.mode !== 'local' || config.issuer !== 'http://127.0.0.1:8180/realms/aio-local')
    throw new Error('Local realm required.');
  const response = await fetch(
    'http://127.0.0.1:8180/realms/master/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: config.keycloakAdmin.username,
        password: config.keycloakAdmin.password,
      }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error('Local Keycloak administration unavailable.');
  const token = (await response.json()) as { access_token: string };
  return async (path: string, method = 'GET', body?: unknown) => {
    if (!path.startsWith('/') || path.includes('..') || path.includes('#'))
      throw new Error('Invalid local admin path.');
    const result = await fetch('http://127.0.0.1:8180/admin/realms/aio-local' + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token.access_token,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!result.ok)
      throw new Error('Local Keycloak admin operation failed with status ' + result.status);
    return result;
  };
}
