import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import type { LocalConfig } from '../src/config.js';
import { demoUsers, ids } from '../src/fixtures.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';

type Execution = {
  displayName?: string;
  id: string;
  providerId?: string;
  flowId?: string;
  authenticationConfig?: string;
  level: number;
  requirement: string;
};
const alias = 'aio-local-mfa';
const roleName = 'aio-mfa-required';

export async function configureLocalMfa(config: LocalConfig) {
  const admin = await localKeycloakAdmin(config);
  const request = async (path: string, method = 'GET', body?: unknown) => {
    try {
      return await admin(path, method, body);
    } catch (error) {
      const status = error instanceof Error ? /status (\d{3})/.exec(error.message)?.[1] : undefined;
      throw Object.assign(
        new Error(method + ' ' + path.split('?')[0] + ' status=' + (status ?? 'unavailable')),
        { name: 'MfaSetupError' },
      );
    }
  };
  // Persist a newly generated fixture password once, before using it. Never reset existing passwords.
  if (!config.users.some((user) => user.id === ids.recovery)) {
    config.users.push({
      ...demoUsers.find((user) => user.id === ids.recovery)!,
      password: randomBytes(32).toString('hex'),
    });
    await writeFile('.local/runtime.mfa.next.json', JSON.stringify(config, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename('.local/runtime.mfa.next.json', '.local/runtime.json');
  }
  for (const id of [ids.admin, ids.recovery]) {
    const user = config.users.find((value) => value.id === id)!;
    const found = (await (
      await request('/users?username=' + encodeURIComponent(user.username) + '&exact=true')
    ).json()) as { id: string; username: string }[];
    if (found.length && (found.length !== 1 || found[0]!.id !== (user.subject ?? id)))
      throw new Error('Synthetic MFA identity does not match the expected subject.');
    if (!found.length) {
      if (id !== ids.recovery) throw new Error('Bootstrap administrator is missing.');
      const created = await request('/users', 'POST', {
        id,
        username: user.username,
        enabled: true,
        firstName: 'Demo',
        lastName: 'Recovery',
        email: user.username + '@example.test',
        emailVerified: true,
        credentials: [{ type: 'password', value: user.password, temporary: false }],
      });
      const subject = created.headers.get('location')?.split('/').pop();
      if (!subject || !/^[0-9a-f-]{36}$/.test(subject))
        throw new Error('Missing created subject receipt.');
      user.subject = subject;
      await writeFile('.local/runtime.mfa.next.json', JSON.stringify(config, null, 2) + '\n', {
        mode: 0o600,
      });
      await rename('.local/runtime.mfa.next.json', '.local/runtime.json');
    }
  }
  // Re-enrollment is explicit local fixture maintenance. Remove only OTP
  // credentials from the two synthetic administrators before saving a new seed.
  for (const id of [ids.admin, ids.recovery]) {
    const subject = config.users.find((value) => value.id === id)?.subject ?? id;
    const credentials = (await (await request('/users/' + subject + '/credentials')).json()) as {
      id: string;
      type: string;
    }[];
    for (const credential of credentials.filter((value) => value.type === 'otp'))
      await request('/users/' + subject + '/credentials/' + credential.id, 'DELETE');
  }
  const roles = (await (await request('/roles')).json()) as { id: string; name: string }[];
  if (!roles.some((role) => role.name === roleName))
    await request('/roles', 'POST', {
      name: roleName,
      description: 'Require OTP for synthetic AIO administrators; no application permissions',
    });
  const role = await (await request('/roles/' + roleName)).json();
  for (const id of [ids.admin, ids.recovery])
    await request(
      '/users/' +
        (config.users.find((user) => user.id === id)?.subject ?? id) +
        '/role-mappings/realm',
      'POST',
      [role],
    );

  const flowList = async () =>
    (await (await request('/authentication/flows')).json()) as {
      id: string;
      alias: string;
      topLevel: boolean;
    }[];
  if (!(await flowList()).some((flow) => flow.alias === alias))
    await request('/authentication/flows', 'POST', {
      alias,
      description: 'Isolated AIO local password and OTP',
      providerId: 'basic-flow',
      topLevel: true,
      builtIn: false,
    });
  const executions = async (flow: string) =>
    (await (
      await request('/authentication/flows/' + encodeURIComponent(flow) + '/executions')
    ).json()) as Execution[];
  async function requirement(flow: string, execution: Execution, required: string) {
    if (execution.requirement !== required)
      await request('/authentication/flows/' + encodeURIComponent(flow) + '/executions', 'PUT', {
        ...execution,
        requirement: required,
      });
  }
  async function subflow(parent: string, name: string, required: string) {
    if (!(await executions(parent)).some((item) => item.displayName === name && item.level === 0))
      await request(
        '/authentication/flows/' + encodeURIComponent(parent) + '/executions/flow',
        'POST',
        { alias: name, type: 'basic-flow', provider: 'basic-flow' },
      );
    const execution = (await executions(parent)).find(
      (value) => value.displayName === name && value.flowId && value.level === 0,
    );
    if (!execution) throw new Error('Unexpected local authentication flow hierarchy.');
    await requirement(parent, execution, required);
  }
  async function execution(
    flow: string,
    provider: string,
    required: string,
    settings?: Record<string, string>,
  ) {
    let list = (await executions(flow)).filter(
      (value) => value.level === 0 && value.providerId === provider,
    );
    if (!list.length) {
      await request(
        '/authentication/flows/' + encodeURIComponent(flow) + '/executions/execution',
        'POST',
        { provider },
      );
      list = (await executions(flow)).filter(
        (value) => value.level === 0 && value.providerId === provider,
      );
    }
    if (list.length !== 1) throw new Error('Ambiguous local authentication execution.');
    const item = list[0]!;
    await requirement(flow, item, required);
    if (settings) {
      const value = { alias: flow + '-' + provider, config: settings };
      await request(
        item.authenticationConfig
          ? '/authentication/config/' + item.authenticationConfig
          : '/authentication/executions/' + item.id + '/config',
        item.authenticationConfig ? 'PUT' : 'POST',
        value,
      );
    }
  }
  const amr = (method: string) => ({
    'default.reference.value': method,
    'default.reference.maxAge': '3600',
  });
  await execution(alias, 'auth-cookie', 'ALTERNATIVE');
  const forms = alias + '-forms';
  await subflow(alias, forms, 'ALTERNATIVE');
  await execution(forms, 'auth-username-password-form', 'REQUIRED', amr('pwd'));
  const administrators = alias + '-administrators';
  await subflow(forms, administrators, 'CONDITIONAL');
  await execution(administrators, 'conditional-user-role', 'REQUIRED', {
    condUserRole: roleName,
    negate: 'false',
  });
  await execution(administrators, 'auth-otp-form', 'REQUIRED', amr('otp'));
  const optional = alias + '-enrolled-users';
  await subflow(forms, optional, 'CONDITIONAL');
  await execution(optional, 'conditional-user-role', 'REQUIRED', {
    condUserRole: roleName,
    negate: 'true',
  });
  await execution(optional, 'conditional-user-configured', 'REQUIRED');
  await execution(optional, 'auth-otp-form', 'REQUIRED', amr('otp'));
  for (const client of config.clients) {
    const records = (await (
      await request('/clients?clientId=' + encodeURIComponent(client.clientId))
    ).json()) as { id: string; clientId: string }[];
    const record = records.find((value) => value.clientId === client.clientId);
    if (!record) throw new Error('Expected local client is missing.');
    const mappers = (await (
      await request('/clients/' + record.id + '/protocol-mappers/models')
    ).json()) as { id: string; name: string }[];
    const existing = mappers.find((value) => value.name === 'aio-authentication-methods');
    const mapper = {
      name: 'aio-authentication-methods',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-amr-mapper',
      config: { 'access.token.claim': 'true', 'id.token.claim': 'true' },
    };
    await request(
      '/clients/' + record.id + '/protocol-mappers/models' + (existing ? '/' + existing.id : ''),
      existing ? 'PUT' : 'POST',
      existing ? { ...mapper, id: existing.id } : mapper,
    );
  }
  // Existing flows remain intact. Only the isolated synthetic realm is switched after all steps exist.
  await request('/', 'PUT', {
    browserFlow: alias,
    otpPolicyType: 'totp',
    otpPolicyAlgorithm: 'HmacSHA1',
    otpPolicyDigits: 6,
    otpPolicyPeriod: 30,
    otpPolicyLookAheadWindow: 1,
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
  });
  return config;
}
