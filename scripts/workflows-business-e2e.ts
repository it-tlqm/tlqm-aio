import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Page, APIResponse } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import { localContainer } from './local-docker.js';
import type { FormsFixture } from './forms-fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import type { WorkflowSpec } from '../src/workflows/contracts.js';
const evidence = '.local/evidence/workflows-configurable-fields-';
import type { WorkflowsService } from '../src/workflows/service.js';
type DefinitionItem = Awaited<ReturnType<WorkflowsService['definitions']>>['items'][number];
type RunDetail = Awaited<ReturnType<WorkflowsService['detail']>>;
const runtime = await loadLocalConfig(),
  W = 'http://127.0.0.1:4105';
const fixture = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixture.instanceId, runtime.instanceId);
const role = (value: FormsFixture['role']) => fixture.users.find((u) => u.role === value)!;
const browser = await chromium.launch({ headless: true }),
  servers: Awaited<ReturnType<typeof createApp>>[] = [];
let stage = 'preflight',
  current: Page | undefined;
const scans: { name: string; violations: unknown[]; incomplete: string[] }[] = [];
async function login(user: { id: string; username: string; password: string }, mfa = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  current = page;
  await context.addInitScript(() => {
    (window as Window & { csp?: string[] }).csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as Window & { csp?: string[] }).csp?.push(e.violatedDirective),
    );
  });
  await page.goto(W + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === W && url.pathname === '/');
  return { context, page };
}
async function data(response: APIResponse, expected = 200) {
  if (response.status() !== expected) {
    const body = await response.json().catch(() => ({}));
    console.error(
      'HTTP ' +
        response.status() +
        '/' +
        expected +
        ' ' +
        (/^[A-Z_]+$/.test(body.error ?? '') ? body.error : ''),
    );
  }
  assert.equal(response.status(), expected);
  return response.json();
}
async function write(
  context: BrowserContext,
  path: string,
  body: Record<string, unknown>,
  expected = 200,
) {
  const me = await data(await context.request.get(W + '/api/v1/me'));
  return data(
    await context.request.post(W + '/api/v1/workflows' + path, {
      headers: { origin: W, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() },
      data: { tenantId: ids.tenantA, reason: 'Kiểm chứng nghiệp vụ W1', ...body },
    }),
    expected,
  );
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}
async function scan(page: Page, name: string) {
  current = page;
  assert.equal(new URL(page.url()).origin, W);
  assert.equal(await page.locator('input[type=password],#otp').count(), 0);
  await page.evaluate(() => document.fonts.ready);
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
  await writeFile(evidence + 'axe.json', JSON.stringify(scans, null, 2));
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const overflowingDialogs = await page.getByRole('dialog').evaluateAll((elements) =>
    elements
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => ({
        slot: el.getAttribute('data-slot') ?? el.tagName,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        children: Array.from(el.children, (child) => ({
          slot: child.getAttribute('data-slot') ?? child.tagName,
          clientWidth: child.clientWidth,
          scrollWidth: child.scrollWidth,
        })),
      })),
  );
  if (overflowingDialogs.length)
    console.error('Layout metrics for ' + name + ': ' + JSON.stringify(overflowingDialogs));
  assert.deepEqual(
    overflowingDialogs,
    [],
    name + ': Dialog content must fit; only the data table may scroll horizontally',
  );
  assert.deepEqual(await page.evaluate(() => (window as Window & { csp?: string[] }).csp), []);
  await page.screenshot({
    path: evidence + name + '.png',
    fullPage: (await page.getByRole('dialog').count()) === 0,
  });
}
const getRun = async (context: BrowserContext, id: string) =>
  (await data(
    await context.request.get(W + '/api/v1/workflows/runs/' + id + '?tenantId=' + ids.tenantA),
  )) as RunDetail;
try {
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
    await app.listen({ host: '127.0.0.1', port: client.port });
    servers.push(app);
  }
  stage = 'SSO';
  const designer = await login(role('designer'), true),
    publisher = await login(role('publisher'), true),
    reviewer = await login(role('reviewer')),
    finance = await login(role('analyst')),
    requester = await login(runtime.users.find((u) => u.id === ids.learner)!);
  const suffix = randomUUID().slice(0, 8),
    title = 'Mua sắm W1 ' + suffix,
    spec = workflowTemplate();
  spec.name = title;
  spec.schemaVersion = 5;
  spec.audienceUnits = [ids.unitA];
  spec.input.sections[0]!.fields.push({
    id: 'external',
    type: 'boolean',
    label: 'Mua từ bên ngoài',
    required: false,
  });
  for (const n of spec.nodes)
    if ('assignee' in n) {
      n.assignee = n.id === 'review' ? role('reviewer').id : role('analyst').id;
      if (n.id === 'review')
        n.form = {
          schemaVersion: 2,
          title: 'Rà soát',
          sections: [
            {
              id: 'verification',
              title: 'Rà soát',
              fields: [{ id: 'confirmed_at', type: 'time', label: 'Giờ xác nhận', required: true }],
            },
          ],
        };
    }
  const definition = await write(designer.context, '/definitions', {
    code: 'w1-' + suffix,
    orgUnitId: ids.unitA,
    spec,
  });
  stage = 'table designer';
  current = designer.page;
  await designer.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await designer.page
    .locator('[data-slot="card"]')
    .filter({ has: designer.page.getByText(title, { exact: true }) })
    .getByRole('button', { name: 'Thiết kế', exact: true })
    .click();
  await designer.page.getByRole('tab', { name: 'Biểu mẫu', exact: true }).click();
  await designer.page.getByRole('button', { name: 'Thêm câu hỏi', exact: true }).click();
  await designer.page.getByLabel('Nhãn câu hỏi', { exact: true }).fill('Chi tiết mua sắm');
  await select(designer.page, 'Loại câu hỏi', 'Bảng chi tiết');
  await designer.page.getByLabel('Bắt buộc trả lời', { exact: true }).check();
  await scan(designer.page, 'table-settings');
  await designer.page.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  stage = 'reference designer';
  for (const [label, type] of [
    ['Người nhận vật tư', 'Nhân sự AIO'],
    ['Đơn vị sử dụng', 'Đơn vị AIO'],
  ]) {
    await designer.page.getByRole('button', { name: 'Thêm câu hỏi', exact: true }).click();
    await designer.page.getByLabel('Nhãn câu hỏi', { exact: true }).fill(label!);
    await select(designer.page, 'Loại câu hỏi', type!);
    await designer.page.getByLabel('Bắt buộc trả lời', { exact: true }).check();
    await designer.page.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  }
  stage = 'design temporal fields and dependent options';
  await designer.page.getByRole('button', { name: 'Thêm câu hỏi', exact: true }).click();
  await designer.page.getByLabel('Nhãn câu hỏi', { exact: true }).fill('Giờ cần nhận');
  await select(designer.page, 'Loại câu hỏi', 'Giờ / phút');
  await designer.page.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  await designer.page.getByRole('button', { name: 'Thêm câu hỏi', exact: true }).click();
  await designer.page.getByLabel('Nhãn câu hỏi', { exact: true }).fill('Hình thức nhận');
  await select(designer.page, 'Loại câu hỏi', 'Chọn một');
  await designer.page.getByLabel('Bắt buộc trả lời', { exact: true }).check();
  await designer.page.getByLabel('Lựa chọn 1', { exact: true }).fill('Giao tận nơi');
  await designer.page.getByLabel('Lựa chọn 2', { exact: true }).fill('Nhận tại kho');
  await designer.page.getByRole('button', { name: 'Thêm quy tắc lựa chọn', exact: true }).click();
  await select(designer.page, 'Áp dụng quy tắc 1 khi — Câu hỏi 1', 'Mua từ bên ngoài');
  await select(designer.page, 'Áp dụng quy tắc 1 khi — Phép so sánh 1', 'Bằng');
  await designer.page
    .getByRole('group', { name: 'Áp dụng quy tắc 1 khi', exact: true })
    .getByRole('button', { name: 'Thêm nhóm VÀ / HOẶC', exact: true })
    .click();
  await select(designer.page, 'Áp dụng quy tắc 1 khi · Nhóm 1 — Câu hỏi 1', 'Giờ cần nhận');
  await designer.page.getByRole('checkbox', { name: 'Nhận tại kho', exact: true }).uncheck();
  await scan(designer.page, 'dependent-options-designer');
  await designer.page.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  stage = 'attachment field designer';
  await designer.page.getByRole('button', { name: 'Thêm câu hỏi', exact: true }).click();
  await designer.page.getByLabel('Nhãn câu hỏi', { exact: true }).fill('Chứng từ mua sắm');
  await select(designer.page, 'Loại câu hỏi', 'Tệp đính kèm');
  await designer.page.getByLabel('Số tệp tối đa', { exact: true }).fill('2');
  await designer.page.getByLabel('Bắt buộc trả lời', { exact: true }).check();
  await scan(designer.page, 'attachment-designer');
  await designer.page.screenshot({ path: '.local/evidence/workflows-attachment-desktop.png' });
  await designer.page.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  stage = 'field policy';
  await designer.page.getByRole('tab', { name: 'Quyền dữ liệu', exact: true }).click();
  const policy = designer.page.getByRole('group', { name: /^Nội dung mua sắm/ });
  await policy.getByLabel('Giới hạn người xem', { exact: true }).check();
  await policy.getByLabel('Người xử lý · Trưởng bộ phận xem xét', { exact: true }).check();
  const attachmentPolicy = designer.page.getByRole('group', { name: /^Chứng từ mua sắm/ });
  await attachmentPolicy.getByLabel('Giới hạn người xem', { exact: true }).check();
  await attachmentPolicy
    .getByLabel('Người xử lý · Trưởng bộ phận xem xét', { exact: true })
    .check();
  stage = 'configure input at a workflow step';
  await select(designer.page, 'Bước sử dụng dữ liệu', 'Duyệt hạn mức');
  const purposeMode = designer.page.getByRole('combobox', {
    name: 'Nội dung mua sắm tại bước',
    exact: true,
  });
  await expect(purposeMode).toBeDisabled();
  await select(designer.page, 'Bước sử dụng dữ liệu', 'Trưởng bộ phận xem xét');
  stage = 'configure required mode by keyboard';
  await purposeMode.press('ArrowDown');
  await expect(designer.page.getByRole('listbox')).toBeVisible();
  await expect(
    designer.page.getByRole('option', { name: 'Chỉ ở hồ sơ gốc', exact: true }),
  ).toBeFocused();
  await designer.page.keyboard.press('End');
  await expect(
    designer.page.getByRole('option', { name: 'Bắt buộc điền', exact: true }),
  ).toBeFocused();
  await designer.page.keyboard.press('Enter');
  await expect(purposeMode).toHaveText('Bắt buộc điền');
  stage = 'configure read and edit modes';
  await select(designer.page, 'Chi tiết mua sắm tại bước', 'Chỉ xem');
  await select(designer.page, 'Ngày cần sử dụng tại bước', 'Cho sửa');
  await scan(designer.page, 'field-policy');
  await designer.page.setViewportSize({ width: 390, height: 844 });
  await scan(designer.page, 'field-policy-mobile');
  await designer.page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'route by total';
  await designer.page.getByRole('tab', { name: 'Luồng xử lý', exact: true }).click();
  await select(designer.page, 'Bước đang cấu hình', 'Từ 10 triệu đồng?');
  await select(designer.page, 'Trường 1.1', 'Chi tiết mua sắm · Tổng Thành tiền');
  await select(designer.page, 'Phép so sánh 1.1', 'Lớn hơn hoặc bằng');
  await designer.page.getByLabel('Giá trị 1.1', { exact: true }).fill('10000000');
  stage = 'route by a completed step result';
  await designer.page.getByRole('button', { name: 'Thêm điều kiện', exact: true }).click();
  await select(designer.page, 'Trường 1.2', 'Trưởng bộ phận xem xét · Giờ xác nhận');
  await select(designer.page, 'Phép so sánh 1.2', 'Lớn hơn hoặc bằng');
  await designer.page.getByLabel('Giá trị 1.2', { exact: true }).fill('17:00');
  await scan(designer.page, 'branch-result-designer');
  stage = 'save designer draft';
  await designer.page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(
    designer.page.getByText('Đã lưu bản nháp. Lượt chạy cũ vẫn dùng phiên bản của chúng.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  const definitions = await data(
    await designer.context.request.get(W + '/api/v1/workflows/definitions?tenantId=' + ids.tenantA),
  );
  const saved = (definitions.items as DefinitionItem[]).find((d) => d.id === definition.id)!;
  assert.equal(saved.draft!.schemaVersion, 5);
  assert.equal(saved.draft!.input.schemaVersion, 2);
  assert.deepEqual(saved.draft!.fieldReaders?.['input.purpose'], ['review']);
  const reviewNode = saved.draft!.nodes.find((node) => node.id === 'review')!;
  assert('inputFields' in reviewNode);
  assert.equal(reviewNode.inputFields?.purpose, 'required');
  assert.equal(reviewNode.inputFields?.needed_on, 'edit');
  const download = designer.page.waitForEvent('download');
  await designer.page.getByRole('button', { name: 'Xuất cấu hình', exact: true }).click();
  const exported = await download;
  const exportedPath = evidence + 'export.json';
  await exported.saveAs(exportedPath);
  const exportedSpec = JSON.parse(await readFile(exportedPath, 'utf8')).content as WorkflowSpec;
  assert.equal(exportedSpec.schemaVersion, 5);
  const exportedStep = exportedSpec.nodes.find((node) => node.id === 'review');
  assert(exportedStep && 'inputFields' in exportedStep);
  assert.deepEqual(exportedStep.inputFields, reviewNode.inputFields);
  const branch = exportedSpec.nodes.find((node) => node.kind === 'condition')!;
  assert(
    branch.condition.rules.some(
      (rule) => 'fieldCode' in rule && rule.fieldCode === 'step.review.confirmed_at',
    ),
  );
  const fields = saved.draft!.input.sections.flatMap((section) => section.fields);
  const delivery = fields.find((field) => field.label === 'Hình thức nhận')!;
  const pickupHour = fields.find((field) => field.label === 'Giờ cần nhận')!;
  const attachmentField = fields.find((field) => field.type === 'attachment')!;
  assert.equal(attachmentField.attachments?.maxFiles, 2);
  assert.equal(delivery.optionRules?.[0]?.when.groups?.[0]?.rules[0]?.fieldId, pickupHour.id);
  await write(publisher.context, '/definitions/' + saved.id + '/publish', {
    expectedRevision: saved.revision,
  });
  stage = 'create draft';
  current = requester.page;
  await requester.page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await requester.page
    .locator('[data-slot="card"]')
    .filter({ has: requester.page.getByText(title, { exact: true }) })
    .getByRole('button', { name: 'Khởi chạy', exact: true })
    .click();
  const secret = 'ghi-chu-rieng-' + suffix;
  await requester.page.getByLabel('Tiêu đề lượt chạy', { exact: true }).fill(title + ' hồ sơ');
  await requester.page.getByLabel(/^Nội dung mua sắm/).fill(secret);
  await requester.page.locator('#answer-amount').fill('1');
  stage = 'apply dependent options while editing a request';
  await requester.page.locator('#answer-' + pickupHour.id).fill('16:30');
  const deliverySelect = requester.page.locator('#answer-' + delivery.id);
  await deliverySelect.click();
  await requester.page.getByRole('option', { name: 'Nhận tại kho', exact: true }).click();
  await requester.page.locator('#answer-external').click();
  await requester.page.getByRole('option', { name: 'Có', exact: true }).click();
  await expect(deliverySelect).toHaveText('Chưa chọn');
  await deliverySelect.click();
  await expect(
    requester.page.getByRole('option', { name: 'Nhận tại kho', exact: true }),
  ).toHaveCount(0);
  await requester.page.getByRole('option', { name: 'Giao tận nơi', exact: true }).click();
  stage = 'reference selectors';
  const people = await data(
    await requester.context.request.get(
      W +
        '/api/v1/workflows/references?' +
        new URLSearchParams({ tenantId: ids.tenantA, unitId: ids.unitA, kind: 'person' }),
    ),
  );
  const selectedPerson = people.items.find(
    (p: { label: string }) => p.label === 'Nhân viên thử nghiệm',
  );
  assert(selectedPerson);
  const units = await data(
    await requester.context.request.get(
      W +
        '/api/v1/workflows/references?' +
        new URLSearchParams({ tenantId: ids.tenantA, unitId: ids.unitA, kind: 'orgUnit' }),
    ),
  );
  const selectedUnit = units.items.find((u: { id: string }) => u.id === ids.unitA);
  assert(selectedUnit);
  await data(
    await requester.context.request.get(
      W +
        '/api/v1/workflows/references?' +
        new URLSearchParams({ tenantId: ids.tenantB, unitId: ids.unitB, kind: 'person' }),
    ),
    403,
  );
  const recipientField = saved
    .draft!.input.sections.flatMap((s) => s.fields)
    .find((f) => f.type === 'person')!;
  const unitField = saved
    .draft!.input.sections.flatMap((s) => s.fields)
    .find((f) => f.type === 'orgUnit')!;
  await requester.page.locator('#answer-' + recipientField.id).click();
  await requester.page
    .getByRole('textbox', { name: 'Tìm nhân sự', exact: true })
    .fill(selectedPerson.label);
  const personButton = requester.page.getByRole('button', {
    name: selectedPerson.label + ' ' + selectedPerson.id.slice(-8),
    exact: true,
  });
  await expect(personButton).toBeVisible();
  assert.equal(
    await requester.page.locator('#answer-' + recipientField.id).getAttribute('aria-controls'),
    await requester.page.getByRole('dialog', { name: /^Người nhận vật tư/ }).getAttribute('id'),
  );
  await scan(requester.page, 'person-picker-desktop');
  await requester.page.setViewportSize({ width: 390, height: 844 });
  await requester.page.getByRole('dialog', { name: /^Người nhận vật tư/ }).scrollIntoViewIfNeeded();
  await scan(requester.page, 'person-picker-mobile');
  await requester.page.keyboard.press('Escape');
  await expect(
    requester.page.getByRole('textbox', { name: 'Tìm nhân sự', exact: true }),
  ).toHaveCount(0);
  await expect(requester.page.locator('#answer-' + recipientField.id)).toBeFocused();
  await requester.page.keyboard.press('Enter');
  await expect(personButton).toBeVisible();
  await personButton.focus();
  await requester.page.keyboard.press('Enter');
  await expect(requester.page.locator('#answer-' + recipientField.id)).toBeFocused();
  await requester.page.locator('#answer-' + unitField.id).click();
  await requester.page
    .getByRole('button', {
      name: selectedUnit.label + ' ' + selectedUnit.id.slice(-8),
      exact: true,
    })
    .click();
  await requester.page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'draft rows';
  for (let i = 1; i <= 3; i++) {
    await requester.page.getByRole('button', { name: 'Thêm dòng', exact: true }).click();
    await requester.page
      .getByRole('textbox', {
        name: `Chi tiết mua sắm · Hàng hóa / nội dung · Dòng ${i}`,
        exact: true,
      })
      .fill('Vật tư ' + i);
    await requester.page
      .getByRole('textbox', { name: `Chi tiết mua sắm · Số lượng · Dòng ${i}`, exact: true })
      .fill(String(i));
    await requester.page
      .getByRole('textbox', { name: `Chi tiết mua sắm · Đơn giá · Dòng ${i}`, exact: true })
      .fill(String(i * 1000000));
  }
  stage = 'upload and quarantine draft attachments';
  const attachmentInput = requester.page
    .locator(`[data-form-field="${attachmentField.id}"]`)
    .locator('input[type=file]');
  const fileContent = Buffer.from('Chứng từ mua sắm giả lập');
  await attachmentInput.setInputFiles({
    name: 'Sai định dạng.pdf',
    mimeType: 'application/pdf',
    buffer: fileContent,
  });
  await expect(
    requester.page.getByText('Một số tệp không vượt qua kiểm tra định dạng.', { exact: true }),
  ).toBeVisible();
  const chooser = requester.page.waitForEvent('filechooser');
  await requester.page
    .getByRole('button', { name: 'Chọn tệp cho Chứng từ mua sắm', exact: true })
    .press('Enter');
  await (
    await chooser
  ).setFiles({
    name: 'Chứng từ.txt',
    mimeType: 'text/plain',
    buffer: fileContent,
  });
  await expect(
    requester.page.getByRole('link', { name: 'Chứng từ.txt', exact: true }),
  ).toBeVisible();
  stage = 'save draft';
  await requester.page.getByRole('button', { name: 'Lưu nháp hồ sơ', exact: true }).click();
  await expect(
    requester.page.getByText('Đã lưu nháp hồ sơ. Có thể đóng và mở lại từ Nháp của tôi.'),
  ).toBeVisible();
  const draftList = await data(
    await requester.context.request.get(W + '/api/v1/workflows/requests?tenantId=' + ids.tenantA),
  );
  const draft = draftList.items.find((d: { title: string }) => d.title === title + ' hồ sơ');
  assert(draft);
  const savedRequest = await data(
    await requester.context.request.get(
      W + '/api/v1/workflows/requests/' + draft.id + '?tenantId=' + ids.tenantA,
    ),
  );
  assert.deepEqual(savedRequest.request.answers[recipientField.id], selectedPerson);
  assert.deepEqual(savedRequest.request.answers[unitField.id], selectedUnit);
  const attachmentId = savedRequest.request.answers[attachmentField.id][0] as string;
  const attachmentUrl =
    W + '/api/v1/workflows/attachments/' + attachmentId + '?tenantId=' + ids.tenantA;
  assert.equal(savedRequest.attachments[0].fileName, 'Chứng từ.txt');
  await data(
    await publisher.context.request.get(
      W + '/api/v1/workflows/requests/' + draft.id + '?tenantId=' + ids.tenantA,
    ),
    403,
  );
  await requester.page.keyboard.press('Escape');
  stage = 'reload draft';
  await requester.page.reload();
  await requester.page.getByRole('button', { name: 'Nháp của tôi', exact: true }).click();
  await requester.page
    .locator('[data-slot="card"]')
    .filter({ has: requester.page.getByText(title + ' hồ sơ', { exact: true }) })
    .getByRole('button', { name: 'Tiếp tục nhập', exact: true })
    .click();
  await expect(
    requester.page.getByRole('textbox', {
      name: 'Chi tiết mua sắm · Số lượng · Dòng 3',
      exact: true,
    }),
  ).toHaveValue('3.000');
  await expect(
    requester.page.getByRole('link', { name: 'Chứng từ.txt', exact: true }),
  ).toBeVisible();
  stage = 'draft responsive';
  await requester.page.locator('#answer-needed_on').fill('2026-12-01');
  await scan(requester.page, 'request-desktop');
  await requester.page.setViewportSize({ width: 390, height: 844 });
  await requester.page
    .getByRole('link', { name: 'Chứng từ.txt', exact: true })
    .scrollIntoViewIfNeeded();
  await scan(requester.page, 'attachment-mobile');
  await requester.page.screenshot({ path: '.local/evidence/workflows-attachment-mobile.png' });
  const downloadAttachment = requester.page.waitForEvent('download');
  await requester.page.getByRole('link', { name: 'Chứng từ.txt', exact: true }).press('Enter');
  assert.equal((await downloadAttachment).suggestedFilename(), 'Chứng từ.txt');
  await scan(requester.page, 'request-mobile');
  await requester.page
    .getByRole('button', { name: 'Gửi đề nghị', exact: true })
    .scrollIntoViewIfNeeded();
  await scan(requester.page, 'submit-mobile');
  stage = 'submit draft';
  await requester.page.getByRole('button', { name: 'Gửi đề nghị', exact: true }).click();
  await requester.page.waitForURL((url) => url.hash.startsWith('#workflow-run/'));
  const runId = new URL(requester.page.url()).hash.split('/')[1]!;
  const run = await getRun(requester.context, runId);
  assert.deepEqual(run.run.inputs[attachmentField.id], [attachmentId]);
  await expect(requester.page.getByText(runId, { exact: true })).toBeVisible();
  await requester.page.getByRole('tab', { name: 'Tệp đính kèm', exact: true }).press('Enter');
  const filesPanel = requester.page.getByRole('tabpanel', { name: 'Tệp đính kèm' });
  await expect(filesPanel.getByRole('link', { name: 'Chứng từ.txt', exact: true })).toBeVisible();
  await scan(requester.page, 'run-files-mobile');
  await requester.page.setViewportSize({ width: 1440, height: 1000 });
  await scan(requester.page, 'run-files-desktop');
  const downloaded = await reviewer.context.request.get(attachmentUrl);
  assert.equal(downloaded.status(), 200);
  assert.equal(downloaded.headers()['cache-control'], 'private, no-store');
  assert.deepEqual(await downloaded.body(), fileContent);
  assert.deepEqual(run.run.inputs[recipientField.id], selectedPerson);
  assert.deepEqual(run.run.inputs[unitField.id], selectedUnit);
  assert.equal(run.run.inputs[pickupHour.id], '16:30');
  assert.equal(run.run.inputs[delivery.id], delivery.options![0]!.id);
  const tableId = saved
    .draft!.input.sections.flatMap((s) => s.fields)
    .find((f) => f.type === 'table')!.id;
  assert.equal((run.run.inputs[tableId] as any).totals.amount, '14000000.00');
  const limited = await getRun(publisher.context, runId);
  assert.equal(limited.run.inputs.purpose, undefined);
  assert(!JSON.stringify(limited).includes(secret));
  stage = 'review and limited reader';
  current = reviewer.page;
  await reviewer.page.goto(W + '/#workflow-run/' + runId);
  const reviewInput = reviewer.page.locator('[id="answer-input.purpose"]');
  const readOnly = reviewer.page.getByRole('region', {
    name: 'Thông tin đề nghị chỉ xem',
    exact: true,
  });
  const reviewDate = reviewer.page.locator('[id="answer-input.needed_on"]');
  await expect(reviewInput).toHaveValue(secret);
  await expect(reviewDate).toHaveValue(run.run.inputs.needed_on as string);
  await expect(readOnly.getByText('Chi tiết mua sắm', { exact: true })).toBeVisible();
  await expect(reviewer.page.locator('[id="answer-input.' + tableId + '"]')).toHaveCount(0);
  const reviewPending = run.tasks.find((task) => task.status === 'pending')!;
  const missing = await write(
    reviewer.context,
    '/tasks/' + reviewPending.id + '/action',
    {
      expectedRevision: reviewPending.revision,
      action: 'approve',
      answers: { confirmed_at: '18:05' },
    },
    400,
  );
  assert.deepEqual(missing.issues, [{ path: 'answers.input.purpose', code: 'REQUIRED_ANSWER' }]);
  await scan(reviewer.page, 'review');
  await reviewer.page.setViewportSize({ width: 390, height: 844 });
  await scan(reviewer.page, 'review-step-input-mobile');
  const tableRegion = readOnly.getByRole('region', { name: 'Bảng Chi tiết mua sắm', exact: true });
  await tableRegion.press('ArrowRight');
  await expect.poll(() => tableRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  stage = 'submit revised values and verify visibility';
  const corrected = 'noi-dung-da-ra-soat-' + suffix;
  await reviewInput.fill(corrected);
  await reviewDate.fill('2026-12-18');
  await reviewer.page.locator('#answer-confirmed_at').fill('18:05');
  await reviewer.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await reviewer.page.getByLabel('Ý kiến / lý do', { exact: true }).fill('Đã đối chiếu nội dung');
  await reviewer.page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(reviewer.page.getByRole('dialog')).toHaveCount(0);
  const ownerResult = await getRun(requester.context, runId);
  assert.equal(ownerResult.run.inputs.purpose, secret);
  assert.deepEqual(ownerResult.tasks.find((task) => task.id === reviewPending.id)?.answers, {
    'input.purpose': corrected,
    'input.needed_on': '2026-12-18',
    confirmed_at: '18:05',
  });
  let financeRun = await getRun(finance.context, runId);
  assert.equal((await finance.context.request.get(attachmentUrl)).status(), 404);
  assert.equal(financeRun.run.inputs[attachmentField.id], undefined);
  assert.equal(financeRun.tasks.find((t) => t.status === 'pending')!.node_id, 'director');
  assert(!JSON.stringify(financeRun).includes(secret));
  assert(!JSON.stringify(financeRun).includes(corrected));
  current = finance.page;
  await finance.page.goto(W + '/#workflow-run/' + runId);
  await expect(
    finance.page.getByRole('heading', { name: title + ' hồ sơ', exact: true }),
  ).toBeVisible();
  await expect(finance.page.getByText(secret, { exact: true })).toHaveCount(0);
  await scan(finance.page, 'limited-reader');
  await finance.page.getByRole('tab', { name: 'Tệp đính kèm', exact: true }).click();
  const limitedFiles = finance.page.getByRole('tabpanel', { name: 'Tệp đính kèm' });
  await expect(limitedFiles.getByText('Không có tệp để hiển thị.')).toBeVisible();
  await expect(limitedFiles.getByRole('link', { name: 'Chứng từ.txt', exact: true })).toHaveCount(
    0,
  );
  let pending = financeRun.tasks.find((t) => t.status === 'pending')!;
  const decided = await write(finance.context, '/tasks/' + pending.id + '/action', {
    expectedRevision: pending.revision,
    action: 'approve',
    answers: {},
  });
  assert(!JSON.stringify(decided).includes(secret));
  financeRun = await getRun(finance.context, runId);
  pending = financeRun.tasks.find((t) => t.status === 'pending')!;
  await write(finance.context, '/tasks/' + pending.id + '/action', {
    expectedRevision: pending.revision,
    action: 'complete',
    answers: { result_note: 'Đã mua đủ vật tư' },
  });
  await finance.page.reload();
  await finance.page.getByRole('tab', { name: 'Lịch sử', exact: true }).click();
  await finance.page.setViewportSize({ width: 390, height: 844 });
  await scan(finance.page, 'history-mobile');
  const financeResult = JSON.stringify(await getRun(finance.context, runId));
  assert(!financeResult.includes(secret) && !financeResult.includes(corrected));
  stage = 'share run and mention follower';
  const runUrl = W + '/api/v1/workflows/runs/' + runId;
  const tenantQuery = '?tenantId=' + ids.tenantA;
  await data(await designer.context.request.get(runUrl + tenantQuery), 403);
  current = requester.page;
  await requester.page.reload();
  await requester.page.getByRole('tab', { name: 'Trao đổi', exact: true }).press('Enter');
  const followName = role('designer').name;
  const searchFollower = requester.page.getByRole('textbox', { name: 'Tìm người theo dõi' });
  await searchFollower.fill(followName);
  await searchFollower.press('Enter');
  await select(requester.page, 'Người đủ quyền theo dõi', followName);
  await requester.page.getByRole('button', { name: 'Thêm người theo dõi', exact: true }).click();
  const mention = requester.page.getByRole('checkbox', { name: followName, exact: true });
  await expect(mention).toBeVisible();
  await mention.press('Space');
  await expect(mention).toBeChecked();
  const note = 'Đối chiếu tình trạng chứng từ của hồ sơ giả lập.';
  await data(
    await requester.context.request.post(runUrl + '/discussion', {
      headers: { origin: W, 'idempotency-key': randomUUID() },
      data: {
        tenantId: ids.tenantA,
        reason: 'Kiểm tra CSRF bình luận',
        text: note,
        mentionIds: [],
      },
    }),
    403,
  );
  await requester.page.getByLabel('Nội dung bình luận').fill(note);
  await requester.page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
  await expect(requester.page.getByText(note, { exact: true })).toBeVisible();
  await expect(requester.page.getByText('@' + followName, { exact: true })).toBeVisible();
  await scan(requester.page, 'discussion-owner-desktop');
  stage = 'followed list and follower projection';
  current = designer.page;
  await designer.page.goto(W + '/#workflows/followed');
  const tracked = designer.page.getByRole('row').filter({ hasText: title + ' hồ sơ' });
  await expect(tracked).toBeVisible();
  await designer.page.reload();
  await tracked.getByRole('button', { name: 'Mở lượt chạy', exact: true }).click();
  const projected = await getRun(designer.context, runId);
  assert.equal(projected.following, true);
  assert.equal(projected.run.inputs.purpose, undefined);
  assert.equal(projected.canAct, false);
  assert.equal(projected.canReassign, false);
  assert.equal((await designer.context.request.get(attachmentUrl)).status(), 404);
  await expect(designer.page.getByText(secret, { exact: true })).toHaveCount(0);
  await designer.page.setViewportSize({ width: 390, height: 844 });
  await designer.page.getByRole('tab', { name: 'Trao đổi', exact: true }).press('Enter');
  await expect(designer.page.getByText(note, { exact: true })).toBeVisible();
  const reply = 'Đã xem và xác nhận tiến độ.';
  await designer.page.getByLabel('Nội dung bình luận').fill(reply);
  await designer.page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
  await expect(designer.page.getByText(reply, { exact: true })).toBeVisible();
  await scan(designer.page, 'discussion-follower-mobile');
  stage = 'revoke follower access and preserve comments';
  current = requester.page;
  await requester.page.reload();
  await requester.page.getByRole('tab', { name: 'Trao đổi', exact: true }).click();
  await expect(requester.page.getByText(reply, { exact: true })).toBeVisible();
  await requester.page
    .getByRole('button', { name: 'Bỏ theo dõi cho ' + followName, exact: true })
    .click();
  await expect(requester.page.getByText('Chưa có người theo dõi.', { exact: true })).toBeVisible();
  await expect(requester.page.getByText(reply, { exact: true })).toBeVisible();
  await data(await designer.context.request.get(runUrl + tenantQuery), 403);
  await data(await designer.context.request.get(runUrl + '/discussion' + tenantQuery), 403);
  const afterRemoval = await data(
    await designer.context.request.get(
      W +
        '/api/v1/workflows/runs?' +
        new URLSearchParams({
          tenantId: ids.tenantA,
          view: 'followed',
          search: title,
        }),
    ),
  );
  assert.deepEqual(afterRemoval.items, []);
  await designer.page.goto(W + '/#workflows/followed');
  await designer.page.reload();
  await expect(tracked).toHaveCount(0);
  stage = 'processed workspace and personal presets';
  current = finance.page;
  await finance.page.setViewportSize({ width: 1440, height: 1000 });
  await finance.page.getByRole('button', { name: 'Đã xử lý', exact: true }).click();
  const searchRun = finance.page.getByRole('textbox', { name: 'Tìm hồ sơ', exact: true });
  await searchRun.fill(title);
  await select(finance.page, 'Trạng thái hồ sơ', 'Hoàn thành');
  await searchRun.press('Enter');
  const record = finance.page.getByRole('row').filter({ hasText: title + ' hồ sơ' });
  await expect(record).toBeVisible();
  await expect(record.getByText('Hoàn tất công việc', { exact: true })).toBeVisible();
  const settings = finance.page.getByText('Bộ lọc đã lưu và cột hiển thị', { exact: true });
  await settings.click();
  const timeColumn = finance.page.getByRole('checkbox', {
    name: title + ' · Giờ cần nhận',
    exact: true,
  });
  await expect(timeColumn).toBeVisible();
  await timeColumn.press('Space');
  await expect(record.getByText('16:30', { exact: true })).toBeVisible();
  const purpose = fields.find((field) => field.id === 'purpose')!;
  await expect(
    finance.page.getByRole('checkbox', { name: title + ' · ' + purpose.label, exact: true }),
  ).toHaveCount(0);
  const filterName = 'Mua sắm đã xử lý ' + suffix;
  await finance.page.getByLabel('Tên bộ lọc', { exact: true }).fill(filterName);
  await finance.page.getByRole('button', { name: 'Lưu bộ lọc mới', exact: true }).click();
  await expect(
    finance.page.getByRole('combobox', { name: 'Chọn bộ lọc đã lưu', exact: true }),
  ).toHaveText(filterName);
  await scan(finance.page, 'processed-workspace-desktop');
  await finance.page.reload();
  await expect(record.getByText('16:30', { exact: true })).toBeVisible();
  await expect(searchRun).toHaveValue(title);
  await finance.page.getByRole('button', { name: 'Đặt lại', exact: true }).click();
  await settings.click();
  await select(finance.page, 'Chọn bộ lọc đã lưu', filterName);
  await expect(record.getByText('16:30', { exact: true })).toBeVisible();
  await finance.page.setViewportSize({ width: 390, height: 844 });
  await settings.click();
  const runTable = finance.page.getByRole('region', { name: 'Bảng hồ sơ', exact: true });
  await runTable.press('ArrowRight');
  await expect(runTable).toBeFocused();
  await expect.poll(() => runTable.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await scan(finance.page, 'processed-workspace-mobile');
  await record.getByRole('button', { name: 'Mở lượt chạy', exact: true }).click();
  await finance.page.getByRole('button', { name: 'Danh sách lượt chạy', exact: true }).click();
  await expect(record.getByText('16:30', { exact: true })).toBeVisible();
  await settings.click();
  await select(finance.page, 'Chọn bộ lọc đã lưu', filterName);
  await finance.page.getByRole('button', { name: 'Bỏ bộ lọc đã lưu', exact: true }).click();
  await expect(
    finance.page.getByRole('combobox', { name: 'Chọn bộ lọc đã lưu', exact: true }),
  ).toHaveText('Bộ lọc mới');
  stage = 'step collaboration scope and follower deep link';
  current = requester.page;
  await requester.page.setViewportSize({ width: 1440, height: 1000 });
  const stepLabel =
    reviewPending.label +
    ' · Lần gửi ' +
    reviewPending.round +
    ', lần xử lý ' +
    reviewPending.attempt;
  await select(requester.page, 'Phạm vi trao đổi', stepLabel);
  await expect(requester.page.getByText(note, { exact: true })).toHaveCount(0);
  await searchFollower.fill(followName);
  await searchFollower.press('Enter');
  await select(requester.page, 'Người đủ quyền theo dõi', followName);
  await requester.page.getByRole('button', { name: 'Thêm người theo dõi', exact: true }).click();
  await expect(mention).toBeVisible();
  await mention.press('Space');
  const stepNote = 'Đối chiếu riêng ở lần xử lý này.';
  await requester.page.getByLabel('Nội dung bình luận').fill(stepNote);
  await requester.page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
  await expect(requester.page.getByText(stepNote, { exact: true })).toBeVisible();
  await scan(requester.page, 'discussion-step-owner-desktop');
  await data(await designer.context.request.get(runUrl + tenantQuery), 403);
  await data(
    await designer.context.request.get(runUrl + tenantQuery + '&taskId=' + pending.id),
    403,
  );
  const stepDetail = await data(
    await designer.context.request.get(runUrl + tenantQuery + '&taskId=' + reviewPending.id),
  );
  assert.equal(stepDetail.relatedTaskId, reviewPending.id);
  assert.deepEqual(
    stepDetail.tasks.map((item: { id: string }) => item.id),
    [reviewPending.id],
  );
  assert.equal(stepDetail.canAct, false);
  assert.ok(!JSON.stringify(stepDetail).includes(secret));
  assert.equal((await designer.context.request.get(attachmentUrl)).status(), 404);
  current = designer.page;
  await designer.page.reload();
  await tracked.getByRole('button', { name: 'Mở lượt chạy', exact: true }).click();
  await designer.page.waitForURL(
    (url) => url.hash === '#workflow-run/' + runId + '/' + reviewPending.id,
  );
  await expect(designer.page.getByText(stepNote, { exact: true })).toBeVisible();
  await expect(designer.page.getByText(note, { exact: true })).toHaveCount(0);
  await expect(designer.page.getByRole('combobox', { name: 'Phạm vi trao đổi' })).toHaveText(
    stepLabel,
  );
  await designer.page.getByLabel('Nội dung bình luận').fill('Đã đối chiếu đúng bước.');
  await designer.page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
  await expect(designer.page.getByText('Đã đối chiếu đúng bước.', { exact: true })).toBeVisible();
  await scan(designer.page, 'discussion-step-follower-mobile');
  await requester.page
    .getByRole('button', { name: 'Bỏ theo dõi cho ' + followName, exact: true })
    .click();
  await expect(requester.page.getByText('Chưa có người theo dõi.', { exact: true })).toBeVisible();
  await data(
    await designer.context.request.get(runUrl + tenantQuery + '&taskId=' + reviewPending.id),
    403,
  );
  await writeFile(
    evidence + 'e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans,
        checks: [
          'SSO/MFA and UI table designer',
          'server decimal total routing',
          'field privacy in details/history/action results',
          'own persistent incomplete draft, reload and atomic submission',
          'configuration export v5',
          'person/unit designer and scoped lookup, persisted snapshots, keyboard selection',
          'step input modes, required completion, immutable original and protected revisions',
          'temporal inputs, nested dependent choices and routing by completed step results',
          'configured attachments, format quarantine, save/reload, keyboard download and hidden-field download denial',
          'record code and permission-scoped attachment tab',
          'share a run and mention via UI, follower reply and live removal, protected fields and attachments',
          'processed decisions, scoped business columns, personal filter persistence and keyboard table scrolling',
          'owner shares an exact step, follower opens scoped deep link, replies and loses access on removal',
          'desktop/mobile/keyboard/axe',
        ],
        credentialsExposed: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS Workflows W1 business forms, field privacy, persisted drafts and ' +
      scans.length +
      ' axe scans.',
  );
} catch (error) {
  const location =
    error instanceof Error
      ? error.stack?.match(/workflows-business-e2e\.ts:\d+:\d+/)?.[0]
      : undefined;
  console.error(
    'Workflows W1 failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      ')' +
      (location ? ' at ' + location : '') +
      '. No sensitive payloads logged.',
  );
  if (
    current &&
    !current.isClosed() &&
    new URL(current.url()).origin === W &&
    new URL(current.url()).pathname === '/' &&
    (await current.locator('input[type=password],#otp').count()) === 0
  )
    await current.screenshot({
      path: evidence + 'failure.png',
      fullPage: (await current.getByRole('dialog').count()) === 0,
    });
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const app of servers) {
    app.server.closeAllConnections();
    await app.close();
  }
}
