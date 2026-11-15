import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import type { APIResponse } from '@playwright/test';
import { loadLocalConfig, applicationDatabaseUrl, assertLocalDatabase } from '../src/config.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { ids } from '../src/fixtures.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { auditMutation } from '../src/management/mutations.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { nextFixtureOtp } from './local-totp.js';
import { localContainer } from './local-docker.js';
import type { FormsFixture } from './forms-fixtures.js';
type Receipt = {
  purpose: 'tlqm-aio-lms-review-admin';
  instanceId: string;
  username: 'lms.admin';
  password: string;
  accountId: string;
  personId: string;
  employmentId: string;
  assignmentId: string;
  subject?: string;
  provisioned?: boolean;
};
type AdminMapping = { accountId: string; credentialKind: string; active: boolean; state: string };
const file = '.local/lms-admin.json',
  appCode = 'aio-lms-sandbox',
  base = 'http://127.0.0.1:4104';
let pool: pg.Pool | undefined,
  owner: pg.Pool | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  stage = 'local preflight',
  transportFailed = false;
try {
  const runtime = await loadLocalConfig();
  assert.equal((await localContainer('keycloak')).running, true);
  assert.equal((await localContainer('foundation-db')).running, true);
  assertLocalDatabase(runtime.databaseUrl);
  const ready = await fetch(base + '/health/ready');
  assert.equal(ready.status, 200);
  const health = (await ready.json()) as {
    environment: string;
    instanceId: string;
    service: string;
  };
  assert.equal(health.environment, 'tlqm-aio-lms-local');
  assert.equal(health.instanceId, runtime.instanceId);
  assert.equal(health.service, appCode);
  pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime), max: 2 });
  owner = new pg.Pool({ connectionString: runtime.databaseUrl, max: 1 });
  owner.on('error', () => {
    transportFailed = true;
    process.exitCode = 1;
    console.error('Local fixture owner connection unavailable; details omitted.');
  });
  assert.deepEqual(
    (await owner.query('SELECT current_database() AS name,current_user AS owner')).rows[0],
    { name: 'aio_foundation', owner: 'aio_foundation' },
  );
  assert.equal(
    (await owner.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-local',
  );
  pool.on('error', () => {
    transportFailed = true;
    process.exitCode = 1;
    console.error('LMS administrator setup database unavailable; connection details omitted.');
  });
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-local',
  );
  browser = await chromium.launch({ headless: true });
  stage = 'operator MFA and authority';
  const proof = await authenticateMfaFixture(browser, runtime, ids.admin),
    identity = {
      issuer: runtime.issuer,
      subject: proof.subject,
      authenticatedAt: proof.authTime,
      authenticationMethods: proof.authenticationMethods ?? [],
    },
    store = new Store(pool),
    governance = new GovernanceService(store),
    operator = await store.principal(identity, 'aio-foundation');
  assert.equal(operator.accountId, ids.admin);
  for (const permission of ['accounts:manage', 'people:manage', 'identity:link'])
    store.require(operator, permission, ids.tenantA);
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
  const rolePermissions = (
    await pool.query<{ permission: string }>(
      "SELECT p.permission FROM role_permissions p JOIN app_roles r ON r.tenant_id=p.tenant_id AND r.app_code=p.app_code AND r.code=p.role_code AND r.active JOIN permission_catalog c ON c.app_code=p.app_code AND c.code=p.permission AND c.active WHERE p.tenant_id=$1 AND p.app_code=$2 AND p.role_code='admin' ORDER BY p.permission",
      [ids.tenantA, appCode],
    )
  ).rows.map((r) => r.permission);
  assert.deepEqual(rolePermissions, [
    'directory:lookup',
    'identity:provision',
    'lms:admin',
    'lms:learn',
    'lms:review',
  ]);
  let receipt: Receipt;
  try {
    receipt = JSON.parse(await readFile(file, 'utf8')) as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    receipt = {
      purpose: 'tlqm-aio-lms-review-admin',
      instanceId: runtime.instanceId,
      username: 'lms.admin',
      password: randomBytes(24).toString('base64url'),
      accountId: randomUUID(),
      personId: randomUUID(),
      employmentId: randomUUID(),
      assignmentId: randomUUID(),
    };
    await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  assert.equal(receipt.purpose, 'tlqm-aio-lms-review-admin');
  assert.equal(receipt.instanceId, runtime.instanceId);
  assert.equal(receipt.username, 'lms.admin');
  assert.match(receipt.password, /^[A-Za-z0-9_-]{32}$/);
  for (const id of [
    receipt.accountId,
    receipt.personId,
    receipt.employmentId,
    receipt.assignmentId,
  ])
    assert.match(id, /^[0-9a-f-]{36}$/);
  const save = async () => {
    await writeFile('.local/lms-admin.next.json', JSON.stringify(receipt, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename('.local/lms-admin.next.json', file);
  };
  const idp = await localKeycloakAdmin(runtime);
  stage = 'owned local SSO account';
  if (!receipt.subject) {
    assert.equal(
      ((await (await idp('/users?username=lms.admin&exact=true')).json()) as unknown[]).length,
      0,
      'Existing username without creation receipt is never claimed',
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
      firstName: 'Quản trị LMS',
      lastName: 'Dùng thử',
      email: 'lms.admin@example.test',
      emailVerified: true,
      attributes: {
        'aio.local.instance': [runtime.instanceId],
        'aio.local.fixture': ['lms-review-admin'],
      },
      requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
      credentials: [{ type: 'password', value: receipt.password, temporary: true }],
    });
    const createdSubject = created.headers.get('location')?.split('/').pop();
    assert.ok(createdSubject);
    receipt.subject = createdSubject;
    await save();
  }
  const account = (await (await idp('/users/' + receipt.subject)).json()) as {
    id: string;
    username: string;
    attributes: Record<string, string[]>;
    requiredActions: string[];
  };
  assert.equal(account.id, receipt.subject);
  assert.equal(account.username, receipt.username);
  assert.equal(account.attributes['aio.local.instance']?.[0], runtime.instanceId);
  assert.equal(account.attributes['aio.local.fixture']?.[0], 'lms-review-admin');
  if (!receipt.provisioned) {
    const mfaRole = await (await idp('/roles/aio-mfa-required')).json();
    await idp('/users/' + receipt.subject + '/role-mappings/realm', 'POST', [mfaRole]);
  }
  stage = 'IAM person employment and identity ownership';
  const db = await owner.connect();
  try {
    await db.query('BEGIN');
    const actor = await store.principal(identity, 'aio-foundation', db),
      marker = 'lms-review-admin:' + receipt.accountId;
    for (const permission of ['accounts:manage', 'people:manage', 'identity:link'])
      store.require(actor, permission, ids.tenantA);
    if (!(await db.query('SELECT 1 FROM bootstrap_receipts WHERE name=$1', [marker])).rowCount) {
      assert.equal(
        (
          await db.query('SELECT 1 FROM accounts WHERE id=$1 OR person_id=$2', [
            receipt.accountId,
            receipt.personId,
          ])
        ).rowCount,
        0,
      );
      const position = (
        await db.query(
          'SELECT p.id FROM positions p JOIN org_units u ON u.id=p.org_unit_id AND u.tenant_id=p.tenant_id AND u.active WHERE p.tenant_id=$1 AND p.org_unit_id=$2 AND p.active ORDER BY p.id LIMIT 1',
          [ids.tenantA, ids.unitA],
        )
      ).rows[0]?.id;
      assert.ok(position);
      await db.query('INSERT INTO persons(id,home_tenant_id,display_name) VALUES ($1,$2,$3)', [
        receipt.personId,
        ids.tenantA,
        'Quản trị LMS · Dùng thử',
      ]);
      await db.query('INSERT INTO accounts(id,person_id,mfa_required) VALUES ($1,$2,true)', [
        receipt.accountId,
        receipt.personId,
      ]);
      await db.query(
        "INSERT INTO external_identities(issuer,subject,account_id,verified_at,verified_by,verification_method) VALUES ($1,$2,$3,now(),$4,'lms-local-provisioning')",
        [runtime.issuer, receipt.subject, receipt.accountId, actor.accountId],
      );
      await db.query('INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)', [
        receipt.accountId,
        ids.tenantA,
      ]);
      await db.query(
        'INSERT INTO employments(id,person_id,tenant_id,legal_entity_id,employee_code) VALUES ($1,$2,$3,$4,$5)',
        [receipt.employmentId, receipt.personId, ids.tenantA, ids.legalA, 'LMS-ADMIN-DEMO'],
      );
      await db.query(
        'INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary) VALUES ($1,$2,$3,$4,$5,true)',
        [receipt.assignmentId, ids.tenantA, ids.legalA, receipt.employmentId, position],
      );
      await db.query('INSERT INTO bootstrap_receipts(name) VALUES ($1)', [marker]);
      await auditMutation(
        db,
        context('Tạo quản trị LMS local dùng thử theo yêu cầu'),
        actor,
        'lms.review_admin.created',
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
  stage = 'LMS administration and personal Portal access';
  for (const grantCode of [appCode, 'aio-foundation'])
    if (
      !(
        await pool.query(
          'SELECT 1 FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
          [receipt.accountId, ids.tenantA, grantCode],
        )
      ).rowCount
    )
      await governance.saveGrant(context('Cấp LMS và Portal cá nhân cho tài khoản dùng thử'), {
        appCode: grantCode,
        accountId: receipt.accountId,
        active: true,
      });
  if (
    !(
      await pool.query(
        "SELECT 1 FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 AND role_code='admin'",
        [receipt.accountId, ids.tenantA, appCode],
      )
    ).rowCount
  )
    await governance.saveBinding(context('Cấp vai trò LMS admin dùng thử'), {
      appCode,
      accountId: receipt.accountId,
      roleCode: 'admin',
      orgUnitId: null,
    });
  assert.deepEqual(
    (
      await pool.query(
        'SELECT app_code,tenant_id,active FROM application_grants WHERE account_id=$1 ORDER BY app_code',
        [receipt.accountId],
      )
    ).rows,
    ['aio-foundation', appCode].map((app_code) => ({
      app_code,
      tenant_id: ids.tenantA,
      active: true,
    })),
  );
  assert.deepEqual(
    (
      await pool.query(
        'SELECT app_code,role_code,org_unit_id,active FROM role_bindings WHERE account_id=$1 ORDER BY role_code',
        [receipt.accountId],
      )
    ).rows,
    [{ app_code: appCode, role_code: 'admin', org_unit_id: null, active: true }],
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
  stage = 'LMS passwordless mapping via verified API';
  const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
    instanceId: string;
    users: FormsFixture[];
  };
  assert.equal(fixtures.instanceId, runtime.instanceId);
  const admin = fixtures.users.find((u) => u.role === 'publisher')!,
    contextBrowser = await browser.newContext(),
    page = await contextBrowser.newPage();
  await page.goto(base + '/auth/login?reauth=1');
  await page.locator('#username').fill(admin.username);
  await page.locator('#password').fill(admin.password);
  await page.locator('#kc-login').click();
  await page.locator('#otp').fill(await nextFixtureOtp(admin.id));
  await page.locator('#kc-login').click();
  await page.waitForURL(base + '/');
  await expect(
    page.getByRole('heading', { name: 'Khóa học dành cho bạn', exact: true }),
  ).toBeVisible();
  const meResponse = await contextBrowser.request.get(base + '/api/v1/me');
  assert.equal(meResponse.status(), 200);
  const me = (await meResponse.json()) as { csrfToken: string };
  let cursor: string | null = null,
    existing: AdminMapping | undefined;
  do {
    const response: APIResponse = await contextBrowser.request.get(
      base + '/api/lms/learners' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert.equal(response.status(), 200);
    const body = (await response.json()) as {
      items: AdminMapping[];
      nextCursor: string | null;
    };
    existing = body.items.find((p) => p.accountId === receipt.accountId);
    cursor = body.nextCursor;
  } while (!existing && cursor);
  if (!existing) {
    const response = await contextBrowser.request.post(base + '/api/lms/learner-commands', {
      headers: {
        origin: base,
        'x-csrf-token': me.csrfToken,
        'idempotency-key': 'lms-review-admin-' + receipt.accountId,
      },
      data: {
        action: 'provision',
        data: { accountId: receipt.accountId, orgUnitId: ids.unitA, expectedRevision: 0 },
        reason: 'Tạo hồ sơ quản trị LMS local dùng thử',
      },
    });
    assert.equal(response.status(), 200);
  } else {
    assert.equal(existing.credentialKind, 'sso-only');
    assert.equal(
      existing.active,
      true,
      'Disabled mapping requires explicit operator restoration, never a setup rerun',
    );
    assert.equal(existing.state, 'ready');
  }
  if (!receipt.provisioned) {
    receipt.provisioned = true;
    await save();
  }
  await writeFile(
    '.local/LMS-TRY.md',
    [
      '# Dùng thử quản trị LMS',
      '',
      'Mở http://127.0.0.1:4104/auth/login để bắt đầu lượt đăng nhập mới.',
      '',
      'Tài khoản: lms.admin. Mật khẩu tạm nằm trong file lms-admin.json cùng thư mục .local; chỉ mở trên máy của bạn, không gửi vào chat hoặc Git.',
      '',
      'Lần đầu: hoàn thành thiết lập MFA và đổi mật khẩu tạm theo các bước SSO yêu cầu. Sau đó bấm Đăng nhập SSO để đăng nhập lại bằng mật khẩu mới và mã OTP. Nếu đã đổi mật khẩu, dùng mật khẩu mới của bạn; chạy lại script không đặt lại mật khẩu hoặc MFA.',
      '',
      'Sau khi đăng nhập: Khóa học & nội dung → Ngân hàng câu hỏi → Bảng điểm & báo cáo → Học viên & tài khoản. Đây là dữ liệu giả lập local. Tài khoản có quyền quản trị LMS và vào Portal để xem ứng dụng/hồ sơ của chính mình. Không có quyền quản trị Foundation hoặc module khác.',
      '',
      'Nếu link callback cũ báo lỗi, quay lại địa chỉ /auth/login ở trên. Không tái sử dụng link Keycloak hoặc callback đã lưu.',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  assert.equal(transportFailed, false);
  console.log(
    'PASS: dedicated lms.admin and passwordless profile provisioned locally; credentials stay in .local/lms-admin.json. User password change and MFA enrollment remain required.',
  );
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  console.error(
    'LMS review administrator setup failed at ' +
      stage +
      (typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? ' (' + code + ')' : '') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await pool?.end();
  await owner?.end();
}
