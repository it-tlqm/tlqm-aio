import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import pg from 'pg';
import { loadLocalConfig, applicationDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { taskPermissions } from '../src/tasks/access.js';
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
    runtime.clients.some((client) => client.code === 'aio-tasks' && client.kind === 'application'),
  );
  const forms = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
    instanceId: string;
    users: FormsFixture[];
  };
  assert.equal(forms.instanceId, runtime.instanceId);
  const role = (name: FormsFixture['role']) => forms.users.find((user) => user.role === name)!;
  const roles = {
    manager: ['tasks:manage', 'tasks:work', 'tasks:view', 'tasks:report'],
    member: ['tasks:work', 'tasks:view'],
    viewer: ['tasks:view'],
    reporter: ['tasks:view', 'tasks:work', 'tasks:report'],
  };
  const choices = [
    { accountId: role('publisher').id, role: 'manager', unitId: null },
    { accountId: role('reviewer').id, role: 'member', unitId: ids.unitA },
    { accountId: role('analyst').id, role: 'reporter', unitId: ids.unitA },
    { accountId: ids.learner, role: 'viewer', unitId: ids.unitA },
    { accountId: role('respondent').id, role: 'viewer', unitId: ids.unitC },
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
    reason: 'Tasks synthetic fixture provisioning',
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
    await service.assertApp(pool, actor, ids.tenantA, 'aio-tasks', 'roles:manage');
    stage = 'explicit roles and grants';
    for (const [code, name] of Object.entries(taskPermissions))
      if (
        !(
          await pool.query(
            "SELECT 1 FROM permission_catalog WHERE app_code='aio-tasks' AND code=$1",
            [code],
          )
        ).rowCount
      )
        await service.savePermission(context(), { appCode: 'aio-tasks', code, name });
    for (const [code, permissions] of Object.entries(roles)) {
      const { rows } = await pool.query<{ name: string; revision: number }>(
        "SELECT name,revision FROM app_roles WHERE tenant_id=$1 AND app_code='aio-tasks' AND code=$2",
        [ids.tenantA, code],
      );
      const prior = rows[0];
      const name = 'Công việc ' + code;
      if (!prior)
        await service.saveRole(context(), { appCode: 'aio-tasks', code, name, permissions });
      else if (prior.name === 'Quy trình ' + code)
        await service.saveRole(context(), { appCode: 'aio-tasks', name }, code, prior.revision);
    }
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
            "SELECT 1 FROM application_grants WHERE tenant_id=$1 AND account_id=$2 AND app_code='aio-tasks'",
            [ids.tenantA, choice.accountId],
          )
        ).rowCount
      )
        await service.saveGrant(context(), {
          appCode: 'aio-tasks',
          accountId: choice.accountId,
          active: true,
        });
      if (
        !(
          await pool.query(
            "SELECT 1 FROM role_bindings WHERE tenant_id=$1 AND account_id=$2 AND app_code='aio-tasks' AND role_code=$3",
            [ids.tenantA, choice.accountId, choice.role],
          )
        ).rowCount
      )
        await service.saveBinding(context(), {
          appCode: 'aio-tasks',
          accountId: choice.accountId,
          roleCode: choice.role,
          orgUnitId: choice.unitId,
        });
    }

    const publisher = role('publisher');
    const portalGrant = await pool.query(
      "SELECT 1 FROM application_grants WHERE tenant_id=$1 AND account_id=$2 AND app_code='aio-foundation'",
      [ids.tenantA, publisher.id],
    );
    if (!portalGrant.rowCount)
      await service.saveGrant(
        context(),
        { appCode: 'aio-foundation', accountId: publisher.id, active: true },
        0,
      );
  }
  await writeFile(
    '.local/tasks-fixtures.json',
    JSON.stringify({ instanceId: runtime.instanceId, choices }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'PASS: Tasks fixture roles/grants created through verified operator MFA; existing identities, credentials and revoked rights preserved.',
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    'Tasks fixtures failed at ' +
      stage +
      (code && /^[A-Z0-9_]+$/.test(code) ? ' (' + code + ')' : '') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const pool of pools) await pool.end();
}
