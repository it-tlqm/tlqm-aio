import { bffClients } from '../src/config.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { FastifyInstance } from 'fastify';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { FormSchema } from '../src/forms/contracts.js';

const runtime = await loadLocalConfig();
const testRuntime = { ...runtime, databaseUrl: testDatabaseUrl(runtime) };
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const F = runtime.clients.find((client) => client.code === 'aio-forms')!.baseUrl;
const browser = await chromium.launch({ headless: true });
const servers: FastifyInstance[] = [];
const run = randomUUID().slice(0, 8),
  code = 'ui-' + run,
  title = 'Khảo sát số hóa ' + run;
let stage = 'startup';
let current: Page | undefined;
const scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
async function login(user: { id: string; username: string; password: string }, mfa = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(event.violatedDirective),
    );
  });
  const page = await context.newPage();
  current = page;
  await page.goto(F + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.origin === F && url.pathname === '/', { timeout: 20000 });
  await page.getByRole('heading', { name: 'Biểu mẫu nội bộ', exact: true }).waitFor();
  return page;
}
const role = (name: FormsFixture['role']) => fixtures.users.find((user) => user.role === name)!;
async function select(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true });
  await trigger.click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(trigger).toHaveText(option);
}
async function confirm(page: Page) {
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor();
  await dialog.getByLabel('Lý do thao tác').fill('Nghiệm thu UI Forms ' + run);
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 });
}
async function scan(page: Page, screen: string) {
  current = page;
  assert.equal(new URL(page.url()).origin, F);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== 'running' ||
            animation.effect?.getTiming().iterations === Infinity,
        ),
    undefined,
    { timeout: 5000 },
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    screen,
    violations: result.violations.map((issue) => issue.id),
    incomplete: result.incomplete.map((issue) => issue.id),
  });
  await writeFile(
    '.local/evidence/forms-accessibility.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), scans }, null, 2) + '\n',
  );
  if (result.violations.length)
    console.error(
      'Forms accessibility: ' +
        JSON.stringify(
          result.violations.map((issue) => ({
            id: issue.id,
            targets: issue.nodes.map((node) => node.target),
          })),
        ),
    );
  assert.equal(result.violations.length, 0);
  assert.deepEqual(
    await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp ?? []),
    [],
  );
}
async function question(
  page: Page,
  label: string,
  type: string,
  required = false,
  configure?: (page: Page) => Promise<void>,
  existing?: string,
) {
  await page
    .getByRole('button', {
      name: existing ? 'Sửa câu hỏi ' + existing : 'Thêm câu hỏi',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nhãn câu hỏi').fill(label);
  await select(page, 'Loại câu hỏi', type);
  if (required) await dialog.getByLabel('Bắt buộc trả lời', { exact: true }).check();
  if (configure) await configure(page);
  if (label === 'Nội dung hỗ trợ') await scan(page, 'condition-editor');
  if (label === 'Số công cụ') await scan(page, 'number-question-editor');
  await dialog.getByRole('button', { name: 'Lưu câu hỏi', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 10000 });
}
async function open(page: Page, formId: string) {
  current = page;
  if (page.url() === F + '/#forms/' + formId) {
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes('/api/v1/forms/' + formId + '?') &&
          response.request().method() === 'GET',
      ),
      page.getByRole('button', { name: 'Tải lại biểu mẫu', exact: true }).click(),
    ]);
  } else await page.goto(F + '/#forms/' + formId);
  await page.getByRole('heading', { name: title, exact: true }).first().waitFor();
}
try {
  for (const client of bffClients(runtime)) {
    const app = await createApp({ runtime: testRuntime, client, test: true, logger: false });
    await app.listen({ host: '127.0.0.1', port: client.port });
    servers.push(app);
  }
  stage = 'designer create and ten question types';
  const designer = await login(role('designer'), true);
  await designer.getByRole('button', { name: 'Tạo biểu mẫu', exact: true }).click();
  await designer.getByLabel('Tên biểu mẫu', { exact: true }).fill(title);
  await designer.getByLabel('Mã biểu mẫu', { exact: true }).fill(code);
  await designer.getByRole('button', { name: 'Tạo bản nháp', exact: true }).click();
  await designer.getByRole('heading', { name: title, exact: true }).waitFor();
  const formId = new URL(designer.url()).hash.slice(7);
  assert.match(formId, /^[0-9a-f-]{36}$/);
  await question(designer, 'Tên khảo sát', 'Văn bản ngắn', true, undefined, 'Câu hỏi đầu tiên');
  await question(designer, 'Mô tả công việc', 'Văn bản dài');
  await question(designer, 'Số công cụ', 'Số', true, async (page) => {
    await page.getByLabel('Giới hạn tối thiểu').fill('0');
    await page.getByLabel('Giới hạn tối đa').fill('20');
  });
  await question(designer, 'Ngày khảo sát', 'Ngày', true);
  await question(designer, 'Mức độ số hóa', 'Chọn một', false, async (page) => {
    await page.getByLabel('Lựa chọn 1', { exact: true }).fill('Thường xuyên');
    await page.getByLabel('Lựa chọn 2', { exact: true }).fill('Thỉnh thoảng');
  });
  await question(designer, 'Kênh sử dụng', 'Chọn nhiều', false, async (page) => {
    await page.getByLabel('Lựa chọn 1', { exact: true }).fill('Web');
    await page.getByLabel('Lựa chọn 2', { exact: true }).fill('Điện thoại');
  });
  await question(designer, 'Cần hỗ trợ', 'Có / Không', true);
  await question(designer, 'Nội dung hỗ trợ', 'Văn bản dài', true, async (page) => {
    await page
      .getByRole('group', { name: 'Hiện câu hỏi khi', exact: true })
      .getByRole('button', { name: 'Thêm điều kiện', exact: true })
      .click();
    await select(page, 'Hiện câu hỏi khi — Câu hỏi 1', 'Cần hỗ trợ');
    await select(page, 'Hiện câu hỏi khi — Phép so sánh 1', 'Bằng');
    await select(page, 'Hiện câu hỏi khi — Giá trị 1', 'Có');
  });
  await question(designer, 'Đề xuất cải tiến', 'Văn bản ngắn');
  await question(designer, 'Đồng ý ghi nhận', 'Có / Không', true);
  await designer.getByLabel('Tên phần 1', { exact: true }).fill('Khảo sát hiện trạng số hóa');
  await designer
    .getByRole('button', { name: 'Đưa câu hỏi Đồng ý ghi nhận lên', exact: true })
    .click();
  await designer
    .getByRole('button', { name: 'Đưa câu hỏi Đồng ý ghi nhận xuống', exact: true })
    .click();
  await designer.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await designer
    .getByText('Đã lưu bản nháp. Phiên bản đã xuất bản giữ nguyên.', { exact: true })
    .waitFor();
  await scan(designer, 'designer-ten-fields');
  await designer.screenshot({ path: '.local/evidence/forms-designer-desktop.png', fullPage: true });
  const definition = (await (
    await designer.request.get(F + '/api/v1/forms/' + formId + '?tenantId=' + ids.tenantA)
  ).json()) as { form: { draft_schema: FormSchema } };
  const schema = definition.form.draft_schema;
  assert.equal(schema.sections.flatMap((section) => section.fields).length, 10);
  const fields = Object.fromEntries(
    schema.sections.flatMap((section) => section.fields).map((field) => [field.label, field.id]),
  );
  stage = 'preview keyboard desktop and mobile';
  const previewButton = designer.getByRole('button', { name: 'Xem trước', exact: true });
  await previewButton.click();
  const preview = designer.getByRole('dialog');
  await preview.waitFor();
  await designer.locator('#answer-' + fields['Cần hỗ trợ']).click();
  await designer.getByRole('option', { name: 'Có', exact: true }).click();
  await expect(designer.getByRole('listbox')).toBeHidden();
  await expect(designer.locator('#answer-' + fields['Cần hỗ trợ'])).toHaveText('Có');
  await expect(preview.getByLabel('Nội dung hỗ trợ', { exact: false })).toBeVisible();
  await scan(designer, 'preview-desktop');
  await designer.setViewportSize({ width: 390, height: 844 });
  await scan(designer, 'preview-mobile');
  assert.ok(await designer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await designer.screenshot({ path: '.local/evidence/forms-preview-mobile.png', fullPage: true });
  for (let i = 0; i < 8; i++) {
    await designer.keyboard.press('Tab');
    assert.ok(await preview.evaluate((element) => element.contains(document.activeElement)));
  }
  await preview.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(previewButton).toBeFocused();
  await designer.setViewportSize({ width: 1440, height: 1000 });
  stage = 'publisher audience and immutable publication UI';
  const publisher = await login(role('publisher'), true);
  await open(publisher, formId);
  await publisher.getByLabel('Đào tạo', { exact: true }).check();
  await publisher.getByLabel('Chuyển đổi số', { exact: true }).check();
  await publisher.getByRole('button', { name: 'Lưu người nhận', exact: true }).click();
  await publisher
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Hủy', exact: true })
    .click();
  assert.equal(
    (
      await (
        await publisher.request.get(F + '/api/v1/forms/' + formId + '?tenantId=' + ids.tenantA)
      ).json()
    ).audiences.length,
    0,
  );
  await publisher.getByRole('button', { name: 'Lưu người nhận', exact: true }).click();
  await confirm(publisher);
  await publisher.getByRole('button', { name: 'Xuất bản', exact: true }).click();
  await confirm(publisher);
  await scan(publisher, 'publisher-distribution');
  stage = 'respondent validation draft and submission';
  const learner = await login(runtime.users.find((user) => user.id === ids.learner)!);
  await open(learner, formId);
  await select(learner, 'Đơn vị trả lời', 'Đào tạo');
  await learner.getByRole('button', { name: 'Gửi phiếu', exact: true }).click();
  await learner.getByText('Vui lòng trả lời câu hỏi này.', { exact: true }).first().waitFor();
  await scan(learner, 'response-invalid');
  await learner.locator('#answer-' + fields['Tên khảo sát']).fill('Phiếu đơn vị A');
  await learner.locator('#answer-' + fields['Số công cụ']).fill('2');
  await learner.locator('#answer-' + fields['Ngày khảo sát']).fill('2026-11-10');
  for (const [label, value] of [
    ['Cần hỗ trợ', 'Không'],
    ['Đồng ý ghi nhận', 'Có'],
    ['Mức độ số hóa', 'Thường xuyên'],
  ]) {
    await learner.locator('#answer-' + fields[label!]).click();
    await learner.getByRole('option', { name: value!, exact: true }).click();
  }
  await learner.getByLabel('Web', { exact: true }).check();
  await learner.locator('#answer-' + fields['Đề xuất cải tiến']).fill('=1+2');
  assert.equal(await learner.locator('#answer-' + fields['Nội dung hỗ trợ']).count(), 0);
  await learner.getByRole('button', { name: 'Lưu nháp phiếu', exact: true }).click();
  await learner.getByText('Đã lưu bản nháp.', { exact: true }).waitFor();
  await learner.reload();
  await learner.locator('#answer-' + fields['Tên khảo sát']).waitFor();
  assert.equal(
    await learner.locator('#answer-' + fields['Tên khảo sát']).inputValue(),
    'Phiếu đơn vị A',
  );
  await learner.locator('#answer-' + fields['Cần hỗ trợ']).click();
  await learner.getByRole('option', { name: 'Có', exact: true }).click();
  await learner.locator('#answer-' + fields['Nội dung hỗ trợ']).fill('Hỗ trợ quy trình giả lập');
  await scan(learner, 'response-filled');
  await learner.screenshot({ path: '.local/evidence/forms-response-desktop.png', fullPage: true });
  await learner.getByRole('button', { name: 'Gửi phiếu', exact: true }).click();
  await confirm(learner);
  await learner
    .getByText('Đã gửi phiếu. Nội dung đã gửi được giữ nguyên.', { exact: true })
    .waitFor();
  await learner.getByRole('button', { name: 'Đọc lại phiếu', exact: true }).click();
  await scan(learner, 'response-readback');
  await learner.getByRole('dialog').getByRole('button', { name: 'Đóng', exact: true }).click();
  stage = 'second unit response UI';
  const second = await login(role('respondent'));
  await open(second, formId);
  await second.locator('#answer-' + fields['Tên khảo sát']).fill('Phiếu đơn vị C');
  await second.locator('#answer-' + fields['Số công cụ']).fill('3');
  await second.locator('#answer-' + fields['Ngày khảo sát']).fill('2026-11-10');
  for (const [label, value] of [
    ['Cần hỗ trợ', 'Không'],
    ['Đồng ý ghi nhận', 'Có'],
  ]) {
    await second.locator('#answer-' + fields[label!]).click();
    await second.getByRole('option', { name: value!, exact: true }).click();
  }
  await second.getByRole('button', { name: 'Gửi phiếu', exact: true }).click();
  await confirm(second);
  stage = 'reviewer analyst and scoped CSV UI';
  const reviewer = await login(role('reviewer'));
  await open(reviewer, formId);
  await reviewer.getByRole('button', { name: 'Xem phiếu', exact: true }).waitFor();
  assert.equal(await reviewer.getByRole('button', { name: 'Xem phiếu', exact: true }).count(), 1);
  await reviewer.getByRole('button', { name: 'Xem phiếu', exact: true }).click();
  await reviewer.getByText('Phiếu đơn vị A', { exact: true }).waitFor();
  assert.equal(await reviewer.getByText('Phiếu đơn vị C', { exact: true }).count(), 0);
  await scan(reviewer, 'reviewer-readback');
  const analyst = await login(role('analyst'));
  await open(analyst, formId);
  await analyst.getByText('1 phiếu đã gửi trong phạm vi', { exact: true }).waitFor();
  await scan(analyst, 'analyst-report');
  const download = analyst.waitForEvent('download');
  await analyst.getByRole('button', { name: 'Tải CSV', exact: true }).click();
  await confirm(analyst);
  await (await download).saveAs('.local/evidence/forms-scoped.csv');
  const csv = await readFile('.local/evidence/forms-scoped.csv', 'utf8');
  assert.ok(csv.includes('text: =1+2'));
  assert.ok(!csv.includes('Phiếu đơn vị C'));
  stage = 'v2 UI leaves v1 response unchanged';
  await open(designer, formId);
  await designer.getByRole('button', { name: 'Tạo bản nháp mới', exact: true }).click();
  await question(designer, 'Tên khảo sát (v2)', 'Văn bản ngắn', true, undefined, 'Tên khảo sát');
  await designer.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await designer
    .getByText('Đã lưu bản nháp. Phiên bản đã xuất bản giữ nguyên.', { exact: true })
    .waitFor();
  await open(publisher, formId);
  await publisher.getByRole('button', { name: 'Xuất bản', exact: true }).click();
  await confirm(publisher);
  await open(learner, formId);
  await learner.getByRole('button', { name: 'Đọc lại phiếu', exact: true }).click();
  assert.equal(
    await learner.getByRole('dialog').getByText('Tên khảo sát', { exact: true }).count(),
    1,
  );
  assert.equal(
    await learner.getByRole('dialog').getByText('Tên khảo sát (v2)', { exact: true }).count(),
    0,
  );
  await learner.getByRole('dialog').getByRole('button', { name: 'Đóng', exact: true }).click();
  await learner.setViewportSize({ width: 390, height: 844 });
  await scan(learner, 'submitted-mobile');
  assert.ok(await learner.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await learner.screenshot({ path: '.local/evidence/forms-submitted-mobile.png', fullPage: true });
  stage = 'group management and close UI';
  await publisher.getByRole('button', { name: 'Nhóm nhận biểu mẫu', exact: true }).click();
  await publisher.getByRole('button', { name: 'Tạo nhóm nhận', exact: true }).click();
  await publisher.getByLabel('Tên nhóm', { exact: true }).fill('Nhóm khảo sát ' + run);
  const references = (await (
    await publisher.request.get(F + '/api/v1/forms/lookups?tenantId=' + ids.tenantA)
  ).json()) as { accounts: { id: string; name: string }[] };
  await publisher
    .getByLabel(references.accounts.find((user) => user.id === ids.learner)!.name, { exact: true })
    .check();
  await scan(publisher, 'group-editor');
  await publisher.getByRole('button', { name: 'Lưu nhóm nhận', exact: true }).click();
  await confirm(publisher);
  await publisher.getByText('Nhóm khảo sát ' + run, { exact: true }).waitFor();
  await open(publisher, formId);
  await publisher.getByRole('button', { name: 'Đóng biểu mẫu', exact: true }).click();
  await confirm(publisher);
  await writeFile(
    '.local/evidence/forms-ui.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        fields: 10,
        scans: scans.length,
        violations: 0,
        checks: [
          'shadcn ten-field designer and condition, ordering and preview',
          'desktop/mobile keyboard and automated accessibility',
          'audience confirmation/cancel and publish',
          'draft reload, submit and immutable readback',
          'reviewer/analyst scope and CSV download',
          'v2 preserves v1 answers/schema',
          'groups and form close',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: Forms ten-question UI workflow, conditions, draft/submit, scoped review/export, v1/v2, groups, responsive keyboard and accessibility scans.',
  );
} catch (error) {
  const location =
    error instanceof Error ? /forms-ui-e2e\.ts:(\d+):(\d+)/.exec(error.stack ?? '') : null;
  if (location) console.error('Forms UI script location: ' + location[1] + ':' + location[2]);
  console.error(
    'Forms UI E2E failed at: ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Credentials and browser payloads omitted.',
  );
  if (
    current &&
    new URL(current.url()).origin === F &&
    (await current.locator('input[type=password]').count()) === 0
  )
    await current
      .screenshot({ path: '.local/evidence/forms-ui-failure.png', fullPage: true })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await Promise.all(servers.map((server) => server.close()));
}
