import { request } from 'node:https';

export const stagingSecretPorts = { a: 4550, b: 4560 } as const;

export function openBaoApi(port: number, ca: Buffer | string) {
  if (![4550, 4560].includes(port)) throw new Error('Invalid staging secret endpoint.');
  const origin = new URL('https://127.0.0.1:' + port);
  return async function call<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    expected: number | number[],
    options: { token?: string; wrap?: string; body?: unknown } = {},
  ): Promise<T> {
    if (!/^[a-z0-9_/-]+(?:\?version=\d+)?$/.test(path))
      throw new Error('Invalid staging secret operation.');
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
      const req = request(
        new URL('/v1/' + path, origin),
        {
          method,
          ca,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
          signal: AbortSignal.timeout(path === 'sys/init' && method === 'PUT' ? 30000 : 8000),
          headers: {
            ...(options.token && { 'x-vault-token': options.token }),
            ...(options.wrap && { 'x-vault-wrap-ttl': options.wrap }),
            ...(body !== undefined && {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            }),
          },
        },
        (response) => {
          if (![expected].flat().includes(response.statusCode ?? 0)) {
            response.resume();
            reject(
              new Error(
                'OpenBao staging ' + method + ' ' + path + ' returned ' + response.statusCode,
              ),
            );
            return;
          }
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (part: string) => {
            data += part;
            if (data.length > 2 * 1024 * 1024)
              response.destroy(new Error('Staging secret response exceeds limit.'));
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve((data ? JSON.parse(data) : undefined) as T);
            } catch {
              reject(new Error('Invalid OpenBao staging response.'));
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  };
}

export type StagingSecretGrant = {
  kind: 'openbao-staging';
  slot: 'a' | 'b';
  instanceId: string;
  workload: 'bff' | 'lms' | 'keycloak' | 'postgres';
  roleId: string;
  wrappedSecret: string;
};

export async function readStagingSecret<T>(grant: StagingSecretGrant, ca: Buffer | string) {
  if (
    grant.kind !== 'openbao-staging' ||
    !['a', 'b'].includes(grant.slot) ||
    !['bff', 'lms', 'keycloak', 'postgres'].includes(grant.workload) ||
    !/^[a-f0-9-]{36}$/.test(grant.instanceId) ||
    !/^[a-f0-9-]{36}$/.test(grant.roleId) ||
    !/^[A-Za-z0-9_.-]{20,256}$/.test(grant.wrappedSecret)
  )
    throw new Error('Invalid isolated workload secret grant.');
  const call = openBaoApi(stagingSecretPorts[grant.slot], ca);
  const unwrapped = await call<{ data: { secret_id: string } }>(
    'sys/wrapping/unwrap',
    'POST',
    200,
    { token: grant.wrappedSecret, body: {} },
  );
  const login = await call<{ auth: { client_token: string } }>('auth/approle/login', 'POST', 200, {
    body: { role_id: grant.roleId, secret_id: unwrapped.data.secret_id },
  });
  const token = login.auth.client_token;
  try {
    const { data } = await call<{ data: { data: { instanceId: string; value: T } } }>(
      'aio-kv/data/' + grant.workload,
      'GET',
      200,
      { token },
    );
    if (data.data.instanceId !== grant.instanceId)
      throw new Error('Wrong staging secret instance.');
    return data.data.value;
  } finally {
    await call('auth/token/revoke-self', 'POST', 204, { token, body: {} });
  }
}
