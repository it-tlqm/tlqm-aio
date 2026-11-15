import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { loadLocalConfig, applicationDatabaseUrl, assertLocalDatabase } from '../src/config.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { ids } from '../src/fixtures.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { auditMutation } from '../src/management/mutations.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localContainer } from './local-docker.js';

type Receipt = {
  purpose: 'tlqm-aio-workflows-review-admin';
  instanceId: string;
  username: 'workflows.admin';
  password: string;
  accountId: string;
  personId: string;
  subject?: string;
  provisioned?: boolean;
};
const file = '.local/workflows-admin.json';
const appCode = 'aio-workflows';
const roles: Record<string, string[]> = {
  designer: ['workflows:design'],
  publisher: ['workflows:publish'],
  coordinator: ['workflows:manage', 'workflows:report'],
};
const pools: pg.Pool[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let stage = 'local preflight';
try {
  const runtime = await loadLocalConfig();
  assert.equal((await localContainer('keycloak')).running, true);
  assert.equal((await localContainer('foundation-db')).running, true);
  assertLocalDatabase(runtime.databaseUrl);
  const owner = new pg.Pool({ connectionString: runtime.databaseUrl, max: 1 });
  const pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime), max: 2 });
  pools.push(owner, pool);
  assert.deepEqual((await owner.query('SELECT purpose FROM environment_marker')).rows, [
    { purpose: 'tlqm-aio-local' },
  ]);
  assert.deepEqual(
    (await owner.query('SELECT current_database() AS name,current_user AS owner')).rows[0],
    { name: 'aio_foundation', owner: 'aio_foundation' },
  );
  browser = await chromium.launch({ headless: true });
  stage = 'operator MFA';
  const proof = await authenticateMfaFixture(browser, runtime, ids.admin);
  const identity = {
    issuer: runtime.issuer,
    subject: proof.subject,
    authenticatedAt: proof.authTime,
    authenticationMethods: proof.authenticationMethods ?? [],
  };
  const store = new Store(pool),
    governance = new GovernanceService(store);
  const operator = await store.principal(identity, 'aio-foundation');
  assert.equal(operator.accountId, ids.admin);
  store.require(operator, 'accounts:manage', ids.tenantA);
  await governance.assertApp(pool, operator, ids.tenantA, appCode, 'roles:manage');
  await governance.assertApp(pool, operator, ids.tenantA, appCode, 'access:manage');
  const context = (reason: string) => ({
    identity,
    appCode: 'aio-foundation',
    tenantId: ids.tenantA,
    reason,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  for (const [roleCode, expected] of Object.entries(roles)) {
    const permissions = (
      await pool.query<{ permission: string }>(
        'SELECT rp.permission FROM role_permissions rp JOIN app_roles r ON r.tenant_id=rp.tenant_id AND r.app_code=rp.app_code AND r.code=rp.role_code AND r.active WHERE rp.tenant_id=$1 AND rp.app_code=$2 AND rp.role_code=$3 ORDER BY rp.permission',
        [ids.tenantA, appCode, roleCode],
      )
    ).rows.map((row) => row.permission);
    assert.deepEqual(permissions, expected.toSorted());
  }
  let receipt: Receipt;
  try {
    receipt = JSON.parse(await readFile(file, 'utf8')) as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    receipt = {
      purpose: 'tlqm-aio-workflows-review-admin',
      instanceId: runtime.instanceId,
      username: 'workflows.admin',
      password: randomBytes(24).toString('base64url'),
      accountId: randomUUID(),
      personId: randomUUID(),
    };
    await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  assert.equal(receipt.purpose, 'tlqm-aio-workflows-review-admin');
  assert.equal(receipt.instanceId, runtime.instanceId);
  assert.equal(receipt.username, 'workflows.admin');
  assert.match(receipt.password, /^[A-Za-z0-9_-]{32}$/);
  for (const id of [receipt.accountId, receipt.personId]) assert.match(id, /^[0-9a-f-]{36}$/);
  const save = async () => {
    await writeFile('.local/workflows-admin.next.json', JSON.stringify(receipt, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename('.local/workflows-admin.next.json', file);
  };
  const admin = await localKeycloakAdmin(runtime);
  stage = 'create owned local SSO account';
  if (!receipt.subject) {
    const existing = (await (
      await admin('/users?username=workflows.admin&exact=true')
    ).json()) as unknown[];
    assert.equal(
      existing.length,
      0,
      'Do not claim an existing username without a creation receipt.',
    );
    const profile = (await (await admin('/users/profile')).json()) as {
      attributes: { name: string; permissions: unknown }[];
    };
    for (const name of ['aio.local.instance', 'aio.local.fixture'])
      assert.deepEqual(
        profile.attributes.find((attribute) => attribute.name === name)?.permissions,
        { view: ['admin'], edit: ['admin'] },
      );
    const created = await admin('/users', 'POST', {
      username: receipt.username,
      enabled: true,
      firstName: 'Quản trị Quy trình',
      lastName: 'Dùng thử',
      email: 'workflows.admin@example.test',
      emailVerified: true,
      attributes: {
        'aio.local.instance': [runtime.instanceId],
        'aio.local.fixture': ['workflows-review-admin'],
      },
      requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
      credentials: [{ type: 'password', value: receipt.password, temporary: true }],
    });
    const subject = created.headers.get('location')?.split('/').pop();
    assert.ok(subject && /^[0-9a-f-]{36}$/.test(subject));
    receipt.subject = subject;
    await save();
  }
  assert.match(receipt.subject, /^[0-9a-f-]{36}$/);
  const account = (await (await admin('/users/' + receipt.subject)).json()) as {
    id: string;
    username: string;
    attributes: Record<string, string[]>;
    requiredActions: string[];
  };
  assert.equal(account.id, receipt.subject);
  assert.equal(account.username, receipt.username);
  assert.equal(account.attributes['aio.local.instance']?.[0], runtime.instanceId);
  assert.equal(account.attributes['aio.local.fixture']?.[0], 'workflows-review-admin');
  if (!receipt.provisioned) {
    const mfaRole = await (await admin('/roles/aio-mfa-required')).json();
    await admin('/users/' + receipt.subject + '/role-mappings/realm', 'POST', [mfaRole]);
  }
  stage = 'record audited directory ownership';
  const db = await owner.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(71092027)');
    const actor = await store.principal(identity, 'aio-foundation', db);
    store.require(actor, 'accounts:manage', ids.tenantA);
    const marker = 'workflows-review-admin-v1:' + receipt.accountId;
    if (!(await db.query('SELECT 1 FROM bootstrap_receipts WHERE name=$1', [marker])).rowCount) {
      assert.equal(
        (
          await db.query('SELECT 1 FROM external_identities WHERE issuer=$1 AND subject=$2', [
            runtime.issuer,
            receipt.subject,
          ])
        ).rowCount,
        0,
      );
      await db.query('INSERT INTO persons(id,home_tenant_id,display_name) VALUES ($1,$2,$3)', [
        receipt.personId,
        ids.tenantA,
        'Quản trị Quy trình · Dùng thử',
      ]);
      await db.query('INSERT INTO accounts(id,person_id,mfa_required) VALUES ($1,$2,true)', [
        receipt.accountId,
        receipt.personId,
      ]);
      await db.query(
        "INSERT INTO external_identities(issuer,subject,account_id,verified_at,verified_by,verification_method) VALUES ($1,$2,$3,now(),$4,'workflows-local-provisioning')",
        [runtime.issuer, receipt.subject, receipt.accountId, actor.accountId],
      );
      await db.query('INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)', [
        receipt.accountId,
        ids.tenantA,
      ]);
      await db.query('INSERT INTO bootstrap_receipts(name) VALUES ($1)', [marker]);
      await auditMutation(
        db,
        context('Tạo quản trị Quy trình dùng thử theo yêu cầu người dùng'),
        actor,
        'workflows.review_admin.created',
        'account',
        receipt.accountId,
        null,
        {
          personId: receipt.personId,
          issuer: runtime.issuer,
          subject: receipt.subject,
          mfaRequired: true,
        },
        receipt.accountId,
      );
    } else {
      assert.equal(
        (await db.query('SELECT person_id FROM accounts WHERE id=$1', [receipt.accountId])).rows[0]
          ?.person_id,
        receipt.personId,
      );
      assert.equal(
        (
          await db.query(
            'SELECT account_id FROM external_identities WHERE issuer=$1 AND subject=$2',
            [runtime.issuer, receipt.subject],
          )
        ).rows[0]?.account_id,
        receipt.accountId,
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  stage = 'grant Workflow administration only';
  if (
    !(
      await pool.query(
        'SELECT 1 FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
        [receipt.accountId, ids.tenantA, appCode],
      )
    ).rowCount
  )
    await governance.saveGrant(context('Cấp ứng dụng Quy trình cho quản trị dùng thử'), {
      appCode,
      accountId: receipt.accountId,
      active: true,
    });
  for (const roleCode of Object.keys(roles))
    if (
      !(
        await pool.query(
          'SELECT 1 FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 AND role_code=$4',
          [receipt.accountId, ids.tenantA, appCode, roleCode],
        )
      ).rowCount
    )
      await governance.saveBinding(context('Cấp vai trò Quy trình cho quản trị dùng thử'), {
        appCode,
        accountId: receipt.accountId,
        roleCode,
        orgUnitId: null,
      });
  const grants = (
    await pool.query(
      'SELECT tenant_id,app_code,active FROM application_grants WHERE account_id=$1 AND app_code=$2',
      [receipt.accountId, appCode],
    )
  ).rows;
  assert.deepEqual(grants, [{ tenant_id: ids.tenantA, app_code: appCode, active: true }]);
  const bindings = (
    await pool.query(
      'SELECT tenant_id,app_code,role_code,org_unit_id,active FROM role_bindings WHERE account_id=$1 AND app_code=$2 ORDER BY role_code',
      [receipt.accountId, appCode],
    )
  ).rows;
  assert.deepEqual(
    bindings,
    Object.keys(roles)
      .sort()
      .map((role_code) => ({
        tenant_id: ids.tenantA,
        app_code: appCode,
        role_code,
        org_unit_id: null,
        active: true,
      })),
  );
  await assert.rejects(
    () =>
      store.principal(
        {
          issuer: runtime.issuer,
          subject: receipt.subject!,
          authenticatedAt: Math.floor(Date.now() / 1000),
          authenticationMethods: ['pwd'],
        },
        appCode,
      ),
    { code: 'MFA_REQUIRED' },
  );
  if (!receipt.provisioned) {
    receipt.provisioned = true;
    await save();
  }
  console.log(
    'PASS: workflows.admin provisioned in local tenant A with design/publish/manage/report only. User must change temporary password and enroll MFA; no existing credentials or fixtures changed.',
  );
} catch {
  console.error(
    'Workflow review administrator setup failed at ' + stage + '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await Promise.all(pools.map((pool) => pool.end()));
}
