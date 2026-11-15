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
  purpose: 'tlqm-aio-organization-review-admin';
  instanceId: string;
  username: 'org.admin';
  password: string;
  accountId: string;
  personId: string;
  subject?: string;
  provisioned?: boolean;
};
const file = '.local/organization-admin.json',
  appCode = 'aio-foundation',
  roleCode = 'organization-admin';
const delegatedApps = ['aio-foundation', 'aio-forms', 'aio-lms-sandbox', 'aio-workflows'];
const permissions = [
  'directory:read',
  'directory:manage',
  'people:read',
  'people:manage',
  'accounts:manage',
  'identity:link',
  'applications:manage',
  'roles:read',
  'roles:manage',
  'access:manage',
  'audit:read',
].sort();
const pools: pg.Pool[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  stage = 'local preflight',
  transportFailed = false;
try {
  const runtime = await loadLocalConfig();
  assertLocalDatabase(runtime.databaseUrl);
  for (const name of ['keycloak', 'foundation-db'] as const)
    assert.equal((await localContainer(name)).running, true);
  const pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime), max: 2 }),
    owner = new pg.Pool({ connectionString: runtime.databaseUrl, max: 1 });
  pools.push(pool, owner);
  for (const p of pools)
    p.on('error', () => {
      transportFailed = true;
      console.error('Local organization setup dependency unavailable; connection details omitted.');
    });
  assert.equal(
    (await owner.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-local',
  );
  assert.deepEqual(
    (await owner.query('SELECT current_database() AS name,current_user AS owner')).rows[0],
    { name: 'aio_foundation', owner: 'aio_foundation' },
  );
  browser = await chromium.launch({ headless: true });
  stage = 'operator MFA and authority';
  const proof = await authenticateMfaFixture(browser, runtime, ids.admin),
    identity = {
      issuer: runtime.issuer,
      subject: proof.subject,
      authenticatedAt: proof.authTime,
      authenticationMethods: proof.authenticationMethods ?? [],
    };
  const store = new Store(pool),
    governance = new GovernanceService(store),
    operator = await store.principal(identity, appCode);
  assert.equal(operator.accountId, ids.admin);
  for (const permission of permissions) store.require(operator, permission, ids.tenantA);
  for (const code of delegatedApps)
    for (const permission of ['roles:manage', 'access:manage'])
      await governance.assertApp(pool, operator, ids.tenantA, code, permission);
  const context = (reason: string) => ({
    identity,
    appCode,
    tenantId: ids.tenantA,
    reason,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  let receipt: Receipt;
  try {
    receipt = JSON.parse(await readFile(file, 'utf8')) as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    receipt = {
      purpose: 'tlqm-aio-organization-review-admin',
      instanceId: runtime.instanceId,
      username: 'org.admin',
      password: randomBytes(24).toString('base64url'),
      accountId: randomUUID(),
      personId: randomUUID(),
    };
    await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  assert.equal(receipt.purpose, 'tlqm-aio-organization-review-admin');
  assert.equal(receipt.instanceId, runtime.instanceId);
  assert.equal(receipt.username, 'org.admin');
  assert.match(receipt.password, /^[A-Za-z0-9_-]{32}$/);
  for (const id of [receipt.accountId, receipt.personId]) assert.match(id, /^[0-9a-f-]{36}$/);
  const save = async () => {
    await writeFile(
      '.local/organization-admin.next.json',
      JSON.stringify(receipt, null, 2) + '\n',
      { mode: 0o600 },
    );
    await rename('.local/organization-admin.next.json', file);
  };
  stage = 'owned local SSO identity';
  const idp = await localKeycloakAdmin(runtime);
  if (!receipt.subject) {
    assert.equal(
      ((await (await idp('/users?username=org.admin&exact=true')).json()) as unknown[]).length,
      0,
      'Existing usernames without a receipt are never claimed',
    );
    const profile = (await (await idp('/users/profile')).json()) as {
      attributes: { name: string; permissions: unknown }[];
    };
    for (const name of ['aio.local.instance', 'aio.local.fixture'])
      assert.deepEqual(profile.attributes.find((a) => a.name === name)?.permissions, {
        view: ['admin'],
        edit: ['admin'],
      });
    const created = await idp('/users', 'POST', {
      username: receipt.username,
      enabled: true,
      firstName: 'Quản trị tổ chức',
      lastName: 'Dùng thử',
      email: 'org.admin@example.test',
      emailVerified: true,
      attributes: {
        'aio.local.instance': [runtime.instanceId],
        'aio.local.fixture': ['organization-review-admin'],
      },
      requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
      credentials: [{ type: 'password', value: receipt.password, temporary: true }],
    });
    const subject = created.headers.get('location')?.split('/').pop();
    assert.ok(subject);
    receipt.subject = subject;
    await save();
  }
  const idpAccount = (await (await idp('/users/' + receipt.subject)).json()) as {
    id: string;
    username: string;
    attributes: Record<string, string[]>;
  };
  assert.equal(idpAccount.id, receipt.subject);
  assert.equal(idpAccount.username, receipt.username);
  assert.equal(idpAccount.attributes['aio.local.instance']?.[0], runtime.instanceId);
  assert.equal(idpAccount.attributes['aio.local.fixture']?.[0], 'organization-review-admin');
  if (!receipt.provisioned)
    await idp('/users/' + receipt.subject + '/role-mappings/realm', 'POST', [
      await (await idp('/roles/aio-mfa-required')).json(),
    ]);
  stage = 'audited person and identity bootstrap';
  const db = await owner.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(71092027)');
    const actor = await store.principal(identity, appCode, db);
    for (const p of ['accounts:manage', 'people:manage', 'identity:link'])
      store.require(actor, p, ids.tenantA);
    const marker = 'organization-review-admin-v1:' + receipt.accountId;
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
        'Quản trị tổ chức · Dùng thử',
      ]);
      await db.query('INSERT INTO accounts(id,person_id,mfa_required) VALUES ($1,$2,true)', [
        receipt.accountId,
        receipt.personId,
      ]);
      await db.query(
        "INSERT INTO external_identities(issuer,subject,account_id,verified_at,verified_by,verification_method) VALUES ($1,$2,$3,now(),$4,'organization-local-provisioning')",
        [runtime.issuer, receipt.subject, receipt.accountId, actor.accountId],
      );
      await db.query('INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)', [
        receipt.accountId,
        ids.tenantA,
      ]);
      await db.query('INSERT INTO bootstrap_receipts(name) VALUES ($1)', [marker]);
      await auditMutation(
        db,
        context('Chuẩn bị quản trị cơ cấu local để người dùng thử'),
        actor,
        'organization.review_admin.created',
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
    for (const code of delegatedApps) {
      await governance.assertApp(db, actor, ids.tenantA, code, 'roles:manage');
      await governance.assertApp(db, actor, ids.tenantA, code, 'access:manage');
      const old = (
        await db.query(
          'SELECT active FROM application_delegations WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
          [receipt.accountId, ids.tenantA, code],
        )
      ).rows[0];
      if (!old) {
        await db.query(
          'INSERT INTO application_delegations(account_id,tenant_id,app_code,created_by) VALUES ($1,$2,$3,$4)',
          [receipt.accountId, ids.tenantA, code, actor.accountId],
        );
        await auditMutation(
          db,
          context('Ủy quyền quản lý truy cập ứng dụng giả lập'),
          actor,
          'organization.review_admin.delegated',
          'application-delegation',
          code,
          null,
          { accountId: receipt.accountId, appCode: code },
          receipt.accountId,
        );
      } else assert.equal(old.active, true, 'Revoked delegation is never revived by rerun');
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  stage = 'explicit Foundation role and grant';
  if (
    !(
      await pool.query('SELECT 1 FROM app_roles WHERE tenant_id=$1 AND app_code=$2 AND code=$3', [
        ids.tenantA,
        appCode,
        roleCode,
      ])
    ).rowCount
  )
    await governance.saveRole(context('Tạo vai trò quản trị cơ cấu local'), {
      appCode,
      code: roleCode,
      name: 'Quản trị tổ chức & truy cập',
      permissions,
      active: true,
    });
  const currentRole = (await governance.roles(operator, ids.tenantA, appCode)).items.find(
    (row) => row.code === roleCode,
  );
  assert.ok(currentRole);
  assert.equal(currentRole.active, true);
  assert.deepEqual(currentRole.permissions, permissions);
  if (
    !(
      await pool.query(
        'SELECT 1 FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
        [receipt.accountId, ids.tenantA, appCode],
      )
    ).rowCount
  )
    await governance.saveGrant(context('Cấp Portal quản trị cơ cấu local'), {
      appCode,
      accountId: receipt.accountId,
      active: true,
    });
  if (
    !(
      await pool.query(
        'SELECT 1 FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 AND role_code=$4',
        [receipt.accountId, ids.tenantA, appCode, roleCode],
      )
    ).rowCount
  )
    await governance.saveBinding(context('Gán quản trị cơ cấu cho tài khoản dùng thử'), {
      appCode,
      accountId: receipt.accountId,
      roleCode,
      orgUnitId: null,
    });
  assert.deepEqual(
    (
      await pool.query(
        'SELECT app_code,active FROM application_grants WHERE account_id=$1 ORDER BY app_code',
        [receipt.accountId],
      )
    ).rows,
    [{ app_code: appCode, active: true }],
  );
  assert.deepEqual(
    (
      await pool.query(
        'SELECT app_code,role_code,org_unit_id,active FROM role_bindings WHERE account_id=$1',
        [receipt.accountId],
      )
    ).rows,
    [{ app_code: appCode, role_code: roleCode, org_unit_id: null, active: true }],
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
  await writeFile(
    '.local/ORGANIZATION-TRY.md',
    [
      '# Dùng thử cơ cấu tổ chức và quản trị truy cập',
      '',
      'Mở http://127.0.0.1:4100/#organization và bắt đầu Đăng nhập SSO. Tài khoản: org.admin.',
      '',
      'Mật khẩu tạm nằm trong organization-admin.json cùng thư mục .local. Chỉ mở trên máy, không gửi vào chat hoặc Git. Lần đầu tự thiết lập MFA và đổi mật khẩu tạm, rồi đăng nhập lại bằng mật khẩu mới + OTP. Script chạy lại giữ nguyên các thiết lập của bạn.',
      '',
      'Các mục: Cơ cấu tổ chức → sơ đồ/pháp nhân/đơn vị/chức danh/vị trí; Nhân sự & tài khoản → danh bạ/hồ sơ/công tác/bổ nhiệm; Vai trò & truy cập → ma trận/cấp quyền theo ứng dụng và đơn vị.',
      '',
      'Tài khoản quản trị cơ cấu trong không gian giả lập A; có quyền xác minh định danh, quản lý tài khoản, vai trò và truy cập Foundation/Forms/LMS/Quy trình. Không có quyền Keycloak admin hoặc tự có quyền sử dụng các module nghiệp vụ. Không sửa tài khoản được bảo vệ hoặc tự cấp quyền cho mình. Chỉ dữ liệu local giả lập.',
      '',
      'Mật khẩu/tài khoản SSO thật do IdP quản lý. Thêm tài khoản AIO trong UI chưa tạo credential ở IdP; dùng Định danh & vòng đời để xác minh liên kết, không ghép bằng email hoặc tên.',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  assert.equal(transportFailed, false);
  console.log(
    'PASS: org.admin local and explicit Foundation role/delegations ready. Credentials stay in .local/organization-admin.json; user MFA/password setup remains required.',
  );
} catch (error) {
  console.error(
    'Organization administrator setup failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '); sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const pool of pools) await pool.end();
}
