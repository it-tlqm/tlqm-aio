import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import pg from 'pg';
import { loadLocalConfig, applicationDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';

const applicationMode = process.argv[2] === 'forms';
const code = applicationMode ? 'aio-forms' : 'aio-onboarding';
const roleCode = applicationMode ? 'respondent' : 'integration-reader';
const manifest = 'infrastructure/local/clients/' + code + '.json';
const restoreOnly =
  process.argv[2] === 'restore' || (applicationMode && process.argv[3] === 'restore');
if (
  (process.argv[2] && !restoreOnly && !applicationMode) ||
  (process.argv[3] && !(applicationMode && restoreOnly))
)
  throw new Error('Use no argument or restore for the fixed synthetic fixture.');
async function run(mode: string, expectedExit = 0) {
  const args =
    mode === 'db:setup'
      ? ['scripts/database.ts']
      : mode === 'forms:fixtures'
        ? ['scripts/forms-fixtures.ts']
        : ['scripts/onboard-client.ts', manifest, mode];
  const exit = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exit, expectedExit, 'Unexpected result for onboarding rehearsal operation: ' + mode);
}
const runtime = await loadLocalConfig();
const client = runtime.clients.find(
  (value) =>
    value.code === code && value.kind === (applicationMode ? 'application' : 'integration-probe'),
);
assert.ok(client, 'Provision the fixed synthetic integration probe first.');
const pools = [false, true].map(
  (test) => new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, test), max: 2 }),
);
let stage = 'preflight';
let restoreRequired = false;
const formsCredentialsBefore = applicationMode
  ? await readFile('.local/forms-fixtures.json')
  : undefined;
try {
  for (const [index, pool] of pools.entries()) {
    assert.equal(
      (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
      index ? 'tlqm-aio-test' : 'tlqm-aio-local',
    );
    const application = (await pool.query('SELECT status FROM applications WHERE code=$1', [code]))
      .rows[0];
    if (!restoreOnly) assert.equal(application?.status, 'active');
  }
  const browser = await chromium.launch({ headless: true });
  let proof;
  try {
    proof = await authenticateMfaFixture(browser, runtime, ids.admin);
  } finally {
    await browser.close();
  }
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
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    reason: 'Synthetic onboarding preservation rehearsal',
  });
  const getGrant = async (pool: pg.Pool) =>
    (
      await pool.query(
        'SELECT * FROM application_grants WHERE app_code=$1 AND tenant_id=$2 AND account_id=$3',
        [code, ids.tenantA, ids.learner],
      )
    ).rows[0];
  const getRole = async (pool: pg.Pool) =>
    (
      await pool.query('SELECT * FROM app_roles WHERE app_code=$1 AND tenant_id=$2 AND code=$3', [
        code,
        ids.tenantA,
        roleCode,
      ])
    ).rows[0];
  const getBinding = async (pool: pg.Pool) =>
    (
      await pool.query(
        'SELECT * FROM role_bindings WHERE app_code=$1 AND tenant_id=$2 AND account_id=$3 AND role_code=$4 ORDER BY id LIMIT 1',
        [code, ids.tenantA, ids.learner, roleCode],
      )
    ).rows[0];
  for (const pool of pools) {
    assert.ok(await getGrant(pool));
    assert.ok(await getRole(pool));
    assert.ok(await getBinding(pool));
    if (!restoreOnly) {
      assert.equal((await getGrant(pool))?.active, true);
      assert.equal((await getRole(pool))?.active, true);
      assert.equal((await getBinding(pool))?.active, true);
    }
  }
  try {
    restoreRequired = true;
    if (!restoreOnly) {
      stage = 'revoke synthetic fixture';
      for (const pool of pools) {
        const service = new GovernanceService(new Store(pool));
        const binding = await getBinding(pool);
        await service.saveBinding(
          context(),
          { appCode: code, active: false },
          binding.id,
          binding.revision,
        );
        await service.saveRole(
          context(),
          { appCode: code, active: false },
          roleCode,
          (await getRole(pool)).revision,
        );
        await service.saveGrant(
          context(),
          { appCode: code, accountId: ids.learner, active: false },
          (await getGrant(pool)).revision,
        );
      }
      stage = 'provision rerun';
      await run('provision');
      for (const pool of pools) {
        assert.equal((await getGrant(pool)).active, false);
        assert.equal((await getRole(pool)).active, false);
        assert.equal((await getBinding(pool)).active, false);
      }
      stage = 'disable and seed';
      await run('disable');
      await run('db:setup');
      if (applicationMode) await run('forms:fixtures');
      for (const pool of pools)
        assert.equal(
          (await pool.query('SELECT status FROM applications WHERE code=$1', [code])).rows[0]
            .status,
          'disabled',
        );
      stage = 'reject implicit reactivation';
      await run('provision', 1);
      stage = 'explicit activation';
      await run('activate');
      for (const pool of pools) {
        assert.equal((await getGrant(pool)).active, false);
        assert.equal((await getRole(pool)).active, false);
        assert.equal((await getBinding(pool)).active, false);
      }
    }
  } finally {
    if (restoreRequired) {
      const admin = await localKeycloakAdmin(runtime);
      const record = (
        (await (await admin('/clients?clientId=' + code)).json()) as {
          id: string;
          enabled: boolean;
        }[]
      )[0]!;
      const disabled =
        !record.enabled ||
        (await pools[0]!.query('SELECT status FROM applications WHERE code=$1', [code])).rows[0]
          .status !== 'active';
      if (disabled) await run('activate');
      for (const pool of pools) {
        const service = new GovernanceService(new Store(pool));
        const role = await getRole(pool);
        if (!role.active)
          await service.saveRole(
            context(),
            { appCode: code, active: true },
            roleCode,
            role.revision,
          );
        const binding = await getBinding(pool);
        if (!binding.active)
          await service.saveBinding(
            context(),
            { appCode: code, active: true },
            binding.id,
            binding.revision,
          );
        const grant = await getGrant(pool);
        if (!grant.active)
          await service.saveGrant(
            context(),
            { appCode: code, accountId: ids.learner, active: true },
            grant.revision,
          );
      }
    }
  }
  const after = await loadLocalConfig();
  if (formsCredentialsBefore)
    assert.ok((await readFile('.local/forms-fixtures.json')).equals(formsCredentialsBefore));
  assert.ok(runtime.encryptionKey === after.encryptionKey);
  assert.ok(
    runtime.clients.every(
      (before) =>
        after.clients.find((entry) => entry.code === before.code)?.clientSecret ===
        before.clientSecret,
    ),
  );
  assert.ok(JSON.stringify(runtime.users) === JSON.stringify(after.users));
  if (!restoreOnly)
    await writeFile(
      applicationMode
        ? '.local/evidence/forms-client-rehearsal.json'
        : '.local/evidence/client-rehearsal.json',
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          code,
          result: 'pass',
          credentialsPreserved: true,
          revokedGrantRoleBindingPreserved: true,
          disabledAppSurvivedSetup: true,
          implicitReactivationRejected: true,
          explicitActivationVerified: true,
          fixtureRestored: true,
        },
        null,
        2,
      ) + '\n',
    );
  if (restoreOnly)
    console.log(
      'Restored only the fixed synthetic integration fixture through audited governance.',
    );
  else
    console.log(
      'PASS: onboarding rerun, credential preservation, disabled setup, explicit activation and revoked grant/role/binding preservation.',
    );
} catch {
  console.error('Client rehearsal failed at: ' + stage + '. No credentials or tokens logged.');
  process.exitCode = 1;
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
}
