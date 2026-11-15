import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Page, APIResponse } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import AxeBuilder from '@axe-core/playwright';
import * as XLSX from 'xlsx';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import { localContainer } from './local-docker.js';
import type { FormsFixture } from './forms-fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { organizationHeaders } from '../src/management/organization-workbook.js';
type Row = Record<string, any>;
const runtime = await loadLocalConfig(),
  A = 'http://127.0.0.1:4100',
  W = 'http://127.0.0.1:4105',
  run = randomUUID().slice(0, 8),
  servers: FastifyInstance[] = [];
const browser = await chromium.launch({ headless: true });
const scans: unknown[] = [],
  ownedRelations: { resource: string; row: Row }[] = [];
let stage = 'preflight',
  admin: { context: BrowserContext; page: Page; csrf: string } | undefined;
async function body(response: APIResponse, expected = 200) {
  const result = await response.json();
  if (response.status() !== expected)
    throw new Error('HTTP_' + response.status() + '_' + String(result.error ?? 'UNKNOWN'));
  return result;
}
async function reserve(context: BrowserContext, base: string) {
  const response = await context.request.get(base + '/health/ready'),
    remaining = Number(response.headers()['x-ratelimit-remaining']);
  if (response.status() === 200 && remaining >= 70) return;
  const seconds = Number(
    response.headers()['retry-after'] ?? response.headers()['x-ratelimit-reset'],
  );
  assert.ok(Number.isFinite(seconds) && seconds >= 0 && seconds <= 60);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 100));
}
async function login(
  base: string,
  user: { id: string; username: string; password: string },
  mfa = false,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  await reserve(context, base);
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL(base + '/');
  const me = await body(await context.request.get(base + '/api/v1/me'));
  return { context, page, csrf: me.csrfToken };
}
async function write(
  session: { context: BrowserContext; csrf: string },
  base: string,
  path: string,
  data: Row,
  method = 'POST',
  csrf = session.csrf,
) {
  return session.context.request.fetch(base + path, {
    method,
    headers: { origin: base, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
    data,
  });
}
async function mutation(resource: string, data: Row, row?: Row) {
  return body(
    await write(
      admin!,
      A,
      '/api/v1/manage/' + resource + (row ? '/' + row.id : ''),
      {
        tenantId: ids.tenantA,
        reason: 'Nghiệm thu vận hành tổ chức ' + run,
        data,
        ...(row ? { expectedRevision: row.revision } : {}),
      },
      row ? 'PATCH' : 'POST',
    ),
  );
}
async function collection(resource: string) {
  const result: Row[] = [];
  let cursor: string | null = null;
  do {
    const data = await body(
      await admin!.context.request.get(
        A +
          '/api/v1/manage/' +
          resource +
          '?' +
          new URLSearchParams({ tenantId: ids.tenantA, ...(cursor ? { cursor } : {}) }),
      ),
    );
    result.push(...data.items);
    cursor = data.nextCursor;
  } while (cursor);
  return result;
}
async function select(page: Page, label: string, name: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true });
  await trigger.click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
}
async function scan(page: Page, name: string) {
  assert.ok([A, W].includes(new URL(page.url()).origin));
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    name,
    violations: result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    incomplete: result.incomplete.map((v) => v.id),
  });
  await writeFile(
    '.local/evidence/organization-operations-axe.json',
    JSON.stringify(scans, null, 2),
  );
  assert.equal(result.violations.length, 0, 'axe ' + name);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'overflow ' + name,
  );
  await page.screenshot({
    path: '.local/evidence/organization-operations-' + name + '.png',
    fullPage: true,
  });
}
async function workflowWrite(
  session: { context: BrowserContext; csrf: string },
  path: string,
  data: Row,
) {
  return body(
    await write(session, W, '/api/v1/workflows' + path, {
      tenantId: ids.tenantA,
      reason: 'Nghiệm thu người duyệt tổ chức ' + run,
      ...data,
    }),
  );
}
try {
  await mkdir('.local/evidence', { recursive: true });
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  for (const code of ['aio-foundation', 'aio-workflows']) {
    const client = runtime.clients.find((c) => c.code === code)!;
    const app = await createApp({
      runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
      client,
      test: true,
      logger: false,
    });
    await app.listen({ host: '127.0.0.1', port: Number(new URL(client.baseUrl).port) });
    servers.push(app);
  }
  admin = await login(
    A,
    runtime.users.find((u) => u.id === ids.admin)!,
    true,
  );
  stage = 'isolated personnel UI';
  const entity = await mutation('legal-entities', {
      code: 'OPS' + run,
      name: 'Công ty vận hành ' + run,
    }),
    unit = await mutation('org-units', {
      legalEntityId: entity.id,
      code: 'OPS' + run,
      name: 'Đơn vị vận hành ' + run,
    }),
    title = await mutation('job-titles', { code: 'OPS' + run, name: 'Chuyên viên ' + run }),
    position = await mutation('positions', {
      legalEntityId: entity.id,
      orgUnitId: unit.id,
      jobTitleId: title.id,
      name: 'Vị trí vận hành ' + run,
    });
  const page = admin.page;
  await reserve(admin.context, A);
  const directoryStart = Date.now();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Nhân sự & tài khoản', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Danh bạ nhân sự', exact: true })).toBeVisible({
    timeout: 30000,
  });
  console.log('Personnel directory ready in ' + (Date.now() - directoryStart) + ' ms.');
  await page.getByRole('tab', { name: 'Tiếp nhận / Điều chuyển / Nghỉ việc', exact: true }).click();
  await page.getByLabel('Họ và tên nhân sự mới', { exact: true }).fill('Nhân sự vận hành ' + run);
  await page.getByLabel('Mã nhân sự', { exact: true }).fill('OPS' + run);
  await select(page, 'Pháp nhân tiếp nhận', entity.name);
  await select(page, 'Vị trí nhận công tác', position.name);
  await page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Xác nhận thay đổi · Nhân sự vận hành ' + run }),
  ).toBeVisible();
  await scan(page, 'onboard-preview-desktop');
  await page.getByLabel('Lý do thực hiện').fill('Tiếp nhận giả lập ' + run);
  await page.getByRole('button', { name: 'Xác nhận thực hiện', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Đã hoàn tất thao tác');
  const person = (await collection('people')).find(
      (p) => p.displayName === 'Nhân sự vận hành ' + run,
    )!,
    employment = (await collection('employments')).find((e) => e.personId === person.id)!;
  assert.ok(person && employment);
  const manager = await mutation('people', { displayName: 'Quản lý vận hành ' + run }),
    managerEmployment = await mutation('employments', {
      personId: manager.id,
      legalEntityId: entity.id,
      employeeCode: 'MGR' + run,
      validFrom: new Date(Date.now() - 86400000).toISOString(),
    });
  await page.getByRole('tab', { name: 'Quản lý trực tiếp', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm quan hệ quản lý', exact: true }).click();
  for (const [field, label] of [
    ['legalEntityId', entity.name],
    ['employmentId', person.displayName + ' · ' + employment.employeeCode + ' · ' + entity.name],
    [
      'managerEmploymentId',
      manager.displayName + ' · ' + managerEmployment.employeeCode + ' · ' + entity.name,
    ],
  ]) {
    await page
      .getByRole('dialog')
      .locator('#field-' + field)
      .click();
    await page.getByRole('option', { name: label, exact: true }).click();
  }
  await page
    .getByRole('dialog')
    .locator('#change-reason')
    .fill('Phân công quản lý giả lập ' + run);
  await scan(page, 'reporting-dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const relation = (await collection('reporting-lines')).find(
    (r) => r.employmentId === employment.id,
  )!;
  assert.ok(relation);
  ownedRelations.push({ resource: 'reporting-lines', row: relation });
  await page.setViewportSize({ width: 390, height: 844 });
  await scan(page, 'reporting-mobile');
  const reportingRegion = page.getByRole('region', { name: 'Bảng Quản lý trực tiếp', exact: true });
  await reportingRegion.press('ArrowRight');
  await expect(reportingRegion).toBeFocused();
  await expect
    .poll(() => reportingRegion.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'Excel preview and atomic import UI';
  const workbook = XLSX.utils.book_new();
  for (const [sheet, rows] of Object.entries({
    DonVi: [['XL' + run, 'Bộ phận Excel ' + run, entity.code, '']],
    ChucDanh: [['XL' + run, 'Chức danh Excel ' + run]],
    ViTri: [['XL' + run, 'Vị trí Excel ' + run, entity.code, 'XL' + run, 'XL' + run]],
    NhanSu: [['XL' + run, 'Nhân sự Excel ' + run, entity.code, 'XL' + run, '2026-01-01', '']],
  }))
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        [...organizationHeaders[sheet as keyof typeof organizationHeaders]],
        ...rows,
      ]),
      sheet,
    );
  const filePath = '.local/evidence/organization-operations-input-' + run + '.xlsx';
  await writeFile(
    filePath,
    XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }),
  );
  await page.getByRole('tab', { name: 'Nhập Excel', exact: true }).click();
  await page.getByLabel('Tệp dữ liệu', { exact: true }).setInputFiles(filePath);
  await page.getByRole('button', { name: 'Kiểm tra & xem trước', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Kết quả kiểm tra · 4 dòng hợp lệ · 0 lỗi' }),
  ).toBeVisible();
  await scan(page, 'excel-preview-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await scan(page, 'excel-preview-mobile');
  const excelRegion = page.getByRole('region', { name: 'Kết quả nhập Excel', exact: true });
  await excelRegion.press('ArrowRight');
  await expect(excelRegion).toBeFocused();
  await expect.poll(() => excelRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Lý do nhập dữ liệu').fill('Nhập Excel giả lập ' + run);
  await page.getByRole('button', { name: 'Xác nhận nhập toàn bộ', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Đã nhập toàn bộ 4 dòng');
  const positions = await collection('positions'),
    newPosition = positions.find((p) => p.name === 'Vị trí Excel ' + run)!;
  stage = 'transfer and offboard UI';
  await page.getByRole('tab', { name: 'Tiếp nhận / Điều chuyển / Nghỉ việc', exact: true }).click();
  await select(page, 'Thao tác nhân sự', 'Điều chuyển vị trí chính');
  await select(
    page,
    'Quan hệ công tác cần điều chuyển',
    person.displayName + ' · ' + employment.employeeCode,
  );
  await select(page, 'Vị trí nhận công tác', newPosition.name);
  await page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Xác nhận thay đổi · ' + person.displayName }),
  ).toBeVisible();
  await page.getByLabel('Lý do thực hiện').fill('Điều chuyển giả lập ' + run);
  await page.getByRole('button', { name: 'Xác nhận thực hiện', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Đã hoàn tất');
  await select(page, 'Thao tác nhân sự', 'Nghỉ việc và thu hồi truy cập');
  await select(page, 'Nhân sự nghỉ việc', person.displayName);
  await page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Xác nhận thay đổi · ' + person.displayName }),
  ).toBeVisible();
  await scan(page, 'offboard-preview');
  await expect(page.getByLabel('Lý do thực hiện')).toHaveValue('');
  await page.getByLabel('Lý do thực hiện').fill('Nghỉ việc giả lập ' + run);
  await page.getByRole('button', { name: 'Xác nhận thực hiện', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Đã hoàn tất');
  assert.equal((await collection('people')).find((p) => p.id === person.id)?.active, false);
  stage = 'live organization approval across Foundation and Workflows';
  const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
    instanceId: string;
    users: FormsFixture[];
  };
  assert.equal(fixtures.instanceId, runtime.instanceId);
  const role = (r: FormsFixture['role']) => fixtures.users.find((u) => u.role === r)!;
  const designer = await login(W, role('designer'), true),
    publisher = await login(W, role('publisher'), true),
    requester = await login(
      W,
      runtime.users.find((u) => u.id === ids.learner)!,
    ),
    handler = await login(W, role('reviewer'));
  const requesterMe = await body(await requester.context.request.get(W + '/api/v1/me')),
    employments = await collection('employments'),
    requesterEmployment = employments.find(
      (e) => e.personId === requesterMe.personId && e.legalEntityId === ids.legalA,
    )!;
  const from = new Date(Date.now() - 1000).toISOString();
  const report = await mutation('reporting-lines', {
    legalEntityId: ids.legalA,
    employmentId: requesterEmployment.id,
    managerEmploymentId: role('analyst').employmentId,
    validFrom: from,
  });
  ownedRelations.push({ resource: 'reporting-lines', row: report });
  const head = await mutation('unit-leaders', {
    legalEntityId: ids.legalA,
    orgUnitId: ids.unitA,
    employmentId: role('analyst').employmentId,
    validFrom: from,
  });
  ownedRelations.push({ resource: 'unit-leaders', row: head });
  const substitute = await mutation('approval-substitutions', {
    legalEntityId: ids.legalA,
    employmentId: role('analyst').employmentId,
    substituteEmploymentId: role('reviewer').employmentId,
    validFrom: from,
  });
  ownedRelations.push({ resource: 'approval-substitutions', row: substitute });
  for (const kind of ['manager', 'unit-head'] as const) {
    const spec = workflowTemplate();
    spec.schemaVersion = 3;
    spec.name = 'Duyệt theo cơ cấu ' + kind + ' ' + run;
    spec.audienceUnits = [ids.unitA];
    spec.positions = {};
    spec.nodes = [
      { id: 'start', kind: 'start', label: 'Bắt đầu', next: 'review' },
      {
        id: 'review',
        kind: 'approval',
        label: 'Người phụ trách duyệt',
        assignee: '',
        assigneeRule: { kind: 'organization', relation: kind },
        dueHours: 24,
        form: null,
        next: 'end',
      },
      { id: 'end', kind: 'end', label: 'Hoàn tất' },
    ];
    let draft = await workflowWrite(designer, '/definitions', {
      code: 'org-' + kind + '-' + run,
      orgUnitId: ids.unitA,
      spec,
    });
    await designer.page.goto(W + '/');
    await designer.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
    await designer.page
      .locator('[data-slot="card"]')
      .filter({ has: designer.page.getByText(spec.name, { exact: true }) })
      .getByRole('button', { name: 'Thiết kế', exact: true })
      .click();
    await select(designer.page, 'Bước đang cấu hình', 'Người phụ trách duyệt');
    await select(designer.page, 'Cách giao nhiệm vụ', 'Theo cơ cấu tổ chức');
    await select(
      designer.page,
      'Người phụ trách',
      kind === 'manager' ? 'Quản lý trực tiếp của người gửi' : 'Trưởng đơn vị của người gửi',
    );
    await scan(designer.page, 'designer-' + kind);
    await designer.page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
    await expect(
      designer.page.getByText('Đã lưu bản nháp. Lượt chạy cũ vẫn dùng phiên bản của chúng.', {
        exact: true,
      }),
    ).toBeVisible();
    draft = (
      await body(
        await designer.context.request.get(
          W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
        ),
      )
    ).items.find((d: Row) => d.id === draft.id);
    assert.equal(draft.draft.schemaVersion, 3);
    assert.equal(draft.draft.nodes.find((n: Row) => n.id === 'review').assigneeRule.relation, kind);
    const published = await workflowWrite(publisher, '/definitions/' + draft.id + '/publish', {
      expectedRevision: draft.revision,
    });
    const started = await workflowWrite(requester, '/runs', {
        definitionId: draft.id,
        versionId: published.version.id,
        unitId: ids.unitA,
        title: 'Đề nghị ' + kind,
        answers: { purpose: 'Nghiệm thu cơ cấu', amount: 100, needed_on: '2026-12-01' },
      }),
      detail = await body(
        await requester.context.request.get(
          W + '/api/v1/workflows/runs/' + started.id + '?tenantId=' + ids.tenantA,
        ),
      ),
      task = detail.tasks.find((t: Row) => t.status === 'pending');
    assert.equal(task.assignee_account_id, role('reviewer').id);
    await handler.page.goto(W + '/#workflow-run/' + started.id);
    await handler.page.getByRole('button', { name: 'Tải lại lượt chạy' }).waitFor();
    await scan(handler.page, 'workflow-' + kind);
    await workflowWrite(handler, '/tasks/' + task.id + '/action', {
      expectedRevision: task.revision,
      action: 'approve',
      answers: {},
    });
    assert.equal(
      (
        await body(
          await requester.context.request.get(
            W + '/api/v1/workflows/runs/' + started.id + '?tenantId=' + ids.tenantA,
          ),
        )
      ).run.status,
      'completed',
    );
    const d = await body(
      await designer.context.request.get(
        W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA,
      ),
    );
    const current = d.items.find((r: Row) => r.id === draft.id);
    await workflowWrite(publisher, '/definitions/' + draft.id + '/status', {
      expectedRevision: current.revision,
      status: 'paused',
    });
  }
  stage = 'API denial and cleanup';
  const invalidCsrf = await write(
    admin,
    A,
    '/api/v1/manage/personnel/preview',
    {
      tenantId: ids.tenantA,
      input: {
        kind: 'offboard',
        personId: manager.id,
        effectiveAt: new Date().toISOString(),
        revokeBindingIds: [],
      },
    },
    'POST',
    'wrong',
  );
  assert.equal(invalidCsrf.status(), 403);
  const cross = await write(admin, A, '/api/v1/manage/personnel/preview', {
    tenantId: ids.tenantB,
    input: {
      kind: 'offboard',
      personId: manager.id,
      effectiveAt: new Date().toISOString(),
      revokeBindingIds: [],
    },
  });
  assert.equal(cross.status(), 403);
  await writeFile(
    '.local/evidence/organization-operations-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans: scans.length,
        assertions: [
          'real MFA and CSRF',
          'personnel onboarding transfer offboard UI',
          'manager editor and responsive UI',
          'four-sheet Excel preview and atomic commit UI',
          'live manager and unit head approvals with effective substitute',
          'cross-tenant and CSRF denial',
        ],
        userCredentialsExposed: false,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: organization operations UI and live workflow integration; ' +
      scans.length +
      ' accessibility scans.',
  );
} catch (error) {
  if (
    admin &&
    new URL(admin.page.url()).origin === A &&
    !(await admin.page.locator('input[type=password]').count())
  ) {
    await admin.page.screenshot({
      path: '.local/evidence/organization-operations-failure.png',
      fullPage: true,
    });
    const alerts = await admin.page.getByRole('alert').allTextContents();
    console.error('Application alerts: ' + alerts.join(' | '));
  }
  console.error(
    'Organization operations failed at ' +
      stage +
      '; ' +
      (error instanceof Error
        ? (error.message.startsWith('HTTP_') ? error.message : error.name) +
          ' ' +
          (error.stack?.match(/organization-operations-e2e\.ts:\d+:\d+/)?.[0] ?? '')
        : 'unknown') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  if (admin)
    for (const { resource, row } of ownedRelations.reverse()) {
      try {
        const current = (await collection(resource)).find((r) => r.id === row.id);
        if (current?.active) await mutation(resource, { active: false }, current);
      } catch {
        console.error('Owned responsibility cleanup pending: ' + resource);
        process.exitCode = 1;
      }
    }
  await browser.close();
  for (const server of servers) {
    server.server.closeAllConnections();
    await server.close();
  }
}
