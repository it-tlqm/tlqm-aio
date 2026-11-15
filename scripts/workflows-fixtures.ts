import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import pg from 'pg';
import { loadLocalConfig, applicationDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { workflowPermissions } from '../src/workflows/access.js';
import { ids } from '../src/fixtures.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localContainer } from './local-docker.js';
import type { FormsFixture } from './forms-fixtures.js';
const pools: pg.Pool[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let stage = 'preflight';
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  const runtime = await loadLocalConfig();
  assert.ok(
    runtime.clients.some(
      (client) => client.code === 'aio-workflows' && client.kind === 'application',
    ),
  );
  const forms = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
    instanceId: string;
    users: FormsFixture[];
  };
  assert.equal(forms.instanceId, runtime.instanceId);
  const role = (name: FormsFixture['role']) => forms.users.find((user) => user.role === name)!;
  const roles = {
    designer: ['workflows:design'],
    publisher: ['workflows:publish'],
    coordinator: ['workflows:manage', 'workflows:report'],
    requester: ['workflows:start'],
    handler: ['workflows:act'],
    collaborator: ['workflows:collaborate'],
  };
  const choices = [
    { accountId: role('designer').id, role: 'designer', unitId: null },
    { accountId: role('designer').id, role: 'collaborator', unitId: ids.unitA },
    { accountId: role('publisher').id, role: 'publisher', unitId: null },
    { accountId: role('publisher').id, role: 'coordinator', unitId: null },
    { accountId: ids.learner, role: 'requester', unitId: null },
    { accountId: role('respondent').id, role: 'requester', unitId: null },
    { accountId: role('reviewer').id, role: 'handler', unitId: ids.unitA },
    { accountId: role('analyst').id, role: 'handler', unitId: null },
  ];
  browser = await chromium.launch({ headless: true });
  stage = 'operator MFA';
  const proof = await authenticateMfaFixture(browser, runtime, ids.admin);
  const identity = {
    issuer: runtime.issuer,
    subject: proof.subject,
    authenticatedAt: proof.authTime,
    authenticationMethods: proof.authenticationMethods ?? [],
  };
  const context = () => ({
    identity,
    appCode: 'aio-foundation',
    tenantId: ids.tenantA,
    reason: 'Workflows synthetic fixture provisioning',
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  for (const test of [false, true]) {
    const pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, test), max: 2 });
    pools.push(pool);
    assert.equal(
      (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
      test ? 'tlqm-aio-test' : 'tlqm-aio-local',
    );
    const store = new Store(pool),
      service = new GovernanceService(store),
      actor = await store.principal(identity, 'aio-foundation');
    await service.assertApp(pool, actor, ids.tenantA, 'aio-workflows', 'roles:manage');
    stage = 'explicit roles and grants';
    for (const [code, name] of Object.entries(workflowPermissions))
      if (
        !(
          await pool.query(
            "SELECT 1 FROM permission_catalog WHERE app_code='aio-workflows' AND code=$1",
            [code],
          )
        ).rowCount
      )
        await service.savePermission(context(), { appCode: 'aio-workflows', code, name });
    for (const [code, permissions] of Object.entries(roles))
      if (
        !(
          await pool.query(
            "SELECT 1 FROM app_roles WHERE tenant_id=$1 AND app_code='aio-workflows' AND code=$2",
            [ids.tenantA, code],
          )
        ).rowCount
      )
        await service.saveRole(context(), {
          appCode: 'aio-workflows',
          code,
          name: 'Quy trình ' + code,
          permissions,
        });
    for (const choice of choices) {
      assert.ok(
        (
          await pool.query(
            'SELECT 1 FROM accounts a JOIN persons p ON p.id=a.person_id WHERE a.id=$1 AND a.active AND p.active',
            [choice.accountId],
          )
        ).rowCount,
      );
      if (
        !(
          await pool.query(
            "SELECT 1 FROM application_grants WHERE tenant_id=$1 AND account_id=$2 AND app_code='aio-workflows'",
            [ids.tenantA, choice.accountId],
          )
        ).rowCount
      )
        await service.saveGrant(context(), {
          appCode: 'aio-workflows',
          accountId: choice.accountId,
          active: true,
        });
      if (
        !(
          await pool.query(
            "SELECT 1 FROM role_bindings WHERE tenant_id=$1 AND account_id=$2 AND app_code='aio-workflows' AND role_code=$3",
            [ids.tenantA, choice.accountId, choice.role],
          )
        ).rowCount
      )
        await service.saveBinding(context(), {
          appCode: 'aio-workflows',
          accountId: choice.accountId,
          roleCode: choice.role,
          orgUnitId: choice.unitId,
        });
    }
  }
  await writeFile(
    '.local/workflows-fixtures.json',
    JSON.stringify({ instanceId: runtime.instanceId, choices }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'PASS: Workflows fixture roles/grants created through verified operator MFA; existing identities, credentials and revoked rights preserved.',
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    'Workflows fixtures failed at ' +
      stage +
      (code && /^[A-Z0-9_]+$/.test(code) ? ' (' + code + ')' : '') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const pool of pools) await pool.end();
}
