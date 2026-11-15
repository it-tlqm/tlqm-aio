import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { APIResponse, BrowserContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../src/app.js';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import type { HumanStep, WorkflowSpec } from '../src/workflows/contracts.js';
import type { FormsFixture } from './forms-fixtures.js';
import { localContainer } from './local-docker.js';
import { nextFixtureOtp } from './local-totp.js';
import { reminderRuntime } from './work-center-runtime.js';

const runtime = await loadLocalConfig();
const base = 'http://127.0.0.1:4105';
const routes = base + '/api/v1/workflows';
const tenant = '?tenantId=' + ids.tenantA;
const evidence = '.local/evidence/workflows-linked-requests-';
const scheduleEvidence = '.local/evidence/workflows-scheduled-requests-';
const stepEvidence = '.local/evidence/workflows-step-linked-requests-';
const fixture = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixture.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixture.users.find((user) => user.role === name)!;
const browser = await chromium.launch({ headless: true });
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let worker: Awaited<ReturnType<typeof reminderRuntime>> | undefined;
let stage = 'preflight';
let current: Page | undefined;
const scans: { name: string; violations: string[]; incomplete: string[] }[] = [];
const scheduleScans: typeof scans = [];
const stepScans: typeof scans = [];

async function read(response: APIResponse, expected = 200) {
  const body = await response.json().catch(() => ({}));
  if (response.status() !== expected && /^[A-Z_]+$/.test(body.error ?? ''))
    console.error('HTTP ' + response.status() + ' ' + body.error);
  assert.equal(response.status(), expected);
  return body;
}
async function login(user: { id: string; username: string; password: string }, mfa = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
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
  return { context, page };
}
async function write(
  context: BrowserContext,
  path: string,
  data: Record<string, unknown>,
  expected = 200,
) {
  const me = await read(await context.request.get(base + '/api/v1/me'));
  return read(
    await context.request.post(routes + path, {
      headers: { origin: base, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() },
      data: { tenantId: ids.tenantA, reason: 'Nghiệm thu nháp quyết toán giả lập', ...data },
    }),
    expected,
  );
}
async function choose(page: Page, label: string, value: string, keyboard = false) {
  const control = page.getByRole('combobox', { name: label, exact: true });
  await expect(control).toBeEnabled();
  if (keyboard) await control.press('Space');
  else await control.click();
  const option = page.getByRole('option', { name: value, exact: true });
  if (keyboard) await option.press('Enter');
  else await option.click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}
async function scan(page: Page, name: string, output = evidence, results = scans) {
  assert.equal(new URL(page.url()).origin, base);
  assert.equal(await page.locator('input[type=password],#otp').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getTiming().iterations === Infinity,
      ),
  );
  const audit = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  results.push({
    name,
    violations: audit.violations.map((v) => v.id),
    incomplete: audit.incomplete.map((v) => v.id),
  });
  await writeFile(output + 'axe.json', JSON.stringify(results, null, 2));
  if (audit.violations.length)
    console.error(
      JSON.stringify(
        audit.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
        })),
      ),
    );
  assert.equal(audit.violations.length, 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const dialog = page.getByRole('dialog');
  if (await dialog.count())
    assert(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
  await page.screenshot({ path: output + name + '.png', fullPage: !(await dialog.count()) });
}
async function checkDialogFocus(page: Page) {
  const dialog = page.getByRole('dialog');
  for (const key of [...Array(12).fill('Tab'), ...Array(4).fill('Shift+Tab')]) {
    await page.keyboard.press(key);
    assert(await dialog.evaluate((element) => element.contains(document.activeElement)));
  }
}
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  const client = runtime.clients.find((item) => item.code === 'aio-workflows')!;
  app = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client,
    test: true,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: client.port });
  stage = 'MFA and versions';
  const designer = await login(role('designer'), true);
  const publisher = await login(role('publisher'), true);
  const reviewer = await login(role('reviewer'));
  const requester = await login(runtime.users.find((user) => user.id === ids.learner)!);
  const suffix = randomUUID().slice(0, 8);
  const sourceName = 'Tạm ứng công tác ' + suffix;
  const targetName = 'Quyết toán công tác ' + suffix;
  async function publish(name: string, target: boolean, customize?: (spec: WorkflowSpec) => void) {
    const spec = workflowTemplate('leave');
    spec.schemaVersion = 5;
    spec.name = name;
    spec.category = 'Tài chính';
    spec.audienceUnits = [ids.unitA];
    spec.input.schemaVersion = 2;
    spec.input.title = name;
    spec.input.sections[0]!.fields = [
      { id: 'purpose', label: 'Nội dung công tác', type: 'longText', required: true },
      {
        id: target ? 'received' : 'amount',
        label: target ? 'Số tiền đã nhận' : 'Số tiền tạm ứng',
        type: 'money',
        currency: 'VND',
        required: true,
      },
      target
        ? {
            id: 'receipts',
            label: 'Chứng từ quyết toán',
            type: 'attachment',
            required: true,
            attachments: { formats: ['txt'], maxBytes: 2048, maxFiles: 1 },
          }
        : { id: 'settle', label: 'Cần quyết toán', type: 'boolean', required: true },
    ];
    for (const node of spec.nodes) if ('assignee' in node) node.assignee = role('reviewer').id;
    customize?.(spec);
    const created = await write(designer.context, '/definitions', {
      code: 'linked-' + (customize ? 'step-' : target ? 'settlement-' : 'advance-') + suffix,
      orgUnitId: ids.unitA,
      spec,
    });
    return write(publisher.context, '/definitions/' + created.id + '/publish', {
      expectedRevision: created.revision,
    });
  }
  const source = await publish(sourceName, false);
  const target = await publish(targetName, true);
  const lookup = await read(
    await publisher.context.request.get(routes + '/lookups' + tenant + '&unitsOnly=true'),
  );
  const unit = lookup.units.find((item: { id: string }) => item.id === ids.unitA);
  assert(unit);
  stage = 'configure in UI';
  current = publisher.page;
  await publisher.page.goto(base + '/#workflows/automation');
  await expect(
    publisher.page.getByRole('heading', { name: 'Tạo quy trình liên kết' }),
  ).toBeVisible();
  await publisher.page.getByLabel('Tên quy tắc').fill('Chuẩn bị quyết toán ' + suffix);
  await choose(publisher.page, 'Quy trình nguồn', sourceName, true);
  await choose(publisher.page, 'Quy trình đích', targetName);
  await choose(publisher.page, 'Đơn vị áp dụng', unit.name);
  for (const [index, from, to] of [
    [1, 'Nội dung công tác', 'Nội dung công tác'],
    [2, 'Số tiền tạm ứng', 'Số tiền đã nhận'],
  ] as const) {
    await publisher.page.getByRole('button', { name: 'Thêm cặp trường' }).click();
    await choose(publisher.page, 'Trường nguồn ' + index, from);
    await choose(publisher.page, 'Trường đích ' + index, to);
  }
  await choose(publisher.page, 'Điều kiện tạo nháp', 'Cần quyết toán');
  await choose(publisher.page, 'Giá trị bằng', 'Có');
  await publisher.page.getByLabel('Lý do thao tác').fill('Áp dụng quy tắc quyết toán thử nghiệm');
  await expect(publisher.page.getByRole('combobox', { name: 'Quy trình nguồn' })).toContainText(
    sourceName,
  );
  await expect(publisher.page.getByRole('combobox', { name: 'Quy trình đích' })).toContainText(
    targetName,
  );
  await scan(publisher.page, 'configuration-desktop');
  await publisher.page.setViewportSize({ width: 390, height: 844 });
  await scan(publisher.page, 'configuration-mobile');
  await publisher.page.setViewportSize({ width: 1440, height: 950 });
  await expect(publisher.page.getByRole('combobox', { name: 'Quy trình nguồn' })).toContainText(
    sourceName,
  );
  await expect(publisher.page.getByRole('combobox', { name: 'Quy trình đích' })).toContainText(
    targetName,
  );
  await publisher.page.getByRole('button', { name: 'Áp dụng quy tắc' }).click();
  await expect(
    publisher.page.getByText('Đã áp dụng quy tắc liên kết.', { exact: true }),
  ).toBeVisible();
  const rules = await read(await publisher.context.request.get(routes + '/link-rules' + tenant));
  const rule = rules.items.find(
    (entry: { source_version_id: string }) => entry.source_version_id === source.version.id,
  );
  assert.equal(rule.target_version_id, target.version.id);
  assert.deepEqual(rule.predicate, { fieldId: 'settle', equals: true });
  await read(await requester.context.request.get(routes + '/link-rules' + tenant), 403);
  stage = 'source approval and isolated worker';
  const sourceRun = await write(requester.context, '/runs', {
    definitionId: source.definition.id,
    versionId: source.version.id,
    unitId: ids.unitA,
    title: 'Tạm ứng công tác hồ sơ ' + suffix,
    answers: { purpose: 'Công tác giả lập', amount: '1200000.25', settle: true },
  });
  const opened = await read(
    await reviewer.context.request.get(routes + '/runs/' + sourceRun.id + tenant),
  );
  const task = opened.tasks.find((item: { status: string }) => item.status === 'pending');
  const decided = await write(reviewer.context, '/tasks/' + task.id + '/action', {
    expectedRevision: task.revision,
    action: 'approve',
    answers: {},
  });
  assert.equal(decided.status, 'completed');
  worker = await reminderRuntime(runtime, true);
  await worker.tick();
  await worker.tick();
  const jobs = await read(
    await publisher.context.request.get(routes + '/link-rules/' + rule.id + '/jobs' + tenant),
  );
  assert.equal(jobs.items.length, 1);
  assert.equal(jobs.items[0].status, 'done');
  assert.equal(jobs.items[0].attempts, 1);
  await publisher.page.getByRole('button', { name: 'Tải lại lịch sử' }).click();
  await expect(publisher.page.getByText('Đã tạo nháp', { exact: true })).toBeVisible();
  await scan(publisher.page, 'history-desktop');
  stage = 'mobile settlement draft';
  current = requester.page;
  await requester.page.setViewportSize({ width: 390, height: 844 });
  await requester.page.goto(base + '/#workflow-run/' + sourceRun.id);
  const openDraft = requester.page.getByRole('button', { name: 'Mở nháp liên kết' });
  await expect(openDraft).toBeVisible();
  await scan(requester.page, 'source-mobile');
  await openDraft.press('Enter');
  const dialog = requester.page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: /^Hồ sơ nguồn ·/ })).toBeVisible();
  await checkDialogFocus(requester.page);
  const linked = await read(
    await requester.context.request.get(
      routes + '/runs/' + sourceRun.id + '/linked-requests' + tenant,
    ),
  );
  const detail = await read(
    await requester.context.request.get(routes + '/requests/' + linked.items[0].requestId + tenant),
  );
  assert.deepEqual(detail.request.answers, { purpose: 'Công tác giả lập', received: '1200000.25' });
  const chooser = requester.page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Chọn tệp cho Chứng từ quyết toán' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'Chứng từ quyết toán.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Chứng từ giả lập'),
  });
  await expect(
    dialog.getByRole('link', { name: 'Chứng từ quyết toán.txt', exact: true }),
  ).toBeVisible();
  await scan(requester.page, 'draft-mobile');
  await dialog.getByRole('button', { name: 'Gửi đề nghị', exact: true }).click();
  await requester.page.waitForURL(
    (url) => url.hash.startsWith('#workflow-run/') && !url.hash.includes(sourceRun.id),
  );
  const relation = await read(
    await requester.context.request.get(
      routes + '/runs/' + sourceRun.id + '/linked-requests' + tenant,
    ),
  );
  assert.equal(relation.items.length, 1);
  assert.equal(relation.items[0].status, 'running');
  await writeFile(
    evidence + 'e2e.json',
    JSON.stringify(
      {
        result: 'pass',
        checkedAtVietnam: new Date(Date.now() + 25200000).toISOString().replace('Z', '+07:00'),
        scans,
        checks: [
          'real SSO/MFA',
          'published versions selected in UI',
          'conditional field mapping',
          'single job across two worker ticks',
          'mobile source and linked draft',
          'keyboard focus stays within the linked draft dialog',
          'upload then submit settlement',
          'scope denial',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: linked draft UI, live IAM worker, settlement attachment and ' +
      scans.length +
      ' axe scans.',
  );
  if (process.argv.includes('--step-linked')) {
    stage = 'step link rule configuration';
    current = publisher.page;
    const stepName = 'Duyệt chi phí theo bước ' + suffix;
    const stepSource = await publish(stepName, false, (spec) => {
      const review = spec.nodes.find(
        (node): node is HumanStep => node.id === 'review' && node.kind === 'approval',
      )!;
      review.next = 'confirm';
      review.form = {
        schemaVersion: 2,
        title: 'Chi phí được duyệt',
        sections: [
          {
            id: 'review_data',
            title: 'Kết quả',
            fields: [
              {
                id: 'approved_amount',
                label: 'Chi phí duyệt',
                type: 'money',
                currency: 'VND',
                required: true,
              },
              { id: 'step_ready', label: 'Đủ điều kiện', type: 'boolean', required: true },
            ],
          },
        ],
      };
      spec.nodes.splice(2, 0, {
        id: 'confirm',
        label: 'Xác nhận sau duyệt',
        kind: 'task',
        assignee: role('reviewer').id,
        dueHours: 24,
        next: 'end',
        form: null,
        allowReturn: true,
        returnMode: 'previous',
      });
    });
    await publisher.page.reload();
    await expect(
      publisher.page.getByRole('heading', { name: 'Tạo quy trình liên kết' }),
    ).toBeVisible();
    await publisher.page.getByLabel('Tên quy tắc').fill('Chuẩn bị nháp theo bước ' + suffix);
    await choose(publisher.page, 'Quy trình nguồn', stepName);
    await choose(publisher.page, 'Quy trình đích', targetName);
    await choose(publisher.page, 'Đơn vị áp dụng', unit.name);
    await choose(publisher.page, 'Khi nào tạo nháp', 'Xem xét đề nghị', true);
    await choose(publisher.page, 'Giao nháp cho', 'Người được chỉ định');
    const requesterIdentity = await read(await requester.context.request.get(base + '/api/v1/me'));
    await publisher.page.getByLabel('Tìm người nhận liên kết').fill(requesterIdentity.displayName);
    const candidates = publisher.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/workflows/draft-schedule-recipients',
    );
    await publisher.page.getByRole('button', { name: 'Tìm người nhận', exact: true }).click();
    const response = await candidates;
    assert.equal(response.status(), 200);
    assert(
      (await response.json()).items.some(
        (item: { id: string }) => item.id === requesterIdentity.accountId,
      ),
    );
    await choose(publisher.page, 'Người nhận liên kết', requesterIdentity.displayName, true);
    for (const [index, fromField, toField] of [
      [1, 'Nội dung công tác', 'Nội dung công tác'],
      [2, 'Bước · Chi phí duyệt', 'Số tiền đã nhận'],
    ] as const) {
      await publisher.page.getByRole('button', { name: 'Thêm cặp trường' }).click();
      await choose(publisher.page, 'Trường nguồn ' + index, fromField);
      await choose(publisher.page, 'Trường đích ' + index, toField);
    }
    await choose(publisher.page, 'Điều kiện tạo nháp', 'Bước · Đủ điều kiện');
    await choose(publisher.page, 'Giá trị bằng', 'Có');
    await publisher.page.getByLabel('Lý do thao tác').fill('Nghiệm thu liên kết theo bước');
    await scan(publisher.page, 'configuration-desktop', stepEvidence, stepScans);
    await publisher.page.setViewportSize({ width: 390, height: 844 });
    await scan(publisher.page, 'configuration-mobile', stepEvidence, stepScans);
    await publisher.page.getByRole('button', { name: 'Áp dụng quy tắc' }).press('Enter');
    await expect(
      publisher.page.getByText('Đã áp dụng quy tắc liên kết.', { exact: true }),
    ).toBeVisible();
    await publisher.page.setViewportSize({ width: 1440, height: 950 });
    const rule = (
      await read(await publisher.context.request.get(routes + '/link-rules' + tenant))
    ).items.find(
      (item: { source_version_id: string }) => item.source_version_id === stepSource.version.id,
    );
    assert.equal(rule.source_step_id, 'review');
    assert.equal(rule.recipient_account_id, requesterIdentity.accountId);
    assert.deepEqual(rule.predicate, { fieldId: 'step_ready', equals: true, origin: 'step' });
    stage = 'step completion and exact linked draft';
    const run = await write(requester.context, '/runs', {
      definitionId: stepSource.definition.id,
      versionId: stepSource.version.id,
      unitId: ids.unitA,
      title: 'Hồ sơ duyệt công tác ' + suffix,
      answers: { purpose: 'Hồ sơ thử theo bước', amount: '400.00', settle: true },
    });
    async function actStep(nodeId: string, action: string, answers: Record<string, unknown> = {}) {
      const data = await read(
        await reviewer.context.request.get(routes + '/runs/' + run.id + tenant),
      );
      const task = data.tasks.find(
        (item: { node_id: string; status: string }) =>
          item.node_id === nodeId && item.status === 'pending',
      );
      assert(task);
      const changed = await write(reviewer.context, '/tasks/' + task.id + '/action', {
        expectedRevision: task.revision,
        action,
        answers,
      });
      return { task, changed };
    }
    const first = await actStep('review', 'approve', {
      approved_amount: '125.25',
      step_ready: true,
    });
    assert.equal(first.changed.status, 'running');
    await worker.tick();
    const linkUrl = routes + '/runs/' + run.id + '/linked-requests' + tenant;
    const related = (await read(await requester.context.request.get(linkUrl))).items;
    assert.equal(related.length, 1);
    const staleId = related[0].requestId;
    const draftUrl = routes + '/requests/' + staleId + tenant;
    const firstDraft = await read(await requester.context.request.get(draftUrl));
    assert.equal(firstDraft.linkedSource.taskId, first.task.id);
    assert.deepEqual(firstDraft.request.answers, {
      purpose: 'Hồ sơ thử theo bước',
      received: '125.25',
    });
    assert.equal((await publisher.context.request.get(draftUrl)).status(), 403);
    current = requester.page;
    await requester.page.goto(base + '/#workflow-run/' + run.id);
    const relatedPanel = requester.page.locator('[data-slot="card"]').filter({
      has: requester.page.getByRole('heading', { name: 'Hồ sơ liên kết' }),
    });
    await expect(relatedPanel.getByText(/Lần xử lý 1 · Vòng 1/)).toBeVisible();
    await scan(requester.page, 'source-active-mobile', stepEvidence, stepScans);
    await relatedPanel.getByRole('button', { name: 'Mở nháp liên kết' }).press('Enter');
    await expect(requester.page.getByRole('dialog').getByLabel('Số tiền đã nhận')).toHaveValue(
      '125.25',
    );
    await checkDialogFocus(requester.page);
    await requester.page.keyboard.press('Escape');
    await expect(requester.page.getByRole('dialog')).toHaveCount(0);
    stage = 'step return blocks old draft';
    await actStep('confirm', 'return');
    await requester.page.reload();
    await expect(relatedPanel.getByText('Nháp hết hiệu lực', { exact: true })).toBeVisible();
    await relatedPanel.getByRole('button', { name: 'Mở nháp liên kết' }).click();
    const staleDialog = requester.page.getByRole('dialog');
    await expect(
      staleDialog.getByText('Lần xử lý nguồn đã mất hiệu lực. Dùng nháp từ lần xử lý hiện tại.'),
    ).toBeVisible();
    await expect(staleDialog.getByLabel('Số tiền đã nhận')).toHaveValue('');
    await expect(staleDialog.getByRole('button', { name: 'Gửi đề nghị' })).toBeDisabled();
    await scan(requester.page, 'draft-inactive-mobile', stepEvidence, stepScans);
    const denied = await write(
      requester.context,
      '/requests/' + staleId + '/submit',
      { expectedRevision: firstDraft.request.revision },
      409,
    );
    assert.equal(denied.error, 'WORKFLOW_LINK_STEP_INACTIVE');
    await requester.page.keyboard.press('Escape');
    const replacement = await actStep('review', 'approve', {
      approved_amount: '130.50',
      step_ready: true,
    });
    await worker.tick();
    await worker.tick();
    const links = (await read(await requester.context.request.get(linkUrl))).items;
    assert.equal(links.length, 2);
    const valid = links.find((item: { sourceAttempt: number }) => item.sourceAttempt === 2);
    assert.notEqual(valid.requestId, staleId);
    assert.equal(valid.status, 'draft');
    await requester.page.reload();
    const validRow = relatedPanel.getByText(/Lần xử lý 2 · Vòng 1/).locator('../..');
    await validRow.getByRole('button', { name: 'Mở nháp liên kết' }).click();
    const newDialog = requester.page.getByRole('dialog');
    await expect(newDialog.getByLabel('Số tiền đã nhận')).toHaveValue('130.50');
    const chooser = requester.page.waitForEvent('filechooser');
    await newDialog.getByRole('button', { name: 'Chọn tệp cho Chứng từ quyết toán' }).click();
    await (
      await chooser
    ).setFiles({
      name: 'Chứng từ bước mới.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Chứng từ thử theo bước'),
    });
    await expect(
      newDialog.getByRole('link', { name: 'Chứng từ bước mới.txt', exact: true }),
    ).toBeVisible();
    await newDialog.getByRole('button', { name: 'Gửi đề nghị', exact: true }).click();
    await requester.page.waitForURL(
      (url) => url.hash.startsWith('#workflow-run/') && !url.hash.includes(run.id),
    );
    const submitted = await read(
      await requester.context.request.get(routes + '/requests/' + valid.requestId + tenant),
    );
    assert.equal(submitted.request.status, 'submitted');
    assert.equal(submitted.linkedSource.taskId, replacement.task.id);
    await actStep('confirm', 'complete');
    assert.equal(
      (
        await read(
          await publisher.context.request.get(routes + '/link-rules/' + rule.id + '/jobs' + tenant),
        )
      ).items.length,
      2,
    );
    await writeFile(
      stepEvidence + 'e2e.json',
      JSON.stringify(
        {
          result: 'pass',
          checkedAtVietnam: new Date(Date.now() + 25200000).toISOString().replace('Z', '+07:00'),
          scans: stepScans,
          checks: [
            'real SSO/MFA',
            'eligible fixed recipient from IAM',
            'configuration via keyboard',
            'draft visible before source completion',
            'map fields from both source scopes',
            'returned attempt hides mapped fields and blocks submission',
            'one draft per successful attempt',
            'replacement draft submitted via browser',
          ],
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS: step link UI, attempt replacement, scoped recipient and ' +
        stepScans.length +
        ' axe scans.',
    );
  }
  if (process.argv.includes('--scheduled')) {
    stage = 'scheduled draft configuration';
    current = publisher.page;
    const title = 'Nháp theo lịch ' + suffix;
    const me = await read(await requester.context.request.get(base + '/api/v1/me'));
    await publisher.page.getByRole('tab', { name: 'Tạo nháp định kỳ' }).press('Enter');
    await expect(publisher.page.getByRole('heading', { name: 'Tạo lịch nháp' })).toBeVisible();
    await publisher.page.getByLabel('Tiêu đề nháp').fill(title);
    await choose(publisher.page, 'Quy trình theo lịch', sourceName + ' · v1', true);
    await choose(publisher.page, 'Đơn vị nhận nháp', unit.name);
    await publisher.page.getByLabel('Tìm người nhận nháp').fill(me.displayName);
    const recipientLookup = publisher.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/workflows/draft-schedule-recipients',
    );
    await publisher.page.getByRole('button', { name: 'Tìm người nhận', exact: true }).click();
    const recipients = await recipientLookup;
    assert.equal(recipients.status(), 200);
    const match = (await recipients.json()).items.find(
      (item: { id: string }) => item.id === me.accountId,
    );
    assert(match);
    await choose(publisher.page, 'Người nhận nháp', match.name, true);
    await choose(publisher.page, 'Tần suất', 'Theo tháng');
    await expect(publisher.page.getByLabel('Lặp lại sau mỗi')).toBeVisible();
    await choose(publisher.page, 'Tần suất', 'Một lần');
    const dueAt = new Date(Math.ceil((Date.now() + 45000) / 60000) * 60000);
    const vietnam = new Date(dueAt.getTime() + 25200000).toISOString();
    await publisher.page.getByLabel('Ngày bắt đầu').fill(vietnam.slice(0, 10));
    await publisher.page.getByLabel('Giờ tạo nháp').fill(vietnam.slice(11, 16));
    await publisher.page.getByLabel('Lý do tạo lịch').fill('Nghiệm thu tạo nháp định kỳ');
    await scan(publisher.page, 'configuration-desktop', scheduleEvidence, scheduleScans);
    await publisher.page.setViewportSize({ width: 390, height: 844 });
    await scan(publisher.page, 'configuration-mobile', scheduleEvidence, scheduleScans);
    await publisher.page.getByRole('button', { name: 'Lưu lịch tạo nháp' }).press('Enter');
    await expect(
      publisher.page.getByRole('status').filter({ hasText: 'Đã lưu lịch tạo nháp.' }),
    ).toBeVisible();
    const list = await read(
      await publisher.context.request.get(routes + '/draft-schedules' + tenant),
    );
    const schedule = list.items.find((item: { title: string }) => item.title === title);
    assert.equal(schedule.version_id, source.version.id);
    assert.equal(schedule.next_run_at, dueAt.toISOString());
    assert.equal(schedule.time_zone, 'Asia/Ho_Chi_Minh');
    const jobsUrl = routes + '/draft-schedules/' + schedule.id + '/jobs' + tenant;
    assert.deepEqual((await read(await publisher.context.request.get(jobsUrl))).items, []);
    assert.equal((await requester.context.request.get(jobsUrl)).status(), 403);
    assert.equal(
      (
        await requester.context.request.get(
          routes +
            '/draft-schedule-recipients' +
            tenant +
            '&unitId=' +
            ids.unitA +
            '&definitionId=' +
            source.definition.id,
        )
      ).status(),
      403,
    );

    stage = 'due schedule and live IAM worker';
    await expect
      .poll(
        async () => {
          await worker!.tick();
          return (await read(await publisher.context.request.get(jobsUrl))).items[0]?.status;
        },
        { timeout: 135000, intervals: [3000, 5000, 7000] },
      )
      .toBe('done');
    await worker.tick();
    const jobs = (await read(await publisher.context.request.get(jobsUrl))).items;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].scheduled_for, dueAt.toISOString());
    assert.equal(jobs[0].attempts, 1);
    assert.equal(jobs[0].history[0].status, 'done');
    await publisher.page.getByRole('button', { name: 'Tải lại lịch' }).click();
    await expect(publisher.page.getByText('Đã tạo nháp', { exact: true })).toBeVisible();
    await scan(publisher.page, 'history-mobile', scheduleEvidence, scheduleScans);
    await publisher.page.getByLabel('Lý do tắt hoặc thử lại').fill('Tắt lịch đã nghiệm thu');
    await publisher.page.getByRole('button', { name: 'Tắt lịch', exact: true }).click();
    await expect(publisher.page.getByText('Đã tắt lịch tạo nháp.', { exact: true })).toBeVisible();

    stage = 'scheduled request ownership';
    current = requester.page;
    await requester.page.goto(base + '/#workflows/requests');
    const fullTitle = title + ' · ' + vietnam.slice(0, 10);
    await expect(requester.page.getByText(fullTitle, { exact: true })).toBeVisible();
    const requests = await read(await requester.context.request.get(routes + '/requests' + tenant));
    const scheduledDraft = requests.items.find(
      (item: { title: string }) => item.title === fullTitle,
    );
    assert(scheduledDraft);
    const scheduledDetail = await read(
      await requester.context.request.get(routes + '/requests/' + scheduledDraft.id + tenant),
    );
    assert.deepEqual(scheduledDetail.request.answers, {});
    assert.equal(scheduledDetail.request.status, 'draft');
    assert.equal(scheduledDetail.request.version_id, source.version.id);
    assert.equal(
      (
        await publisher.context.request.get(routes + '/requests/' + scheduledDraft.id + tenant)
      ).status(),
      403,
    );
    await requester.page
      .getByText(fullTitle, { exact: true })
      .locator('../..')
      .getByRole('button', { name: 'Tiếp tục nhập' })
      .click();
    await expect(requester.page.getByRole('dialog')).toBeVisible();
    await checkDialogFocus(requester.page);
    await scan(requester.page, 'draft-mobile', scheduleEvidence, scheduleScans);
    await writeFile(
      scheduleEvidence + 'e2e.json',
      JSON.stringify(
        {
          result: 'pass',
          checkedAtVietnam: new Date(Date.now() + 25200000).toISOString().replace('Z', '+07:00'),
          scans: scheduleScans,
          checks: [
            'real SSO/MFA',
            'scoped IAM recipient search',
            'Vietnam due instant',
            'no draft before due',
            'one draft across worker ticks',
            'scoped run history and disable',
            'pinned blank draft visible only to recipient',
            'keyboard focus stays within the scheduled draft dialog',
          ],
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS: scheduled draft UI, real Vietnam due time, live IAM, no duplicate and ' +
        scheduleScans.length +
        ' axe scans.',
    );
  }
} catch (error) {
  const location =
    error instanceof Error
      ? error.stack?.match(/workflows-linked-requests-e2e\.ts:\d+:\d+/)?.[0]
      : undefined;
  console.error(
    'Workflow automation failed at ' + stage + (location ? ' (' + location + ')' : '') + '.',
  );
  if (
    current &&
    !current.isClosed() &&
    new URL(current.url()).origin === base &&
    new URL(current.url()).pathname === '/' &&
    (await current.locator('input[type=password],#otp').count()) === 0
  )
    await current.screenshot({
      path:
        (stage.startsWith('scheduled') || stage.startsWith('due schedule')
          ? scheduleEvidence
          : process.argv.includes('--step-linked')
            ? stepEvidence
            : evidence) + 'failure.png',
    });
  process.exitCode = 1;
} finally {
  await worker?.close();
  await browser.close();
  app?.server.closeAllConnections();
  await app?.close();
}
