import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { demoUsers, ids } from '../src/fixtures.js';
import { defaultLearningPolicy } from '../src/lms/learning-policy.js';
import type { StagingSlot } from '../src/staging-config.js';
import { recordedLmsVideo } from './lms-video-fixture.js';
import { captureAudit } from './staging-audit.js';
import type { AuditEvidence } from './staging-audit.js';
import { gradebookRows, verifyLmsUi, verifyScopedLmsUi } from './staging-access-ui.js';
import { reportActors } from './staging-report-fixtures.js';
import type { ReportSession } from './staging-report-fixtures.js';
import { scannerTestSignature } from './staging-scan-fixture.js';

type Revision = { id: string; revision: number };

function expectStatus(actual: number, expected: number, path: string, body: unknown) {
  if (actual === expected) return;
  const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
  const code = typeof error === 'string' && /^[A-Z_]{2,80}$/.test(error) ? error : 'UNSPECIFIED';
  console.error('LMS gate status ' + actual + ' at ' + path.split('?')[0] + ' (' + code + ').');
  assert.equal(actual, expected);
}

async function read<T>(page: Page, path: string, status = 200) {
  const response = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }, path);
  if (response.status !== status) {
    let error: unknown;
    try {
      error = JSON.parse(response.body);
    } catch {
      error = null;
    }
    expectStatus(response.status, status, path, error);
  }
  return response.body as T;
}

async function write<T>(
  page: Page,
  path: string,
  body: string | number[],
  options: {
    status?: number;
    key?: string;
    headers?: Record<string, string>;
    csrf?: boolean;
    capture?: (requestId: string | null) => void;
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': options.key ?? randomUUID(),
    ...options.headers,
  };
  const response = await page.evaluate(
    async ({ path, body, headers, csrf }) => {
      if (csrf) {
        const me = await fetch('/api/v1/me');
        if (!me.ok) throw new Error('Staging LMS actor unavailable.');
        headers['x-csrf-token'] = (await me.json()).csrfToken;
      }
      const response = await fetch(path, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : Uint8Array.from(body),
      });
      return {
        status: response.status,
        body: await response.json(),
        requestId: response.headers.get('x-request-id'),
      };
    },
    { path, body, headers, csrf: options.csrf ?? true },
  );
  expectStatus(response.status, options.status ?? 200, path, response.body);
  options.capture?.(response.requestId);
  return response.body as T;
}

const envelope = (action: string, data: Record<string, unknown>) =>
  JSON.stringify({ action, data, reason: 'Synthetic staging release gate' });

export async function verifyStagingLms(
  operator: Page,
  learner: Page,
  portalOperator: Page,
  portalLearner: Page,
  slot: StagingSlot,
  phase: (name: string) => void,
  audit?: AuditEvidence[],
  accessUi = false,
  reportSession?: ReportSession,
  mobileAssessment = false,
) {
  phase('LMS Secure cookie and R2 media');
  const cookie = (await learner.context().cookies()).find(
    (entry) => entry.name === '__Host-aio_lms_' + slot + '_session',
  );
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.path === '/');
  const file = '%PDF-1.4\n% Synthetic AIO staging receipt\n%%EOF\n';
  const mediaId = randomUUID();
  const mediaPath = '/api/lms/media';
  if (accessUi) {
    const result = await write<{ error: string }>(
      operator,
      '/api/lms/question-imports/preview?kind=quiz',
      [...scannerTestSignature()],
      {
        status: 422,
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'x-file-name': 'staging-scan-probe.xlsx',
        },
      },
    );
    assert.equal(result.error, 'LMS_UPLOAD_QUARANTINED');
  }
  await write(operator, mediaPath, file, {
    headers: {
      'content-type': 'application/pdf',
      'x-file-name': 'staging.pdf',
      'x-file-size': String(Buffer.byteLength(file)),
      'x-file-sha256': createHash('sha256').update(file).digest('hex'),
      'x-media-id': mediaId,
      'x-owner-unit-id': ids.unitA,
    },
  });
  assert.equal(await read<string>(operator, mediaPath + '/' + mediaId), file);
  await read(learner, mediaPath + '/' + mediaId, 403);
  const video = await recordedLmsVideo(operator, 1000);
  const videoId = randomUUID();
  await write(operator, mediaPath, Array.from(video), {
    headers: {
      'content-type': 'video/webm',
      'x-file-name': 'staging.webm',
      'x-file-size': String(video.byteLength),
      'x-file-sha256': createHash('sha256').update(video).digest('hex'),
      'x-media-id': videoId,
      'x-owner-unit-id': ids.unitA,
    },
  });

  phase('LMS publish course and learner visibility');
  const commands = '/api/lms/commands';
  const suffix = randomUUID().slice(0, 8);
  const courseTitle = 'Khóa học staging ' + suffix;
  const save = envelope('save-course', {
    code: 'stage-' + suffix,
    ownerUnitId: ids.unitA,
    expectedRevision: 0,
    spec: {
      schemaVersion: 3,
      title: courseTitle,
      subtitle: '',
      series: 'AIO staging',
      duration: 30,
      video: { kind: 'file', id: videoId },
      deadline: '',
      isMandatory: true,
      audienceUnits: reportSession ? [ids.unitA, ids.unitC] : [ids.unitA],
      checkpoints: [],
      questions: [{ id: 'q', type: 'single', question: 'Chọn đáp án A', options: ['A', 'B'] }],
      answerKey: { q: { answer: 0, explanation: 'Phản hồi giả lập' } },
      attachments: [{ id: 'document', title: 'Tài liệu staging', mediaId }],
      policy: { ...defaultLearningPolicy, requireVideoCompletion: false, checkpointPolicy: 'none' },
    },
  });
  await write(learner, commands, save, { status: 403 });
  await write(operator, commands, save, { status: 403, csrf: false });
  const course = await write<Revision>(operator, commands, save);
  const published = await write<{ versionId: string }>(
    operator,
    commands,
    envelope('publish-course', { courseId: course.id, expectedRevision: course.revision }),
    { capture: captureAudit(audit, 'lms', 'course.published') },
  );
  const versionId = published.versionId;
  const detail = JSON.parse(
    await read<string>(learner, '/api/lms/course?versionId=' + versionId),
  ) as { spec: Record<string, unknown> };
  assert.ok(!Object.hasOwn(detail.spec, 'answerKey'));
  assert.equal(
    await read<string>(learner, mediaPath + '/' + mediaId + '?versionId=' + versionId),
    file,
  );
  await read(learner, '/api/lms/manage/courses', 403);

  phase('LMS batch and Portal delegated training feed');
  const training = '/api/lms/training-commands';
  const path = await write<Revision>(
    operator,
    training,
    envelope('save-path', {
      expectedRevision: 0,
      spec: {
        schemaVersion: 1,
        title: 'Lộ trình staging ' + suffix,
        description: '',
        courseVersionIds: [versionId],
        audienceUnits: [ids.unitA],
      },
    }),
  );
  const pathVersion = await write<{ versionId: string }>(
    operator,
    training,
    envelope('publish-path', {
      id: path.id,
      expectedRevision: path.revision,
    }),
  );
  const schedule = {
    title: 'Đợt staging ' + suffix,
    startsAt: Date.now() - 60000,
    dueAt: Date.now() + 86400000,
  };
  const batch = await write<Revision>(
    operator,
    training,
    envelope('create-batch', {
      ...schedule,
      pathVersionId: pathVersion.versionId,
      ownerUnitId: ids.unitA,
      accountIds: [ids.learner],
    }),
  );
  const feed = '/api/v1/work-center/training?tenantId=' + ids.tenantA;
  const work = JSON.parse(await read<string>(portalLearner, feed)) as {
    items: { id: string; route: string }[];
    notices: { batchId: string; kind: string }[];
  };
  assert.ok(
    work.items.some(
      (item) => item.id === batch.id && item.route === '/#training-batch/' + batch.id,
    ),
    'Expected newly assigned batch in the Portal feed',
  );
  assert.ok(
    work.notices.some((notice) => notice.batchId === batch.id && notice.kind === 'assigned'),
    'Expected initial assignment notice for the new batch',
  );
  await read(portalLearner, '/api/v1/work-center/training?tenantId=' + ids.tenantB, 403);

  phase('LMS D1 assessment, report and completed Portal task');
  const submit = envelope('submit', { versionId, answers: { q: 0 }, tabSwitchCount: 0 });
  const key = randomUUID();
  const exam = await write<{ id: string; score: number }>(learner, commands, submit, { key });
  assert.equal(exam.score, 100);
  assert.deepEqual(await write(learner, commands, submit, { key }), exam);
  const assessment = JSON.parse(await read<string>(learner, '/api/lms/attempt?id=' + exam.id)) as {
    score: number;
  };
  assert.equal(assessment.score, 100);
  const report = '/api/lms/report?courseId=' + course.id;
  await read(operator, report);
  await read(learner, report, 403);
  if (accessUi) {
    phase('LMS course file and searched report export UI');
    await write(
      learner,
      '/api/lms/report-export',
      JSON.stringify({
        filters: { courseId: course.id },
        reason: 'Synthetic report permission check',
      }),
      { status: 403 },
    );
    await verifyLmsUi(
      operator,
      learner,
      courseTitle,
      {
        path: mediaPath + '/' + mediaId + '?versionId=' + versionId,
        content: file,
      },
      demoUsers.find(({ id }) => id === ids.learner)!.name,
      phase,
      mobileAssessment,
    );
  }
  let managerScope;
  if (reportSession) {
    phase('LMS unit C learner assessment and operator control report');
    const outside = await reportSession('aio-lms-sandbox', 'outside');
    const otherExam = await write<{ score: number }>(outside, commands, submit);
    assert.equal(otherExam.score, 100);
    type Row = {
      employeeId: string;
      accountId: string;
      name: string;
      orgUnitId: string;
      attempts: number;
    };
    type Gradebook = { items: Row[]; total: number; page: number; pageSize: number };
    const gradebook = async (actor: Page) => {
      const first = JSON.parse(await read<string>(actor, report)) as Gradebook;
      assert.ok(first.page === 1 && first.pageSize > 0 && first.total <= 5000);
      for (let page = 2; page <= Math.ceil(first.total / first.pageSize); page++) {
        const next = JSON.parse(await read<string>(actor, report + '&page=' + page)) as Gradebook;
        assert.equal(next.total, first.total);
        assert.equal(next.page, page);
        first.items.push(...next.items);
      }
      assert.equal(first.items.length, first.total);
      assert.equal(new Set(first.items.map(({ employeeId }) => employeeId)).size, first.total);
      return first;
    };
    const all = await gradebook(operator);
    const otherRow = all.items.find(({ accountId }) => accountId === reportActors.outside.id);
    assert.ok(otherRow && otherRow.orgUnitId === ids.unitC && otherRow.attempts === 1);
    assert.ok(
      all.items.some(({ accountId, attempts }) => accountId === ids.learner && attempts === 1),
    );
    phase('LMS manager scoped gradebook, search and direct learner access');
    const manager = await reportSession('aio-lms-sandbox', 'reviewer');
    const expected = all.items.filter(({ orgUnitId }) => orgUnitId === ids.unitA);
    const scoped = await gradebook(manager);
    assert.equal(scoped.total, expected.length);
    assert.deepEqual(
      scoped.items.map(({ accountId }) => accountId).sort(),
      expected.map(({ accountId }) => accountId).sort(),
    );
    const outsideSearch = JSON.parse(
      await read<string>(
        manager,
        report + '&search=' + encodeURIComponent(reportActors.outside.name),
      ),
    ) as Gradebook;
    assert.deepEqual(
      { total: outsideSearch.total, items: outsideSearch.items },
      { total: 0, items: [] },
    );
    await read(manager, report + '&orgUnitId=' + ids.unitC, 403);
    await read(
      manager,
      '/api/lms/report-learner?courseId=' + course.id + '&employeeId=' + otherRow.employeeId,
      404,
    );
    const learnerName = demoUsers.find(({ id }) => id === ids.learner)!.name;
    await verifyScopedLmsUi(manager, courseTitle, learnerName, reportActors.outside.name, phase);
    const csrfToken: string = await manager.evaluate(
      async () => (await (await fetch('/api/v1/me')).json()).csrfToken,
    );
    const exportKey = randomUUID();
    const exportReport = () =>
      manager.evaluate(
        async ({ csrfToken, key, courseId }) => {
          const response = await fetch('/api/lms/report-export', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': csrfToken,
              'idempotency-key': key,
            },
            body: JSON.stringify({
              filters: { courseId },
              reason: 'Kiểm báo cáo phạm vi đơn vị staging',
            }),
          });
          return {
            status: response.status,
            requestId: response.headers.get('x-request-id'),
            bytes: response.ok ? Array.from(new Uint8Array(await response.arrayBuffer())) : [],
            error: response.ok ? null : ((await response.json()).error as string),
          };
        },
        { csrfToken, key: exportKey, courseId: course.id },
      );
    const exported = await exportReport();
    assert.equal(exported.status, 200);
    captureAudit(audit, 'lms', 'report.exported')(exported.requestId);
    const rows = gradebookRows(Buffer.from(exported.bytes));
    assert.equal(rows.length, scoped.total);
    assert.ok(
      expected.every(({ name }) => JSON.stringify(rows).includes(name)) &&
        !JSON.stringify(rows).includes(reportActors.outside.name),
    );
    const replayed = await exportReport();
    assert.equal(replayed.status, 200);
    assert.deepEqual(gradebookRows(Buffer.from(replayed.bytes)), rows);
    phase('LMS manager cached export denied immediately after grant revocation');
    await write(
      portalOperator,
      '/api/v1/access/grants/revoke',
      JSON.stringify({
        tenantId: ids.tenantA,
        accountId: reportActors.reviewer.id,
        appCode: 'aio-lms-sandbox',
        expectedRevision: 1,
        reason: 'Thu hồi quyền xuất báo cáo staging',
      }),
    );
    const denied = await exportReport();
    assert.equal(denied.status, 403);
    assert.equal(denied.error, 'APPLICATION_ACCESS_DENIED');
    assert.equal(denied.bytes.length, 0);
    managerScope = {
      controlRows: all.total,
      managerRows: scoped.total,
      deniedUnitAndLearner: true,
      outsideSearchEmpty: true,
      xlsxScopeVerified: true,
      exportReplayDeniedAfterRevoke: true,
    };
  }
  const after = JSON.parse(await read<string>(portalLearner, feed)) as typeof work;
  assert.ok(!after.items.some((item) => item.id === batch.id));

  if (new URL(portalOperator.url()).hostname.endsWith('.localhost')) {
    phase('LMS navigation back to the staging Portal');
    const link = operator.getByRole('link', { name: 'Mở Portal' });
    await link.waitFor({ state: 'visible' });
    assert.equal(
      new URL((await link.getAttribute('href'))!, operator.url()).origin,
      new URL(portalOperator.url()).origin,
    );
  }

  phase('LMS and Portal next-request revocation');
  await write(
    portalOperator,
    '/api/v1/access/grants/revoke',
    JSON.stringify({
      tenantId: ids.tenantA,
      accountId: ids.learner,
      appCode: 'aio-lms-sandbox',
      expectedRevision: 1,
      reason: 'Synthetic staging release gate',
    }),
  );
  await read(learner, '/api/lms/courses', 403);
  await read(portalLearner, feed, 403);
  return {
    secureCookie: true,
    ...(accessUi && { questionUploadQuarantined: true }),
    rollbackObjects: { courseId: course.id, versionId, attemptId: exam.id, mediaId },
    r2Media: true,
    courseAssessmentReplay: true,
    reportScope: true,
    portalTrainingBatchAndNotice: true,
    nextRequestRevocation: true,
    ...(managerScope ? { scopedReports: managerScope } : {}),
    ...(accessUi
      ? {
          accessUi: {
            scopedFileDownload: true,
            reportTabHidden: true,
            searchedXlsxDownload: true,
            directLearnerExportDenied: true,
            ...(mobileAssessment && { assessmentKeyboard390px: true }),
          },
        }
      : {}),
  };
}
