import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { demoUsers, ids } from '../src/fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { stagingModules } from '../src/staging-config.js';
import type { StagingConfig } from '../src/staging-config.js';
import { captureAudit } from './staging-audit.js';
import type { AuditEvidence } from './staging-audit.js';
import {
  verifyFormsUi,
  verifyMobileDialog,
  verifyPortalWorkflowUi,
  verifyPortalTaskUi,
  verifySavedTaskStageUi,
  verifyScopedFormsUi,
  verifyTaskUi,
} from './staging-access-ui.js';
import type { ReportSession } from './staging-report-fixtures.js';
import type { TaskWorkPage } from '../src/tasks/options.js';
import { defaultTaskStages } from '../src/tasks/options.js';
import type { TaskDetail, TaskWorkflow } from '../src/tasks/options.js';
import type { FormWorkPage } from '../src/forms/work-center.js';
import type { D1Database } from '../src/lms/types.js';
import type { OperationItem } from '../src/workflows/operations-options.js';
import type {
  ConfigurationMapping,
  ConfigurationPackage,
  SignedConfigurationReview,
} from '../src/configuration-package.js';
import type { WorkflowSpec } from '../src/workflows/contracts.js';
import type { Definition } from '../src/workflows/service.js';
import { scannerTestSignature } from './staging-scan-fixture.js';

type Revision = { id: string; revision: number };
type Actor = 'operator' | 'member' | 'other';
type Session = (baseUrl: string, actor: Actor) => Promise<Page>;
type JobDrill = {
  lms: D1Database;
  setRecipientGrant: (active: boolean) => Promise<void>;
  awaitQueueAlert?: (state: 'firing' | 'resolved') => Promise<void>;
  runWorkers?: (count: 1 | 2) => Promise<number[]>;
};
type PromotionPreview = {
  review: SignedConfigurationReview;
  backup: ConfigurationPackage;
  changes: { path: string }[];
};
type PromotionSource = { pack: ConfigurationPackage; review: SignedConfigurationReview };
type PromotionDrill =
  | {
      kind: 'source';
      publish: (source: PromotionSource) => void;
    }
  | { kind: 'target'; source: PromotionSource };

async function read<T>(page: Page, path: string, tenant: string = ids.tenantA, status = 200) {
  const result = await page.evaluate(
    async (url) => {
      const response = await fetch(url);
      return { status: response.status, body: await response.json() };
    },
    path + (path.includes('?') ? '&' : '?') + 'tenantId=' + tenant,
  );
  assert.equal(result.status, status, 'Unexpected staged read status for ' + path);
  return result.body as T;
}

async function command<T>(
  page: Page,
  path: string,
  fields: Record<string, unknown>,
  {
    key = randomUUID(),
    status = 200,
    csrf = true,
    capture,
  }: {
    key?: string;
    status?: number;
    csrf?: boolean;
    capture?: (requestId: string | null) => void;
  } = {},
) {
  const result = await page.evaluate(
    async ({ path, body, key, csrf }) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'idempotency-key': key,
      };
      if (csrf) {
        const me = await fetch('/api/v1/me');
        if (!me.ok) throw new Error('Staging actor session unavailable.');
        const data = await me.json();
        headers['x-csrf-token'] = data.csrfToken;
      }
      const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
      return {
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        contentType: response.headers.get('content-type'),
        body: await response.text(),
      };
    },
    {
      path,
      body: { tenantId: ids.tenantA, reason: 'Synthetic staging release gate', ...fields },
      key,
      csrf,
    },
  );
  if (result.status !== status && result.contentType?.includes('application/json')) {
    const failure = JSON.parse(result.body) as { error?: string };
    if (typeof failure.error === 'string' && /^[A-Z_]{2,80}$/.test(failure.error))
      console.error('Staging command refused with ' + failure.error + '.');
  }
  assert.equal(result.status, status, 'Unexpected staged command status for ' + path);
  capture?.(result.requestId);
  return (
    result.contentType?.includes('application/json') ? JSON.parse(result.body) : result.body
  ) as T;
}

async function verifyWorkflowJob(
  publisher: Page,
  handler: Page,
  lms: Page,
  fixture: JobDrill,
  audit: AuditEvidence[] | undefined,
  phase: (name: string) => void,
) {
  const api = '/api/v1/workflows';
  const spec = workflowTemplate('blank');
  spec.name = 'Tiếp nhận đào tạo staging';
  spec.audienceUnits = [ids.unitA];
  spec.input.sections[0]!.fields.push({
    id: 'training_title',
    label: 'Tên đợt đào tạo',
    type: 'shortText',
    required: true,
  });
  for (const node of spec.nodes) if (node.kind === 'approval') node.assignee = ids.learner;
  const definition = await command<Revision>(publisher, api + '/definitions', {
    code: 'training-job-' + randomUUID().slice(0, 8),
    orgUnitId: ids.unitA,
    spec,
  });
  const { version } = await command<{ version: { id: string } }>(
    publisher,
    api + '/definitions/' + definition.id + '/publish',
    { expectedRevision: definition.revision },
  );
  await command(publisher, api + '/intake-rules', {
    kind: 'lms-training',
    definitionId: definition.id,
    versionId: version.id,
    unitId: ids.unitA,
    recipientAccountId: ids.admin,
    mapping: { title: 'training_title', summary: 'purpose' },
  });
  const title = 'Đợt đào tạo tổng hợp staging';
  const summary = 'Đề nghị đào tạo sử dụng dữ liệu giả lập.';
  const run = await command<{ id: string }>(publisher, api + '/runs', {
    definitionId: definition.id,
    versionId: version.id,
    unitId: ids.unitA,
    title,
    answers: { purpose: summary, requested_on: '2026-12-01', training_title: title },
  });
  const runPath = api + '/runs/' + run.id;
  const { tasks } = await read<{ tasks: (Revision & { status: string })[] }>(handler, runPath);
  const task = tasks.find(({ status }) => status === 'pending');
  assert.ok(task);
  const operations = api + '/operations?kind=intake&runId=' + run.id + '&view=';
  const jobAt = async (view: 'attention' | 'resolved') =>
    (await read<{ items: OperationItem[] }>(publisher, operations + view)).items[0];
  const poll = { timeout: 50000, intervals: [800, 2000, 4000] };
  const matches = () =>
    fixture.lms
      .prepare('SELECT id,source_version_id FROM lms_training_intakes WHERE source_run_id=?')
      .bind(run.id)
      .all<{ id: string; source_version_id: string }>();

  phase('Workflow job blocks on a revoked LMS recipient');
  await fixture.setRecipientGrant(false);
  let blocked: OperationItem;
  try {
    await command(handler, api + '/tasks/' + task.id + '/action', {
      expectedRevision: task.revision,
      action: 'approve',
      answers: {},
    });
    if (fixture.runWorkers) assert.deepEqual(await fixture.runWorkers(1), [1]);
    await expect.poll(async () => (await jobAt('attention'))?.status, poll).toBe('blocked');
    blocked = (await jobAt('attention'))!;
    assert.equal(blocked.errorCode, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
    assert.equal(blocked.attempts, 1);
    assert.ok(blocked.canRetry);
    assert.deepEqual((await matches()).results, []);
    await read(handler, operations + 'attention', ids.tenantA, 403);
    await read(publisher, operations + 'attention', ids.tenantB, 403);
    await command(
      handler,
      api + '/intake-jobs/' + blocked.id + '/retry',
      { expectedRevision: 1 },
      {
        status: 403,
      },
    );
    await fixture.awaitQueueAlert?.('firing');
  } finally {
    await fixture.setRecipientGrant(true);
  }

  phase('Workflow job retry through the staging operations screen');
  const retryPath = api + '/intake-jobs/' + blocked.id + '/retry';
  await command(publisher, retryPath, { expectedRevision: 2 }, { status: 409 });
  const viewport = publisher.viewportSize();
  let replicaResults: number[] | undefined;
  await publisher.setViewportSize({ width: 390, height: 844 });
  try {
    await publisher.goto(new URL('/#workflows/automation', publisher.url()).href);
    await publisher.getByRole('tab', { name: 'Vận hành job', exact: true }).press('Enter');
    const section = publisher.getByRole('region', { name: 'Vận hành job Quy trình' });
    const row = section.getByRole('listitem').filter({ hasText: blocked.id });
    const retry = row.getByRole('button', { name: 'Thử lại job', exact: true });
    await expect(retry).toBeVisible();
    await retry.press('Enter');
    await row.getByLabel('Lý do thử lại').fill('Quyền tiếp nhận đã được khôi phục');
    const scan = await new AxeBuilder({ page: publisher })
      .include('section[aria-label="Vận hành job Quy trình"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    assert.deepEqual(
      scan.violations.map(({ id }) => id),
      [],
    );
    const retryResponse = publisher.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === retryPath && response.request().method() === 'POST',
    );
    await row.getByRole('button', { name: 'Đưa vào hàng chờ', exact: true }).press('Enter');
    const response = await retryResponse;
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.json(), { id: blocked.id, status: 'queued' });
    captureAudit(
      audit,
      'workflows',
      'intake.retry_requested',
    )(response.headers()['x-request-id'] ?? null);
    await expect(
      section.getByRole('status').filter({ hasText: 'Đã đưa job vào hàng chờ.' }),
    ).toBeVisible();
    if (fixture.runWorkers) {
      replicaResults = await fixture.runWorkers(2);
      assert.deepEqual(replicaResults, [0, 1]);
    }
    await expect.poll(async () => (await jobAt('resolved'))?.status, poll).toBe('done');
    const view = section.getByRole('combobox', { name: 'Trạng thái vận hành' });
    await view.press('Enter');
    await publisher.getByRole('option', { name: 'Đã xử lý', exact: true }).press('Enter');
    await expect(row.getByText('Hoàn thành', { exact: true })).toBeVisible();
    await row.getByText('Lịch sử xử lý', { exact: true }).press('Enter');
    await expect(row.getByText(/Lần 1 · Đã dừng/)).toBeVisible();
    await expect(row.getByText(/Lần 2 · Hoàn thành/)).toBeVisible();
    assert.ok(
      await publisher.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    );
  } finally {
    if (viewport) await publisher.setViewportSize(viewport);
  }

  assert.deepEqual(await read(publisher, runPath + '/training-intake'), { state: 'draft' });
  assert.deepEqual((await matches()).results, [{ id: blocked.id, source_version_id: version.id }]);
  const delivery = await fixture.lms
    .prepare(
      "SELECT count(*) AS total FROM aio_audit WHERE request_id=? AND action='training.workflow_intake_received'",
    )
    .bind(blocked.id)
    .first<{ total: number }>();
  assert.equal(delivery?.total, 1);
  await fixture.awaitQueueAlert?.('resolved');
  captureAudit(audit, 'lms', 'training.workflow_intake_received')(blocked.id);
  const inbox = await lms.evaluate(async () => {
    const response = await fetch('/api/lms/training-intakes');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(inbox.status, 200);
  assert.deepEqual(
    inbox.body.items.filter((item: { id: string }) => item.id === blocked.id),
    [{ id: blocked.id, unitId: ids.unitA, title, summary }],
  );
  return {
    history: ['blocked', 'done'],
    deliveries: 1,
    ...(replicaResults && { replicaResults }),
    pinnedVersion: true,
    deniedCrossTenant: true,
    deniedWithoutPermission: true,
    staleRevisionDenied: true,
    keyboard390px: true,
    axeViolations: 0,
  };
}

async function verifyWorkflowPromotion(
  publisher: Page,
  member: Page,
  drill: PromotionDrill,
  audit: AuditEvidence[] | undefined,
  phase: (name: string) => void,
) {
  const base = '/api/v1/workflows';
  const sourceSide = drill.kind === 'source';
  const unitId = sourceSide ? ids.unitC : ids.unitA;
  const spec = workflowTemplate('blank');
  spec.name = sourceSide ? 'Quy trình đã duyệt ở slot A' : 'Quy trình hiện hành ở slot B';
  spec.audienceUnits = [unitId];
  for (const node of spec.nodes)
    if (node.kind === 'approval') node.assignee = sourceSide ? ids.recovery : ids.learner;
  phase('Workflow configuration promotion fixture and initial publication');
  const definition = await command<Revision>(publisher, base + '/definitions', {
    code: 'promotion-' + randomUUID().slice(0, 8),
    orgUnitId: unitId,
    spec,
  });
  const publish = (expectedRevision: number) =>
    command<{
      definition: Definition;
      version: { id: string; version: number; spec: WorkflowSpec };
    }>(publisher, base + '/definitions/' + definition.id + '/publish', { expectedRevision });
  const initial = await publish(definition.revision);
  const transfer = '/api/v1/configuration-transfer/workflow/' + definition.id + '/';
  const preview = (pack: ConfigurationPackage, mappings: ConfigurationMapping[] = []) =>
    command<PromotionPreview>(publisher, transfer + 'preview', { package: pack, mappings });
  if (drill.kind === 'source') {
    phase('Workflow promotion export and review at source');
    const pack = await command<ConfigurationPackage>(publisher, transfer + 'export', {});
    const review = await preview(pack);
    assert.deepEqual(review.changes, []);
    drill.publish({ pack, review: review.review });
    const importEvidence = review.review.payload.importEvidence;
    assert.ok(importEvidence);
    return { exported: true, packageSha256: importEvidence.packageSha256 };
  }

  phase('Workflow promotion review and mapping at destination');
  const { pack, review: foreignReview } = drill.source;
  const start = (versionId: string, title: string) =>
    command<{ id: string; version_id: string }>(publisher, base + '/runs', {
      definitionId: definition.id,
      versionId,
      unitId,
      title,
      answers: { purpose: 'Dữ liệu staging tổng hợp', requested_on: '2026-12-01' },
    });
  const originalRun = await start(initial.version.id, 'Lượt đã ghim trước promotion');
  const snapshot = () =>
    read<{ run: object; tasks: object[]; version: object }>(
      publisher,
      base + '/runs/' + originalRun.id,
    );
  const pinned = await snapshot();
  assert.ok(pinned.tasks.length);
  const refused = await command<{ error: string }>(
    publisher,
    transfer + 'apply',
    { review: foreignReview },
    { status: 403 },
  );
  assert.equal(refused.error, 'CONFIGURATION_REVIEW_INVALID');
  const mappings: ConfigurationMapping[] = [
    { type: 'unit', from: ids.unitC, to: ids.unitA },
    { type: 'account', from: ids.recovery, to: ids.learner },
  ];
  const reviewed = await preview(pack, mappings);
  assert.ok(reviewed.changes.some(({ path }) => path === 'name'));
  phase('Workflow promotion dialog mapping and keyboard at 390px');
  const viewport = publisher.viewportSize();
  await publisher.setViewportSize({ width: 390, height: 844 });
  try {
    await publisher.goto(new URL('/#workflows/definitions', publisher.url()).href);
    phase('Workflow promotion find destination definition at 390px');
    await publisher.getByRole('textbox', { name: 'Tìm quy trình', exact: true }).fill(spec.name);
    const card = publisher
      .locator('[data-slot="card"]')
      .filter({ has: publisher.getByText(spec.name, { exact: true }) });
    const design = card.getByRole('button', { name: /^(Thiết kế|Xem & phát hành)$/u });
    await expect(design).toBeEnabled();
    await design.press('Enter');
    phase('Workflow promotion opens the destination import dialog');
    const importButton = publisher.getByRole('button', { name: 'Nhập cấu hình', exact: true });
    await expect(importButton).toBeEnabled();
    await importButton.press('Enter');
    const name = 'Nhập cấu hình vào bản nháp';
    const dialog = publisher.getByRole('dialog', { name, exact: true });
    phase('Workflow promotion imports the source package and loads mapping controls');
    await dialog.getByLabel('Tệp cấu hình JSON', { exact: true }).setInputFiles({
      name: 'workflow.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(pack)),
    });
    await expect(dialog.getByRole('combobox')).toHaveCount(mappings.length);
    await expect(
      dialog.getByRole('button', { name: 'Ghi bản nháp đã đối chiếu', exact: true }),
    ).toBeDisabled();
    phase('Workflow promotion validates dialog focus, reflow and axe');
    await verifyMobileDialog(publisher, 'dialog', name);
    await expect(
      dialog.getByRole('button', { name: 'Xem trước khác biệt', exact: true }),
    ).toBeVisible();
    phase('Workflow promotion closes dialog and restores opener focus');
    await dialog.getByRole('button', { name: 'Đóng', exact: true }).last().press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(importButton).toBeFocused();
  } finally {
    if (viewport) await publisher.setViewportSize(viewport);
  }
  const payload = reviewed.review.payload;
  const imported = payload.content as WorkflowSpec;
  assert.equal(payload.revision, initial.definition.revision);
  assert.deepEqual(imported.audienceUnits, [ids.unitA]);
  assert.ok(
    imported.nodes.some((node) => node.kind === 'approval' && node.assignee === ids.learner),
  );
  assert.ok(payload.importEvidence && payload.importEvidence.mappingCount === 2);
  assert.equal(
    payload.importEvidence.packageSha256,
    foreignReview.payload.importEvidence?.packageSha256,
  );
  assert.notEqual(
    payload.importEvidence.mappingSha256,
    foreignReview.payload.importEvidence?.mappingSha256,
  );

  phase('Workflow promotion authorization, CAS, audit and pinned runs');
  const apply = { review: reviewed.review };
  await command(member, transfer + 'apply', apply, { status: 403 });
  const key = randomUUID();
  const changed = await command<Definition>(publisher, transfer + 'apply', apply, {
    key,
    capture: captureAudit(audit, 'workflows', 'definition.updated'),
  });
  assert.equal(changed.latest_version, initial.version.version);
  assert.equal(changed.revision, initial.definition.revision + 1);
  assert.deepEqual(
    await command<Definition>(publisher, transfer + 'apply', apply, { key }),
    changed,
  );
  const stale = await command<{ error: string }>(publisher, transfer + 'apply', apply, {
    status: 409,
  });
  assert.equal(stale.error, 'REVISION_CONFLICT');
  const next = await publish(changed.revision);
  assert.equal(next.version.version, initial.version.version + 1);
  assert.equal(next.version.spec.name, (pack.content as WorkflowSpec).name);
  assert.equal((await start(next.version.id, 'Lượt sau promotion')).version_id, next.version.id);
  const retained = await snapshot();
  assert.deepEqual(retained.version, pinned.version);
  assert.deepEqual(retained.tasks, pinned.tasks);
  assert.deepEqual(retained.run, pinned.run);
  const rollback = await preview(reviewed.backup);
  const recovered = await command<Definition>(publisher, transfer + 'apply', {
    review: rollback.review,
  });
  assert.deepEqual(recovered.draft, reviewed.backup.content);
  assert.equal(recovered.latest_version, next.version.version);
  assert.deepEqual(await snapshot(), retained);
  return {
    ...payload.importEvidence,
    diffEntries: reviewed.changes.length,
    mappingDialogKeyboard390px: true,
    sourceReviewDenied: true,
    permissionDenied: true,
    draftCasAndReplay: true,
    auditCorrelationRequired: true,
    publishedSeparately: true,
    pinnedRunRetained: true,
    backupDraftRestored: true,
  };
}

export async function verifyStagingBusiness(
  runtime: StagingConfig,
  session: Session,
  phase: (name: string) => void,
  audit?: AuditEvidence[],
  accessUi = false,
  reportSession?: ReportSession,
  jobDrill?: JobDrill,
  promotionDrill?: PromotionDrill,
) {
  const open = (code: string, actor: Actor) =>
    session(runtime.clients.find((client) => client.code === code)!.baseUrl, actor);
  const suffix = randomUUID().slice(0, 8);
  const foundations = {
    operator: await open('aio-foundation', 'operator'),
    member: await open('aio-foundation', 'member'),
  };
  phase('Portal registry links');
  const apps = await read<{ items: { code: string; launchUrl: string }[] }>(
    foundations.member,
    '/api/v1/applications',
  );
  for (const module of stagingModules) {
    const client = runtime.clients.find((c) => c.code === 'aio-' + module)!;
    assert.equal(apps.items.find((a) => a.code === client.code)?.launchUrl, client.baseUrl);
  }
  let directoryAccess;
  let organizationWorkbookScan;
  if (accessUi) {
    phase('Portal Directory pagination and tenant scope');
    type PeoplePage = { items: { id: string; displayName: string }[]; nextCursor: string | null };
    const path = '/api/v1/manage/people';
    const first = await read<PeoplePage>(foundations.operator, path);
    assert.equal(first.items.length, 500);
    assert.ok(first.nextCursor);
    const second = await read<PeoplePage>(
      foundations.operator,
      path + '?cursor=' + first.nextCursor,
    );
    const people = [...first.items, ...second.items];
    assert.equal(new Set(people.map(({ id }) => id)).size, people.length);
    assert.equal(
      people.filter(({ displayName }) => displayName === 'Nhân sự phân trang staging').length,
      503,
    );
    assert.ok(!people.some(({ displayName }) => displayName === 'Nhân sự ngoài phạm vi staging'));
    assert.equal(second.nextCursor, null);
    await read(foundations.operator, path, ids.tenantB, 403);
    await read(foundations.member, path, ids.tenantA, 403);
    directoryAccess = {
      rows: people.length,
      pages: 2,
      deniedCrossTenant: true,
      deniedWithoutPermission: true,
    };
    phase('Foundation organization workbook quarantine and import permission');
    const base = '/api/v1/manage/organization-import/';
    const file = scannerTestSignature().toString('base64');
    const preview = { file };
    const commit = { file, snapshot: 'a'.repeat(64) };
    for (const [operation, payload] of [
      ['preview', preview],
      ['commit', commit],
    ] as const) {
      await command(foundations.member, base + operation, payload, { status: 403 });
      const response = await command<{ error: string }>(
        foundations.operator,
        base + operation,
        payload,
        { status: 422 },
      );
      assert.equal(response.error, 'ORGANIZATION_WORKBOOK_QUARANTINED');
    }
    organizationWorkbookScan = {
      previewQuarantined: true,
      commitQuarantined: true,
      unauthorizedDenied: true,
    };
  }

  phase('Forms publish, submit and scoped export');
  const forms = '/api/v1/forms';
  const designer = await open('aio-forms', 'operator');
  const respondent = await open('aio-forms', 'member');
  const form = await command<Revision>(
    designer,
    forms,
    {
      code: 'stage-' + suffix,
      schema: {
        schemaVersion: 1,
        title: 'Khảo sát staging',
        sections: [
          {
            id: 'main',
            title: 'Phản hồi',
            fields: [{ id: 'feedback', type: 'shortText', label: 'Phản hồi', required: true }],
          },
        ],
      },
      orgUnitId: reportSession ? null : ids.unitA,
      maxSubmissions: 2,
    },
    { capture: captureAudit(audit, 'forms', 'form.created') },
  );
  const formPath = forms + '/' + form.id;
  const assigned = await command<{ form: Revision }>(designer, formPath + '/audience', {
    expectedRevision: form.revision,
    audiences: (reportSession ? [ids.unitA, ids.unitC] : [ids.unitA]).map((targetId) => ({
      kind: 'unit',
      targetId,
      opensAt: '2020-01-01T00:00:00Z',
      closesAt: null,
    })),
  });
  const published = await command<{ version: { id: string } }>(designer, formPath + '/publish', {
    expectedRevision: assigned.form.revision,
  });
  const formFeed = '/api/v1/work-center/forms?search=' + encodeURIComponent('Khảo sát staging');
  const portalForm = async () =>
    (await read<FormWorkPage>(foundations.member, formFeed)).items.find(({ id }) => id === form.id);
  assert.deepEqual(await portalForm(), {
    id: form.id,
    title: 'Khảo sát staging',
    version: 1,
    action: 'start',
  });
  const answers = {
    versionId: published.version.id,
    orgUnitId: ids.unitA,
    answers: { feedback: 'Staging answer ' + suffix },
    submit: true,
  };
  const submission = formPath + '/submissions';
  const submissionKey = randomUUID();
  await command(respondent, submission, answers, { status: 403, csrf: false });
  if (audit)
    await command(respondent, submission, { ...answers, orgUnitId: ids.unitC }, { status: 403 });
  const submitted = await command(respondent, submission, answers, { key: submissionKey });
  assert.deepEqual(
    await command(respondent, submission, answers, { key: submissionKey }),
    submitted,
  );
  const exportPath = formPath + '/versions/' + published.version.id + '/export';
  const csv = await command<string>(designer, exportPath, {});
  assert.ok(csv.includes(answers.answers.feedback));
  await command(respondent, exportPath, {}, { status: 403 });
  await read(respondent, forms, ids.tenantB, 403);
  const uiAnswer = 'Phiếu UI ' + suffix;
  const outsideAnswer = 'Phiếu riêng đơn vị C ' + suffix;
  if (reportSession) {
    phase('Forms submit a fixture in unit C');
    const outside = await reportSession('aio-forms', 'outside');
    await command(outside, submission, {
      ...answers,
      orgUnitId: ids.unitC,
      answers: { feedback: outsideAnswer },
    });
  }
  let outsideProjectId: string | undefined;
  if (accessUi) {
    phase('Forms open from Portal, scoped submit and CSV download');
    const portalPage = await open('aio-foundation', 'member');
    try {
      await verifyFormsUi(respondent, designer, form.id, answers.answers.feedback, uiAnswer, {
        page: portalPage,
        formsBase: runtime.clients.find(({ code }) => code === 'aio-forms')!.baseUrl,
        portalOrigin: runtime.clients.find(({ code }) => code === 'aio-foundation')!.baseUrl,
        resumeDraft: runtime.namedHosts === true,
      });
    } finally {
      await portalPage.close();
    }
    assert.equal(await portalForm(), undefined);
  }
  let formsScope;
  if (reportSession) {
    phase('Forms operator control totals across both units');
    const all = await read<{ total: number; byUnit: { orgUnitId: string; count: number }[] }>(
      designer,
      formPath + '/report',
    );
    assert.equal(all.total, 3);
    assert.deepEqual(
      Object.fromEntries(all.byUnit.map(({ orgUnitId, count }) => [orgUnitId, count])),
      { [ids.unitA]: 2, [ids.unitC]: 1 },
    );
    phase('Forms reviewer, analyst and CSV source scope');
    const reviewer = await reportSession('aio-forms', 'reviewer');
    const analyst = await reportSession('aio-forms', 'analyst');
    const list = formPath + '/submissions/page';
    const rows = await read<{
      items: { id: string; org_unit_id: string; answers: { feedback: string } }[];
      nextCursor: string | null;
    }>(reviewer, list);
    assert.deepEqual(
      rows.items.map((item) => item.org_unit_id),
      [ids.unitA, ids.unitA],
    );
    assert.equal(rows.nextCursor, null);
    assert.equal(rows.items[0]?.answers.feedback, uiAnswer);
    const after = await read<typeof rows>(reviewer, list + '?after=' + rows.items[0]!.id);
    assert.deepEqual(
      after.items.map(({ answers }) => answers.feedback),
      [answers.answers.feedback],
    );
    assert.deepEqual(
      rows.items.map((item) => item.answers.feedback).sort(),
      [answers.answers.feedback, uiAnswer].sort(),
    );
    await read(reviewer, formPath + '/report', ids.tenantA, 403);
    await read(analyst, list, ids.tenantA, 403);
    const scoped = await read<typeof all>(analyst, formPath + '/report');
    assert.equal(scoped.total, 2);
    assert.deepEqual(scoped.byUnit, [{ orgUnitId: ids.unitA, count: 2 }]);
    await command(reviewer, exportPath, {}, { status: 403 });
    const scopedCsv = await command<string>(
      analyst,
      exportPath,
      {},
      {
        capture: captureAudit(audit, 'forms', 'form.exported'),
      },
    );
    assert.ok(
      scopedCsv.includes(answers.answers.feedback) &&
        scopedCsv.includes(uiAnswer) &&
        !scopedCsv.includes(outsideAnswer),
    );
    phase('Forms reviewer readback and analyst scoped CSV UI');
    await verifyScopedFormsUi(
      reviewer,
      analyst,
      form.id,
      [answers.answers.feedback, uiAnswer],
      outsideAnswer,
    );
    formsScope = {
      controlRows: all.total,
      reviewerRows: rows.items.length,
      analystRows: scoped.total,
      deniedCrossRoleActions: true,
      csvScopeVerified: true,
      scopedCursorRead: true,
    };
  }

  phase('Workflows publish, Portal work and pinned run');
  const workflows = '/api/v1/workflows';
  const publisher = await open('aio-workflows', 'operator');
  const handler = await open('aio-workflows', 'member');
  if (accessUi) {
    phase('Workflow Directory reference lookup under source scope');
    const path = workflows + '/references?kind=person&unitId=';
    const member = demoUsers.find(({ id }) => id === ids.learner)!;
    const found = await read<{ items: { id: string; label: string }[] }>(
      handler,
      path + ids.unitA + '&search=' + encodeURIComponent(member.name),
    );
    assert.deepEqual(found.items, [{ id: member.id, label: member.name }]);
    await read(handler, path + ids.unitB, ids.tenantB, 403);
  }
  const spec = workflowTemplate('blank');
  spec.name = 'Quy trình staging ' + suffix;
  spec.audienceUnits = [ids.unitA];
  const confidential = 'Synthetic owner field ' + suffix;
  if (audit) {
    spec.schemaVersion = 5;
    spec.fieldReaders = { 'input.purpose': ['owner'] };
  }
  if (accessUi) {
    spec.input.schemaVersion = 2;
    spec.input.sections[0]!.fields.push({
      id: 'private_file',
      label: 'Chứng từ riêng',
      type: 'attachment',
      required: false,
      attachments: { formats: ['txt'], maxFiles: 1, maxBytes: 1024 },
    });
    spec.fieldReaders = { ...spec.fieldReaders, 'input.private_file': ['owner'] };
  }
  for (const node of spec.nodes) if (node.kind === 'approval') node.assignee = ids.learner;
  const definition = await command<Revision>(publisher, workflows + '/definitions', {
    code: 'stage-' + suffix,
    orgUnitId: ids.unitA,
    spec,
  });
  const workflow = await command<{ version: { id: string } }>(
    publisher,
    workflows + '/definitions/' + definition.id + '/publish',
    { expectedRevision: definition.revision },
  );
  const runInput = {
    definitionId: definition.id,
    versionId: workflow.version.id,
    unitId: ids.unitA,
    title: 'Đề nghị staging ' + suffix,
    answers: { purpose: confidential, requested_on: '2026-12-01' },
  };
  const runAudit = { capture: captureAudit(audit, 'workflows', 'run.started') };
  let privateFile: { id: string; content: string; fileName: string } | undefined;
  let uploadScanQuarantine = false;
  let run: { id: string };
  if (accessUi) {
    phase('Workflow draft attachment fixture and submission');
    const requests = workflows + '/requests';
    const draft = await command<Revision>(publisher, requests, runInput);
    const flagged = await command<{ id: string; status: string }>(
      publisher,
      requests + '/' + draft.id + '/attachments',
      {
        fieldId: 'private_file',
        fileName: 'Synthetic-scan-probe.txt',
        content: scannerTestSignature().toString('base64'),
      },
    );
    assert.equal(flagged.status, 'quarantined');
    const flaggedStatus = await publisher.evaluate(
      async (path) => (await fetch(path)).status,
      workflows + '/attachments/' + flagged.id + '?tenantId=' + ids.tenantA,
    );
    assert.ok([403, 404].includes(flaggedStatus));
    uploadScanQuarantine = true;
    const fileName = 'Chung-tu-staging.txt';
    const content = 'Chứng từ giả lập ' + suffix;
    const file = await command<{ id: string; status: string }>(
      publisher,
      requests + '/' + draft.id + '/attachments',
      {
        fieldId: 'private_file',
        fileName,
        content: Buffer.from(content).toString('base64'),
      },
    );
    assert.equal(file.status, 'ready');
    privateFile = { id: file.id, content, fileName };
    const saved = await command<Revision>(publisher, requests + '/' + draft.id, {
      ...runInput,
      answers: { ...runInput.answers, private_file: [file.id] },
      expectedRevision: draft.revision,
    });
    run = await command(
      publisher,
      requests + '/' + draft.id + '/submit',
      { expectedRevision: saved.revision },
      runAudit,
    );
  } else run = await command(publisher, workflows + '/runs', runInput, runAudit);
  const work = await read<{
    items: { id: string; taskId: string; route: string }[];
    source: { baseUrl: string };
  }>(foundations.member, '/api/v1/work-center/work');
  const pending = work.items.find((item) => item.id === run.id);
  assert.ok(pending?.taskId && pending.route.includes(run.id));
  assert.equal(work.source.baseUrl, new URL(handler.url()).origin);
  const runPath = workflows + '/runs/' + run.id;
  const detail = await read<{
    run: { version_id: string };
    tasks: { id: string; revision: number; node_id: string }[];
  }>(handler, runPath);
  if (audit) {
    assert.ok(
      !JSON.stringify(detail).includes(confidential),
      'Handler received an owner-only field',
    );
    assert.ok(
      JSON.stringify(await read(publisher, runPath)).includes(confidential),
      'Owner lost access to their field',
    );
  }
  const step = detail.tasks.find((task) => task.id === pending.taskId);
  assert.ok(step);
  const actionPath = workflows + '/tasks/' + step.id + '/action';
  const approve = { expectedRevision: step.revision, action: 'approve', answers: {} };
  await command(publisher, actionPath, approve, { status: 403 });
  if (accessUi) {
    phase('Portal search, Workflow field and file access, approval UI');
    await verifyPortalWorkflowUi(
      foundations.member,
      publisher,
      {
        baseUrl: work.source.baseUrl,
        route: pending.route,
        title: runInput.title,
        privateAnswer: confidential,
      },
      privateFile,
      phase,
    );
  } else await command(handler, actionPath, approve);
  const done = await read<{ run: { version_id: string; status: string } }>(publisher, runPath);
  assert.equal(done.run.version_id, workflow.version.id);
  assert.equal(done.run.status, 'completed');
  await read(handler, workflows + '/definitions', ids.tenantB, 403);
  let workflowReportScope;
  if (accessUi) {
    phase('Workflow scoped CSV report and source authorization');
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      new Date(),
    );
    const report = {
      dataset: 'attempts',
      groupBy: 'step',
      measure: 'lateRate',
      from: day,
      to: day,
      unitId: ids.unitA,
      versionId: workflow.version.id,
    };
    const path = workflows + '/performance-report/export';
    const request = { report, group: workflow.version.id + '/' + step.node_id };
    const csv = await command<string>(publisher, path, request, {
      capture: captureAudit(audit, 'workflows', 'report.exported'),
    });
    assert.ok(csv.includes(step.id) && csv.includes(run.id));
    assert.ok(!csv.includes(confidential));
    await command(handler, path, request, { status: 403 });
    workflowReportScope = {
      scopedCsv: true,
      ownerFieldOmitted: true,
      actorWithoutReportDenied: true,
    };
  }

  phase('Tasks project, handoff and CAS');
  const tasks = '/api/v1/tasks';
  const manager = await open('aio-tasks', 'operator');
  const worker = await open('aio-tasks', 'member');
  if (runtime.namedHosts) {
    phase('Workflow and Tasks navigation back to the staging Portal');
    for (const page of [publisher, manager]) {
      const link = page.getByRole('link', { name: 'Mở Portal' });
      await link.waitFor({ state: 'visible' });
      assert.equal(
        new URL((await link.getAttribute('href'))!, page.url()).origin,
        new URL(foundations.operator.url()).origin,
      );
    }
  }
  const projectName = 'Dự án staging ' + suffix;
  const privateName = 'Dự án riêng ' + suffix;
  const project = await command<Revision>(manager, tasks + '/projects', {
    unitId: ids.unitA,
    name: projectName,
    description: 'Synthetic staging',
  });
  const projectPath = tasks + '/projects/' + project.id;
  if (audit) {
    const privateProject = await command<Revision>(manager, tasks + '/projects', {
      unitId: ids.unitA,
      name: privateName,
      description: '',
    });
    await read(worker, tasks + '/projects/' + privateProject.id, ids.tenantA, 403);
  }
  await command(manager, projectPath + '/member', {
    expectedRevision: project.revision,
    accountId: ids.learner,
    role: 'member',
    active: true,
  });
  const title = 'Việc staging ' + suffix;
  const item = await command<Revision>(manager, projectPath + '/items', {
    title,
    description: '',
    dueOn: null,
    remindDays: null,
    assigneeId: ids.learner,
    participantIds: [],
  });
  const itemPath = tasks + '/items/' + item.id;
  const assignedPath = '/api/v1/work-center/tasks/assigned';
  const memberFeed = () =>
    read<TaskWorkPage>(foundations.member, assignedPath + '?search=' + encodeURIComponent(title));
  phase('Portal assigned Tasks and source scope');
  assert.deepEqual(
    (await memberFeed()).items.map(({ id }) => id),
    [item.id],
  );
  await read(foundations.member, assignedPath, ids.tenantB, 403);
  if (accessUi) {
    phase('Tasks membership, search, report scope and UI handoff');
    const candidates = await read<{ items: { accountId: string }[] }>(
      manager,
      projectPath +
        '/candidates?search=' +
        encodeURIComponent(demoUsers.find(({ id }) => id === ids.learner)!.name),
    );
    assert.equal(candidates.items.length, 1);
    assert.equal(candidates.items[0]?.accountId, ids.learner);
    await read(worker, projectPath + '/candidates?search=' + suffix, ids.tenantA, 403);
    await read(worker, projectPath + '/report', ids.tenantA, 403);
    await read(manager, projectPath + '/report');
    const other = await open('aio-tasks', 'other');
    const outside = await command<Revision>(other, tasks + '/projects', {
      tenantId: ids.tenantB,
      unitId: ids.unitB,
      name: 'Dự án tenant B ' + suffix,
      description: '',
    });
    const outsidePath = tasks + '/projects/' + outside.id;
    outsideProjectId = outside.id;
    await read(other, outsidePath, ids.tenantB);
    await read(other, projectPath, ids.tenantB, 404);
    await read(manager, outsidePath, ids.tenantA, 404);
    const portalTask = await open('aio-foundation', 'member');
    try {
      await verifyPortalTaskUi(portalTask, {
        baseUrl: runtime.clients.find(({ code }) => code === 'aio-tasks')!.baseUrl,
        project: project.id,
        task: item.id,
        title,
      });
    } finally {
      await portalTask.close();
    }
  }
  const handoff = accessUi
    ? await verifyTaskUi(
        worker,
        {
          projectId: project.id,
          projectName,
          privateName,
          title,
          itemPath,
          recipient: demoUsers.find(({ id }) => id === ids.admin)!.name,
        },
        phase,
      )
    : await command<Revision>(worker, itemPath + '/handoff', {
        expectedRevision: item.revision,
        assigneeId: ids.admin,
      });
  const progress = itemPath + '/progress';
  assert.deepEqual((await memberFeed()).items, []);
  assert.ok(
    (
      await read<TaskWorkPage>(
        foundations.operator,
        assignedPath + '?search=' + encodeURIComponent(title),
      )
    ).items.some(({ id }) => id === item.id),
  );
  await command(
    worker,
    progress,
    { expectedRevision: handoff.revision, status: 'done', progress: 100 },
    { status: 403 },
  );
  await command(
    manager,
    progress,
    { expectedRevision: item.revision, status: 'done', progress: 100 },
    { status: 409 },
  );
  const finished = { expectedRevision: handoff.revision, status: 'done', progress: 100 };
  const finishKey = randomUUID();
  const final = await command(manager, progress, finished, {
    key: finishKey,
    capture: captureAudit(audit, 'tasks', 'task.progress'),
  });
  assert.deepEqual(await command(manager, progress, finished, { key: finishKey }), final);
  await read(worker, projectPath, ids.tenantB, 403);

  let taskStageChecks;
  if (runtime.namedHosts && accessUi) {
    phase('Tasks custom stage, source permissions and saved view');
    const custom = await command<Revision>(manager, tasks + '/projects', {
      unitId: ids.unitA,
      name: 'Trạng thái Công việc ' + suffix,
      description: '',
    });
    const customPath = tasks + '/projects/' + custom.id;
    const membership = await command<Revision>(manager, customPath + '/member', {
      expectedRevision: custom.revision,
      accountId: ids.learner,
      role: 'member',
      active: true,
    });
    const workflow: TaskWorkflow = {
      stages: [...defaultTaskStages, { code: 'review', phase: 'doing', name: 'Chờ duyệt' }],
      transitions: [
        { from: 'todo', to: 'review', roles: ['member', 'manager'] },
        { from: 'review', to: 'done', roles: ['manager'] },
      ],
    };
    const settings = { workflow, expectedRevision: membership.revision };
    await command(worker, customPath + '/workflow', settings, { status: 403 });
    const configKey = randomUUID();
    const configured = await command<Revision>(manager, customPath + '/workflow', settings, {
      key: configKey,
      capture: captureAudit(audit, 'tasks', 'project.workflow_changed'),
    });
    assert.deepEqual(
      await command(manager, customPath + '/workflow', settings, { key: configKey }),
      configured,
    );
    await command(manager, customPath + '/workflow', settings, { status: 409 });
    const reviewTitle = 'Việc chờ duyệt ' + suffix;
    const review = await command<Revision>(manager, customPath + '/items', {
      title: reviewTitle,
      description: '',
      dueOn: null,
      remindDays: null,
      assigneeId: ids.learner,
      participantIds: [],
    });
    const reviewPath = tasks + '/items/' + review.id;
    const moved = await command<Revision>(worker, reviewPath + '/progress', {
      status: 'doing',
      stageCode: 'review',
      progress: 60,
      expectedRevision: review.revision,
    });
    const finish = { status: 'done', progress: 100, expectedRevision: moved.revision };
    const denied = await command<{ error: string }>(worker, reviewPath + '/progress', finish, {
      status: 403,
    });
    assert.equal(denied.error, 'TASKS_TRANSITION_DENIED');
    const stage = (await read<TaskDetail>(worker, reviewPath)).item;
    assert.deepEqual(
      [stage.stageCode, stage.revision, stage.allowedStages],
      ['review', moved.revision, []],
    );
    const filtered = await read<{ items: { id: string }[] }>(
      worker,
      customPath + '/items?stageCode=review',
    );
    assert.deepEqual(
      filtered.items.map(({ id }) => id),
      [review.id],
    );
    const assigned = await read<TaskWorkPage>(
      foundations.member,
      assignedPath + '?search=' + encodeURIComponent(reviewTitle),
    );
    assert.deepEqual(
      assigned.items.map(({ id, stageName }) => [id, stageName]),
      [[review.id, 'Chờ duyệt']],
    );
    await verifySavedTaskStageUi(worker, custom.id, 'Chờ duyệt', reviewTitle);
    await command(manager, reviewPath + '/progress', finish);
    assert.equal((await read<TaskDetail>(manager, reviewPath)).item.status, 'done');
    taskStageChecks = {
      roleDenied: true,
      casAndReplay: true,
      portalStageLabel: true,
      savedViewReload: true,
      keyboard390px: true,
    };
  }

  const workflowJob = jobDrill
    ? await verifyWorkflowJob(
        publisher,
        handler,
        await open('aio-lms-sandbox', 'operator'),
        jobDrill,
        audit,
        phase,
      )
    : undefined;
  const workflowPromotion = promotionDrill
    ? await verifyWorkflowPromotion(publisher, handler, promotionDrill, audit, phase)
    : undefined;

  phase('Immediate revocation across active BFF sessions');
  for (const [module, page, path] of [
    ['forms', respondent, forms],
    ['workflows', handler, workflows + '/definitions'],
    ['tasks', worker, tasks + '/projects'],
  ] as const) {
    await read(page, path);
    await command(
      foundations.operator,
      '/api/v1/access/grants/revoke',
      {
        accountId: ids.learner,
        appCode: 'aio-' + module,
        expectedRevision: 1,
      },
      module === 'forms' ? { capture: captureAudit(audit, 'foundation', 'access.revoked') } : {},
    );
    await read(page, path, ids.tenantA, 403);
  }
  await read(foundations.member, '/api/v1/work-center/work', ids.tenantA, 403);
  await read(foundations.member, assignedPath, ids.tenantA, 403);
  await read(foundations.member, formFeed, ids.tenantA, 403);
  return {
    portalRegistry: true,
    ...(directoryAccess && { directoryAccess, workflowReferenceScope: true }),
    ...(organizationWorkbookScan && { organizationWorkbookScan }),
    ...(workflowReportScope && { workflowReportScope }),
    ...(uploadScanQuarantine && { uploadScanQuarantine }),
    ...(taskStageChecks && { taskStageChecks }),
    ...(workflowJob && { workflowJob }),
    ...(workflowPromotion && { workflowPromotion }),
    rollbackObjects: {
      formId: form.id,
      runId: run.id,
      definitionId: definition.id,
      projectId: project.id,
      taskId: item.id,
      outsideProjectId,
    },
    formsPublishSubmitExport: true,
    ...(runtime.namedHosts &&
      accessUi && { formsPortalDraftResume: true, formsConfirmationKeyboard390px: true }),
    workflowRunPinnedAndReachedFromPortal: true,
    taskHandoffCompletionAndCas: true,
    portalTasksAssignmentHandoffAndRevocation: true,
    crossTenantDenied: [...stagingModules],
    nextRequestRevocation: [...stagingModules, 'portal-work-center'],
    ...(formsScope ? { scopedReports: formsScope } : {}),
    ...(audit
      ? { sameTenantUnitDenial: true, workflowOwnerField: true, unassignedProjectDenied: true }
      : {}),
    ...(accessUi
      ? {
          accessUi: {
            portalSearchAndSourceLink: true,
            formsSubmitAndCsv: true,
            workflowFieldAndFile: true,
            workflowApproval: true,
            tasksSearchAndHandoff: true,
            portalTaskKeyboardAndMobileAxe: true,
            tasksReportAndCandidateDenied: true,
            tasksIndependentTenantData: true,
          },
        }
      : {}),
  };
}
