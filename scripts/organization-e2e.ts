import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { APIResponse } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { FastifyInstance } from 'fastify';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { nextFixtureOtp } from './local-totp.js';
import type { Row } from '../frontend/src/lib/api.js';
const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4100',
  run = randomUUID().slice(0, 8);
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
  page = await context.newPage();
let server: FastifyInstance | undefined,
  stage = 'startup',
  csrf = '';
const scans: unknown[] = [],
  created: { resource: string; row: Row }[] = [];
async function collection(resource: string, appCode?: string) {
  const items: Row[] = [];
  let cursor: string | null = null;
  do {
    const response: APIResponse = await context.request.get(
      base +
        '/api/v1/manage/' +
        resource +
        '?' +
        new URLSearchParams({
          tenantId: ids.tenantA,
          ...(appCode ? { appCode } : {}),
          ...(cursor ? { cursor } : {}),
        }),
    );
    assert.equal(response.status(), 200);
    const body = await response.json();
    items.push(...body.items);
    cursor = body.nextCursor ?? null;
  } while (cursor);
  return items;
}
async function mutation(resource: string, data: Row, row?: Row) {
  const response = await context.request.fetch(
    base +
      '/api/v1/manage/' +
      resource +
      (row ? '/' + String(row.id ?? row.code ?? row.accountId) : ''),
    {
      method: row ? 'PATCH' : 'POST',
      headers: { origin: base, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
      data: {
        tenantId: ids.tenantA,
        reason: 'Organization acceptance ' + run,
        data,
        ...(row ? { expectedRevision: row.revision } : {}),
      },
    },
  );
  assert.equal(response.status(), 200, 'Mutation ' + resource);
  const value = await response.json();
  if (!row) created.push({ resource, row: value });
  return value as Row;
}
async function nav(name: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(page.getByRole('status', { name: 'Đang tải cơ cấu và nhân sự' })).toHaveCount(0);
}
async function save() {
  const dialog = page.getByRole('dialog');
  await dialog.locator('#change-reason').fill('Kiểm thử cơ cấu và phân quyền ' + run);
  await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await page.waitForFunction(
    () =>
      !!document.querySelector('[role=alertdialog]') || !document.querySelector('[role=dialog]'),
  );
  if (await page.getByRole('alertdialog').isVisible())
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Xác nhận lưu', exact: true })
      .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Đang tải cơ cấu và nhân sự' })).toHaveCount(0);
}
async function select(field: string, name: string) {
  await page
    .getByRole('dialog')
    .locator('#field-' + field)
    .click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function scan(name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  assert.equal(new URL(page.url()).origin, base);
  assert.equal(await page.locator('input[type=password],#otp,#totp').count(), 0);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    name,
    violations: result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    incomplete: result.incomplete.map((v) => v.id),
  });
  await writeFile(
    '.local/evidence/organization-accessibility.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), scans }, null, 2) + '\n',
  );
  assert.equal(result.violations.length, 0, 'Accessibility ' + name);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'Page overflow ' + name,
  );
  await page.screenshot({ path: '.local/evidence/organization-' + name + '.png', fullPage: true });
}
try {
  await mkdir('.local/evidence', { recursive: true });
  server = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((c) => c.code === 'aio-foundation')!,
    test: true,
    logger: false,
  });
  await server.listen({ host: '127.0.0.1', port: 4100 });
  const user = runtime.users.find((u) => u.id === ids.admin)!;
  await page.goto(base + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  await page.locator('#otp').fill(await nextFixtureOtp(user.id));
  await page.locator('#kc-login').click();
  await page.waitForURL(base + '/');
  await expect(page.locator('[data-code=AUTHENTICATED]')).toBeVisible();
  csrf = (await (await context.request.get(base + '/api/v1/me')).json()).csrfToken;
  stage = 'seed independent scoped organization fixtures via real MFA API';
  const entity = await mutation('legal-entities', {
    code: 'ORG-' + run,
    name: 'Công ty mẫu ' + run,
  });
  const root = await mutation('org-units', {
    legalEntityId: entity.id,
    code: 'HQ-' + run,
    name: 'Khối vận hành ' + run,
  });
  const title = await mutation('job-titles', {
    code: 'TITLE-' + run,
    name: 'Chuyên viên vận hành ' + run,
  });
  const person = await mutation('people', { displayName: 'Đặng Ánh Cơ Cấu ' + run });
  const account = await mutation('accounts', { personId: person.id, active: true });
  stage = 'tree context creates child and position';
  await nav('Cơ cấu tổ chức');
  await page.getByLabel('Tìm đơn vị', { exact: true }).fill('khoi van hanh ' + run);
  await page
    .getByRole('navigation', { name: 'Cây cơ cấu tổ chức' })
    .getByRole('button', { name: String(root.name), exact: true })
    .press('Enter');
  await page.getByRole('button', { name: 'Thêm đơn vị con', exact: true }).click();
  await expect(page.getByRole('dialog').locator('#field-legalEntityId')).toContainText(
    String(entity.name),
  );
  await expect(page.getByRole('dialog').locator('#field-parentId')).toContainText(
    String(root.name),
  );
  await page
    .getByRole('dialog')
    .locator('#field-code')
    .fill('TEAM-' + run);
  await page
    .getByRole('dialog')
    .locator('#field-name')
    .fill('Tổ điều phối ' + run);
  await save();
  const child = (await collection('org-units')).find((row) => row.code === 'TEAM-' + run)!;
  assert.equal(child.parentId, root.id);
  created.push({ resource: 'org-units', row: child });
  await page.getByLabel('Tìm đơn vị', { exact: true }).fill('to dieu phoi ' + run);
  await page
    .getByRole('navigation', { name: 'Cây cơ cấu tổ chức' })
    .getByRole('button', { name: String(child.name), exact: true })
    .click();
  await page.getByRole('button', { name: 'Thêm vị trí', exact: true }).click();
  await select('jobTitleId', String(title.name));
  await page
    .getByRole('dialog')
    .locator('#field-name')
    .fill('Điều phối viên ' + run);
  await save();
  const position = (await collection('positions')).find(
    (row) => row.name === 'Điều phối viên ' + run,
  )!;
  assert.equal(position.orgUnitId, child.id);
  created.push({ resource: 'positions', row: position });
  await page.getByLabel('Tìm đơn vị', { exact: true }).fill('');
  await scan('tree-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await scan('tree-mobile');
  stage = 'person dossier creates employment and main assignment without roles';
  await nav('Nhân sự & tài khoản');
  await page.getByLabel('Tìm nhân sự', { exact: true }).fill('dang anh co cau ' + run);
  await page
    .getByRole('button', { name: 'Xem hồ sơ ' + String(person.displayName), exact: true })
    .click();
  await scan('person-before-assignment');
  await page.getByRole('button', { name: 'Thêm quan hệ công tác', exact: true }).click();
  await expect(page.getByRole('dialog').locator('#field-personId')).toContainText(
    String(person.displayName),
  );
  await select('legalEntityId', String(entity.name));
  await page
    .getByRole('dialog')
    .locator('#field-employeeCode')
    .fill('EMP-' + run);
  await page.getByRole('dialog').locator('#field-validFrom').fill('2026-01-01T00:00');
  await save();
  const employment = (await collection('employments')).find((row) => row.personId === person.id)!;
  created.push({ resource: 'employments', row: employment });
  await page
    .getByRole('button', { name: 'Xem hồ sơ ' + String(person.displayName), exact: true })
    .click();
  await page.getByRole('button', { name: 'Bổ nhiệm / kiêm nhiệm', exact: true }).click();
  await select('positionId', String(position.name) + ' · ' + String(child.name));
  await page.getByRole('dialog').locator('#field-validFrom').fill('2026-01-02T00:00');
  await save();
  const assignment = (await collection('assignments')).find(
    (row) => row.employmentId === employment.id,
  )!;
  assert.equal(assignment.isPrimary, true);
  created.push({ resource: 'assignments', row: assignment });
  assert.equal(
    (await collection('bindings', 'aio-foundation')).filter((row) => row.accountId === account.id)
      .length,
    0,
  );
  await page
    .getByRole('button', { name: 'Xem hồ sơ ' + String(person.displayName), exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Ứng dụng trong hồ sơ', exact: true }).click();
  await page.getByRole('option', { name: 'AIO Foundation', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Quyền ứng dụng của nhân sự', exact: true }),
  ).toContainText('Chưa có quyền truy cập hiện hành');
  await scan('person-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await scan('person-mobile');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Xem hồ sơ ' + String(person.displayName), exact: true }),
  ).toBeFocused();
  stage = 'matrix creates explicit role and assignment';
  await nav('Vai trò & truy cập');
  await page.getByRole('button', { name: 'Thêm vai trò', exact: true }).click();
  await page
    .getByRole('dialog')
    .locator('#field-code')
    .fill('org-reader-' + run);
  await page
    .getByRole('dialog')
    .locator('#field-name')
    .fill('Đọc cơ cấu ' + run);
  await page
    .getByRole('dialog')
    .getByRole('checkbox', { name: 'Xem cơ cấu tổ chức', exact: true })
    .check();
  await save();
  const role = (await collection('roles', 'aio-foundation')).find(
    (row) => row.code === 'org-reader-' + run,
  )!;
  created.push({ resource: 'roles', row: role });
  await page.getByRole('button', { name: 'Gán vai trò', exact: true }).click();
  await select('accountId', String(person.displayName));
  await select('roleCode', String(role.name));
  await select('orgUnitId', String(child.name));
  await save();
  const binding = (await collection('bindings', 'aio-foundation')).find(
    (row) => row.accountId === account.id,
  )!;
  assert.equal(binding.orgUnitId, child.id);
  assert.equal(binding.roleCode, role.code);
  created.push({ resource: 'bindings', row: binding });
  await page.getByLabel('Tìm quyền trong ma trận', { exact: true }).fill('co cau');
  await page.getByLabel('Tìm phân công vai trò', { exact: true }).fill(String(person.displayName));
  await scan('matrix-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await scan('matrix-mobile');
  stage = 'workspace refresh reloads an already opened catalogue';
  await nav('Cơ cấu tổ chức');
  await page.getByRole('tab', { name: 'Chức danh', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Tìm kiếm trong danh sách', exact: true })
    .fill(String(title.code));
  await expect(page.getByRole('cell', { name: String(title.name), exact: true })).toBeVisible();
  Object.assign(
    title,
    await mutation('job-titles', { name: 'Chức danh đã cập nhật ' + run }, title),
  );
  await page.getByRole('button', { name: 'Tải lại không gian quản trị', exact: true }).click();
  await expect(page.getByRole('cell', { name: String(title.name), exact: true })).toBeVisible();
  stage = 'scope error clears the entire assembled view';
  await nav('Cơ cấu tổ chức');
  await page.getByRole('tab', { name: 'Sơ đồ tổ chức', exact: true }).click();
  await page.getByLabel('Tìm đơn vị', { exact: true }).fill('to dieu phoi ' + run);
  await expect(page.getByRole('navigation', { name: 'Cây cơ cấu tổ chức' })).toContainText(
    String(child.name),
  );
  await page.route('**/api/v1/manage/positions?**', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'PERMISSION_DENIED' }),
    }),
  );
  await page.getByRole('button', { name: 'Tải lại không gian quản trị', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Cây cơ cấu tổ chức' })).toBeHidden();
  await scan('read-denied');
  await page.unroute('**/api/v1/manage/positions?**');
  stage = 'archive only owned test fixtures through audited API';
  const ended = '2026-02-01T00:00:00.000Z';
  for (const item of created.filter((item) => item.resource === 'bindings'))
    await mutation('bindings', { appCode: 'aio-foundation', active: false }, item.row);
  for (const item of created.filter((item) => item.resource === 'roles'))
    await mutation('roles', { appCode: 'aio-foundation', active: false }, item.row);
  for (const item of created.filter((item) => item.resource === 'assignments'))
    await mutation('assignments', { validUntil: ended }, item.row);
  for (const item of created.filter((item) => item.resource === 'employments'))
    await mutation('employments', { validUntil: ended }, item.row);
  for (const resource of [
    'positions',
    'job-titles',
    'org-units',
    'legal-entities',
    'accounts',
    'people',
  ])
    for (const item of [...created].reverse().filter((item) => item.resource === resource))
      await mutation(resource, { active: false }, item.row);
  await writeFile(
    '.local/evidence/organization-e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        scans: scans.length,
        checks: [
          'MFA + real scoped APIs; child/position defaults',
          'Vietnamese unaccented tree/person search; desktop/mobile',
          'person → employment → main assignment; no automatic role',
          'explicit role permissions and unit scope through confirmation',
          'injected 403 on one relation clears assembled view',
          'owned fixtures archived through API; history retained',
        ],
        fixturesArchived: created.length,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: organization/person/role workspace, ' + scans.length + ' axe scans; fixtures archived.',
  );
} catch (error) {
  console.error(
    'Organization E2E failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      ') ' +
      (error instanceof Error
        ? (error.stack?.match(/organization-e2e\.ts:\d+:\d+/)?.[0] ?? '')
        : '') +
      '. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  if (server) {
    server.server.closeAllConnections();
    await server.close();
  }
}
