import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { Page, APIResponse } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import AxeBuilder from '@axe-core/playwright';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { nextFixtureOtp } from './local-totp.js';
import type { FormsFixture } from './forms-fixtures.js';
type Row = Record<string, any>;
const runtime = await loadLocalConfig(),
  A = 'http://127.0.0.1:4100',
  W = 'http://127.0.0.1:4105',
  suffix = randomUUID().slice(0, 8),
  browser = await chromium.launch({ headless: true }),
  servers: FastifyInstance[] = [],
  scans: Row[] = [];
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixtures.users.find((u) => u.role === name)!;
let stage = 'startup',
  current: Page | undefined,
  admin: Awaited<ReturnType<typeof login>> | undefined,
  employee: Awaited<ReturnType<typeof login>> | undefined,
  original: Row | undefined,
  publisher: Awaited<ReturnType<typeof login>> | undefined,
  definition: Row | undefined,
  proposalId: string | undefined;
const restoreGrants: Row[] = [],
  restoreBindings: Row[] = [];
async function json(r: APIResponse, expected = 200) {
  const b = await r.json();
  if (r.status() !== expected)
    throw new Error(
      'HTTP_' + r.status() + '_' + (/^[A-Z0-9_]+$/.test(b.error ?? '') ? b.error : 'UNEXPECTED'),
    );
  return b as Row;
}
async function login(
  base: string,
  user: { id: string; username: string; password: string },
  mfa = false,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  current = page;
  await context.addInitScript(() => {
    (window as Window & { csp?: string[] }).csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as Window & { csp?: string[] }).csp?.push(e.violatedDirective),
    );
  });
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL(base + '/');
  return { context, page, me: await json(await context.request.get(base + '/api/v1/me')) };
}
type Session = Awaited<ReturnType<typeof login>>;
async function write(s: Session, base: string, path: string, data: Row, expected = 200) {
  return json(
    await s.context.request.fetch(base + path, {
      method: path.startsWith('/api/v1/manage/bindings/') ? 'PATCH' : 'POST',
      headers: { origin: base, 'x-csrf-token': s.me.csrfToken, 'idempotency-key': randomUUID() },
      data: { tenantId: ids.tenantA, reason: 'Nghiệm thu hồ sơ liên kết ' + suffix, ...data },
    }),
    expected,
  );
}
async function grant(
  accountId: string,
  appCode: string,
  active: boolean,
  validUntil: string | null = null,
) {
  const list = await json(
      await admin!.context.request.get(
        A + '/api/v1/manage/grants?' + new URLSearchParams({ tenantId: ids.tenantA, appCode }),
      ),
    ),
    old = list.items.find((g: Row) => g.accountId === accountId);
  return write(admin!, A, '/api/v1/manage/grants', {
    data: { accountId, appCode, active, validUntil },
    expectedRevision: old?.revision ?? 0,
  });
}
async function temporaryGrant(accountId: string, appCode: string) {
  const list = await json(
      await admin!.context.request.get(
        A + '/api/v1/manage/grants?' + new URLSearchParams({ tenantId: ids.tenantA, appCode }),
      ),
    ),
    old = list.items.find((g: Row) => g.accountId === accountId);
  restoreGrants.push({
    accountId,
    appCode,
    active: old?.active ?? false,
    validUntil: old?.validUntil ?? null,
  });
  if (!old?.active) await grant(accountId, appCode, true);
}
async function bind(accountId: string, appCode: string, roleCode: string) {
  const binding = await write(admin!, A, '/api/v1/manage/bindings', {
    data: {
      accountId,
      appCode,
      roleCode,
      orgUnitId: appCode === 'aio-foundation' ? null : ids.unitA,
    },
  });
  restoreBindings.push({ ...binding, appCode });
}
async function select(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}
async function scan(page: Page, name: string) {
  current = page;
  assert.ok([A, W].includes(new URL(page.url()).origin));
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
  await writeFile('.local/evidence/profile-workflows-axe.json', JSON.stringify(scans, null, 2));
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => (window as Window & { csp?: string[] }).csp), []);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: '.local/evidence/profile-workflows-' + name + '.png',
    fullPage: (await page.getByRole('dialog').count()) === 0,
  });
}
async function restoreConfiguration() {
  if (!admin || !original) return;
  const now = await json(
    await admin.context.request.get(A + '/api/v1/directory-config/people?tenantId=' + ids.tenantA),
  );
  const saved = await write(admin, A, '/api/v1/directory-config/people', {
    configuration: original.draft,
    expectedRevision: now.configuration.revision,
  });
  await write(admin, A, '/api/v1/directory-config/people/publish', {
    expectedRevision: saved.revision,
  });
}
try {
  for (const code of ['aio-foundation', 'aio-workflows']) {
    const client = runtime.clients.find((c) => c.code === code)!,
      app = await createApp({
        runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
        client,
        test: true,
        logger: false,
      });
    await app.listen({ host: '127.0.0.1', port: client.port });
    servers.push(app);
  }
  admin = await login(
    A,
    runtime.users.find((u) => u.id === ids.admin)!,
    true,
  );
  stage = 'synthetic HR permissions';
  await temporaryGrant(role('publisher').id, 'aio-foundation');
  await temporaryGrant(role('publisher').id, 'aio-workflows');
  await write(admin, A, '/api/v1/manage/roles', {
    data: {
      appCode: 'aio-foundation',
      code: 'profile-hr-' + suffix,
      name: 'HR liên kết giả lập ' + suffix,
      permissions: ['people:read', 'people:manage', 'directory:read'],
    },
  });
  await bind(role('publisher').id, 'aio-foundation', 'profile-hr-' + suffix);
  await bind(role('publisher').id, 'aio-workflows', 'requester');
  const designer = await login(W, role('designer'), true);
  publisher = await login(W, role('publisher'), true);
  const spec = workflowTemplate('blank');
  spec.name = 'Xét hồ sơ ' + suffix;
  spec.audienceUnits = [ids.unitA];
  spec.positions = {};
  spec.nodes = [
    { id: 'start', kind: 'start', label: 'Gửi hồ sơ', next: 'review' },
    {
      id: 'review',
      kind: 'approval',
      label: 'Xét cập nhật hồ sơ',
      assignee: role('reviewer').id,
      dueHours: 24,
      next: 'end',
      form: null,
    },
    { id: 'end', kind: 'end', label: 'Hoàn thành' },
  ];
  definition = await write(designer, W, '/api/v1/workflows/definitions', {
    code: 'profile-ui-' + suffix,
    orgUnitId: ids.unitA,
    spec,
  });
  const published = await write(
    publisher,
    W,
    '/api/v1/workflows/definitions/' + definition.id + '/publish',
    { expectedRevision: definition.revision },
  );
  definition = published.definition;
  stage = 'employee proposal';
  original = (
    await json(
      await admin.context.request.get(
        A + '/api/v1/directory-config/people?tenantId=' + ids.tenantA,
      ),
    )
  ).configuration;
  const configuration = structuredClone(original!.draft),
    fieldId = 'x_' + suffix,
    label = 'Địa điểm làm việc ' + suffix;
  configuration.schema.sections[0].fields.push({
    id: fieldId,
    type: 'shortText',
    label,
    required: false,
    maxLength: 100,
  });
  configuration.selfView.push(fieldId);
  configuration.selfEdit.push(fieldId);
  const draft = await write(admin, A, '/api/v1/directory-config/people', {
    configuration,
    expectedRevision: original!.revision,
  });
  await write(admin, A, '/api/v1/directory-config/people/publish', {
    expectedRevision: draft.revision,
  });
  employee = await login(
    A,
    runtime.users.find((u) => u.id === ids.learner)!,
  );
  await employee.page.goto(A + '/#profile');
  await employee.page.getByLabel(label, { exact: true }).fill('Cao Bằng ' + suffix);
  await employee.page
    .getByLabel('Lý do đề xuất cập nhật')
    .fill('Đề nghị chuyển địa điểm ' + suffix);
  await employee.page.getByRole('button', { name: 'Gửi HR duyệt', exact: true }).click();
  await expect(employee.page.getByRole('status')).toContainText('Đã gửi đề xuất');
  proposalId = (
    await json(
      await employee.context.request.get(A + '/api/v1/profile/proposals?tenantId=' + ids.tenantA),
    )
  ).items.find((p: Row) => p.reason === 'Đề nghị chuyển địa điểm ' + suffix).id;
  const hr = await login(A, role('publisher'), true),
    page = hr.page;
  stage = 'HR routes proposal using configured workflow';
  current = page;
  await page.goto(A + '/#people');
  await page.getByRole('tab', { name: 'Thông tin mở rộng', exact: true }).click();
  await page.getByRole('tab', { name: 'Duyệt đề xuất nhân viên', exact: true }).click();
  const card = page
      .locator('[data-slot=card]')
      .filter({ has: page.getByText('Đề nghị chuyển địa điểm ' + suffix, { exact: true }) }),
    button = card.getByRole('button', { name: 'Quy trình phê duyệt', exact: true });
  await button.click();
  let dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('combobox', { name: 'Quy trình xét duyệt hồ sơ', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  dialog = page.getByRole('dialog');
  await select(page, 'Quy trình xét duyệt hồ sơ', spec.name);
  await select(page, 'Đơn vị gửi duyệt', 'Đào tạo');
  await dialog.getByLabel(/^Nội dung đề nghị/).fill('Đối soát địa điểm công tác');
  await dialog.getByLabel(/^Ngày đề nghị/).fill('2026-11-11');
  await dialog
    .getByLabel('Lý do xử lý đề xuất', { exact: true })
    .fill('Gửi cấp có thẩm quyền xét duyệt');
  await scan(page, 'dispatch-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await scan(page, 'dispatch-mobile');
  await dialog.getByLabel('Lý do xử lý đề xuất', { exact: true }).scrollIntoViewIfNeeded();
  await scan(page, 'dispatch-mobile-controls');
  await dialog.getByRole('button', { name: 'Gửi quy trình xét duyệt', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Mở lượt phê duyệt', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await scan(page, 'pending');
  const state = await json(
      await hr.context.request.get(
        A + '/api/v1/profile-workflows/' + proposalId + '?tenantId=' + ids.tenantA,
      ),
    ),
    runId = state.run.id;
  assert.equal(state.canApply, false);
  await write(
    hr,
    A,
    '/api/v1/profile/proposals/' + proposalId + '/review',
    { decision: 'approved', expectedRevision: 1 },
    409,
  );
  await write(
    employee,
    A,
    '/api/v1/profile-workflows/' + proposalId + '/apply',
    { expectedRevision: 1 },
    403,
  );
  await write(
    hr,
    A,
    '/api/v1/profile-workflows/' + proposalId + '/apply',
    { expectedRevision: 1 },
    409,
  );
  const noCsrf = await hr.context.request.post(
    A + '/api/v1/profile-workflows/' + proposalId + '/apply',
    {
      headers: { 'idempotency-key': randomUUID() },
      data: { tenantId: ids.tenantA, reason: 'Thiếu CSRF', expectedRevision: 1 },
    },
  );
  assert.equal(noCsrf.status(), 403);
  stage = 'independent approval with source snapshot';
  const reviewer = await login(W, role('reviewer'));
  await reviewer.page.goto(W + '/#workflow-run/' + runId);
  await expect(reviewer.page.getByRole('region', { name: 'Đề xuất hồ sơ nhân sự' })).toContainText(
    'Cao Bằng ' + suffix,
  );
  await scan(reviewer.page, 'source-desktop');
  await reviewer.page.setViewportSize({ width: 390, height: 844 });
  await scan(reviewer.page, 'source-mobile');
  await reviewer.page.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await reviewer.page
    .getByRole('dialog')
    .getByLabel('Ý kiến / lý do')
    .fill('Đồng ý thay đổi đã đối soát');
  await reviewer.page
    .getByRole('dialog')
    .getByRole('button', { name: 'Xác nhận', exact: true })
    .click();
  await expect(reviewer.page.getByRole('dialog')).toHaveCount(0);
  const before = await json(
    await employee.context.request.get(A + '/api/v1/profile/me?tenantId=' + ids.tenantA),
  );
  assert.equal(before.answers[fieldId], undefined);
  stage = 'revocation then explicit HR application';
  await grant(role('publisher').id, 'aio-workflows', false);
  await json(
    await hr.context.request.get(
      A + '/api/v1/profile-workflows/' + proposalId + '?tenantId=' + ids.tenantA,
    ),
    403,
  );
  await grant(role('publisher').id, 'aio-workflows', true);
  current = page;
  await dialog.getByRole('button', { name: 'Kiểm tra trạng thái', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Xác nhận áp dụng hồ sơ', exact: true }),
  ).toBeVisible();
  await scan(page, 'apply-confirmation');
  await dialog
    .getByLabel('Lý do xử lý đề xuất', { exact: true })
    .fill('HR kiểm tra và áp dụng sau duyệt');
  await dialog.getByRole('button', { name: 'Xác nhận áp dụng hồ sơ', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText('Đã duyệt');
  await employee.page.reload();
  await expect(employee.page.getByLabel(label, { exact: true })).toHaveValue('Cao Bằng ' + suffix);
  await employee.page.setViewportSize({ width: 390, height: 844 });
  await scan(employee.page, 'applied-mobile');
  await writeFile(
    '.local/evidence/profile-workflows-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        proposalId,
        runId,
        scans,
        checks: [
          'real MFA HR dispatch',
          'immutable source snapshot visible to independent approver',
          'no automatic application',
          'legacy route, CSRF and role denial',
          'source grant revocation',
          'explicit HR apply and employee history',
        ],
        credentialsExposed: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS profile proposals → Workflows → explicit HR application via real SSO; ' +
      scans.length +
      ' axe scans.',
  );
} catch (e) {
  if (
    current &&
    [A, W].includes(new URL(current.url()).origin) &&
    !(await current.locator('input[type=password],#otp').count())
  )
    await current.screenshot({
      path: '.local/evidence/profile-workflows-failure.png',
      fullPage: true,
    });
  console.error(
    'Profile workflows failed at ' +
      stage +
      '; ' +
      (e instanceof Error
        ? (e.message.startsWith('HTTP_') ? e.message : e.name) +
          ' ' +
          (e.stack?.match(/profile-workflows-e2e\.ts:\d+:\d+/)?.[0] ?? '')
        : 'unknown') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  if (employee && proposalId)
    try {
      const proposals = await json(
          await employee.context.request.get(
            A + '/api/v1/profile/proposals?tenantId=' + ids.tenantA,
          ),
        ),
        p = proposals.items.find((p: Row) => p.id === proposalId);
      if (p?.status === 'pending')
        await write(employee, A, '/api/v1/profile/proposals/' + proposalId + '/review', {
          decision: 'withdrawn',
          expectedRevision: p.revision,
        });
    } catch {
      console.error('Synthetic proposal cleanup pending.');
      process.exitCode = 1;
    }
  try {
    await restoreConfiguration();
  } catch {
    console.error('Synthetic profile configuration restore pending.');
    process.exitCode = 1;
  }
  if (admin) {
    for (const binding of restoreBindings.reverse())
      try {
        await write(admin, A, '/api/v1/manage/bindings/' + binding.id, {
          data: { appCode: binding.appCode, active: false },
          expectedRevision: binding.revision,
        });
      } catch {
        console.error('Synthetic HR binding restoration pending.');
        process.exitCode = 1;
      }
    for (const g of restoreGrants.reverse())
      try {
        await grant(g.accountId, g.appCode, g.active, g.validUntil);
      } catch {
        console.error('Synthetic grant restoration pending.');
        process.exitCode = 1;
      }
  }
  if (publisher && definition)
    try {
      await write(publisher, W, '/api/v1/workflows/definitions/' + definition.id + '/status', {
        expectedRevision: definition.revision,
        status: 'paused',
      });
    } catch {
      console.error('Synthetic workflow pause pending.');
      process.exitCode = 1;
    }
  await browser.close();
  for (const app of servers) {
    app.server.closeAllConnections();
    await app.close();
  }
}
