import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { defaultLearningPolicy } from '../src/lms/learning-policy.js';
import { recordedLmsVideo } from './lms-video-fixture.js';
import { chromium, expect } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ids } from '../src/fixtures.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { nextFixtureOtp } from './local-totp.js';
import { reserveTestRequests } from './e2e-request-budget.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { reminderRuntime } from './work-center-runtime.js';
import { signTrainingIntake } from '../src/lms-intake-proof.js';
import type { TrainingIntakeEnvelope } from '../src/lms-intake-proof.js';

const runtime = await loadLocalConfig(),
  base = 'http://127.0.0.1:4104';
const workflowBase = 'http://127.0.0.1:4105',
  foundationBase = 'http://127.0.0.1:4100';
const viaWorkflow = process.argv.includes('--workflow-intake');
const evidence =
  '.local/evidence/' + (viaWorkflow ? 'workflows-training-intake-' : 'lms-training-');
const tenant = '?tenantId=' + ids.tenantA;
const fixtures = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
  instanceId: string;
  users: FormsFixture[];
};
assert.equal(fixtures.instanceId, runtime.instanceId);
const role = (name: FormsFixture['role']) => fixtures.users.find((user) => user.role === name)!;
const browser = await chromium.launch({ headless: true });
let foundation: Awaited<ReturnType<typeof createApp>> | undefined,
  worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
let workflows: Awaited<ReturnType<typeof createApp>> | undefined;
const automation: Awaited<ReturnType<typeof reminderRuntime>>[] = [];
let iam: Awaited<ReturnType<typeof login>> | undefined;
const restoreGrants = new Map<string, { active: boolean; validUntil: string | null }>();
let stage = 'startup';
let current: Page | undefined;
const scans: { screen: string; violations: string[]; incomplete: string[] }[] = [];
const checks: string[] = [];
async function login(
  user: { id: string; username: string; password: string },
  mfa = false,
  origin = base,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  await context.addInitScript(() => {
    (window as Window & { qaCsp?: string[] }).qaCsp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as Window & { qaCsp?: string[] }).qaCsp?.push(e.violatedDirective),
    );
  });
  current = page;
  await page.goto(origin + '/auth/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  if (mfa) {
    await page.locator('#otp').fill(await nextFixtureOtp(user.id));
    await page.locator('#kc-login').click();
  }
  await page.waitForURL(origin + '/');
  if (origin === base)
    await expect(
      page.getByRole('heading', { name: 'Khóa học dành cho bạn', exact: true }),
    ).toBeVisible();
  const response = await context.request.get(origin + '/api/v1/me');
  assert.equal(response.status(), 200);
  return {
    context,
    page,
    origin,
    me: (await response.json()) as { csrfToken: string; displayName: string },
  };
}
async function send(
  user: { context: BrowserContext; me: { csrfToken: string } },
  action: string,
  data: unknown,
  expected = 200,
  key = randomUUID(),
) {
  const response = await user.context.request.post(base + '/api/lms/commands', {
    headers: { origin: base, 'x-csrf-token': user.me.csrfToken, 'idempotency-key': key },
    data: { action, data, reason: 'Nghiệm thu LMS chức năng giả lập' },
  });
  if (response.status() !== expected) {
    const body = await response.json().catch(() => ({}));
    console.error(
      'Course HTTP ' +
        response.status() +
        '/' +
        expected +
        (typeof body.error === 'string' && /^[A-Z0-9_]+$/.test(body.error) ? ' ' + body.error : ''),
    );
  }
  assert.equal(response.status(), expected);
  return await response.json();
}
async function scan(page: Page, screen: string) {
  current = page;
  assert([base, workflowBase].includes(new URL(page.url()).origin));
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
    screen,
    violations: result.violations.map((v) => v.id),
    incomplete: result.incomplete.map((v) => v.id),
  });
  if (result.violations.length)
    console.error(
      JSON.stringify(
        result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
      ),
    );
  assert.equal(result.violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => (window as Window & { qaCsp?: string[] }).qaCsp), []);
  await page.evaluate(() => scrollTo(0, 0));
  const dialog = page.getByRole('dialog');
  const hasDialog = (await dialog.count()) === 1;
  if (hasDialog) assert(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({
    path: evidence + screen + '.png',
    fullPage: !hasDialog,
  });
}
async function choose(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}
async function trainingSend(
  user: Awaited<ReturnType<typeof login>>,
  action: string,
  data: unknown,
  expected = 200,
  key: string = randomUUID(),
  reason = 'Nghiệm thu lộ trình và đợt đào tạo',
) {
  const response = await user.context.request.post(base + '/api/lms/training-commands', {
    headers: { origin: base, 'x-csrf-token': user.me.csrfToken, 'idempotency-key': key },
    data: { action, data, reason },
  });
  if (response.status() !== expected) {
    const body = await response.json().catch(() => ({}));
    console.error(
      'Training HTTP ' +
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

type Session = Awaited<ReturnType<typeof login>>;
type Row = Record<string, any>;
async function reserveFoundation(context: BrowserContext, minimum?: number) {
  if (viaWorkflow) await reserveTestRequests(context, foundationBase, minimum);
}
async function readJson(
  response: Awaited<ReturnType<BrowserContext['request']['get']>>,
  status = 200,
) {
  const body = (await response.json().catch(() => ({}))) as Row;
  assert.equal(
    response.status(),
    status,
    /^[A-Z0-9_]+$/.test(body.error ?? '') ? body.error : 'HTTP',
  );
  return body;
}
async function writeCommand(session: Session, path: string, data: Row, key = randomUUID()) {
  return readJson(
    await session.context.request.post(session.origin + path, {
      headers: {
        origin: session.origin,
        'x-csrf-token': session.me.csrfToken,
        'idempotency-key': key,
      },
      data: { tenantId: ids.tenantA, reason: 'Nghiệm thu đề nghị đào tạo giả lập', ...data },
    }),
  );
}
async function setGrant(appCode: string, active: boolean, validUntil: string | null = null) {
  await reserveFoundation(iam!.context);
  const path = '/api/v1/manage/grants';
  const { items } = await readJson(
    await iam!.context.request.get(foundationBase + path + tenant + '&appCode=' + appCode),
  );
  const row = items.find((entry: Row) => entry.accountId === role('publisher').id);
  assert(row);
  if (!restoreGrants.has(appCode))
    restoreGrants.set(appCode, { active: row.active, validUntil: row.validUntil ?? null });
  if (row.active !== active || (row.validUntil ?? null) !== validUntil)
    await writeCommand(iam!, path, {
      data: { appCode, accountId: row.accountId, active, validUntil },
      expectedRevision: row.revision,
    });
}

async function prepareTrainingIntake(suffix: string, batchTitle: string) {
  stage = 'Workflow training source version and rule';
  workflows = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((c) => c.code === 'aio-workflows')!,
    test: true,
    logger: false,
  });
  await workflows.listen({ host: '127.0.0.1', port: 4105 });
  const designer = await login(role('designer'), true, workflowBase);
  const publisher = await login(role('publisher'), true, workflowBase);
  const requester = await login(
    runtime.users.find((user) => user.id === ids.learner)!,
    false,
    workflowBase,
  );
  const reviewer = await login(role('reviewer'), false, workflowBase);
  iam = await login(
    runtime.users.find((user) => user.id === ids.admin)!,
    true,
    foundationBase,
  );
  const paths = '/api/v1/workflows';
  const spec = workflowTemplate('leave');
  spec.schemaVersion = 5;
  spec.input.schemaVersion = 2;
  spec.name = 'Đề nghị đào tạo ' + suffix;
  spec.input.title = spec.name;
  spec.audienceUnits = [ids.unitA];
  spec.input.sections[0]!.fields = [
    { id: 'training_title', label: 'Tên đợt đề xuất', type: 'shortText', required: true },
    { id: 'training_summary', label: 'Nội dung đào tạo', type: 'longText', required: true },
    { id: 'budget', label: 'Ngân sách đề nghị', type: 'money', currency: 'VND', required: true },
    { id: 'private_notes', label: 'Thông tin hạn chế', type: 'shortText', required: false },
  ];
  spec.fieldReaders = { 'input.private_notes': ['owner'] };
  for (const node of spec.nodes) if (node.kind === 'approval') node.assignee = role('reviewer').id;
  const definition = await writeCommand(designer, paths + '/definitions', {
    code: 'training-intake-' + suffix,
    orgUnitId: ids.unitA,
    spec,
  });
  const published = await writeCommand(
    publisher,
    paths + '/definitions/' + definition.id + '/publish',
    { expectedRevision: definition.revision },
  );
  const units = (
    await readJson(
      await publisher.context.request.get(
        workflowBase + paths + '/lookups' + tenant + '&unitsOnly=true',
      ),
    )
  ).units;
  const unit = units.find(({ id }: Row) => id === ids.unitA);
  current = publisher.page;
  await current.goto(workflowBase + '/#workflows/automation');
  await current.getByRole('tab', { name: 'Chuyển đề nghị' }).press('Enter');
  await choose(current, 'Module đích', 'Đào tạo LMS');
  await choose(current, 'Quy trình nguồn', spec.name + ' · v1');
  await choose(current, 'Đơn vị tiếp nhận', unit.name);
  await current.getByLabel('Tìm người tiếp nhận').fill(publisher.me.displayName);
  await current.getByRole('button', { name: 'Tìm người', exact: true }).press('Enter');
  await choose(current, 'Người tiếp nhận', publisher.me.displayName);
  await choose(current, 'Ghép tên đợt đào tạo', 'Tên đợt đề xuất');
  await choose(current, 'Ghép nội dung đề nghị', 'Nội dung đào tạo');
  await current
    .getByLabel('Lý do áp dụng', { exact: true })
    .fill('Chuyển đề nghị đào tạo đã duyệt');
  await scan(current, 'rule-desktop');
  await current.setViewportSize({ width: 390, height: 844 });
  await scan(current, 'rule-mobile');
  await current.getByRole('button', { name: 'Áp dụng quy tắc', exact: true }).press('Enter');
  await expect(
    current.getByText('Đã áp dụng quy tắc chuyển đề nghị.', { exact: true }),
  ).toBeVisible();
  const rule = (
    await readJson(
      await publisher.context.request.get(workflowBase + paths + '/intake-rules' + tenant),
    )
  ).items.find(
    (item: Row) => item.version_id === published.version.id && item.kind === 'lms-training',
  );
  assert.deepEqual(rule.mapping, { title: 'training_title', summary: 'training_summary' });
  stage = 'Approved budget, scoped delivery retry and signed LMS receipt';
  const summary = 'Đào tạo hai khóa cho nhân viên trong đơn vị.';
  const hidden = 'Nội dung riêng ' + suffix;
  const run = await writeCommand(requester, paths + '/runs', {
    definitionId: definition.id,
    versionId: published.version.id,
    unitId: ids.unitA,
    title: 'Nhu cầu đào tạo ' + suffix,
    answers: {
      training_title: batchTitle,
      training_summary: summary,
      budget: '2500000.00',
      private_notes: hidden,
    },
  });
  const tasks = (
    await readJson(
      await reviewer.context.request.get(workflowBase + paths + '/runs/' + run.id + tenant),
    )
  ).tasks;
  const task = tasks.find((item: Row) => item.status === 'pending');
  const commandKey = randomUUID();
  const jobs = async () =>
    (
      await readJson(
        await publisher.context.request.get(
          workflowBase + paths + '/intake-rules/' + rule.id + '/jobs' + tenant,
        ),
      )
    ).items as Row[];
  assert.equal((await jobs()).length, 0);
  for (const _ of [0, 1]) {
    const result = await writeCommand(
      reviewer,
      paths + '/tasks/' + task.id + '/action',
      { expectedRevision: task.revision, action: 'approve', answers: {} },
      commandKey,
    );
    assert.equal(result.status, 'completed');
  }
  const status = () =>
    requester.context.request
      .get(workflowBase + paths + '/runs/' + run.id + '/training-intake' + tenant)
      .then((response) => readJson(response));
  assert.deepEqual(await status(), { state: 'queued' });
  await setGrant('aio-lms-sandbox', false);
  automation.push(await reminderRuntime(runtime, true));
  await automation[0]!.tick();
  const [blocked] = await jobs();
  assert.equal(blocked!.error_code, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
  assert.deepEqual(await status(), { state: 'blocked' });
  await setGrant('aio-lms-sandbox', true);
  await writeCommand(publisher, paths + '/intake-jobs/' + blocked!.id + '/retry', {
    expectedRevision: blocked!.attempts,
  });
  automation.push(await reminderRuntime(runtime, true));
  await Promise.all(automation.map((entry) => entry.tick()));
  const [job] = await jobs();
  assert.equal(job!.status, 'done');
  assert.deepEqual(
    job!.history.map(({ status }: Row) => status),
    ['done', 'blocked'],
  );
  assert.deepEqual(await status(), { state: 'draft' });
  const target = runtime.clients.find(({ code }) => code === 'aio-lms-sandbox')!;
  const envelope: TrainingIntakeEnvelope = {
    instanceId: runtime.instanceId,
    environment: 'test',
    reference: {
      id: job!.id,
      kind: 'lms-training',
      tenantId: ids.tenantA,
      unitId: ids.unitA,
      runId: run.id,
      versionId: published.version.id,
      round: run.round,
      accountId: rule.recipient_account_id,
      personId: rule.recipient_person_id,
    },
  };
  const send = (data: TrainingIntakeEnvelope, proof?: string, statusPath = '') =>
    publisher.context.request.post(base + '/api/integrations/workflow-intake' + statusPath, {
      data,
      headers: proof ? { 'x-aio-service-proof': proof } : {},
    });
  await readJson(await send(envelope), 403);
  const proof = await signTrainingIntake(target.clientSecret, target.clientId, 'receive', envelope);
  await readJson(await send(envelope, proof, '-status'), 403);
  await readJson(
    await send({ ...envelope, reference: { ...envelope.reference, unitId: ids.unitC } }, proof),
    403,
  );
  const wrongEnvironment = { ...envelope, environment: 'local' as const };
  await readJson(
    await send(
      wrongEnvironment,
      await signTrainingIntake(target.clientSecret, target.clientId, 'receive', wrongEnvironment),
    ),
    403,
  );
  assert.deepEqual(await readJson(await send(envelope, proof)), { id: job!.id });
  await readJson(
    await publisher.context.request.post(
      foundationBase + '/api/v1/integrations/aio-lms-sandbox/training-intake',
      { data: envelope },
    ),
    401,
  );
  const audit = await worker!.db
    .prepare(
      "SELECT count(*) AS total FROM aio_audit WHERE request_id=? AND action='training.workflow_intake_received'",
    )
    .bind(job!.id)
    .first<{ total: number }>();
  assert.equal(audit?.total, 1);
  checks.push(
    'approved Workflow triggers one native LMS draft after revoked recipient retry',
    'proof binds operation, environment and exact reference, with idempotent replay',
  );
  return { id: job!.id as string, runId: run.id as string, requester, status, summary, hidden };
}
try {
  foundation = await createApp({
    runtime: { ...runtime, databaseUrl: testDatabaseUrl(runtime) },
    client: runtime.clients.find((c) => c.code === 'aio-foundation')!,
    test: true,
    logger: false,
  });
  if (viaWorkflow)
    foundation.addHook('onResponse', async (_request, reply) => {
      if (reply.statusCode === 429)
        console.log('Foundation rate limit reached during synthetic training suite.');
    });
  await foundation.listen({ host: '127.0.0.1', port: 4100 });
  worker = await startLocalLms(true);
  await migrateLms(worker.db, worker.config);
  const suffix = randomUUID().slice(0, 6),
    pathTitle = 'Hội nhập ' + suffix,
    batchTitle = 'Đào tạo nhân viên ' + suffix;
  const intake = viaWorkflow ? await prepareTrainingIntake(suffix, batchTitle) : null;
  stage = 'Real SSO and source course fixtures';
  const admin = await login(role('publisher'), true),
    learner = await login(runtime.users.find((u) => u.id === ids.learner)!),
    reviewer = await login(role('reviewer'));
  await reserveFoundation(admin.context);
  const me = await (await learner.context.request.get(base + '/api/v1/me')).json(),
    refs = await (await admin.context.request.get(base + '/api/lms/lookups')).json(),
    unitName = refs.units.find((u: { id: string }) => u.id === ids.unitA).name;
  const footage = await recordedLmsVideo(admin.page),
    mediaId = randomUUID();
  const upload = await admin.context.request.post(base + '/api/lms/media', {
    headers: {
      origin: base,
      'content-type': 'video/webm',
      'x-csrf-token': admin.me.csrfToken,
      'idempotency-key': randomUUID(),
      'x-media-id': mediaId,
      'x-owner-unit-id': ids.unitA,
      'x-file-name': 'training-fixture.webm',
      'x-file-size': String(footage.length),
      'x-file-sha256': createHash('sha256').update(footage).digest('hex'),
    },
    data: footage,
  });
  assert.equal(upload.status(), 200);
  const versions: string[] = [],
    titles: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const title = 'Nội dung hội nhập ' + i + ' ' + suffix;
    titles.push(title);
    const spec: CourseSpec = {
      schemaVersion: 3,
      title,
      subtitle: 'Dữ liệu đào tạo giả lập',
      series: 'TLQM',
      duration: 2,
      video: { kind: 'file', id: mediaId },
      deadline: '',
      isMandatory: true,
      audienceUnits: [ids.unitA],
      checkpoints: [],
      questions: [
        { id: 'q', type: 'single', question: 'Quy tắc giả lập?', options: ['Đúng', 'Sai'] },
      ],
      answerKey: { q: { answer: 0, explanation: 'Phản hồi giả lập' } },
      attachments: [],
      policy: { ...defaultLearningPolicy, requireVideoCompletion: false, checkpointPolicy: 'none' },
    };
    const draft = await send(admin, 'save-course', {
      code: 'training-' + i + '-' + suffix,
      ownerUnitId: ids.unitA,
      expectedRevision: 0,
      spec,
    });
    versions.push(
      (
        await send(admin, 'publish-course', {
          courseId: draft.id,
          expectedRevision: draft.revision,
        })
      ).versionId,
    );
  }
  stage = 'Design and publish reusable path through UI';
  await reserveFoundation(admin.context, 180);
  await admin.page.getByRole('tab', { name: 'Quản lý đào tạo', exact: true }).click();
  await admin.page.getByRole('button', { name: 'Quản lý lộ trình', exact: true }).click();
  await admin.page.getByRole('button', { name: 'Tạo lộ trình', exact: true }).click();
  await admin.page.getByLabel('Tên lộ trình', { exact: true }).fill(pathTitle);
  await admin.page
    .getByLabel('Hướng dẫn lộ trình', { exact: true })
    .fill('Hoàn thành hai khóa trong đợt hội nhập.');
  await admin.page.getByRole('checkbox', { name: unitName, exact: true }).check();
  for (const title of titles)
    await choose(admin.page, 'Thêm khóa vào lộ trình', title + ' · phiên bản 1');
  const move = admin.page.getByRole('button', { name: 'Đưa lên khóa 2', exact: true });
  await move.focus();
  await admin.page.keyboard.press('Space');
  await scan(admin.page, 'path-desktop');
  await admin.page.setViewportSize({ width: 390, height: 844 });
  await scan(admin.page, 'path-mobile');
  await admin.page.setViewportSize({ width: 1440, height: 1000 });
  await admin.page.getByRole('button', { name: 'Lưu lộ trình', exact: true }).click();
  await expect(admin.page.getByText('Đã lưu bản nháp lộ trình.', { exact: true })).toBeVisible();
  await admin.page.getByRole('button', { name: 'Phát hành lộ trình', exact: true }).click();
  await expect(
    admin.page.getByText('Đã phát hành lộ trình phiên bản 1.', { exact: true }),
  ).toBeVisible();
  const pathsUrl = new URL('/api/lms/training-paths', base);
  let path: Row | undefined;
  const cursors = new Set<string>();
  for (;;) {
    await reserveFoundation(admin.context);
    const page = await readJson(await admin.context.request.get(pathsUrl.href));
    path = (page.items as Row[]).find((item) => item.title === pathTitle);
    if (path || !page.nextCursor) break;
    assert.equal(typeof page.nextCursor, 'string');
    assert.ok(!cursors.has(page.nextCursor));
    cursors.add(page.nextCursor);
    pathsUrl.searchParams.set('cursor', page.nextCursor);
  }
  assert.ok(path, 'Published fixture must appear in the authorized cursor listing.');
  assert.deepEqual(path.published.courseVersionIds, [versions[1], versions[0]]);
  await admin.page.getByRole('button', { name: 'Về danh sách lộ trình', exact: true }).click();
  const batchInput = {
    workflowIntakeId: intake?.id,
    pathVersionId: path.versionId,
    ownerUnitId: ids.unitA,
    title: batchTitle,
    startsAt: Date.now() - 1000,
    dueAt: Date.now() + 86400000,
    accountIds: [me.accountId],
  };
  if (intake) {
    stage = 'Native LMS draft scope, source revocation and atomic confirmation';
    await reserveFoundation(admin.context, 180);
    await admin.page.getByRole('button', { name: 'Danh sách đợt', exact: true }).click();
    const drafts = '/api/lms/training-intakes';
    const inbox = async () =>
      (await readJson(await admin.context.request.get(base + drafts))).items as Row[];
    await readJson(await learner.context.request.get(base + drafts), 403);
    await readJson(await reviewer.context.request.get(base + drafts), 403);
    assert.deepEqual(
      (await inbox()).filter(({ id }) => id === intake.id),
      [{ id: intake.id, unitId: ids.unitA, title: batchTitle, summary: intake.summary }],
    );
    assert(!JSON.stringify(await inbox()).includes(intake.hidden));
    assert.equal(
      (await trainingSend(admin, 'create-batch', { ...batchInput, ownerUnitId: ids.unitC }, 403))
        .error,
      'LMS_TRAINING_INTAKE_UNIT_DENIED',
    );
    await setGrant('aio-workflows', false);
    assert(!(await inbox()).some(({ id }) => id === intake.id));
    assert.equal(
      (await trainingSend(admin, 'create-batch', batchInput, 403)).error,
      'LMS_TRAINING_INTAKE_SOURCE_DENIED',
    );
    await setGrant('aio-workflows', true);
    await reserveFoundation(admin.context);

    assert.equal(worker.config.purpose, 'tlqm-aio-lms-test');
    assert.match(intake.id, /^[0-9a-f-]{36}$/);
    const trigger = 'training_intake_test_' + suffix;
    await worker.db
      .prepare(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON aio_audit
      WHEN NEW.action='training.batch_created' AND json_extract(NEW.details,'$.workflowIntakeId')='${intake.id}'
      BEGIN SELECT RAISE(ABORT,'Synthetic training intake audit failure'); END`,
      )
      .run();
    try {
      const failed = await trainingSend(admin, 'create-batch', batchInput, 503);
      assert.equal(failed.error, 'LMS_DEPENDENCY_UNAVAILABLE');
      const applied = await worker.db
        .prepare('SELECT batch_id FROM lms_training_intakes WHERE id=?')
        .bind(intake.id)
        .first<{ batch_id: string | null }>();
      assert.equal(applied?.batch_id, null);
      assert.equal(
        await worker.db
          .prepare('SELECT count(*) FROM lms_training_batches WHERE tenant_id=? AND title=?')
          .bind(ids.tenantA, batchTitle)
          .first<number>('count(*)'),
        0,
      );
    } finally {
      await worker.db.prepare(`DROP TRIGGER ${trigger}`).run();
    }
    await reserveFoundation(admin.context);
    const loadIntakes = admin.page.getByRole('button', { name: 'Tải đề nghị đào tạo' });
    await expect(loadIntakes).toBeEnabled();
    const intakeResponse = admin.page.waitForResponse(
      (response) => response.url() === base + drafts && response.request().method() === 'GET',
    );
    await loadIntakes.press('Enter');
    const fetched = await intakeResponse;
    assert.equal(fetched.status(), 200);
    assert((await fetched.json()).items.some((item: Row) => item.id === intake.id));
    const openIntake = admin.page.getByRole('button', {
      name: 'Mở đề nghị ' + batchTitle,
      exact: true,
    });
    await expect(openIntake).toBeEnabled();
    await openIntake.press('Enter');
  } else await admin.page.getByRole('button', { name: 'Tạo đợt đào tạo', exact: true }).click();
  let dialog = admin.page.getByRole('dialog');
  if (intake) {
    await expect(dialog.getByLabel('Tên đợt', { exact: true })).toHaveValue(batchTitle);
    await expect(dialog.getByText(intake.summary, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Đơn vị phụ trách đợt' })).toBeDisabled();
  } else await dialog.getByLabel('Tên đợt', { exact: true }).fill(batchTitle);
  await dialog.getByLabel('Ngày bắt đầu', { exact: true }).fill('2026-11-10');
  await dialog.getByLabel('Hạn hoàn thành', { exact: true }).fill('2026-12-10');
  await reserveFoundation(admin.context);
  const findPath = dialog.getByRole('textbox', { name: 'Tìm lộ trình phát hành', exact: true });
  await findPath.fill('Không có lộ trình ' + suffix);
  await expect(dialog.getByRole('status')).toHaveText('Không tìm thấy lộ trình phát hành.');
  await findPath.fill(pathTitle);
  await choose(admin.page, 'Lộ trình phát hành', pathTitle + ' · v1');
  await dialog
    .getByRole('checkbox', { name: me.displayName + ' · ' + unitName, exact: true })
    .check();
  await scan(admin.page, 'batch-dialog');
  if (intake) {
    await admin.page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByLabel('Tên đợt', { exact: true }).focus();
    for (const key of [...Array(12).fill('Tab'), ...Array(4).fill('Shift+Tab')]) {
      await admin.page.keyboard.press(key);
      assert(await dialog.evaluate((node) => node.contains(document.activeElement)));
    }
    await dialog.evaluate((node) => node.scrollTo(0, 0));
    await scan(admin.page, 'batch-dialog-mobile');
    const confirm = dialog.getByRole('button', { name: 'Giao đợt đào tạo', exact: true });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    await admin.page.screenshot({ path: evidence + 'batch-dialog-actions-mobile.png' });
    checks.push('keyboard stays within the intake dialog at 390px');
    await admin.page.setViewportSize({ width: 1440, height: 1000 });
  }
  if (intake) await reserveFoundation(admin.context);
  const commitRequest = intake
    ? admin.page.waitForRequest(
        (request) =>
          request.url() === base + '/api/lms/training-commands' &&
          request.method() === 'POST' &&
          request.postDataJSON()?.action === 'create-batch',
      )
    : null;
  const commitResponse = admin.page.waitForResponse(
    (response) =>
      response.url() === base + '/api/lms/training-commands' &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.action === 'create-batch',
  );
  await dialog.getByRole('button', { name: 'Giao đợt đào tạo', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const committed = await commitResponse;
  assert.equal(committed.status(), 200);
  const createdBatch = (await committed.json()) as { id: string };
  assert.match(createdBatch.id, /^[0-9a-f-]{36}$/);
  const batch = await readJson(
    await admin.context.request.get(
      base + '/api/lms/training-batch?id=' + createdBatch.id + '&manage=true',
    ),
  );
  assert.equal(batch.title, batchTitle);
  assert.equal(batch.summary.participants, 1);
  if (intake && commitRequest) {
    const sent = await commitRequest;
    const command = sent.postDataJSON();
    await reserveFoundation(admin.context);
    const replay = await trainingSend(
      admin,
      'create-batch',
      command.data,
      200,
      sent.headers()['idempotency-key']!,
      command.reason,
    );
    assert.equal(replay.id, batch.id);
    await reserveFoundation(admin.context);
    assert.equal(
      (await trainingSend(admin, 'create-batch', command.data, 409)).error,
      'LMS_TRAINING_INTAKE_APPLIED',
    );
    const rows = (
      await worker.db
        .prepare('SELECT batch_id FROM lms_training_intakes WHERE id=? AND tenant_id=?')
        .bind(intake.id, ids.tenantA)
        .all()
    ).results;
    assert.deepEqual(rows, [{ batch_id: batch.id }]);
    assert.deepEqual(await intake.status(), { state: 'active' });
    await intake.requester.page.setViewportSize({ width: 390, height: 844 });
    await intake.requester.page.goto(workflowBase + '/#workflow-run/' + intake.runId);
    await expect(
      intake.requester.page.getByText('Đào tạo LMS · Đã giao đợt đào tạo', { exact: true }),
    ).toBeVisible();
    await scan(intake.requester.page, 'source-status-mobile');
    checks.push(
      'source permission checked again on opening and confirming',
      'no private field or learner identity in source status',
      'audit failure rolls back LMS batch and leaves draft pending',
      'unit scope, exactly-once conversion and active state from LMS',
    );
  } else await admin.page.getByRole('button', { name: 'Danh sách đợt', exact: true }).click();
  await admin.page.getByLabel('Tìm đợt đào tạo', { exact: true }).fill(batchTitle);
  await admin.page.getByRole('button', { name: 'Xem tiến độ', exact: true }).click();
  const memberSearch = admin.page.getByLabel('Tìm học viên trong đợt', { exact: true });
  await memberSearch.fill('Không có học viên ' + suffix);
  await expect(
    admin.page.getByText('Không tìm thấy học viên phù hợp.', { exact: true }),
  ).toBeVisible();
  await expect(
    admin.page.getByText('0/1 người đã hoàn thành · 0 người quá hạn trong phạm vi được xem.', {
      exact: true,
    }),
  ).toBeVisible();
  await memberSearch.fill(me.displayName);
  await expect(
    admin.page.getByRole('heading', { name: me.displayName, exact: true }),
  ).toBeVisible();
  await scan(admin.page, 'batch-members');
  await admin.page.getByRole('button', { name: 'Về danh sách đợt', exact: true }).click();
  stage = 'Learner sees only own batch and opens the pinned course';
  await reserveFoundation(learner.context);
  await learner.page.getByRole('tab', { name: 'Đợt đào tạo của tôi', exact: true }).click();
  await learner.page.getByLabel('Tìm đợt đào tạo', { exact: true }).fill(batchTitle);
  await learner.page.getByRole('button', { name: 'Xem tiến độ', exact: true }).click();
  await scan(learner.page, 'learner-progress');
  await learner.page.setViewportSize({ width: 390, height: 844 });
  await scan(learner.page, 'learner-mobile');
  await learner.page.getByRole('button', { name: 'Mở khóa học', exact: true }).first().click();
  await expect(learner.page.getByText(titles[1]!, { exact: true }).first()).toBeVisible();
  await expect(
    learner.page.getByRole('button', { name: 'Làm bài kiểm tra', exact: true }),
  ).toBeEnabled();
  for (const versionId of versions)
    await send(learner, 'submit', { versionId, answers: { q: 0 }, tabSwitchCount: 0 });
  await learner.page.getByRole('tab', { name: 'Đợt đào tạo của tôi', exact: true }).click();
  await learner.page.getByLabel('Tìm đợt đào tạo', { exact: true }).fill(batchTitle);
  await learner.page.getByRole('button', { name: 'Xem tiến độ', exact: true }).click();
  await expect(
    learner.page.getByText('1/1 người đã hoàn thành · 0 người quá hạn trong phạm vi được xem.', {
      exact: true,
    }),
  ).toBeVisible();
  await scan(learner.page, 'completed-mobile');
  stage = 'Backend roles, ownership and source versions';
  await reserveFoundation(admin.context);
  await trainingSend(learner, 'save-path', { expectedRevision: 0, spec: path.spec }, 403);
  await trainingSend(
    reviewer,
    'create-batch',
    {
      pathVersionId: path.versionId,
      ownerUnitId: ids.unitA,
      title: 'Không được phép',
      startsAt: Date.now() - 1000,
      dueAt: Date.now() + 86400000,
      accountIds: [me.accountId],
    },
    403,
  );
  const other = await trainingSend(admin, 'create-batch', {
    pathVersionId: path.versionId,
    ownerUnitId: ids.unitA,
    title: 'Đợt riêng ' + suffix,
    startsAt: Date.now() - 1000,
    dueAt: Date.now() + 86400000,
    accountIds: [role('publisher').id],
  });
  assert.equal(
    (await learner.context.request.get(base + '/api/lms/training-batch?id=' + other.id)).status(),
    404,
  );
  const noCsrf = await admin.context.request.post(base + '/api/lms/training-commands', {
    data: {
      action: 'save-path',
      data: { expectedRevision: 0, spec: path.spec },
      reason: 'Không CSRF',
    },
  });
  assert.equal(noCsrf.status(), 403);
  const updated = await trainingSend(admin, 'save-path', {
    id: path.id,
    expectedRevision: path.revision,
    spec: { ...path.spec, title: pathTitle + ' bản mới' },
  });
  await trainingSend(admin, 'publish-path', { id: path.id, expectedRevision: updated.revision });
  const oldBatch = await (
    await learner.context.request.get(base + '/api/lms/training-batch?id=' + batch.id)
  ).json();
  assert.equal(oldBatch.pathVersion, 1);
  assert.equal(oldBatch.pathTitle, pathTitle);
  assert.equal(oldBatch.members[0].completed, true);
  stage = 'Admin cancels with history retained';
  await reserveFoundation(admin.context);
  await admin.page.getByLabel('Tìm đợt đào tạo', { exact: true }).fill(batchTitle);
  await admin.page.getByRole('button', { name: 'Hủy đợt', exact: true }).click();
  await admin.page
    .getByRole('dialog')
    .getByRole('button', { name: 'Xác nhận hủy đợt', exact: true })
    .click();
  await expect(admin.page.getByRole('dialog')).toHaveCount(0);
  await readJson(
    await learner.context.request.get(base + '/api/lms/training-batch?id=' + batch.id),
    404,
  );
  const retained = await (
    await admin.context.request.get(
      base + '/api/lms/training-batch?id=' + batch.id + '&manage=true',
    )
  ).json();
  assert.equal(retained.members[0].completed, true);
  if (intake) {
    assert.deepEqual(await intake.status(), { state: 'cancelled' });
    await intake.requester.page
      .getByRole('button', { name: 'Tải trạng thái LMS', exact: true })
      .press('Enter');
    await expect(
      intake.requester.page.getByText('Đào tạo LMS · Đợt đào tạo đã hủy', { exact: true }),
    ).toBeVisible();
    checks.push(
      'cancelled status is pulled from LMS while retained learner results stay under LMS scope',
    );
  }
  await writeFile(
    evidence + 'e2e.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checkedAtVietnam: new Date(Date.now() + 7 * 3600000).toISOString().replace('Z', '+07:00'),
        result: 'pass',
        scans,
        pathId: path.id,
        batchId: batch.id,
        checks: [
          'MFA admin designs ordered reusable path',
          'snapshot batch enrollment with dates',
          'learner opens pinned course and completes batch',
          'roles, ownership, CSRF and immutable version pinning',
          'cancel removes active work without erasing learning results',
          ...checks,
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS LMS learning paths and training batches via real SSO; ' + scans.length + ' axe scans.',
  );
} catch (error) {
  console.error(
    'LMS training failed at ' +
      stage +
      ' (' +
      (error instanceof Error ? error.name : 'unknown') +
      '). Sensitive details omitted.',
  );
  if (
    error instanceof assert.AssertionError &&
    typeof error.actual === 'number' &&
    typeof error.expected === 'number'
  )
    console.error('Numeric assertion ' + error.actual + '/' + error.expected);
  if (
    error instanceof assert.AssertionError &&
    /^[A-Z0-9_]+$/.test(error.message.split('\n')[0] ?? '')
  )
    console.error('Response error ' + error.message.split('\n')[0]);
  if (error instanceof Error)
    console.error(
      error.stack?.match(/lms-training-e2e\.ts:\d+:\d+/)?.[0] ?? 'Script location unavailable',
    );
  if (
    current &&
    !current.isClosed() &&
    [base, workflowBase].includes(new URL(current.url()).origin) &&
    new URL(current.url()).pathname === '/' &&
    !(await current.locator('input[type=password],#otp').count())
  )
    await current.screenshot({ path: evidence + 'failure.png', fullPage: true });
  process.exitCode = 1;
} finally {
  try {
    for (const [appCode, prior] of restoreGrants)
      await setGrant(appCode, prior.active, prior.validUntil);
  } catch (error) {
    const firstLine = error instanceof Error ? error.message.split('\n')[0] : '';
    console.error(
      'Synthetic intake grants restoration failed.' +
        (/^[A-Z0-9_]+$/.test(firstLine ?? '') ? ' ' + firstLine : ''),
    );
    process.exitCode = 1;
  }
  await Promise.all(automation.map((entry) => entry.close()));
  await browser.close();
  await worker?.mf.dispose();
  workflows?.server.closeAllConnections();
  await workflows?.close();
  foundation?.server.closeAllConnections();
  await foundation?.close();
}
