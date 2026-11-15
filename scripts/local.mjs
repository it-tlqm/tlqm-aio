import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { demoUsers } from '../src/fixtures.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local');
const runtimePath = join(directory, 'runtime.json');
const secret = () => randomBytes(32).toString('hex');
const command = process.argv[2];
if (!['prepare', 'up', 'stop'].includes(command)) throw new Error('Use prepare, up or stop.');

if (command === 'prepare') {
  try {
    await access(runtimePath);
    console.log('Local configuration already exists; credentials were preserved.');
    process.exit(0);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(join(directory, 'realm'), { recursive: true });
  const databasePassword = secret();
  const identityPassword = secret();
  const adminPassword = secret();
  const clients = [
    { code: 'aio-foundation', name: 'AIO Foundation', port: 4100 },
    { code: 'aio-probe', name: 'SSO client B', port: 4101 },
    { code: 'aio-cms', name: 'AIO CMS', port: 4107 },
  ].map((item) => ({
    ...item,
    baseUrl: 'http://127.0.0.1:' + item.port,
    clientId: item.code,
    audience: item.code + '-api',
    clientSecret: secret(),
  }));
  const users = demoUsers.map((user) => ({ ...user, password: secret() }));
  const runtime = {
    mode: 'local',
    instanceId: randomUUID(),
    issuer: 'http://127.0.0.1:8180/realms/aio-local',
    databaseUrl:
      'postgresql://aio_foundation:' + databasePassword + '@127.0.0.1:5438/aio_foundation',
    encryptionKey: secret(),
    clients,
    users,
    keycloakAdmin: { username: 'aio-local-admin', password: adminPassword },
  };
  const realm = {
    realm: 'aio-local',
    enabled: true,
    displayName: 'TLQM AIO — Local test only',
    sslRequired: 'none',
    registrationAllowed: false,
    resetPasswordAllowed: false,
    loginWithEmailAllowed: false,
    bruteForceProtected: true,
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 3600,
    clients: clients.map((client) => ({
      clientId: client.clientId,
      name: client.name,
      secret: client.clientSecret,
      enabled: true,
      protocol: 'openid-connect',
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: false,
      redirectUris: [client.baseUrl + '/auth/callback'],
      webOrigins: [],
      attributes: {
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
      ],
    })),
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      enabled: true,
      firstName: 'Demo',
      lastName: user.username,
      email: user.username + '@example.test',
      emailVerified: true,
      requiredActions: [],
      credentials: [{ type: 'password', value: user.password, temporary: false }],
    })),
  };
  await writeFile(
    join(directory, 'realm', 'aio-local-realm.json'),
    JSON.stringify(realm, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(
    join(directory, 'compose.env'),
    [
      'IDENTITY_DB_PASSWORD=' + identityPassword,
      'FOUNDATION_DB_PASSWORD=' + databasePassword,
      'KEYCLOAK_ADMIN_PASSWORD=' + adminPassword,
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(runtimePath, JSON.stringify(runtime, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log('Generated local-only configuration in .local/. No credentials printed.');
} else {
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  if (runtime.mode !== 'local' || new URL(runtime.databaseUrl).hostname !== '127.0.0.1') {
    throw new Error('Refusing a non-local configuration.');
  }
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) {
    throw new Error('Unset Docker overrides before operating this local stack.');
  }
  const context = spawnSync('docker', ['context', 'inspect', 'desktop-linux'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (context.status !== 0) throw new Error('Local Docker Desktop context unavailable.');
  const endpoint = JSON.parse(context.stdout)[0]?.Endpoints?.docker?.Host;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('npipe://')) {
    throw new Error('Expected a local Windows named-pipe Docker endpoint.');
  }
  const args = [
    '--context',
    'desktop-linux',
    'compose',
    '--env-file',
    join(directory, 'compose.env'),
    '-p',
    'tlqm-aio-local',
    '-f',
    join(root, 'infrastructure/local/compose.yml'),
  ];
  // Stop preserves volumes. This tool never deletes volumes or operates another project.
  const result = spawnSync(
    'docker',
    [...args, ...(command === 'up' ? ['up', '-d', '--wait', '--wait-timeout', '180'] : ['stop'])],
    { stdio: 'inherit', windowsHide: true },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (command === 'up') {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(runtime.issuer + '/.well-known/openid-configuration', {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok && (await response.json()).issuer === runtime.issuer) {
          ready = true;
          break;
        }
      } catch {
        /* wait for startup */
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('Local Keycloak discovery did not become ready.');
    const configure = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(root, 'scripts/keycloak.ts')],
      { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    if (configure.status !== 0) process.exit(configure.status ?? 1);
    const theme = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(root, 'scripts/sso-theme.ts'), 'ensure'],
      { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    if (theme.status !== 0) process.exit(theme.status ?? 1);
    console.log('Local Keycloak ready at http://127.0.0.1:8180. Next: npm run db:setup');
  }
}
