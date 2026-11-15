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
test('Question bank protects answer keys, imports atomically, preserves published copies, and replays after expiry/archive', async () => {
  const bank = new QuestionBank(db, async () => administrator, directory),
    studentBank = new QuestionBank(db, async () => student, directory),
    foreignBank = new QuestionBank(db, async () => foreign, directory);
  await assert.rejects(() => studentBank.listBank(), { code: 'LMS_PERMISSION_DENIED' });
  const request = () =>
    new Request('http://127.0.0.1:4104/api/lms/question-imports/preview?kind=quiz', {
      method: 'POST',
      headers: { 'x-file-name': 'mau.xlsx' },
      body: questionTemplate('quiz') as Uint8Array<ArrayBuffer>,
    });
  const previewKey = command(),
    preview = await bank.preview(request(), 'quiz', previewKey);
  assert.deepEqual(await bank.preview(request(), 'quiz', previewKey), preview);
  assert.equal(preview.items.length, 3);
  assert.deepEqual(preview.errors, []);
  await assert.rejects(
    () =>
      foreignBank.applyImport(
        { previewId: preview.id, destination: 'bank', category: 'Import', mode: 'append' },
        command(),
      ),
    { code: 'LMS_IMPORT_EXPIRED' },
  );
  const before = (await bank.listBank()).items.length;
  await db
    .prepare(
      "CREATE TRIGGER bank_test_audit_failure BEFORE INSERT ON aio_audit WHEN NEW.action='questions.imported_to_bank' BEGIN SELECT RAISE(ABORT,'BANK_AUDIT_FAILURE'); END",
    )
    .run();
  const input = {
      previewId: preview.id,
      destination: 'bank' as const,
      category: 'Nghiệm thu',
      mode: 'append' as const,
    },
    key = command();
  try {
    await assert.rejects(() => bank.applyImport(input, key));
    assert.equal((await bank.listBank()).items.length, before);
  } finally {
    await db.prepare('DROP TRIGGER bank_test_audit_failure').run();
  }
  const imported = await bank.applyImport(input, key);
  assert.ok('ids' in imported && imported.ids);
  assert.equal(imported.ids.length, 3);
  await db.prepare('DELETE FROM lms_question_imports WHERE id=?').bind(preview.id).run();
  assert.deepEqual(await bank.applyImport(input, key), imported);
  await assert.rejects(() => bank.applyImport(input, command()), { code: 'LMS_IMPORT_EXPIRED' });
  const saved = (await bank.listBank({ search: 'nghiem thu' })).items;
  assert.equal(saved.length, 3);
  const course = await makeCourse(),
    published = await db
      .prepare('SELECT spec_json FROM lms_course_versions WHERE id=?')
      .bind(course.versionId)
      .first();
  const attach = {
      courseId: course.id,
      expectedRevision: course.revision,
      kind: 'quiz' as const,
      mode: 'replace' as const,
      items: saved.map((item) => ({ id: item.id, revision: item.revision })),
    },
    attachKey = command();
  const applied = await bank.attach(attach, attachKey);
  assert.equal(applied.count, 3);
  const first = saved[0]!;
  await assert.rejects(
    () =>
      foreignBank.saveQuestion(
        {
          id: first.id,
          expectedRevision: 1,
          category: first.category,
          entry: first.entry,
          status: 'active',
        },
        command(),
      ),
    { code: 'LMS_QUESTION_NOT_FOUND' },
  );
  const outcomes = await Promise.allSettled([
    bank.saveQuestion(
      { id: first.id, expectedRevision: 1, category: 'A', entry: first.entry, status: 'archived' },
      command(),
    ),
    bank.saveQuestion(
      { id: first.id, expectedRevision: 1, category: 'B', entry: first.entry, status: 'archived' },
      command(),
    ),
  ]);
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(
    outcomes.filter((row) => row.status === 'rejected' && row.reason.code === 'REVISION_CONFLICT')
      .length,
    1,
  );
  assert.deepEqual(await bank.attach(attach, attachKey), applied);
  await assert.rejects(
    () => bank.attach({ ...attach, expectedRevision: applied.revision }, command()),
    { code: 'REVISION_CONFLICT' },
  );
  assert.deepEqual(
    await db
      .prepare('SELECT spec_json FROM lms_course_versions WHERE id=?')
      .bind(course.versionId)
      .first(),
    published,
  );
  await assert.rejects(() =>
    db
      .prepare('UPDATE lms_question_versions SET category=? WHERE question_id=?')
      .bind('tamper', first.id)
      .run(),
  );
  await assert.rejects(() => bank.attach({ ...attach, items: [null] as never }, command()), {
    code: 'INVALID_REQUEST',
  });
  const exported = await bank.exportQuestions(
    { source: 'course', kind: 'quiz', courseId: course.id },
    command(),
  );
  assert.equal(exported.entries.length, 3);
  const audit = (
    await db
      .prepare("SELECT details FROM aio_audit WHERE action LIKE 'questions.%'")
      .all<{ details: string }>()
  ).results;
  assert.ok(audit.length);
  assert.equal(
    audit.some((row) => /correctAnswer|answerKey|explanation|Phương án/.test(row.details)),
    false,
  );
  let denied = false;
  const live = new QuestionBank(
    db,
    async () => {
      if (denied) throw new LmsError(403, 'APPLICATION_ACCESS_DENIED');
      return administrator;
    },
    directory,
  );
  const exportKey = command(),
    exportInput = { source: 'course' as const, kind: 'quiz' as const, courseId: course.id };
  await live.exportQuestions(exportInput, exportKey);
  denied = true;
  await assert.rejects(() => live.exportQuestions(exportInput, exportKey), {
    code: 'APPLICATION_ACCESS_DENIED',
  });
});
async function completedAttempt(service: Courses, versionId: string, passed = true) {
  const progress = await service.saveProgress(
    { versionId, expectedRevision: 0, position: 30 },
    command(),
  );
  const checkpoint = await service.checkpoint(
    { versionId, expectedRevision: progress.revision, questionId: 'cp1', answer: 0 },
    command(),
  );
  await service.saveProgress(
    { versionId, expectedRevision: checkpoint.revision, position: 30 },
    command(),
  );
  return service.submit(
    { versionId, answers: { q1: passed ? 1 : 0, q2: [0, 2], q3: 'an toàn' }, tabSwitchCount: 0 },
    command(),
  );
}
const currentSubjects = async (accountIds: string[]) =>
  [administrator, student, otherStudent, foreign, outside]
    .filter((actor) => accountIds.includes(actor.principal.accountId))
    .map((actor) => ({
      accountId: actor.principal.accountId,
      personId: actor.link.person_id,
      tenantId: actor.link.tenant_id,
      orgUnitId: actor.link.org_unit_id,
    }));
test('Certificates require a real passing attempt, retain snapshots, and issue once through atomic audit/receipt', async () => {
  const course = await makeCourse();
  const failed = await completedAttempt(learn, course.versionId, false);
  await assert.rejects(() => learn.issueCertificate(failed.id, command()), {
    code: 'LMS_CERTIFICATE_NOT_ELIGIBLE',
  });
  const passed = await learn.submit(
    {
      versionId: course.versionId,
      answers: { q1: 1, q2: [0, 2], q3: 'an toàn' },
      tabSwitchCount: 0,
    },
    command(),
  );
  const other = new Courses(db, async () => otherStudent, directory);
  await assert.rejects(() => other.issueCertificate(passed.id, command()), {
    code: 'LMS_ATTEMPT_NOT_FOUND',
  });
  await db
    .prepare(
      "CREATE TRIGGER certificate_test_audit_failure BEFORE INSERT ON aio_audit WHEN NEW.action='learning.certificate_issued' BEGIN SELECT RAISE(ABORT,'CERT_AUDIT_FAILURE'); END",
    )
    .run();
  try {
    await assert.rejects(() => learn.issueCertificate(passed.id, command()));
    assert.equal(
      await db.prepare('SELECT id FROM lms_certificates WHERE id=?').bind(passed.id).first(),
      null,
    );
  } finally {
    await db.prepare('DROP TRIGGER certificate_test_audit_failure').run();
  }
  const key = command();
  const requestIds: [string, string] = [randomUUID(), randomUUID()];
  const issue = (requestId: string) =>
    new Courses(db, async () => ({ ...student, requestId }), directory).issueCertificate(
      passed.id,
      key,
    );
  const [first, second] = await Promise.all([issue(requestIds[0]), issue(requestIds[1])]);
  assert.deepEqual(first, second);
  const audit = await db
    .prepare(
      "SELECT request_id FROM aio_audit WHERE action='learning.certificate_issued' AND request_id IN (?,?,?)",
    )
    .bind(...requestIds, key.key)
    .all<{ request_id: string }>();
  assert.equal(audit.results.length, 1);
  assert.ok(requestIds.includes(audit.results[0]!.request_id));
  const achievements = new Achievements(db, async () => student, currentSubjects);
  const certificate = await achievements.certificate(first.code);
  assert.equal(certificate.courseTitle, spec().title);
  assert.equal(certificate.completedAt, passed.createdAt);
  assert.equal(certificate.score, 100);
  assert.equal(certificate.checksum, passed.checksum);
  await Promise.all([
    learn.issueCertificate(passed.id, command()),
    learn.issueCertificate(passed.id, command()),
  ]);
  assert.deepEqual(await achievements.certificate(first.code), certificate);
  await admin.setStatus(course.id, course.revision, 'archived', command());
  assert.deepEqual(await achievements.certificate(first.code), certificate);
  await assert.rejects(
    () => new Achievements(db, async () => otherStudent, currentSubjects).certificate(first.code),
    { code: 'LMS_CERTIFICATE_NOT_FOUND' },
  );
  await assert.rejects(
    () => new Achievements(db, async () => foreign, currentSubjects).certificate(first.code),
    { code: 'LMS_CERTIFICATE_NOT_FOUND' },
  );
  assert.deepEqual(
    await new Achievements(db, async () => administrator, currentSubjects).certificate(first.code),
    certificate,
  );
  await assert.rejects(
    () =>
      new Achievements(
        db,
        async () => administrator,
        async () => [],
      ).certificate(first.code),
    { code: 'LMS_CERTIFICATE_NOT_FOUND' },
  );
  await assert.rejects(() =>
    db.prepare('UPDATE lms_certificates SET code=? WHERE id=?').bind('forged', passed.id).run(),
  );
  await assert.rejects(() =>
    db.prepare('DELETE FROM lms_certificates WHERE id=?').bind(passed.id).run(),
  );
  let revoked = false;
  const live = new Achievements(
    db,
    async () => {
      if (revoked) throw new LmsError(403, 'APPLICATION_ACCESS_DENIED');
      return student;
    },
    currentSubjects,
  );
  await live.certificate(first.code);
  revoked = true;
  await assert.rejects(() => live.certificate(first.code), { code: 'APPLICATION_ACCESS_DENIED' });
});
test('Unit ranking uses best result once per course, shared ties, live subjects and no peer answers', async () => {
  const course = await makeCourse(),
    other = new Courses(db, async () => otherStudent, directory);
  await completedAttempt(learn, course.versionId);
  await completedAttempt(other, course.versionId);
  const achievements = new Achievements(db, async () => student, currentSubjects);
  const before = await achievements.ranking({});
  await learn.submit(
    {
      versionId: course.versionId,
      answers: { q1: 1, q2: [0, 2], q3: 'an toàn' },
      tabSwitchCount: 0,
    },
    command(),
  );
  const next = await admin.publish(course.id, course.revision, command());
  await completedAttempt(learn, next.versionId);
  assert.deepEqual(await achievements.ranking({}), before);
  const ties = new Achievements(
    db,
    async () => student,
    async (ids) =>
      (await currentSubjects(ids)).filter(
        (row) =>
          row.accountId === otherStudent.principal.accountId ||
          row.accountId === student.principal.accountId,
      ),
  );
  const rows = await ties.ranking({});
  assert.equal(
    rows.items.some((row) => 'answers' in row || 'snapshot' in row || 'account_id' in row),
    false,
  );
  await completedAttempt(admin, course.versionId);
  const shared = new Achievements(
    db,
    async () => administrator,
    async (ids) =>
      (await currentSubjects(ids)).filter(
        (row) =>
          row.accountId === administrator.principal.accountId ||
          row.accountId === otherStudent.principal.accountId,
      ),
  );
  assert.deepEqual(
    (await shared.ranking({})).items.map((row) => row.rank),
    [1, 1],
  );
  const none = new Achievements(
    db,
    async () => student,
    async () => [],
  );
  assert.equal((await none.ranking({})).items.length, 0);
  await assert.rejects(() => achievements.ranking({ orgUnitId: otherUnit }), {
    code: 'LMS_PERMISSION_DENIED',
  });
  await assert.rejects(() => achievements.ranking({ page: '0' }), { code: 'INVALID_REQUEST' });
  const stale = new Achievements(
    db,
    async () => student,
    async (ids) => (await currentSubjects(ids)).map((row) => ({ ...row, orgUnitId: otherUnit })),
  );
  assert.equal((await stale.ranking({})).items.length, 0);
  const same = new Achievements(
    db,
    async () => student,
    async (ids) =>
      (await currentSubjects(ids)).filter((row) => row.accountId === student.principal.accountId),
  );
  assert.equal((await same.ranking({ search: student.link.code })).items.length, 1);
  assert.equal((await same.ranking({ page: '2' })).items.length, 0);
});
test('Course validation rejects answer leakage, broken references and ambiguous grading inputs', () => {
  const source = spec();
  assert.deepEqual(parseCourse(source, true), source);
  assert.equal('answerKey' in publicCourse(source), false);
  assert.equal(gradeCourse(source, { q1: 1, q2: [2, 0], q3: '  AN   TOÀN ' }).score, 100);
  assert.equal(gradeCourse(source, { q1: 1, q2: [2, 0], q3: 'an' }).score, 67);
  assert.throws(
    () => gradeCourse(source, { q1: 1, q2: [0, 0], q3: 'an toàn' }),
    CourseValidationError,
  );
  for (const change of [
    { ...source, questions: [...source.questions, source.questions[0]] },
    { ...source, answerKey: { ...source.answerKey, q1: { answer: 9, explanation: '' } } },
    { ...source, video: { kind: 'file', id: '../../unsafe' } },
    { ...source, deadline: '2026-02-30' },
    { ...source, checkpoints: [{ ...source.checkpoints[0], time: 40 }] },
    { ...source, audienceUnits: [] },
    { ...source, questions: [], answerKey: { cp1: source.answerKey.cp1 } },
  ])
    assert.throws(() => parseCourse(change, true), CourseValidationError);
});
test('Course draft/version ownership, tenant scope, revision and idempotency are enforced', async () => {
  const input = {
      code: 'draft-' + randomUUID().slice(0, 8),
      ownerUnitId: unit,
      expectedRevision: 0,
      spec: spec(),
    },
    key = command();
  const saved = await admin.save(input, key);
  assert.deepEqual(await admin.save(input, key), saved);
  await assert.rejects(() => admin.save({ ...input, code: 'changed' }, key), {
    code: 'IDEMPOTENCY_KEY_REUSED',
  });
  const published = await admin.publish(saved.id, 1, command());
  await assert.rejects(
    () => admin.save({ ...input, courseId: saved.id, expectedRevision: 1 }, command()),
    { code: 'REVISION_CONFLICT' },
  );
  const foreignAdmin = new Courses(db, async () => foreign, directory);
  await assert.rejects(() => foreignAdmin.publish(saved.id, 2, command()), {
    code: 'LMS_COURSE_NOT_FOUND',
  });
  await assert.rejects(() => learn.save(input, command()), { code: 'LMS_PERMISSION_DENIED' });
  const scoped = new Courses(db, async () => outside, directory);
  await assert.rejects(() => scoped.detail(published.versionId), {
    code: 'LMS_COURSE_UNAVAILABLE',
  });
  assert.equal(
    (await scoped.list()).items.some((c) => c.id === saved.id),
    false,
  );
  assert.equal('answerKey' in (await learn.detail(published.versionId)).spec, false);
  await assert.rejects(() =>
    db
      .prepare('UPDATE lms_course_versions SET checksum=? WHERE id=?')
      .bind('tamper', published.versionId)
      .run(),
  );
  await assert.rejects(() =>
    db
      .prepare('UPDATE lms_courses SET tenant_id=? WHERE id=?')
      .bind(foreign.link.tenant_id, saved.id)
      .run(),
  );
});
test('Learning gates checkpoints, grades server-side, retries once, and preserves attempt snapshot', async () => {
  const course = await makeCourse(),
    versionId = course.versionId;
  await assert.rejects(
    () =>
      learn.submit(
        { versionId, answers: { q1: 1, q2: [0, 2], q3: 'an toàn' }, tabSwitchCount: 0 },
        command(),
      ),
    { code: 'LMS_LEARNING_INCOMPLETE' },
  );
  await assert.rejects(
    () =>
      learn.checkpoint({ versionId, expectedRevision: 0, questionId: 'cp1', answer: 0 }, command()),
    { code: 'LMS_CHECKPOINT_NOT_REACHED' },
  );
  const first = await learn.saveProgress(
    { versionId, expectedRevision: 0, position: 30 },
    command(),
  );
  assert.equal(first.position, 10);
  assert.equal(first.finished, false);
  const answered = await learn.checkpoint(
    { versionId, expectedRevision: first.revision, questionId: 'cp1', answer: 0 },
    command(),
  );
  assert.equal(answered.correct, true);
  const p = { versionId, expectedRevision: answered.revision, position: 30 },
    pkey = command();
  const completed = await learn.saveProgress(p, pkey);
  assert.equal(completed.finished, true);
  assert.deepEqual(await learn.saveProgress(p, pkey), completed);
  const submit = { versionId, answers: { q1: 1, q2: [2, 0], q3: 'an toàn' }, tabSwitchCount: 0 },
    key = command();
  const result = await learn.submit(submit, key);
  assert.equal(result.score, 100);
  assert.deepEqual(await learn.submit(submit, key), result);
  assert.equal(
    (await db
      .prepare('SELECT COUNT(*) AS count FROM lms_attempts WHERE employee_id=? AND version_id=?')
      .bind(student.link.employee_id, versionId)
      .first<{ count: number }>())!.count,
    1,
  );
  const changed = spec();
  changed.title = 'Tiêu đề sửa sau';
  changed.answerKey.q1 = { answer: 0, explanation: 'Đáp án mới' };
  const courseRow = await db
    .prepare('SELECT code FROM lms_courses WHERE id=?')
    .bind(course.id)
    .first<{ code: string }>();
  await admin.save(
    {
      courseId: course.id,
      code: courseRow!.code,
      ownerUnitId: unit,
      expectedRevision: 2,
      spec: changed,
    },
    command(),
  );
  await admin.publish(course.id, 3, command());
  const old = await learn.attempt(result.id);
  assert.equal(old.lessonTitle, 'Khóa học nghiệm thu');
  assert.equal(old.score, 100);
  assert.equal((old.review as { correctAnswer: unknown }[])[0]!.correctAnswer, 1);
  const another = new Courses(db, async () => otherStudent, directory);
  await assert.rejects(() => another.attempt(result.id), { code: 'LMS_ATTEMPT_NOT_FOUND' });
});
test('Course transaction rolls back mutation when audit fails; concurrent edits cannot overwrite', async () => {
  const course = await makeCourse();
  await db
    .prepare(
      "CREATE TRIGGER course_test_audit_failure BEFORE INSERT ON aio_audit WHEN NEW.action='course.status_changed' BEGIN SELECT RAISE(ABORT,'COURSE_AUDIT_FAILURE'); END",
    )
    .run();
  try {
    await assert.rejects(() => admin.setStatus(course.id, course.revision, 'archived', command()));
    assert.equal(
      (await db
        .prepare('SELECT status FROM lms_courses WHERE id=?')
        .bind(course.id)
        .first<{ status: string }>())!.status,
      'active',
    );
  } finally {
    await db.prepare('DROP TRIGGER course_test_audit_failure').run();
  }
  const results = await Promise.allSettled([
    admin.setStatus(course.id, course.revision, 'archived', command()),
    admin.setStatus(course.id, course.revision, 'archived', command()),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    results.filter((r) => r.status === 'rejected' && r.reason.code === 'REVISION_CONFLICT').length,
    1,
  );
  await assert.rejects(() => learn.detail(course.versionId), { code: 'LMS_COURSE_UNAVAILABLE' });
});
test('Notes are owned by the learner; revoked session is checked inside the write transaction', async () => {
  const course = await makeCourse(),
    versionId = course.versionId;
  const note = await learn.addNote({ versionId, time: 5, content: 'Ghi chú riêng' }, command());
  const another = new Courses(db, async () => otherStudent, directory);
  await assert.rejects(() => another.deleteNote(note.id, command()), { code: 'REVISION_CONFLICT' });
  assert.equal((await learn.detail(versionId)).notes.length, 1);
  const key = command();
  await learn.deleteNote(note.id, key);
  assert.deepEqual(await learn.deleteNote(note.id, key), { deleted: true });
  const doomed = actor('learner');
  const unauthorized = new Courses(db, async () => doomed, directory);
  await assert.rejects(
    () => unauthorized.addNote({ versionId, time: 0, content: 'Không được lưu' }, command()),
    { code: 'REVISION_CONFLICT' },
  );
  let allowed = true;
  const dynamic = new Courses(
    db,
    async () => {
      if (!allowed) throw new LmsError(403, 'APPLICATION_ACCESS_DENIED');
      return student;
    },
    directory,
  );
  const prior = command();
  const existing = await dynamic.addNote(
    { versionId, time: 0, content: 'Có quyền lúc tạo' },
    prior,
  );
  assert.ok(existing.id);
  allowed = false;
  await assert.rejects(
    () => dynamic.addNote({ versionId, time: 0, content: 'Có quyền lúc tạo' }, prior),
    { code: 'APPLICATION_ACCESS_DENIED' },
  );
});

test('Gradebook uses current Directory names and published versions; reviewer exports are scoped, audited and revocation-aware', async () => {
  const actors = [administrator, student, otherStudent, outside];
  let visible = actors;
  const reportDirectory = {
    ...directory,
    people: async (_tenant: string, accountIds: string[]) =>
      visible
        .filter((actor) => accountIds.includes(actor.principal.accountId))
        .map((actor) => ({
          accountId: actor.principal.accountId,
          personId: actor.link.person_id,
          displayName: 'Tên AIO ' + actor.link.code,
          units: [
            {
              id: actor.link.org_unit_id,
              name: 'Đơn vị AIO ' + actor.link.org_unit_id,
              employeeCodes: [actor.link.code],
            },
          ],
        })),
  };
  const reports = new Reports(db, async () => administrator, reportDirectory),
    course = await makeCourse();
  await assert.rejects(() => new Reports(db, async () => student, reportDirectory).gradebook({}), {
    code: 'LMS_PERMISSION_DENIED',
  });
  const initial = await reports.gradebook({ courseId: course.id });
  assert.equal(initial.items.length, 3);
  assert.equal(initial.summary.withRequired, 3);
  assert.equal(initial.summary.averageBestScore, null);
  assert.ok(initial.items.every((row) => row.name.startsWith('Tên AIO')));
  await completedAttempt(learn, course.versionId);
  const other = new Courses(db, async () => otherStudent, directory);
  await completedAttempt(other, course.versionId, false);
  const after = await reports.gradebook({ courseId: course.id });
  assert.equal(after.summary.completed, 1);
  assert.equal(after.summary.pending, 2);
  assert.equal(after.summary.averageBestScore, 84);
  assert.equal(after.summary.attempts, 2);
  assert.equal(
    after.items.find((row) => row.employeeId === student.link.employee_id)!.cells[0]!.watchedPct,
    100,
  );
  assert.equal(JSON.stringify(after).includes('correctAnswer'), false);
  assert.equal(JSON.stringify(after).includes('answerKey'), false);
  const scopedActor = {
    ...otherStudent,
    link: { ...otherStudent.link, role: 'manager' as const },
    principal: {
      ...otherStudent.principal,
      permissions: [
        ...otherStudent.principal.permissions,
        { tenantId: tenant, orgUnitId: unit, permission: 'lms:review' },
      ],
    },
  };
  await db
    .prepare("UPDATE employees SET role='manager' WHERE id=?")
    .bind(otherStudent.link.employee_id)
    .run();
  try {
    const reviewer = new Reports(db, async () => scopedActor, reportDirectory);
    await assert.rejects(() => reviewer.gradebook({ orgUnitId: otherUnit }), {
      code: 'LMS_PERMISSION_DENIED',
    });
    await assert.rejects(() => reviewer.learnerDetail(outside.link.employee_id, {}), {
      code: 'LMS_LEARNER_NOT_FOUND',
    });
    const key = command(),
      filter = { courseId: course.id },
      exported = await reviewer.exportReport(filter, key);
    assert.deepEqual(await reviewer.exportReport(filter, key), exported);
    const book = XLSX.read(reportWorkbook(exported.data, exported.issuedAt), { type: 'array' });
    assert.deepEqual(book.SheetNames, ['Tong_quan', 'Bang_diem', 'Chi_tiet', 'Don_vi']);
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets.Bang_diem!).length, 3);
    visible = actors.filter((actor) => actor !== student);
    await assert.rejects(() => reviewer.exportReport(filter, key), { code: 'LMS_REPORT_CHANGED' });
    assert.equal((await reviewer.gradebook(filter)).total, 2);
    visible = actors;
    await db
      .prepare(
        "CREATE TRIGGER report_test_audit_failure BEFORE INSERT ON aio_audit WHEN NEW.action='report.exported' BEGIN SELECT RAISE(ABORT,'REPORT_AUDIT_FAILURE'); END",
      )
      .run();
    const failedKey = command();
    try {
      await assert.rejects(() => reviewer.exportReport(filter, failedKey));
      assert.equal(
        await db
          .prepare('SELECT 1 FROM lms_course_receipts WHERE command_key=?')
          .bind(failedKey.key)
          .first(),
        null,
      );
    } finally {
      await db.prepare('DROP TRIGGER report_test_audit_failure').run();
    }
    const changed = await admin.publish(course.id, course.revision, command());
    const next = await reports.gradebook(filter);
    assert.equal(next.summary.completed, 0);
    assert.equal(next.summary.attempts, 0);
    assert.equal(next.items[0]!.cells[0]!.versionId, changed.versionId);
    assert.equal((await learn.history()).items.length > 0, true);
    await admin.setStatus(course.id, changed.revision, 'archived', command());
    await assert.rejects(() => reports.gradebook(filter), { code: 'LMS_COURSE_NOT_FOUND' });
  } finally {
    await db
      .prepare("UPDATE employees SET role='learner' WHERE id=?")
      .bind(otherStudent.link.employee_id)
      .run();
  }
  const optional = spec();
  optional.schemaVersion = 2;
  optional.video = { kind: 'gdrive', id: 'synthetic-drive-file-12345' };
  optional.isMandatory = false;
  optional.audienceUnits = [otherUnit];
  const saved = await admin.save(
    {
      code: 'optional-' + randomUUID().slice(0, 8),
      ownerUnitId: unit,
      expectedRevision: 0,
      spec: optional,
    },
    command(),
  );
  await admin.publish(saved.id, 1, command());
  const noRequired = await reports.gradebook({ courseId: saved.id });
  assert.equal(noRequired.total, 1);
  assert.equal(noRequired.summary.notRequired, 1);
  assert.equal(noRequired.summary.completed, 0);
  assert.equal(noRequired.summary.completionRate, null);
  assert.equal(noRequired.courses[0]!.tracking, 'self-confirmed');
});
