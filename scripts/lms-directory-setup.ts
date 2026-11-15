import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { loadLocalConfig, applicationDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localContainer } from './local-docker.js';
const runtime = await loadLocalConfig(),
  appCode = 'aio-lms-sandbox',
  permission = 'directory:lookup';
const browser = await chromium.launch({ headless: true }),
  pools: pg.Pool[] = [];
let stage = 'preflight',
  transportFailed = false;
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  const proof = await authenticateMfaFixture(browser, runtime, ids.admin),
    identity = {
      issuer: runtime.issuer,
      subject: proof.subject,
      authenticatedAt: proof.authTime,
      authenticationMethods: proof.authenticationMethods ?? [],
    };
  for (const test of [false, true]) {
    stage = test ? 'test permissions' : 'local permissions';
    const pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, test), max: 2 });
    pool.on('error', () => {
      transportFailed = true;
      console.error('Directory setup database unavailable; connection details omitted.');
      process.exitCode = 1;
    });
    pools.push(pool);
    assert.equal(
      (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
      test ? 'tlqm-aio-test' : 'tlqm-aio-local',
    );
    const store = new Store(pool),
      service = new GovernanceService(store),
      actor = await store.principal(identity, 'aio-foundation');
    assert.equal(actor.accountId, ids.admin);
    await service.assertApp(pool, actor, ids.tenantA, appCode, 'roles:manage');
    const context = (key: string) => ({
      identity,
      appCode: 'aio-foundation',
      tenantId: ids.tenantA,
      requestId: randomUUID(),
      idempotencyKey: 'lms-directory-v1-' + (test ? 'test' : 'local') + '-' + key,
      reason: 'Onboard read-only Directory capability for isolated LMS',
    });
    if (
      !(
        await pool.query('SELECT 1 FROM permission_catalog WHERE app_code=$1 AND code=$2', [
          appCode,
          permission,
        ])
      ).rowCount
    )
      await service.savePermission(context('permission'), {
        appCode,
        code: permission,
        name: 'Đọc Directory theo phạm vi của ứng dụng',
      });
    for (const role of ['manager', 'admin']) {
      const ctx = context(role);
      // A successful provisioning receipt is a tombstone: rerun never restores later revocation.
      if (
        (
          await pool.query(
            'SELECT 1 FROM mutation_receipts WHERE actor_account_id=$1 AND app_code=$2 AND tenant_id=$3 AND idempotency_key=$4',
            [ids.admin, 'aio-foundation', ids.tenantA, ctx.idempotencyKey],
          )
        ).rowCount
      )
        continue;
      const current = (
        await pool.query(
          'SELECT revision,active FROM app_roles WHERE tenant_id=$1 AND app_code=$2 AND code=$3',
          [ids.tenantA, appCode, role],
        )
      ).rows[0];
      assert.ok(current);
      assert.equal(current.active, true, 'Disabled role requires explicit restoration, not setup');
      const permissions = (
        await pool.query<{ permission: string }>(
          'SELECT permission FROM role_permissions WHERE tenant_id=$1 AND app_code=$2 AND role_code=$3 ORDER BY permission',
          [ids.tenantA, appCode, role],
        )
      ).rows.map((row) => row.permission);
      await service.saveRole(
        ctx,
        { appCode, permissions: [...new Set([...permissions, permission])].sort() },
        role,
        current.revision,
      );
    }
  }
  assert.equal(transportFailed, false);
  console.log(
    'Local and test LMS Directory capability provisioned; grants, bindings and revocations preserved.',
  );
} catch (error) {
  if (error instanceof Error)
    console.error(
      error.stack?.match(/lms-directory-setup\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable',
    );
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code))
    console.error('Directory setup code: ' + code);
  console.error(
    'LMS Directory setup failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await Promise.all(pools.map((pool) => pool.end()));
}
