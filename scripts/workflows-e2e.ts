import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import type { Page, APIResponse, BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import { reserveTestRequests } from './e2e-request-budget.js';
import { localContainer } from './local-docker.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { WorkflowsService } from '../src/workflows/service.js';
import type { ReportBucket, ReportObservation } from '../src/workflows/report-options.js';
type DefinitionItem = Awaited<ReturnType<WorkflowsService['definitions']>>['items'][number];
type RunDetail = Awaited<ReturnType<WorkflowsService['detail']>>;
const runtime = await loadLocalConfig(),
  A = 'http://127.0.0.1:4100',
  W = 'http://127.0.0.1:4105';
const documentLibrary = process.argv.includes('--document-library');
const versionHistory = process.argv.includes('--version-history');
const customReport = process.argv.includes('--custom-report');
const performance = customReport || process.argv.includes('--performance-report');
const reportEvidence =
  '.local/evidence/workflows-' + (customReport ? 'custom-report-' : 'performance-');
const versionEvidence = '.local/evidence/workflows-version-history-';
const documentEvidence = '.local/evidence/workflows-document-library-';
const evidence = performance
  ? reportEvidence
  : versionHistory
    ? versionEvidence
    : documentLibrary
      ? documentEvidence
      : '.local/evidence/workflows-';
const receipt = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(receipt.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => receipt.users.find((user) => user.role === name)!;
const browser = await chromium.launch({ headless: true }),
  servers: Awaited<ReturnType<typeof createApp>>[] = [];
const pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 1 });
let stage = 'preflight',
  current: Page | undefined;
const checks: string[] = [],
  scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
let restoreGrant: (() => Promise<void>) | undefined;
async function status(response: APIResponse, expected: number) {
  if (response.status() !== expected) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    console.error(
      'Workflow HTTP ' +
        response.status() +
        '/' +
        expected +
        (body.error && /^[A-Z0-9_]+$/.test(body.error) ? ' ' + body.error : ''),
    );
  }
  assert.equal(response.status(), expected);
}
async function login(
  user: { id: string; username: string; password: string },
  mfa = false,
  base = W,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective),
    );
  });
  const page = await context.newPage();
  current = page;
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === base && url.pathname === '/');
  await status(await context.request.get(base + '/api/v1/me'), 200);
  return { page, context };
}
async function write(
  context: BrowserContext,
  path: string,
  data: Record<string, unknown>,
  csrf?: string,
  key = randomUUID(),
) {
  const me = await (await context.request.get(W + '/api/v1/me')).json();
  return context.request.post(W + '/api/v1/workflows' + path, {
    headers: { origin: W, 'x-csrf-token': csrf ?? me.csrfToken, 'idempotency-key': key },
    data: { tenantId: ids.tenantA, reason: 'Nghiệm thu Quy trình giả lập', ...data },
  });
}
const select = async (page: Page, label: string, choice: string) => {
  const trigger = page.getByRole('combobox', { name: label, exact: true });
  await trigger.click();
  await page.getByRole('option', { name: choice, exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(trigger).toHaveText(choice);
};
async function checkResponsiveGraph(page: Page) {
  for (const width of [1440, 390, 320, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
          const nodes = Array.from(document.querySelectorAll('.react-flow__node')).map((node) =>
            node.getBoundingClientRect(),
          );
          if (!canvas || nodes.length !== 6) return false;
          const center =
            (Math.min(...nodes.map((node) => node.left)) +
              Math.max(...nodes.map((node) => node.right))) /
            2;
          return (
            Math.abs(center - (canvas.left + canvas.width / 2)) <= 2 &&
            nodes.every(
              (node) =>
                node.width > 0 &&
                node.left >= canvas.left - 1 &&
                node.right <= canvas.right + 1 &&
                node.top >= canvas.top - 1 &&
                node.bottom <= canvas.bottom + 1,
            )
          );
        }),
      )
      .toBe(true);
  }
  checks.push('Graph remains centered and fully visible through desktop → 390 → 320 → desktop');
}
async function confirm(page: Page, reason = 'Nghiệm thu luồng xử lý giả lập') {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Ý kiến / lý do').fill(reason);
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function scan(page: Page, screen: string) {
  current = page;
  assert.equal(new URL(page.url()).origin, W);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.waitForTimeout(150);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    screen,
    violations: result.violations.map((issue) => issue.id),
    incomplete: result.incomplete.map((issue) => issue.id),
  });
  if (result.violations.length)
    console.error(
      JSON.stringify(
        result.violations.map((issue) => ({
          id: issue.id,
          targets: issue.nodes.map((node) => node.target),
        })),
      ),
    );
  assert.deepEqual(
    result.violations.map((issue) => issue.id),
    [],
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(
    await page
      .getByRole('tablist')
      .evaluateAll((lists) =>
        lists.every((list) =>
          Array.from(list.querySelectorAll('[role="tab"]')).every(
            (tab) => tab.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1,
          ),
        ),
      ),
    true,
    'Wrapped tabs must stay inside their list and not overlap the panel',
  );
  assert.deepEqual(await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp), []);
}
const runDetail = async (context: BrowserContext, id: string) =>
  (await (
    await context.request.get(W + '/api/v1/workflows/runs/' + id + '?tenantId=' + ids.tenantA)
  ).json()) as RunDetail;
async function openInbox(page: Page, title: string) {
  current = page;
  await page.getByRole('button', { name: 'Cần xử lý', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: title });
  await row.getByRole('button', { name: 'Mở lượt chạy' }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  for (const code of ['aio-foundation', 'aio-workflows']) {
    const client = runtime.clients.find((client) => client.code === code)!;
    assert.ok(client);
    const app = await createApp({
      runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
      client,
      test: true,
      logger: false,
    });
    await app.listen({ host: '127.0.0.1', port: client.port });
    servers.push(app);
  }
  stage = 'MFA designer and publisher';
  const designer = await login(role('designer'), true),
    publisher = await login(role('publisher'), true),
    handler = await login(role('reviewer')),
    finance = await login(role('analyst'));
  stage = 'Portal to Workflows SSO';
  const requester = await login(
    runtime.users.find((user) => user.id === ids.learner)!,
    false,
    A,
  );
  await requester.page.goto(W + '/auth/login');
  await requester.page.waitForURL((url) => url.origin === W && url.pathname === '/');
  assert.equal(await requester.page.locator('#username,#password,#otp').count(), 0);
  await status(await requester.context.request.get(W + '/api/v1/me'), 200);
  checks.push('Real Portal → Workflows SSO and MFA design/publish');
  stage = 'Template and graph designer';
  current = designer.page;
  await designer.page.getByRole('heading', { name: 'Quy trình', exact: true }).waitFor();
  await designer.page.getByRole('button', { name: 'Tạo quy trình' }).click();
  await designer.page
    .getByRole('dialog')
    .locator('[data-slot="card"]')
    .filter({ has: designer.page.getByText('Đề nghị mua sắm', { exact: true }) })
    .getByRole('button', { name: 'Dùng mẫu', exact: true })
    .click();
  await checkResponsiveGraph(designer.page);
  const title = 'Mua sắm nghiệm thu ' + randomUUID().slice(0, 6),
    runTitle = 'Đề nghị ' + randomUUID().slice(0, 8);
  await designer.page.getByRole('tab', { name: 'Thông tin & đối tượng' }).click();
  await designer.page.getByLabel('Tên quy trình', { exact: true }).fill(title);
  const lookup = await (
    await designer.context.request.get(W + '/api/v1/workflows/lookups?tenantId=' + ids.tenantA)
  ).json();
  const unitName = lookup.units.find((unit: { id: string }) => unit.id === ids.unitA).name;
  await select(designer.page, 'Đơn vị quản lý', unitName);
  const audienceUnit = designer.page.getByRole('checkbox', { name: unitName, exact: true });
  await audienceUnit.check();
  await expect(audienceUnit).toBeChecked();
  await designer.page.getByRole('tab', { name: 'Luồng xử lý' }).click();
  for (const [step, actor] of [
    ['review', role('reviewer')],
    ['director', role('analyst')],
    ['fulfil', role('analyst')],
  ] as const) {
    await designer.page.locator('.react-flow__node[data-id="' + step + '"]').click();
    await select(designer.page, 'Người xử lý', actor.name);
  }
  await select(designer.page, 'Bước đang cấu hình', 'Từ 10 triệu đồng?');
  const rootGroup = designer.page.getByRole('group', { name: 'Nhóm điều kiện 1', exact: true });
  await rootGroup.getByRole('button', { name: 'Thêm nhóm', exact: true }).click();
  const nestedGroup = designer.page.getByRole('group', { name: 'Nhóm điều kiện 1.2', exact: true });
  await nestedGroup.getByRole('button', { name: 'Thêm điều kiện', exact: true }).click();
  await select(designer.page, 'Trường 1.2.2', 'Ngày cần sử dụng');
  await designer.page.getByRole('button', { name: 'Tự sắp xếp sơ đồ' }).click();
  await scan(designer.page, 'compound-conditions');
  await select(designer.page, 'Bước đang cấu hình', 'Thực hiện mua sắm');
  await scan(designer.page, 'designer');
  await designer.page.screenshot({
    path: '.local/evidence/workflows-designer.png',
    fullPage: true,
  });
  await designer.page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(
    designer.page.getByText('Đã lưu bản nháp. Lượt chạy cũ vẫn dùng phiên bản của chúng.', {
      exact: true,
    }),
  ).toBeVisible();
  let definition = (
    (
      await (
        await designer.context.request.get(
          W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
        )
      ).json()
    ).items as DefinitionItem[]
  ).find((row) => row.name === title)!;
  assert.ok(definition);
  const branch = definition.draft!.nodes.find((node) => node.kind === 'condition')!;
  assert.equal(branch.condition.rules.length, 2);
  assert.equal('rules' in branch.condition.rules[1]! && branch.condition.rules[1].rules.length, 2);
  await status(
    await write(designer.context, '/definitions/' + definition.id + '/publish', {
      expectedRevision: definition.revision,
    }),
    403,
  );
  stage = 'Publish through UI';
  await publisher.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  const card = publisher.page
    .locator('[data-slot="card"]')
    .filter({ has: publisher.page.getByText(title, { exact: true }) });
  await card.getByRole('button', { name: 'Xem & phát hành' }).click();
  await publisher.page.getByRole('button', { name: 'Phát hành', exact: true }).click();
  await confirm(publisher.page);
  definition = (
    (
      await (
        await publisher.context.request.get(
          W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
        )
      ).json()
    ).items as DefinitionItem[]
  ).find((row) => row.id === definition.id)!;
  assert.equal(definition.latest_version, 1);
  checks.push(
    'BOS layout + shadcn visual design, assignees and explicit audience, separate design/publish',
  );
  stage = 'Start request via UI';
  current = requester.page;
  await requester.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  const available = requester.page
    .locator('[data-slot="card"]')
    .filter({ has: requester.page.getByText(title, { exact: true }) });
  await available.getByRole('button', { name: 'Khởi chạy' }).click();
  const dialog = requester.page.getByRole('dialog');
  await dialog.getByLabel('Tiêu đề lượt chạy').fill(runTitle);
  await dialog.locator('#answer-purpose').fill('Mua thiết bị giả lập');
  await dialog.locator('#answer-amount').fill('20000000');
  await dialog.locator('#answer-needed_on').fill('2026-12-01');
  await dialog.getByRole('button', { name: 'Gửi đề nghị' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await expect(requester.page.getByRole('heading', { name: runTitle, exact: true })).toBeVisible();
  const runId = new URL(requester.page.url()).hash.slice(14);
  assert.match(runId, /^[0-9a-f-]{36}$/);
  let detail = await runDetail(requester.context, runId);
  let pending = detail.tasks.find((task) => task.status === 'pending')!;
  assert.equal(pending.node_id, 'review');
  await status(
    await write(finance.context, '/tasks/' + pending.id + '/action', {
      expectedRevision: pending.revision,
      action: 'approve',
      answers: {},
    }),
    403,
  );
  await status(
    await write(
      handler.context,
      '/tasks/' + pending.id + '/action',
      { expectedRevision: pending.revision, action: 'approve', answers: {} },
      'wrong',
    ),
    403,
  );
  stage = 'Return and resubmit UI';
  await openInbox(handler.page, runTitle);
  await handler.page.getByRole('button', { name: 'Trả về', exact: true }).click();
  await confirm(handler.page, 'Bổ sung mô tả trước khi duyệt');
  await requester.page.getByRole('button', { name: 'Tải lại lượt chạy' }).click();
  await requester.page.locator('#answer-purpose').fill('Mô tả đã được bổ sung giả lập');
  await requester.page.getByRole('button', { name: 'Gửi lại đề nghị' }).click();
  await confirm(requester.page, 'Đã bổ sung nội dung yêu cầu');
  detail = await runDetail(requester.context, runId);
  assert.equal(detail.run.round, 2);
  assert.equal(detail.inputs.length, 2);
  await openInbox(handler.page, runTitle);
  await handler.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await confirm(handler.page);
  detail = await runDetail(requester.context, runId);
  assert.equal(detail.run.current_step, 'director');
  checks.push(
    'Return/resubmit retains old inputs and decisions; high-value branch selects director',
  );
  stage = 'Pinned v1 after publishing v2';
  const updatedSpec = structuredClone(definition.draft!);
  updatedSpec.name = title + ' v2';
  const saved = await write(designer.context, '/definitions/' + definition.id, {
    expectedRevision: definition.revision,
    code: definition.code,
    orgUnitId: definition.org_unit_id,
    spec: updatedSpec,
  });
  await status(saved, 200);
  const newDefinition = await saved.json();
  await status(
    await write(publisher.context, '/definitions/' + definition.id + '/publish', {
      expectedRevision: newDefinition.revision,
    }),
    200,
  );
  assert.equal((await runDetail(requester.context, runId)).version.version, 1);
  stage = 'Approval and task form UI';
  await openInbox(finance.page, runTitle);
  await finance.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await confirm(finance.page);
  await finance.page.locator('#answer-result_note').fill('Đã hoàn thành mua sắm giả lập');
  await scan(finance.page, 'task-form');
  await finance.page.getByRole('button', { name: 'Hoàn tất bước', exact: true }).click();
  await confirm(finance.page);
  detail = await runDetail(requester.context, runId);
  assert.equal(detail.run.status, 'completed');
  assert.equal(detail.version.version, 1);
  await finance.page.getByRole('tab', { name: 'Lịch sử', exact: true }).click();
  await expect(
    finance.page.getByText('Bổ sung mô tả trước khi duyệt', { exact: true }),
  ).toBeVisible();
  await scan(finance.page, 'history');
  await finance.page.screenshot({ path: '.local/evidence/workflows-history.png', fullPage: true });
  await requester.page.getByRole('button', { name: 'Tải lại lượt chạy' }).click();
  await requester.page.setViewportSize({ width: 390, height: 844 });
  await scan(requester.page, 'run-mobile');
  await requester.page.screenshot({
    path: '.local/evidence/workflows-run-mobile.png',
    fullPage: true,
  });
  checks.push('Task form execution, immutable version, readable timeline and responsive UI');
  stage = 'Low-value route and live grant revocation';
  const latest = (
    (
      await (
        await publisher.context.request.get(
          W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
        )
      ).json()
    ).items as DefinitionItem[]
  ).find((row) => row.id === definition.id)!;
  const started = await write(requester.context, '/runs', {
    definitionId: latest.id,
    versionId: latest.version!.id,
    unitId: ids.unitA,
    title: 'Luồng hạn mức thấp',
    answers: { purpose: 'Dữ liệu giả lập', amount: 100, needed_on: '2026-12-01' },
  });
  await status(started, 200);
  const low = await started.json();
  detail = await runDetail(requester.context, low.id);
  pending = detail.tasks.find((task) => task.status === 'pending')!;
  const before = (
    await pool.query(
      "SELECT active FROM application_grants WHERE account_id=$1 AND app_code='aio-workflows' AND tenant_id=$2",
      [role('reviewer').id, ids.tenantA],
    )
  ).rows[0];
  assert.equal(before.active, true);
  const change = async (active: boolean) => {
    await pool.query(
      "WITH changed AS (UPDATE application_grants SET active=$1 WHERE account_id=$2 AND tenant_id=$3 AND app_code='aio-workflows' RETURNING account_id) INSERT INTO audit_events(actor_account_id,subject_account_id,tenant_id,app_code,action,reason,request_id) SELECT $4,account_id,$3,'aio-workflows','test.fixture_changed','Workflow live grant test and explicit restoration',$5 FROM changed",
      [active, role('reviewer').id, ids.tenantA, ids.admin, randomUUID()],
    );
  };
  restoreGrant = async () => change(before.active);
  await change(false);
  const revokedAt = Date.now();
  await status(
    await handler.context.request.get(
      W + '/api/v1/workflows/runs?tenantId=' + ids.tenantA + '&view=inbox',
    ),
    403,
  );
  const revokeMs = Date.now() - revokedAt;
  await restoreGrant();
  restoreGrant = undefined;
  const replacement = await login(role('reviewer'));
  const command = { expectedRevision: pending.revision, action: 'approve', answers: {} };
  const key = randomUUID();
  const once = await write(
    replacement.context,
    '/tasks/' + pending.id + '/action',
    command,
    undefined,
    key,
  );
  await status(once, 200);
  await status(
    await write(replacement.context, '/tasks/' + pending.id + '/action', command, undefined, key),
    200,
  );
  assert.equal((await runDetail(requester.context, low.id)).run.current_step, 'fulfil');
  checks.push(
    'Live grant revocation ' +
      revokeMs +
      ' ms; low-value branch skips director; HTTP retries do not duplicate tasks',
  );
  stage = 'Scoped report';
  await publisher.page.getByRole('button', { name: 'Báo cáo', exact: true }).click();
  await expect(publisher.page.getByText('Nhiệm vụ quá hạn', { exact: true })).toBeVisible();
  await scan(publisher.page, 'report');
  if (performance) {
    stage = 'Performance dataset, group, history and chart';
    current = publisher.page;
    const page = publisher.page;
    const pinned = await runDetail(publisher.context, runId);
    const old = pinned.tasks.find((task) => task.status === 'returned')!;
    assert(old && old.round < pinned.run.round);
    const filters = page.getByRole('heading', { name: 'Hiệu quả xử lý', exact: true });
    await expect(filters).toBeVisible();
    await select(page, 'Phiên bản quy trình', title + ' · v1');
    await select(page, 'Đơn vị báo cáo', unitName);
    await select(page, 'Lịch sử xử lý', 'Tất cả lần xử lý');
    await select(page, 'Chỉ số chính', 'Tỷ lệ trễ');
    const resultResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/performance-report?') &&
        res.url().includes('versionId=' + pinned.version.id),
    );
    await page.getByRole('button', { name: 'Áp dụng bộ lọc', exact: true }).press('Enter');
    const response = await resultResponse;
    assert.equal(response.status(), 200);
    const result = (await response.json()) as { groups: ReportBucket[]; totals: { rows: number } };
    assert.equal(result.totals.rows, pinned.tasks.length);
    const group = result.groups.find(
      (bucket) => bucket.key === pinned.version.id + '/' + old.node_id,
    )!;
    assert(group);
    await expect(page.getByRole('region', { name: 'Bảng tổng hợp báo cáo' })).toBeVisible();
    await scan(page, 'performance-table-desktop');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: reportEvidence + 'table-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const table = page.getByRole('region', { name: 'Bảng tổng hợp báo cáo' });
    await table.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await select(page, 'Chỉ số chính', 'Thời gian trung bình');
    await page.getByRole('button', { name: 'Áp dụng bộ lọc', exact: true }).press('Enter');
    await expect(page.getByRole('region', { name: 'Bảng tổng hợp báo cáo' })).toBeVisible();
    await page.getByRole('button', { name: 'Biểu đồ', exact: true }).press('Enter');
    await expect(page.getByRole('list', { name: 'Biểu đồ Thời gian trung bình' })).toBeVisible();
    await scan(page, 'performance-chart-mobile');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: reportEvidence + 'chart-mobile.png', fullPage: true });

    stage = 'Exact detail group and scoped CSV file';
    const detailResponse = page.waitForResponse((res) =>
      res.url().includes('/performance-report/details?'),
    );
    await page
      .getByRole('button', { name: 'Chi tiết nhóm ' + group.label, exact: true })
      .press('Enter');
    const detailResult = await detailResponse;
    assert.equal(detailResult.status(), 200);
    const rows = (await detailResult.json()) as { total: number; items: ReportObservation[] };
    assert.equal(rows.total, group.metrics.rows);
    assert(
      rows.items.some(
        (item) => item.taskId === old.id && item.superseded && item.status === 'returned',
      ),
    );
    assert(rows.items.every((item) => item.runId === runId));
    await expect(
      page.getByRole('heading', { name: 'Chi tiết nhóm ' + group.label, exact: true }),
    ).toBeVisible();
    await scan(page, 'performance-details-mobile');
    await page.screenshot({ path: reportEvidence + 'details-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Tải CSV chi tiết', exact: true }).press('Enter');
    const exportDialog = page.getByRole('dialog', { name: 'Xuất chi tiết báo cáo' });
    await exportDialog.getByLabel('Lý do xuất').fill('Đối chiếu thời gian xử lý giả lập');
    const download = page.waitForEvent('download');
    const exported = page.waitForResponse((res) =>
      res.url().endsWith('/performance-report/export'),
    );
    await exportDialog.getByRole('button', { name: 'Tải CSV', exact: true }).press('Enter');
    const file = await download;
    assert.equal(file.suggestedFilename(), 'bao-cao-quy-trinh.csv');
    const csv = await readFile((await file.path())!, 'utf8');
    assert(csv.startsWith('\uFEFF'));
    assert(csv.includes(old.id));
    assert(!csv.includes('Mua thiết bị giả lập'));
    assert(!csv.includes('Luồng hạn mức thấp'));
    const exportResponse = await exported;
    assert.equal(exportResponse.headers()['x-report-rows'], String(rows.total));
    assert.match(exportResponse.headers()['cache-control'] ?? '', /no-store/);
    await expect(exportDialog).toHaveCount(0);

    stage = 'Share evaluates recipient permissions and opens exact history attempt';
    await page.getByRole('button', { name: 'Chia sẻ bộ lọc', exact: true }).press('Enter');
    const shareDialog = page.getByRole('dialog', { name: 'Chia sẻ bộ lọc báo cáo' });
    const link = await shareDialog.getByLabel('Liên kết báo cáo').inputValue();
    assert(link.includes('versionId=' + pinned.version.id));
    assert(!link.includes(runId) && !link.includes(group.key));
    await page.keyboard.press('Escape');
    await expect(shareDialog).toHaveCount(0);
    const sharedQuery = link.split('?')[1]!;
    await status(
      await requester.context.request.get(
        W + '/api/v1/workflows/performance-report?' + sharedQuery,
      ),
      403,
    );
    await requester.page.goto(link);
    await expect(requester.page.locator('[data-workflow-error]')).toBeVisible();
    await expect(requester.page.getByRole('region', { name: 'Bảng tổng hợp báo cáo' })).toHaveCount(
      0,
    );
    const row = page
      .getByRole('listitem')
      .filter({ hasText: runTitle })
      .filter({ hasText: 'vòng ' + old.round + ' · lần xử lý ' + old.attempt });
    await row
      .getByRole('button', { name: 'Mở hồ sơ ' + runTitle + ' · lần xử lý ' + old.attempt })
      .press('Enter');
    await page.waitForURL(
      (url) => url.hash === '#workflow-run/' + runId + '/' + old.id + '/history',
    );
    await expect(page.getByRole('tab', { name: 'Lịch sử', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('#workflow-task-history-' + old.id)).toBeFocused();
    await expect(page.locator('#workflow-task-history-' + old.id)).toContainText('Đã thay thế');
    await page.getByRole('button', { name: 'Về báo cáo', exact: true }).press('Enter');
    await expect(page.getByRole('combobox', { name: 'Phiên bản quy trình' })).toHaveText(
      title + ' · v1',
    );
    await expect(page.getByRole('combobox', { name: 'Lịch sử xử lý' })).toHaveText(
      'Tất cả lần xử lý',
    );
    checks.push(
      'performance filters scoped to pinned version and unit, table and chart',
      'history detail reconciles to group, deep link focuses exact replaced attempt',
      'CSV download contains only selected report metadata and audit reason',
      'shared URL carries filters only and receiver needs report scope',
    );
  }
  if (customReport) {
    stage = 'Custom report controls, authorized facets and round-specific values';
    current = publisher.page;
    const page = publisher.page;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByRole('group', { name: 'Trường nghiệp vụ' })).toBeVisible();
    await select(page, 'Nhóm theo', 'Trường nghiệp vụ');
    const grouping = page.getByRole('combobox', { name: 'Trường để nhóm', exact: true });
    await expect(grouping).toBeEnabled();
    await grouping.press('Enter');
    await page.getByRole('option', { name: 'Nội dung mua sắm', exact: true }).press('Enter');
    await expect(grouping).toHaveText('Nội dung mua sắm');
    await select(page, 'Lọc theo trường', 'Nội dung mua sắm');
    const filter = page.getByRole('combobox', { name: 'Giá trị lọc', exact: true });
    await expect(page.getByRole('status').filter({ hasText: 'Đang tải trường…' })).toHaveCount(0);
    await select(page, 'Giá trị lọc', 'Mua thiết bị giả lập');
    await expect(filter).toHaveText('Mua thiết bị giả lập');
    await select(page, 'Trường để tính', 'Giá trị dự kiến (VND)');
    await select(page, 'Phép tính', 'Tổng');
    await page.getByText('Cột chi tiết (0/6)', { exact: true }).press('Enter');
    const purpose = page.getByRole('checkbox', { name: 'Nội dung mua sắm', exact: true });
    await purpose.press('Space');
    await expect(purpose).toBeChecked();
    const customResponse = page.waitForResponse(
      (res) => res.url().includes('/performance-report?') && res.url().includes('groupBy=field'),
    );
    await page.getByRole('button', { name: 'Áp dụng bộ lọc', exact: true }).press('Enter');
    const response = await customResponse;
    assert.equal(response.status(), 200);
    const report = (await response.json()) as {
      totals: { fieldValue: string };
      groups: ReportBucket[];
    };
    assert.equal(report.totals.fieldValue, '20000000');
    assert.deepEqual(
      report.groups.map(({ label }) => label),
      ['Mua thiết bị giả lập'],
    );
    await expect(page.getByRole('region', { name: 'Bảng tổng hợp báo cáo' })).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Tổng · Giá trị dự kiến (VND)' }),
    ).toBeVisible();
    await scan(page, 'custom-report-desktop');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: reportEvidence + 'fields-desktop.png', fullPage: true });

    stage = 'Custom report mobile drill-down and share';
    await page.setViewportSize({ width: 390, height: 844 });
    const detailsResponse = page.waitForResponse((res) =>
      res.url().includes('/performance-report/details?'),
    );
    await page
      .getByRole('button', { name: 'Chi tiết nhóm Mua thiết bị giả lập', exact: true })
      .press('Enter');
    const details = await detailsResponse;
    assert.equal(details.status(), 200);
    const drillDown = (await details.json()) as { total: number; items: ReportObservation[] };
    assert.equal(drillDown.total, 1);
    assert.equal(drillDown.items[0]?.round, 1);
    assert.equal(drillDown.items[0]?.fields?.['input.purpose'], 'Mua thiết bị giả lập');
    await expect(page.locator('dd').filter({ hasText: 'Mua thiết bị giả lập' })).toBeVisible();
    await scan(page, 'custom-report-details-mobile');
    await page.screenshot({ path: reportEvidence + 'fields-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Tải CSV chi tiết', exact: true }).press('Enter');
    const exportDialog = page.getByRole('dialog', { name: 'Xuất chi tiết báo cáo' });
    await exportDialog.getByLabel('Lý do xuất').fill('Đối chiếu trường giả lập');
    const pending = page.waitForEvent('download');
    await exportDialog.getByRole('button', { name: 'Tải CSV', exact: true }).press('Enter');
    const downloaded = await pending;
    const csv = await readFile((await downloaded.path())!, 'utf8');
    assert.match(csv, /Nội dung mua sắm/);
    assert.match(csv, /Mua thiết bị giả lập/);
    assert.doesNotMatch(csv, /Mô tả đã được bổ sung/);
    await expect(exportDialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Chia sẻ bộ lọc', exact: true }).press('Enter');
    const shareDialog = page.getByRole('dialog', { name: 'Chia sẻ bộ lọc báo cáo' });
    const link = await shareDialog.getByLabel('Liên kết báo cáo').inputValue();
    const parameters = new URLSearchParams(link.split('?')[1]);
    assert.equal(parameters.get('columns'), 'input.purpose');
    assert.match(parameters.get('match') ?? '', /^[a-f0-9]{64}$/);
    assert(!decodeURIComponent(link).includes('Mua thiết bị giả lập'));
    await page.keyboard.press('Escape');
    await page.goto(link);
    await expect(
      page.getByRole('columnheader', { name: 'Tổng · Giá trị dự kiến (VND)' }),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Giá trị lọc', exact: true })).toHaveText(
      'Mua thiết bị giả lập',
    );
    await status(
      await requester.context.request.get(W + '/api/v1/workflows/performance-report?' + parameters),
      403,
    );
    checks.push(
      'business report groups and filters by authorized pinned fields with keyboard controls',
      'report preserves previous round inputs, numeric total and scoped CSV',
      'shared filters round-trip opaque field values and receiver permissions',
    );
  }
  if (versionHistory) {
    stage = 'Compare published versions and scoped history';
    const page = publisher.page;
    current = page;
    const path = '/definitions/' + definition.id + '/versions';
    const query = '?tenantId=' + ids.tenantA;
    const apiPath = W + '/api/v1/workflows' + path;
    await status(await requester.context.request.get(apiPath + query), 403);
    const dataResponse = await publisher.context.request.get(apiPath + query);
    await status(dataResponse, 200);
    const data = await dataResponse.json();
    const [latest, first] = data.items;
    assert.deepEqual([latest.version, first.version], [2, 1]);
    await status(
      await write(
        publisher.context,
        path + '/restore',
        {
          sourceVersionId: first.id,
          expectedRevision: data.revision,
        },
        'wrong',
      ),
      403,
    );
    await page.getByRole('button', { name: 'Quy trình', exact: true }).click();
    const card = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText(title + ' v2', { exact: true }) });
    const open = card.getByRole('button', { name: 'Lịch sử phiên bản', exact: true });
    await open.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Lịch sử phiên bản', exact: true });
    await expect(dialog.getByText('1 thay đổi giữa v1 và v2')).toBeVisible();
    const change = dialog.locator('summary').filter({ hasText: 'Tên quy trình' });
    await change.press('Enter');
    await expect(dialog.getByText(JSON.stringify(title), { exact: true })).toBeVisible();
    await expect(dialog.getByText(JSON.stringify(title + ' v2'), { exact: true })).toBeVisible();
    await scan(page, 'version-comparison-desktop');
    await page.screenshot({ path: versionEvidence + 'desktop.png' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await open.press('Enter');
    await expect(dialog.getByText('1 thay đổi giữa v1 và v2')).toBeVisible();
    assert(
      await dialog.evaluate((element) => {
        const frame = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll('[role=combobox]')).every((control) => {
          const bounds = control.getBoundingClientRect();
          return bounds.left >= frame.left + 20 && bounds.right <= frame.right - 20;
        });
      }),
    );
    await change.press('Enter');
    for (const key of ['Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert(await dialog.evaluate((element) => element.contains(document.activeElement)));
    }
    await scan(page, 'version-comparison-mobile');
    await page.screenshot({ path: versionEvidence + 'mobile.png' });

    stage = 'Restore publishes a new version and keeps existing runs pinned';
    await dialog.getByRole('button', { name: 'Khôi phục v1', exact: true }).press('Enter');
    const restoredResponse = page.waitForResponse((res) => res.url().endsWith(path + '/restore'));
    await confirm(page, 'Phục hồi cấu hình mua sắm giả lập');
    const response = await restoredResponse;
    assert.equal(response.status(), 200);
    const restored = await response.json();
    assert.equal(restored.version.version, 3);
    assert.notEqual(restored.version.id, first.id);
    assert.equal(restored.version.spec.name, title);
    await expect(page.getByText('Đã phát hành v3 từ cấu hình v1.', { exact: true })).toBeVisible();
    const afterResponse = await publisher.context.request.get(apiPath + query);
    await status(afterResponse, 200);
    const after = await afterResponse.json();
    assert.deepEqual(
      after.items.map((item: { version: number }) => item.version),
      [3, 2, 1],
    );
    assert.equal((await runDetail(requester.context, runId)).run.version_id, first.id);
    const startedResponse = await write(requester.context, '/runs', {
      definitionId: definition.id,
      versionId: restored.version.id,
      unitId: ids.unitA,
      title: 'Hồ sơ sau khôi phục ' + randomUUID().slice(0, 8),
      answers: { purpose: 'Dữ liệu giả lập sau khôi phục', amount: 100, needed_on: '2026-12-01' },
    });
    await status(startedResponse, 200);
    const started = await startedResponse.json();
    assert.equal(started.version_id, restored.version.id);
    checks.push(
      'published history uses design and publish scope, with CSRF for restore',
      'keyboard comparison and focus restoration on desktop and mobile',
      'restore publishes a fresh snapshot, keeps v1/v2 and starts new requests on v3',
    );
  }
  if (documentLibrary) {
    stage = 'Create folder and draft document linked to a published edition';
    current = designer.page;
    const page = designer.page;
    const docTitle = 'Hướng dẫn mua sắm ' + randomUUID().slice(0, 8);
    const folderName = 'Quản lý chất lượng ' + randomUUID().slice(0, 8);
    const childName = 'Quy trình mua sắm';
    const fileName = 'huong-dan-gia-lap.txt';
    const content = 'Kiểm tra thông tin mua sắm giả lập trước khi gửi đề nghị.';
    const query = new URLSearchParams({ tenantId: ids.tenantA });
    const docBase = W + '/api/v1/workflows/documents';
    await reserveTestRequests(designer.context, W, 120);
    await page.getByRole('button', { name: 'Tài liệu quy trình', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Tạo thư mục', exact: true }).press('Enter');
    let folder = page.getByRole('dialog', { name: 'Tạo thư mục' });
    await select(page, 'Đơn vị quản lý thư mục', unitName);
    await folder.getByLabel('Tên thư mục').fill(folderName);
    await folder.getByRole('button', { name: 'Lưu thư mục' }).press('Enter');
    await expect(page.getByRole('combobox', { name: 'Thư mục tài liệu' })).toHaveText(folderName);
    await page.getByRole('button', { name: 'Tạo thư mục', exact: true }).press('Enter');
    folder = page.getByRole('dialog', { name: 'Tạo thư mục' });
    await expect(folder.getByRole('combobox', { name: 'Thư mục cha' })).toHaveText(folderName);
    await folder.getByLabel('Tên thư mục').fill(childName);
    await folder.getByRole('button', { name: 'Lưu thư mục' }).press('Enter');
    await expect(page.getByRole('combobox', { name: 'Thư mục tài liệu' })).toHaveText(
      folderName + ' / ' + childName,
    );

    await page.getByRole('button', { name: 'Tạo tài liệu', exact: true }).press('Enter');
    const editor = page.getByRole('dialog', { name: 'Tạo tài liệu', exact: true });
    await editor.getByLabel('Tên tài liệu').fill(docTitle);
    await editor.getByLabel('Nội dung tài liệu').fill(content);
    await select(page, 'Quy trình liên kết', title + ' v2');
    await select(page, 'Phiên bản quy trình liên kết', 'v1 · ' + title);
    await editor.getByLabel('Tìm đơn vị', { exact: true }).fill(unitName);
    await expect(editor.getByRole('checkbox', { name: unitName, exact: true })).toBeChecked();
    await editor
      .getByLabel('Tệp đính kèm')
      .setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from(content) });
    await scan(page, 'document-draft-desktop');
    await page.screenshot({ path: documentEvidence + 'draft-desktop.png' });
    const saved = page.waitForResponse(
      (res) => res.url() === docBase && res.request().method() === 'POST',
    );
    await editor.getByRole('button', { name: 'Lưu dự thảo' }).press('Enter');
    const response = await saved;
    assert.equal(response.status(), 200);
    const doc = await response.json();
    const reader = await requester.context.request.get(docBase + '/' + doc.id + '?' + query);
    await status(reader, 404);

    const transition = async (p: Page, label: string) => {
      await reserveTestRequests(p.context(), W);
      const detail = p.getByRole('dialog', { name: docTitle, exact: true });
      await detail.getByRole('button', { name: label, exact: true }).press('Enter');
      await detail.getByLabel('Lý do', { exact: true }).fill('Nghiệm thu tài liệu mua sắm giả lập');
      const saved = p.waitForResponse(
        (res) => res.url() === docBase + '/' + doc.id + '/transition',
      );
      await detail.getByRole('button', { name: 'Xác nhận', exact: true }).press('Enter');
      assert.equal((await saved).status(), 200);
      await expect(detail.getByRole('button', { name: 'Xác nhận', exact: true })).toHaveCount(0);
    };
    await transition(page, 'Gửi duyệt');

    stage = 'Review and issue under publisher scope';
    current = publisher.page;
    await current.getByRole('button', { name: 'Tài liệu quy trình', exact: true }).press('Enter');
    await current
      .getByRole('button', { name: 'Mở tài liệu ' + docTitle, exact: true })
      .press('Enter');
    await transition(current, 'Phê duyệt');
    await transition(current, 'Ban hành');
    await expect(
      current
        .getByRole('dialog', { name: docTitle, exact: true })
        .getByText('Đang ban hành v1', { exact: true }),
    ).toBeVisible();

    stage = 'Read linked document and download on mobile';
    await reserveTestRequests(requester.context, W, 100);
    current = requester.page;
    await current.goto(W + '/#workflow-run/' + runId);
    const pinned = await runDetail(requester.context, runId);
    const available = await requester.context.request.get(
      docBase +
        '?' +
        new URLSearchParams({
          tenantId: ids.tenantA,
          versionId: pinned.version.id,
        }),
    );
    await status(available, 200);
    assert((await available.json()).items.some((item: { id: string }) => item.id === doc.id));
    await current.getByRole('button', { name: 'Tải lại lượt chạy', exact: true }).press('Enter');
    const link = current
      .getByRole('region', { name: 'Tài liệu áp dụng' })
      .getByRole('link', { name: docTitle, exact: true });
    await expect(link).toBeVisible();
    const popup = current.waitForEvent('popup');
    await link.press('Enter');
    const reading = await popup;
    current = reading;
    await reading.setViewportSize({ width: 390, height: 844 });
    const displayed = reading.getByRole('dialog', { name: docTitle, exact: true });
    await expect(displayed.getByText(content, { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(displayed.getByText('Lịch sử tài liệu', { exact: true })).toHaveCount(0);
    const attachment = displayed.getByRole('link', { name: 'Tải ' + fileName, exact: true });
    await attachment.focus();
    await reading.keyboard.press('Tab');
    assert(await displayed.evaluate((element) => element.contains(document.activeElement)));
    await scan(reading, 'issued-document-mobile');
    await reading.screenshot({ path: documentEvidence + 'reader-mobile.png' });
    const file = reading.waitForEvent('download');
    const fileUrl = await attachment.getAttribute('href');
    await attachment.press('Enter');
    const downloaded = await file;
    assert.equal(downloaded.suggestedFilename(), fileName);
    assert.equal(await readFile((await downloaded.path())!, 'utf8'), content);
    await transition(publisher.page, 'Ngừng ban hành');
    await status(await requester.context.request.get(new URL(fileUrl!, W).href), 404);
    await status(await requester.context.request.get(docBase + '/' + doc.id + '?' + query), 404);
    await reading.close();
    checks.push(
      'nested folders and workflow-version linked draft saved through SSO/MFA',
      'requester cannot open draft, publisher reviews and issues',
      'run opens applicable issued document in a new tab and downloads private file',
      'withdrawal denies document and attachment immediately',
    );
  }
  await writeFile(
    evidence + 'e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checkedAtVietnam: new Date(Date.now() + 7 * 3600000).toISOString().replace('Z', '+07:00'),
        result: 'pass',
        checks,
        scans,
        definitionId: definition.id,
        runId,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: Workflows real SSO/MFA, BOS-derived visual design, publication, branches, task forms, return/resubmit, version pinning, live revocation and ' +
      scans.length +
      ' axe scans.',
  );
} catch (error) {
  if (error instanceof Error)
    console.error(
      'Workflow failure location: ' +
        (error.stack?.match(/scripts[\\/]workflows-e2e\.ts:\d+:\d+/)?.[0] ?? 'unavailable'),
    );
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error('Workflow numeric assertion: ' + error.actual + '/' + error.expected);
  console.error(
    'Workflows E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  if (
    current &&
    !current.isClosed() &&
    new URL(current.url()).origin === W &&
    new URL(current.url()).pathname === '/' &&
    (await current.locator('input[type=password]').count()) === 0
  )
    await current.screenshot({
      path: evidence + 'failure.png',
      fullPage: true,
    });
  process.exitCode = 1;
} finally {
  await restoreGrant?.();
  await browser.close();
  for (const app of servers) {
    app.server.closeAllConnections();
    await app.close();
  }
  await pool.end();
}
