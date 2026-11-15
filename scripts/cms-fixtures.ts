import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, applicationDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { cmsPermissions } from '../src/cms/access.js';
import { ids } from '../src/fixtures.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localContainer } from './local-docker.js';
import { chromium } from '@playwright/test';

const runtime = await loadLocalConfig();
const pools: pg.Pool[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const cmsAccountId = ids.learner;
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  assert.ok(
    runtime.clients.some((client) => client.code === 'aio-cms' && client.kind === 'application'),
  );
  browser = await chromium.launch({ headless: true });
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
    reason: 'CMS local fixture provisioning',
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  for (const test of [false, true]) {
    const pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, test), max: 2 });
    pools.push(pool);
    const store = new Store(pool);
    const governance = new GovernanceService(store);
    const actor = await store.principal(identity, 'aio-foundation');
    await governance.assertApp(pool, actor, ids.tenantA, 'aio-cms', 'roles:manage');
    for (const [code, name] of Object.entries(cmsPermissions)) {
      if (
        !(
          await pool.query('SELECT 1 FROM permission_catalog WHERE app_code=$1 AND code=$2', [
            'aio-cms',
            code,
          ])
        ).rowCount
      )
        await governance.savePermission(context(), { appCode: 'aio-cms', code, name });
    }
    const permissions = Object.keys(cmsPermissions);
    const role = (
      await pool.query(
        'SELECT revision FROM app_roles WHERE tenant_id=$1 AND app_code=$2 AND code=$3',
        [ids.tenantA, 'aio-cms', 'admin'],
      )
    ).rows[0];
    if (!role)
      await governance.saveRole(context(), {
        appCode: 'aio-cms',
        code: 'admin',
        name: 'CMS administrator',
        permissions,
      });
    else
      await governance.saveRole(
        context(),
        { appCode: 'aio-cms', name: 'CMS administrator', permissions },
        'admin',
        role.revision,
      );
    if (
      !(
        await pool.query(
          'SELECT 1 FROM application_grants WHERE tenant_id=$1 AND account_id=$2 AND app_code=$3',
          [ids.tenantA, cmsAccountId, 'aio-cms'],
        )
      ).rowCount
    )
      await governance.saveGrant(context(), {
        appCode: 'aio-cms',
        accountId: cmsAccountId,
        active: true,
      });
    if (
      !(
        await pool.query(
          'SELECT 1 FROM role_bindings WHERE tenant_id=$1 AND account_id=$2 AND app_code=$3 AND role_code=$4',
          [ids.tenantA, cmsAccountId, 'aio-cms', 'admin'],
        )
      ).rowCount
    )
      await governance.saveBinding(context(), {
        appCode: 'aio-cms',
        accountId: cmsAccountId,
        roleCode: 'admin',
      });
  }
  console.log('PASS: CMS local admin permission catalog, grant and binding are ready.');
} finally {
  await browser?.close();
  await Promise.all(pools.map((pool) => pool.end()));
}
