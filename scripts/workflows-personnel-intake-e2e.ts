import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { createApp } from '../src/app.js';
import {
  applicationDatabaseUrl,
  assertLocalDatabase,
  loadLocalConfig,
  testDatabaseUrl,
} from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import type { FormsFixture } from './forms-fixtures.js';
import { localContainer } from './local-docker.js';
import { nextFixtureOtp } from './local-totp.js';
import { reserveTestRequests } from './e2e-request-budget.js';
import { reminderRuntime } from './work-center-runtime.js';

type Row = Record<string, any>;
const A = 'http://127.0.0.1:4100',
  W = 'http://127.0.0.1:4105';
const suffix = randomUUID().slice(0, 8);
const evidence = '.local/evidence/workflows-personnel-intake-';
const runtime = await loadLocalConfig();
const fixture = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixture.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixture.users.find((user) => user.role === name)!;
const operatorAccount = role('designer').id;
const tenant = '?tenantId=' + ids.tenantA;
const paths = '/api/v1/workflows';
const personnel = '/api/v1/manage/personnel';
const servers: FastifyInstance[] = [];
const browser = await chromium.launch({ headless: true });
const db = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, true), max: 1 });
const ownerUrl = new URL(runtime.databaseUrl);
ownerUrl.pathname = '/aio_foundation_test';
assertLocalDatabase(ownerUrl.href, true);
assert.equal(ownerUrl.username, 'aio_foundation');
const owner = new pg.Pool({ connectionString: ownerUrl.href, max: 1 });
const scans: { name: string; violations: string[]; incomplete: string[] }[] = [];
let admin: Awaited<ReturnType<typeof login>> | undefined;
const restoreGrants = new Map<string, { active: boolean; validUntil: string | null }>();
const restoreBindings: Row[] = [];
let workers: Awaited<ReturnType<typeof reminderRuntime>>[] = [];
let stage = 'preflight',
  current: Page | undefined;

async function read(response: APIResponse, status = 200) {
  const body = (await response.json().catch(() => ({}))) as Row;
  assert.equal(
    response.status(),
    status,
    /^[A-Z0-9_]+$/.test(body.error ?? '') ? body.error : 'HTTP',
  );
  return body;
}

async function login(
  base: string,
  user: { id: string; username: string; password: string },
  mfa = false,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 970 } });
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
  await page.waitForURL(base + '/');
  const me = await read(await context.request.get(base + '/api/v1/me'));
  return { context, page, base, me };
}
type Session = Awaited<ReturnType<typeof login>>;

async function write(
  session: Session,
  path: string,
  data: Row,
  status = 200,
  options: { method?: string; key?: string; csrf?: string } = {},
) {
  return read(
    await session.context.request.fetch(session.base + path, {
      method: options.method ?? 'POST',
      headers: {
        origin: session.base,
        'x-csrf-token': options.csrf ?? session.me.csrfToken,
        'idempotency-key': options.key ?? randomUUID(),
      },
      data: { tenantId: ids.tenantA, reason: 'Nghiệm thu tiếp nhận giả lập ' + suffix, ...data },
    }),
    status,
  );
}

async function currentGrant(appCode: string) {
  const { items } = await read(
    await admin!.context.request.get(A + '/api/v1/manage/grants' + tenant + '&appCode=' + appCode),
  );
  return items.find((item: Row) => item.accountId === operatorAccount);
}

async function setGrant(
  active: boolean,
  validUntil: string | null = null,
  appCode = 'aio-workflows',
) {
  const old = await currentGrant(appCode);
  if (Boolean(old?.active) === active && (old?.validUntil ?? null) === validUntil) return;
  await write(admin!, '/api/v1/manage/grants', {
    data: { accountId: operatorAccount, appCode, active, validUntil },
    expectedRevision: old?.revision ?? 0,
  });
}

async function choose(page: Page, label: string, value: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.press('Space');
  await page.getByRole('option', { name: value, exact: true }).press('Enter');
  await expect(trigger).toHaveText(value);
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

async function scan(page: Page, name: string) {
  assert.ok([A, W].includes(new URL(page.url()).origin));
  assert.equal(await page.locator('input[type=password],#otp').count(), 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.screenshot({ path: evidence + name + '.png', fullPage: true, animations: 'disabled' });
  const audit = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  scans.push({
    name,
    violations: audit.violations.map(({ id }) => id),
    incomplete: audit.incomplete.map(({ id }) => id),
  });
  await writeFile(evidence + 'axe.json', JSON.stringify(scans, null, 2));
  assert.deepEqual(
    audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
    [],
  );
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

try {
  await mkdir('.local/evidence', { recursive: true });
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  assert.equal(
    (await db.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
  for (const code of ['aio-foundation', 'aio-workflows']) {
    const client = runtime.clients.find((item) => item.code === code)!;
    const app = await createApp({
      runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
      client,
      test: true,
      logger: false,
    });
    await app.listen({ host: '127.0.0.1', port: client.port });
    servers.push(app);
  }
  stage = 'MFA and explicit synthetic operator rights';
  admin = await login(
    A,
    runtime.users.find(({ id }) => id === ids.admin)!,
    true,
  );
  for (const appCode of ['aio-foundation', 'aio-workflows']) {
    const prior = await currentGrant(appCode);
    restoreGrants.set(appCode, {
      active: prior?.active ?? false,
      validUntil: prior?.validUntil ?? null,
    });
    await setGrant(true, null, appCode);
  }
  const hrRole = 'intake-hr-' + suffix;
  await write(admin, '/api/v1/manage/roles', {
    data: {
      appCode: 'aio-foundation',
      code: hrRole,
      name: 'HR giả lập ' + suffix,
      permissions: ['people:read', 'people:manage', 'directory:read'],
    },
  });
  restoreBindings.push({
    ...(await write(admin, '/api/v1/manage/bindings', {
      data: {
        accountId: operatorAccount,
        appCode: 'aio-foundation',
        roleCode: hrRole,
        orgUnitId: null,
      },
    })),
    appCode: 'aio-foundation',
  });
  const bindings = await read(
    await admin.context.request.get(
      A + '/api/v1/manage/bindings' + tenant + '&appCode=aio-workflows',
    ),
  );
  if (
    !bindings.items.some(
      (item: Row) =>
        item.active &&
        item.accountId === operatorAccount &&
        item.roleCode === 'coordinator' &&
        item.orgUnitId === null,
    )
  )
    restoreBindings.push({
      ...(await write(admin, '/api/v1/manage/bindings', {
        data: {
          accountId: operatorAccount,
          appCode: 'aio-workflows',
          roleCode: 'coordinator',
          orgUnitId: null,
        },
      })),
      appCode: 'aio-workflows',
    });
  const hr = await login(A, role('designer'), true);
  const designer = await login(W, role('designer'), true);
  const publisher = await login(W, role('publisher'), true);
  const requester = await login(
    W,
    runtime.users.find(({ id }) => id === ids.learner)!,
  );
  const reviewer = await login(W, role('reviewer'));
  const administration = await login(W, role('analyst'));
  const unauthorized = await login(
    A,
    runtime.users.find(({ id }) => id === ids.learner)!,
  );
  await read(
    await unauthorized.context.request.get(A + personnel + '/workflow-drafts' + tenant),
    403,
  );

  stage = 'published version and HR intake rule UI';
  const spec = workflowTemplate('leave');
  spec.schemaVersion = 5;
  spec.input.schemaVersion = 2;
  spec.name = 'Tiếp nhận ' + suffix;
  spec.input.title = spec.name;
  spec.audienceUnits = [ids.unitA];
  spec.input.sections[0]!.fields = [
    { id: 'full_name', label: 'Họ tên đề nghị', type: 'shortText', required: true },
    { id: 'salary_note', label: 'Ghi chú lương riêng', type: 'shortText', required: false },
  ];
  spec.fieldReaders = { 'input.salary_note': ['owner'] };
  for (const node of spec.nodes)
    if (node.kind === 'approval') {
      node.assignee = role('reviewer').id;
      node.next = 'handover';
    }
  spec.nodes.push(
    {
      id: 'handover',
      kind: 'parallel',
      label: 'Bàn giao song song',
      branches: ['it_assets', 'admin_assets'],
      join: 'ready',
    },
    {
      id: 'it_assets',
      kind: 'task',
      label: 'IT bàn giao thiết bị',
      assignee: role('reviewer').id,
      dueHours: 24,
      next: 'ready',
      form: {
        schemaVersion: 1,
        title: 'Thiết bị IT',
        sections: [
          {
            id: 'asset',
            title: 'Bàn giao IT',
            fields: [
              { id: 'equipment', type: 'shortText', label: 'Mã thiết bị IT', required: true },
            ],
          },
        ],
      },
    },
    {
      id: 'admin_assets',
      kind: 'task',
      label: 'Hành chính bàn giao chỗ làm',
      assignee: role('analyst').id,
      dueHours: 24,
      next: 'ready',
      form: {
        schemaVersion: 1,
        title: 'Chỗ làm',
        sections: [
          {
            id: 'asset',
            title: 'Bàn giao Hành chính',
            fields: [
              { id: 'workspace', type: 'shortText', label: 'Mã vị trí làm việc', required: true },
            ],
          },
        ],
      },
    },
    { id: 'ready', kind: 'join', label: 'Đủ bàn giao', next: 'end' },
  );
  const draft = await write(designer, paths + '/definitions', {
    code: 'intake-' + suffix,
    orgUnitId: ids.unitA,
    spec,
  });
  const published = await write(publisher, paths + '/definitions/' + draft.id + '/publish', {
    expectedRevision: draft.revision,
  });
  const units = (
    await read(
      await publisher.context.request.get(W + paths + '/lookups' + tenant + '&unitsOnly=true'),
    )
  ).units;
  const unit = units.find(({ id }: Row) => id === ids.unitA);
  const ruleBody = {
    kind: 'hr-onboarding',
    definitionId: draft.id,
    versionId: published.version.id,
    unitId: ids.unitA,
    recipientAccountId: operatorAccount,
    mapping: { displayName: 'full_name' },
  };
  await write(requester, paths + '/intake-rules', ruleBody, 403);
  await write(
    publisher,
    paths + '/intake-rules',
    { ...ruleBody, recipientAccountId: ids.learner },
    403,
  );
  current = publisher.page;
  await current.goto(W + '/#workflows/automation');
  await current.getByRole('tab', { name: 'Chuyển đề nghị' }).press('Enter');
  await choose(current, 'Quy trình nguồn', spec.name + ' · v1');
  await choose(current, 'Đơn vị tiếp nhận', unit.name);
  await current.getByLabel('Tìm người tiếp nhận').fill(hr.me.displayName);
  await current.getByRole('button', { name: 'Tìm người', exact: true }).press('Enter');
  await choose(current, 'Người tiếp nhận', hr.me.displayName);
  await choose(current, 'Ghép họ tên', 'Họ tên đề nghị');
  await current.getByLabel('Lý do áp dụng', { exact: true }).fill('Đề nghị tiếp nhận giả lập');
  await scan(current, 'rule-desktop');
  await current.setViewportSize({ width: 390, height: 844 });
  await scan(current, 'rule-mobile');
  await current.getByRole('button', { name: 'Áp dụng quy tắc', exact: true }).press('Enter');
  await expect(
    current.getByText('Đã áp dụng quy tắc chuyển đề nghị.', { exact: true }),
  ).toBeVisible();
  const rule = (
    await read(await publisher.context.request.get(W + paths + '/intake-rules' + tenant))
  ).items.find((item: Row) => item.version_id === published.version.id);
  assert.deepEqual(rule.mapping, { displayName: 'full_name' });

  stage = 'parallel IT and administration handover before personnel intake';
  const title = 'Đề nghị nhân sự ' + suffix;
  const name = 'Nhân sự giả lập ' + suffix;
  const salary = 'Lương riêng giả lập ' + suffix;
  const start = (runTitle: string) =>
    write(requester, paths + '/runs', {
      definitionId: draft.id,
      versionId: published.version.id,
      unitId: ids.unitA,
      title: runTitle,
      answers: { full_name: name, salary_note: salary },
    });
  async function completeOnboarding(id: string, verifyBrowser = false) {
    await reserveTestRequests(reviewer.context, W, 100);
    const record = await read(
      await reviewer.context.request.get(W + paths + '/runs/' + id + tenant),
    );
    const task = record.tasks.find((item: Row) => item.status === 'pending');
    const args = { expectedRevision: task.revision, action: 'approve', answers: {} };
    const key = randomUUID();
    for (const _ of [0, 1]) {
      const approved = await write(reviewer, paths + '/tasks/' + task.id + '/action', args, 200, {
        key,
      });
      assert.equal(approved.status, 'running');
    }
    const detail = async (session: Awaited<ReturnType<typeof login>>) =>
      read(await session.context.request.get(W + paths + '/runs/' + id + tenant));
    const opened = await detail(requester);
    const it = opened.tasks.find((item: Row) => item.node_id === 'it_assets');
    const adminTask = opened.tasks.find((item: Row) => item.node_id === 'admin_assets');
    assert.deepEqual([it.status, adminTask.status], ['pending', 'pending']);
    for (const session of [reviewer, administration])
      assert(!JSON.stringify(await detail(session)).includes(salary));
    const finish = (
      session: Awaited<ReturnType<typeof login>>,
      task: Row,
      answers: Row,
      status = 200,
    ) =>
      write(
        session,
        paths + '/tasks/' + task.id + '/action',
        {
          expectedRevision: task.revision,
          action: 'complete',
          answers,
        },
        status,
      );
    if (verifyBrowser) {
      await finish(administration, adminTask, {}, 400);
      const finishInBrowser = async (
        session: Awaited<ReturnType<typeof login>>,
        task: Row,
        label: string,
        value: string,
        screen: string,
      ) => {
        current = session.page;
        await current.goto(W + '/#workflow-run/' + id + '/' + task.id);
        await expect(
          current.getByRole('heading', { name: opened.run.title, exact: true }),
        ).toBeVisible();
        await expect(current.getByText(salary, { exact: true })).toHaveCount(0);
        await expect(current.getByText('Ghi chú lương riêng', { exact: true })).toHaveCount(0);
        const field = current.getByRole('textbox', { name: label });
        await field.fill(value);
        await field.scrollIntoViewIfNeeded();
        await scan(current, screen);
        await current.screenshot({ path: evidence + screen + '.png' });
        const finishTask = current.getByRole('button', { name: 'Hoàn tất bước', exact: true });
        await expect(finishTask).toBeEnabled();
        await finishTask.press('Enter');
        const modal = current.getByRole('dialog');
        await modal.getByLabel('Ý kiến / lý do').fill('Xác nhận bàn giao tài sản giả lập');
        await modal.getByRole('button', { name: 'Xác nhận', exact: true }).press('Enter');
        await modal.waitFor({ state: 'hidden' });
      };
      await finishInBrowser(reviewer, it, 'Mã thiết bị IT', 'IT-' + suffix, 'it-assets-desktop');
      const partial = await detail(requester);
      assert.equal(partial.run.status, 'running');
      assert.equal(partial.tasks.find((item: Row) => item.id === adminTask.id).status, 'pending');
      assert.deepEqual(await jobs(), []);
      await administration.page.setViewportSize({ width: 390, height: 844 });
      await finishInBrowser(
        administration,
        adminTask,
        'Mã vị trí làm việc',
        'HC-' + suffix,
        'admin-assets-mobile',
      );
    } else {
      await Promise.all([
        finish(reviewer, it, { equipment: 'IT-' + suffix }),
        finish(administration, adminTask, { workspace: 'HC-' + suffix }),
      ]);
    }
    const completed = await detail(requester);
    assert.equal(completed.run.status, 'completed');
    assert.equal(
      completed.history.filter((item: Row) => item.action === 'run.parallel_joined').length,
      1,
    );
  }
  const run = await start(title);
  const jobs = async (id = rule.id) =>
    (
      await read(
        await publisher.context.request.get(W + paths + '/intake-rules/' + id + '/jobs' + tenant),
      )
    ).items as Row[];
  const inbox = async () =>
    (await read(await hr.context.request.get(A + personnel + '/workflow-drafts' + tenant)))
      .items as Row[];
  assert.deepEqual(await jobs(), []);
  await completeOnboarding(run.id, true);
  stage = 'completion, revocation and exactly-once worker retry';
  const [queued] = await jobs();
  assert.equal(queued!.status, 'queued');
  await setGrant(false);
  const worker = await reminderRuntime(runtime, true);
  workers.push(worker);
  await worker.tick();
  const [blocked] = await jobs();
  assert.equal(blocked!.error_code, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
  assert(!(await inbox()).some((item) => item.runId === run.id));
  await write(publisher, paths + '/intake-jobs/' + queued!.id + '/retry', { expectedRevision: 1 });
  await setGrant(true);
  const concurrent = await reminderRuntime(runtime, true);
  workers.push(concurrent);
  await Promise.all(workers.map((entry) => entry.tick()));
  const [finished] = await jobs();
  assert.equal(finished!.status, 'done');
  assert.deepEqual(
    finished!.history.map(({ status }: Row) => status),
    ['done', 'blocked'],
  );
  const received = (await inbox()).filter((item) => item.runId === run.id);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.id, queued!.id);
  assert.equal(received[0]!.displayName, name);
  assert.equal(received[0]!.employeeCode, undefined);
  assert(!JSON.stringify(received).includes(salary));

  stage = 'foundation review, live source permission and unit scope';
  const code = 'INT' + suffix;
  const positions = (
    await read(await hr.context.request.get(A + '/api/v1/manage/positions' + tenant))
  ).items as Row[];
  const position = positions.find((item) => item.active && item.orgUnitId === ids.unitA);
  const outside = positions.find((item) => item.active && item.orgUnitId !== ids.unitA);
  assert(position && outside);
  const entities = (
    await read(await hr.context.request.get(A + '/api/v1/manage/legal-entities' + tenant))
  ).items;
  const entity = entities.find((item: Row) => item.id === position.legalEntityId);
  const input = {
    kind: 'onboard',
    workflowIntakeId: queued!.id,
    displayName: name,
    employeeCode: code,
    positionId: position.id,
    legalEntityId: position.legalEntityId,
    effectiveAt: new Date().toISOString(),
    revokeBindingIds: [],
  };
  const countBefore = await db.query(
    'SELECT 1 FROM employments WHERE tenant_id=$1 AND employee_code=$2',
    [ids.tenantA, code],
  );
  assert.equal(countBefore.rowCount, 0);
  const { error: wrongUnit } = await write(
    hr,
    personnel + '/preview',
    {
      input: { ...input, positionId: outside.id, legalEntityId: outside.legalEntityId },
    },
    403,
  );
  assert.equal(wrongUnit, 'PERSONNEL_WORKFLOW_INTAKE_UNIT_DENIED');
  const preview = await write(hr, personnel + '/preview', { input });
  await setGrant(false);
  assert(!(await inbox()).some((item) => item.id === queued!.id));
  await write(hr, personnel + '/commit', { input, snapshot: preview.snapshot }, 403);
  await setGrant(true);
  await write(hr, personnel + '/preview', { input }, 403, { csrf: 'invalid' });

  current = hr.page;
  await current
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Nhân sự & tài khoản', exact: true })
    .press('Enter');
  await current
    .getByRole('tab', { name: 'Tiếp nhận / Điều chuyển / Nghỉ việc', exact: true })
    .press('Enter');
  await current.setViewportSize({ width: 390, height: 844 });
  await current.getByRole('button', { name: 'Tải đề nghị tiếp nhận' }).press('Enter');
  await current.getByRole('button', { name: 'Mở đề nghị ' + title, exact: true }).press('Enter');
  await expect(current.getByLabel('Họ và tên nhân sự mới')).toBeFocused();
  await expect(current.getByLabel('Họ và tên nhân sự mới')).toHaveValue(name);
  await expect(current.getByLabel('Mã nhân sự')).toHaveValue('');
  await current.getByLabel('Mã nhân sự').fill(code);
  await choose(current, 'Pháp nhân tiếp nhận', entity.name);
  await choose(current, 'Vị trí nhận công tác', position.name);
  await scan(current, 'draft-mobile');
  await current.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).press('Enter');
  await expect(current.getByRole('heading', { name: 'Xác nhận thay đổi · ' + name })).toBeVisible();
  await current.setViewportSize({ width: 1440, height: 970 });
  await scan(current, 'confirmation-desktop');
  stage = 'atomic personnel operation and replay';
  await current.getByLabel('Lý do thực hiện').fill('Xác nhận tiếp nhận giả lập ' + suffix);
  const marker = (
    await owner.query('SELECT current_database() AS database,purpose FROM environment_marker')
  ).rows[0];
  assert.deepEqual(marker, { database: 'aio_foundation_test', purpose: 'tlqm-aio-test' });
  assert.match(queued!.id, /^[a-f0-9-]{36}$/);
  const trigger = 'personnel_intake_test_' + suffix;
  await owner.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.target_id='${queued!.id}' AND NEW.action='personnel.workflow_intake_applied'
      THEN RAISE EXCEPTION 'Synthetic intake audit failure'; END IF; RETURN NEW; END; $$`);
  const confirm = current.getByRole('button', { name: 'Xác nhận thực hiện', exact: true });
  try {
    await owner.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    const failed = current.waitForResponse(
      (response) => response.url() === A + personnel + '/commit',
    );
    await confirm.press('Enter');
    assert.equal((await failed).status(), 500);
    await expect(confirm).toBeEnabled();
    assert.equal(
      (
        await db.query('SELECT 1 FROM employments WHERE tenant_id=$1 AND employee_code=$2', [
          ids.tenantA,
          code,
        ])
      ).rowCount,
      0,
    );
    assert((await inbox()).some((item) => item.id === queued!.id));
    assert.equal(
      (
        await db.query('SELECT 1 FROM persons WHERE home_tenant_id=$1 AND display_name=$2', [
          ids.tenantA,
          name,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`);
    await owner.query(`DROP FUNCTION ${trigger}()`);
  }
  const request = current.waitForRequest(
    (req) => req.url() === A + personnel + '/commit' && req.method() === 'POST',
  );
  await confirm.press('Enter');
  const sent = await request;
  await expect(current.getByText('Đã hoàn tất thao tác', { exact: false })).toBeVisible();
  const replay = await write(hr, personnel + '/commit', sent.postDataJSON() as Row, 200, {
    key: sent.headers()['idempotency-key']!,
  });
  await write(hr, personnel + '/commit', sent.postDataJSON() as Row, 409);
  assert(!(await inbox()).some((item) => item.id === queued!.id));
  const rows = (
    await db.query(
      `SELECT e.id,e.person_id,d.employment_id,d.source_run_id,
      (SELECT count(*)::integer FROM accounts a WHERE a.person_id=e.person_id) AS accounts
     FROM employments e JOIN personnel_workflow_intakes d ON (d.tenant_id,d.employment_id)=(e.tenant_id,e.id)
     JOIN assignments a ON (a.tenant_id,a.employment_id)=(e.tenant_id,e.id)
     WHERE e.tenant_id=$1 AND e.employee_code=$2 AND a.position_id=$3`,
      [ids.tenantA, code, position.id],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, replay.records[1].id);
  assert.equal(rows[0].source_run_id, run.id);
  assert.equal(rows[0].accounts, 0);
  const audit = (
    await db.query(
      'SELECT action,count(*)::integer AS total FROM audit_events WHERE tenant_id=$1 AND target_id=$2 GROUP BY action ORDER BY action',
      [ids.tenantA, queued!.id],
    )
  ).rows;
  assert.deepEqual(audit, [
    { action: 'personnel.workflow_intake_applied', total: 1 },
    { action: 'personnel.workflow_intake_received', total: 1 },
  ]);

  stage = 'protected mapped field and immutable history';
  await write(publisher, paths + '/intake-rules/' + rule.id + '/disable', {
    expectedRevision: rule.revision,
  });
  const protectedRule = await write(publisher, paths + '/intake-rules', {
    ...ruleBody,
    mapping: { displayName: 'salary_note' },
  });
  const restricted = await start('Đề nghị có trường riêng ' + suffix);
  await completeOnboarding(restricted.id);
  await worker.tick();
  const [denied] = await jobs(protectedRule.id);
  assert.equal(denied!.error_code, 'WORKFLOW_INTAKE_FIELD_DENIED');
  assert(!(await inbox()).some((item) => item.runId === restricted.id));
  assert.equal(
    (
      await db.query('SELECT 1 FROM personnel_workflow_intakes WHERE source_run_id=$1', [
        restricted.id,
      ])
    ).rowCount,
    0,
  );
  await write(publisher, paths + '/intake-rules/' + protectedRule.id + '/disable', {
    expectedRevision: protectedRule.revision,
  });
  assert.equal((await jobs())[0]?.status, 'done');
  await writeFile(
    evidence + 'e2e.json',
    JSON.stringify(
      {
        finishedAtVietnam: new Date(Date.now() + 7 * 3600000).toISOString().replace('Z', '+07:00'),
        scans,
        checks: [
          'SSO/MFA',
          'keyboard rule configuration',
          'one destination draft across concurrent workers',
          'source grant revocation before and after delivery',
          'scoped retry',
          'restricted field mapping blocked',
          'same unit only',
          'Foundation preview and confirmation',
          'separate IT and administration handovers, required fields, one join and no salary disclosure',
          'atomic onboarding and audit',
          'audit failure rolls back employment, assignment and draft consumption',
          'no account creation',
          'idempotent replay',
          'disable preserves history',
        ],
      },
      null,
      2,
    ),
  );
  console.log('Workflow personnel intake E2E passed with ' + scans.length + ' axe scans.');
} catch (error) {
  console.error('Workflow personnel intake failed at ' + stage + '.');
  console.error(error instanceof Error ? error.message : String(error));
  if (
    current &&
    !current.isClosed() &&
    [A, W].includes(new URL(current.url()).origin) &&
    (await current.locator('input[type=password],#otp').count()) === 0
  )
    await current.screenshot({ path: evidence + 'failure.png' });
  process.exitCode = 1;
} finally {
  try {
    if (admin) {
      for (const binding of restoreBindings.reverse())
        await write(
          admin,
          '/api/v1/manage/bindings/' + binding.id,
          {
            data: { appCode: binding.appCode, active: false },
            expectedRevision: binding.revision,
          },
          200,
          { method: 'PATCH' },
        );
      for (const [appCode, grant] of restoreGrants)
        await setGrant(grant.active, grant.validUntil, appCode);
    }
  } catch {
    console.error('Synthetic IAM fixture restoration failed.');
    process.exitCode = 1;
  }
  await Promise.all(workers.map((worker) => worker.close()));
  await browser.close();
  for (const server of servers.reverse()) {
    server.server.closeAllConnections();
    await server.close();
  }
  await Promise.all([db.end(), owner.end()]);
}
