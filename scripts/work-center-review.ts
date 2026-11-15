import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { loadLocalConfig, applicationDatabaseUrl, assertLocalDatabase } from '../src/config.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localContainer } from './local-docker.js';
import { ids } from '../src/fixtures.js';
const runtime = await loadLocalConfig();
const receipt = JSON.parse(await readFile('.local/workflows-admin.json', 'utf8')) as {
  instanceId: string;
  username: string;
  accountId: string;
  personId: string;
  subject: string;
  provisioned: boolean;
};
assert.equal(receipt.instanceId, runtime.instanceId);
assert.equal(receipt.username, 'workflows.admin');
assert.equal(receipt.provisioned, true);
const connectionString = applicationDatabaseUrl(runtime, false);
assertLocalDatabase(connectionString, false);
assert.equal((await localContainer('foundation-db')).running, true);
assert.equal((await localContainer('keycloak')).running, true);
const pool = new pg.Pool({ connectionString, max: 2 }),
  store = new Store(pool),
  governance = new GovernanceService(store),
  browser = await chromium.launch({ headless: true });
try {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-local',
  );
  const target = (
    await pool.query(
      'SELECT a.person_id,i.subject FROM accounts a JOIN external_identities i ON i.account_id=a.id AND i.active WHERE a.id=$1 AND a.active AND i.issuer=$2',
      [receipt.accountId, runtime.issuer],
    )
  ).rows;
  assert.deepEqual(target, [{ person_id: receipt.personId, subject: receipt.subject }]);
  const proof = await authenticateMfaFixture(browser, runtime, ids.admin),
    identity = {
      issuer: runtime.issuer,
      subject: proof.subject,
      authenticatedAt: proof.authTime,
      authenticationMethods: proof.authenticationMethods ?? [],
    };
  const actor = await store.principal(identity, 'aio-foundation');
  assert.equal(actor.accountId, ids.admin);
  const grants = (
    await pool.query('SELECT * FROM application_grants WHERE account_id=$1 AND tenant_id=$2', [
      receipt.accountId,
      ids.tenantA,
    ])
  ).rows;
  assert.ok(grants.some((g) => g.app_code === 'aio-workflows' && g.active));
  const portal = grants.find((g) => g.app_code === 'aio-foundation');
  if (!portal)
    await governance.saveGrant(
      {
        identity,
        appCode: 'aio-foundation',
        tenantId: ids.tenantA,
        reason: 'Mở Portal cá nhân cho quản trị Quy trình dùng thử Trung tâm công việc',
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
      { accountId: receipt.accountId, appCode: 'aio-foundation', active: true },
      0,
    );
  else
    assert.equal(
      portal.active,
      true,
      'Existing revoked Portal grant is preserved; explicit regrant needed.',
    );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM role_bindings WHERE account_id=$1 AND app_code='aio-foundation' AND active",
        [receipt.accountId],
      )
    ).rowCount,
    0,
  );
  await writeFile(
    '.local/WORK-CENTER-TRY.md',
    '# Dùng thử Trung tâm công việc\n\nMở http://127.0.0.1:4100/#work-center bằng workflows.admin để xem bảng theo dõi và cấu hình nhắc hạn. Tài khoản này có Portal cá nhân và quyền Quy trình đã cấp; không có quyền quản trị Foundation. Mật khẩu tạm trong workflows-admin.json cùng thư mục .local; tự mở trên máy, không gửi vào chat/Git. Nếu chưa thiết lập, tự đổi mật khẩu và đăng ký MFA lần đầu.\n\nĐể thử phía nhân viên, demo.learner có Portal và quyền gửi Quy trình; mật khẩu nằm trong runtime.json, chỉ mở trên máy. Hồ sơ/nhiệm vụ được tạo ở Quy trình 4105 sẽ hiện theo quyền nguồn. Thông báo chỉ có từ khi nâng cấp; không phát lại toàn bộ lịch sử.\n\nNhắc hạn mặc định tắt ở đơn vị chưa cấu hình. Bật trong Cấu hình nhắc hạn; npm run dev chạy tiến trình mỗi 30 giây. Khi chạy npm start, mở thêm npm run work-center:worker. Đọc docs/WORK_CENTER.md cho giới hạn và rollback. Không gửi email/SMS/Slack.\n',
  );
  await writeFile(
    '.local/evidence/work-center-review-account.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        username: receipt.username,
        portalGrant: true,
        foundationAdminRoles: 0,
        passwordAndMfaUntouched: true,
        sourceGrantPreserved: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: workflows.admin has personal Portal plus existing Workflows rights; password/MFA unchanged. See .local/WORK-CENTER-TRY.md.',
  );
} finally {
  await browser.close();
  await pool.end();
}
