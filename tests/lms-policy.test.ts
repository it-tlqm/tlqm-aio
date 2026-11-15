import {
  learningPolicy,
  defaultLearningPolicy,
  parseLearningPolicy,
} from '../src/lms/learning-policy.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { localLmsConfig, migrateLms } from '../scripts/lms-local.js';
import type { D1Database } from '../src/lms/types.js';
import { Courses } from '../src/lms/courses.js';
import type { CourseActor } from '../src/lms/courses.js';
import {
  parseCourse,
  gradeCourse,
  publicCourse,
  CourseValidationError,
} from '../src/lms/course-contracts.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
import { LmsError } from '../src/lms/security.js';
import { Achievements } from '../src/lms/achievements.js';
import { QuestionBank } from '../src/lms/question-bank.js';
import { questionTemplate } from '../src/lms/question-spreadsheet.js';
import { Reports } from '../src/lms/reports.js';
import { reportWorkbook } from '../src/lms/report-export.js';
import * as XLSX from 'xlsx';

const config = await localLmsConfig(true);
const mf = new Miniflare({
  modules: true,
  script: 'export default {fetch(){return new Response("test")}}',
  host: '127.0.0.1',
  port: 0,
  d1Databases: ['DB'],
  log: new Log(LogLevel.NONE),
});
let db: D1Database;
const tenant = randomUUID(),
  unit = randomUUID(),
  otherUnit = randomUUID();
function actor(role: 'admin' | 'learner', tenantId = tenant, unitId = unit): CourseActor {
  const accountId = randomUUID(),
    employeeId = randomUUID(),
    personId = randomUUID();
  return {
    sessionHash: randomUUID(),
    principal: {
      version: 1,
      appCode: config.clientId,
      issuer: config.issuer,
      subject: accountId,
      accountId,
      personId,
      displayName: 'Synthetic LMS course test',
      tenantIds: [tenantId],
      units: [{ tenantId, orgUnitId: unitId }],
      permissions: [
        { tenantId, orgUnitId: null, permission: 'lms:learn' },
        ...(role === 'admin' ? [{ tenantId, orgUnitId: null, permission: 'lms:admin' }] : []),
      ],
      authenticatedAt: Math.floor(Date.now() / 1000),
      authenticationMethods: role === 'admin' ? ['pwd', 'otp'] : ['pwd'],
      maxAgeSeconds: 0,
    },
    link: {
      account_id: accountId,
      person_id: personId,
      employee_id: employeeId,
      tenant_id: tenantId,
      org_unit_id: unitId,
      active: 1,
      auth_not_before: 0,
      name: 'Synthetic',
      code: employeeId,
      department: 'Test',
      role,
    },
  };
}
const administrator = actor('admin'),
  student = actor('learner'),
  otherStudent = actor('learner'),
  foreign = actor('admin', randomUUID()),
  outside = actor('learner', tenant, otherUnit);
const directory = {
  units: async (tenantId: string) =>
    [unit, otherUnit].map((id) => ({
      id,
      name: id,
      code: id,
      legalEntityId: tenantId,
      legalEntityName: tenantId,
    })),
  people: async () => [],
};
const admin = new Courses(
  { prepare: (sql) => db.prepare(sql), batch: (statements) => db.batch(statements) },
  async () => administrator,
  directory,
);
const learn = new Courses(
  { prepare: (sql) => db.prepare(sql), batch: (statements) => db.batch(statements) },
  async () => student,
  directory,
);
const command = () => ({ key: randomUUID(), reason: 'Synthetic course acceptance' });
const spec = (): CourseSpec => ({
  schemaVersion: 1,
  title: 'Khóa học nghiệm thu',
  subtitle: 'Nội dung giả lập',
  series: 'TLQM local',
  duration: 30,
  video: { kind: 'youtube', id: 'abcdefghijk' },
  deadline: '2026-12-01',
  isMandatory: true,
  audienceUnits: [unit],
  checkpoints: [
    {
      id: 'cp1',
      type: 'single',
      title: 'Mốc đầu',
      time: 10,
      question: 'Chọn đáp án?',
      options: ['Một', 'Hai'],
    },
  ],
  questions: [
    { id: 'q1', type: 'single', question: 'Câu một?', options: ['A', 'B'] },
    { id: 'q2', type: 'multiple', question: 'Chọn nhiều?', options: ['A', 'B', 'C'] },
    { id: 'q3', type: 'text', question: 'Nhập từ?', options: [] },
  ],
  answerKey: {
    cp1: { answer: 0, explanation: 'Giải thích mốc' },
    q1: { answer: 1, explanation: 'Đáp án B' },
    q2: { answer: [0, 2], explanation: 'Hai lựa chọn' },
    q3: { answer: 'an toàn', explanation: 'Chuẩn hóa khoảng trắng và chữ hoa' },
  },
  attachments: [],
});
async function makeCourse() {
  const saved = await admin.save(
    {
      code: 'test-' + randomUUID().slice(0, 8),
      ownerUnitId: unit,
      expectedRevision: 0,
      spec: spec(),
    },
    command(),
  );
  const published = await admin.publish(saved.id, saved.revision, command());
  return { ...saved, ...published };
}
before(async () => {
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  await migrateLms(db, config);
  for (const a of [administrator, student, otherStudent, foreign, outside])
    await db.batch([
      db
        .prepare(
          'INSERT INTO employees(id,code,name,department,role,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind(
          a.link.employee_id,
          a.link.code,
          a.link.name,
          'Test',
          a.link.role,
          'isolated-test-not-a-login',
          '',
          '',
        ),
      db
        .prepare(
          'INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by) VALUES (?,?,?,?,?,?,?)',
        )
        .bind(
          a.principal.accountId,
          a.principal.personId,
          a.link.employee_id,
          a.link.tenant_id,
          a.link.org_unit_id,
          Date.now(),
          a.principal.accountId,
        ),
      db
        .prepare(
          'INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES (?,?,?,?,?)',
        )
        .bind(
          config.issuer,
          a.principal.subject,
          a.principal.accountId,
          Date.now(),
          a.principal.accountId,
        ),
      db
        .prepare(
          'INSERT INTO aio_sessions(hash,account_id,employee_id,issuer,subject,sid,authenticated_at,encrypted_payload,created_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          a.sessionHash,
          a.principal.accountId,
          a.link.employee_id,
          config.issuer,
          a.principal.subject,
          randomUUID(),
          a.principal.authenticatedAt,
          'isolated-domain-test',
          Date.now(),
          Date.now() + 900000,
          Date.now() + 3600000,
        ),
    ]);
});
after(() => mf.dispose());

const passedAnswers = { q1: 1, q2: [0, 2], q3: 'an toàn' };
async function configured(
  patch: Partial<import('../src/lms/learning-policy.js').LearningPolicy> = {},
  base = spec(),
) {
  base.schemaVersion = 3;
  base.policy = {
    ...structuredClone(defaultLearningPolicy),
    requireVideoCompletion: false,
    checkpointPolicy: 'none',
    ...patch,
  };
  const saved = await admin.save(
    {
      code: 'policy-' + randomUUID().slice(0, 8),
      ownerUnitId: unit,
      expectedRevision: 0,
      spec: base,
    },
    command(),
  );
  return { ...(await admin.publish(saved.id, saved.revision, command())), spec: base };
}
const submit = (versionId: string, answers = passedAnswers, key = command()) =>
  learn.submit({ versionId, answers, tabSwitchCount: 0 }, key);

test('v3 policy validation preserves defaults for legacy and does not expose answer keys', () => {
  assert.equal(learningPolicy(spec()).passScore, 80);
  const next = { ...spec(), schemaVersion: 3, policy: { ...defaultLearningPolicy, passScore: 60 } };
  assert.equal(parseCourse(next, true).policy?.passScore, 60);
  assert.throws(() => parseCourse({ ...next, schemaVersion: 2 }));
  assert.throws(() => parseLearningPolicy({ ...defaultLearningPolicy, maxAttempts: -1 }));
  assert.throws(() => parseLearningPolicy({ ...defaultLearningPolicy, passScore: 0 }));
  assert.throws(() => parseLearningPolicy({ ...defaultLearningPolicy, script: 'execute' }));
  assert.equal('answerKey' in publicCourse(parseCourse(next)), false);
});
test('threshold, certificate, catalogue and history agree below 80 and keep old publication policy', async () => {
  const course = await configured({ passScore: 60 }),
    result = await submit(course.versionId, { q1: 1, q2: [0, 2], q3: 'sai' });
  assert.equal(result.score, 67);
  assert.equal(result.passed, true);
  assert.equal(result.policy?.passScore, 60);
  const issued = await learn.issueCertificate(result.id, command());
  assert.equal(issued.id, result.id);
  assert.equal((await learn.list()).items.find((c) => c.id === course.id)?.progress.passed, true);
  assert.equal((await learn.history()).items.find((a) => a.id === result.id)?.passed, true);
  const reportDirectory = {
    ...directory,
    people: async (_tenant: string, ids: string[]) =>
      ids.includes(student.principal.accountId)
        ? [
            {
              accountId: student.principal.accountId,
              personId: student.principal.personId,
              displayName: 'Học viên chính sách',
              units: [{ id: unit, name: 'Đơn vị giả lập', employeeCodes: [student.link.code] }],
            },
          ]
        : [],
  };
  const report = await new Reports(db, async () => administrator, reportDirectory).gradebook({
    courseId: course.id,
  });
  assert.equal(report.items[0]?.cells[0]?.state, 'passed');
  const ranking = await new Achievements(
    db,
    async () => student,
    async (ids) =>
      ids.includes(student.principal.accountId)
        ? [
            {
              accountId: student.principal.accountId,
              personId: student.principal.personId,
              tenantId: tenant,
              orgUnitId: unit,
            },
          ]
        : [],
  ).ranking({});
  assert.equal(ranking.items.find((r) => r.isMe)?.completed, 1);
  const draft = await admin.save(
    {
      courseId: course.id,
      code: (await admin.list(true)).items.find((c) => c.id === course.id)!.code,
      ownerUnitId: unit,
      expectedRevision: course.revision,
      spec: { ...course.spec, policy: { ...course.spec.policy!, passScore: 100 } },
    },
    command(),
  );
  await admin.publish(course.id, draft.revision, command());
  assert.equal((await learn.attempt(result.id)).passed, true);
  assert.equal((await learn.issueCertificate(result.id, command())).id, result.id);
  assert.equal((await learn.list()).items.find((c) => c.id === course.id)?.progress.passed, false);
});
test('attempt limit is atomic under competing requests and an idempotent retry spends no attempt', async () => {
  const retryCourse = await configured({ maxAttempts: 1, cooldownMinutes: 60 }),
    retryKey = command();
  const retry = await Promise.all([
    submit(retryCourse.versionId, passedAnswers, retryKey),
    submit(retryCourse.versionId, passedAnswers, retryKey),
  ]);
  assert.deepEqual(retry[0], retry[1]);
  const course = await configured({ maxAttempts: 1 }),
    key = command();
  const outcomes = await Promise.allSettled([
    submit(course.versionId, passedAnswers, key),
    submit(course.versionId),
    submit(course.versionId),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of outcomes.filter((r) => r.status === 'rejected'))
    assert.equal(r.reason.code, 'LMS_ATTEMPT_LIMIT');
  const first = outcomes[0];
  if (first?.status === 'fulfilled')
    assert.deepEqual(await submit(course.versionId, passedAnswers, key), first.value);
  assert.equal((await learn.detail(course.versionId)).assessment.remaining, 0);
  assert.equal(
    (await db
      .prepare('SELECT count(*) AS n FROM lms_attempts WHERE version_id=?')
      .bind(course.versionId)
      .first<{ n: number }>())!.n,
    1,
  );
});
test('cooldown is enforced at submission boundary and permits a new attempt after its deadline', async (t) => {
  const course = await configured({ cooldownMinutes: 1, maxAttempts: 2 }),
    now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const first = await submit(course.versionId);
  await assert.rejects(submit(course.versionId), { code: 'LMS_ATTEMPT_COOLDOWN' });
  assert.equal(
    (await learn.detail(course.versionId)).assessment.nextAllowedAt,
    first.createdAt + 60000,
  );
  t.mock.timers.tick(60000);
  assert.equal((await submit(course.versionId)).passed, true);
});
test('correct checkpoint policy keeps wrong answers incomplete; video requirement remains independent', async () => {
  const course = await configured({ checkpointPolicy: 'correct' });
  const progress = await learn.saveProgress(
    { versionId: course.versionId, position: 10, expectedRevision: 0 },
    command(),
  );
  const wrong = await learn.checkpoint(
    {
      versionId: course.versionId,
      questionId: 'cp1',
      answer: 1,
      expectedRevision: progress.revision,
    },
    command(),
  );
  assert.equal(wrong.completed, false);
  assert.deepEqual((await learn.detail(course.versionId)).progress.answeredCheckpoints, []);
  await assert.rejects(submit(course.versionId), { code: 'LMS_LEARNING_INCOMPLETE' });
  const correct = await learn.checkpoint(
    { versionId: course.versionId, questionId: 'cp1', answer: 0, expectedRevision: wrong.revision },
    command(),
  );
  assert.equal(correct.completed, true);
  assert.equal((await submit(course.versionId)).passed, true);
  const videoRequired = await configured({ requireVideoCompletion: true });
  await assert.rejects(submit(videoRequired.versionId), { code: 'LMS_LEARNING_INCOMPLETE' });
  await learn.saveProgress(
    { versionId: videoRequired.versionId, position: 30, expectedRevision: 0 },
    command(),
  );
  assert.equal((await submit(videoRequired.versionId)).passed, true);
});
test('prerequisite gates apply to direct reads/progress/submit and unlock only after a passing snapshot', async () => {
  const prerequisite = await configured({ passScore: 100 }),
    dependent = await configured({ prerequisiteVersionIds: [prerequisite.versionId] });
  assert.equal(
    (await learn.list()).items.find((c) => c.id === dependent.id)?.prerequisitesRemaining,
    1,
  );
  await assert.rejects(learn.detail(dependent.versionId), { code: 'LMS_PREREQUISITES_REQUIRED' });
  await assert.rejects(
    learn.saveProgress(
      { versionId: dependent.versionId, expectedRevision: 0, position: 30 },
      command(),
    ),
    { code: 'LMS_PREREQUISITES_REQUIRED' },
  );
  await assert.rejects(submit(dependent.versionId), { code: 'LMS_PREREQUISITES_REQUIRED' });
  await submit(prerequisite.versionId, { q1: 0, q2: [0, 2], q3: 'an toàn' });
  await assert.rejects(learn.detail(dependent.versionId), { code: 'LMS_PREREQUISITES_REQUIRED' });
  await submit(prerequisite.versionId);
  assert.equal((await learn.detail(dependent.versionId)).versionId, dependent.versionId);
  assert.equal((await submit(dependent.versionId)).passed, true);
});
test('prerequisite publication rejects self/cycles and cross-audience versions atomically', async () => {
  const a = await configured(),
    b = await configured({ prerequisiteVersionIds: [a.versionId] });
  const code = (await admin.list(true)).items.find((c) => c.id === a.id)!.code;
  const saved = await admin.save(
    {
      courseId: a.id,
      code,
      ownerUnitId: unit,
      expectedRevision: a.revision,
      spec: { ...a.spec, policy: { ...a.spec.policy!, prerequisiteVersionIds: [b.versionId] } },
    },
    command(),
  );
  await assert.rejects(admin.publish(a.id, saved.revision, command()), {
    code: 'LMS_PREREQUISITE_CYCLE',
  });
  assert.equal((await admin.list(true)).items.find((c) => c.id === a.id)?.versionId, a.versionId);
  const outsideSpec = spec();
  outsideSpec.audienceUnits = [otherUnit];
  const outsideCourse = await configured({}, outsideSpec);
  await assert.rejects(configured({ prerequisiteVersionIds: [outsideCourse.versionId] }), {
    code: 'LMS_PREREQUISITE_UNAVAILABLE',
  });
  await assert.rejects(configured({ prerequisiteVersionIds: [randomUUID()] }), {
    code: 'LMS_PREREQUISITE_UNAVAILABLE',
  });
});
test('policy checks do not bypass revocation or allow learner authoring', async () => {
  const course = await configured();
  const unauth = new Courses(
    db,
    async () => ({ ...student, principal: { ...student.principal, permissions: [] } }),
    directory,
  );
  await assert.rejects(
    unauth.submit(
      { versionId: course.versionId, answers: passedAnswers, tabSwitchCount: 0 },
      command(),
    ),
    { code: 'LMS_PERMISSION_DENIED' },
  );
  await assert.rejects(
    learn.save(
      { code: 'denied', ownerUnitId: unit, expectedRevision: 0, spec: course.spec },
      command(),
    ),
    { code: 'LMS_PERMISSION_DENIED' },
  );
});
