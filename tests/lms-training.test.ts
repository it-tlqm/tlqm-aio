import { Training } from '../src/lms/training.js';
import type { TrainingPathSpec } from '../src/lms/training-contracts.js';
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

const livePeople = [administrator, student, otherStudent, outside];
const liveDirectory = {
  ...directory,
  people: async (_tenant: string, ids: string[]) =>
    livePeople
      .filter((a) => ids.includes(a.principal.accountId))
      .map((a) => ({
        accountId: a.principal.accountId,
        personId: a.principal.personId,
        displayName: a.link.name,
        units: [
          {
            id: a.link.org_unit_id,
            name: 'Đơn vị ' + a.link.org_unit_id,
            employeeCodes: [a.link.code],
          },
        ],
      })),
};
const training = new Training(
  { prepare: (sql) => db.prepare(sql), batch: (s) => db.batch(s) },
  async () => administrator,
  liveDirectory,
);
const mine = new Training(
  { prepare: (sql) => db.prepare(sql), batch: (s) => db.batch(s) },
  async () => student,
  liveDirectory,
);
async function preparePath(audience = [unit]) {
  const courseSpec = spec();
  courseSpec.audienceUnits = audience;
  courseSpec.schemaVersion = 3;
  courseSpec.policy = {
    ...defaultLearningPolicy,
    requireVideoCompletion: false,
    checkpointPolicy: 'none',
  };
  const course = await admin.save(
    {
      code: 'path-course-' + randomUUID().slice(0, 8),
      ownerUnitId: unit,
      expectedRevision: 0,
      spec: courseSpec,
    },
    command(),
  );
  const version = await admin.publish(course.id, course.revision, command());
  const draft: TrainingPathSpec = {
    schemaVersion: 1,
    title: 'Lộ trình giả lập',
    description: 'Hướng dẫn',
    courseVersionIds: [version.versionId],
    audienceUnits: audience,
  };
  const saved = await training.savePath({ expectedRevision: 0, spec: draft }, command()),
    published = await training.publishPath(saved.id, saved.revision, command());
  return { course, courseSpec, version, draft, saved, published };
}
const batchInput = (versionId: string, accountIds = [student.principal.accountId]) => ({
  pathVersionId: versionId,
  ownerUnitId: unit,
  title: 'Đợt đào tạo giả lập',
  startsAt: Date.now() - 10000,
  dueAt: Date.now() + 86400000,
  accountIds,
});
test('path drafts, immutable versions and batch enrollment are explicit, revisioned and idempotent', async () => {
  const p = await preparePath(),
    input = batchInput(p.published.versionId),
    key = command();
  const b = await training.createBatch(input, key);
  assert.deepEqual(await training.createBatch(input, key), b);
  assert.equal((await mine.batches()).items.find((v) => v.id === b.id)?.members.length, 1);
  await assert.rejects(training.publishPath(p.saved.id, p.saved.revision, command()), {
    code: 'REVISION_CONFLICT',
  });
  await assert.rejects(
    db
      .prepare("UPDATE lms_learning_path_versions SET checksum='bad' WHERE id=?")
      .bind(p.published.versionId)
      .run(),
  );
  await assert.rejects(
    db
      .prepare('UPDATE lms_training_enrollments SET unit_id=? WHERE batch_id=?')
      .bind(otherUnit, b.id)
      .run(),
  );
  assert.equal((await training.paths()).items.find((x) => x.id === p.saved.id)?.version, 1);
});
test('learners cannot author or read another enrollment; reviewer sees only current permitted people', async () => {
  const p = await preparePath([unit, otherUnit]),
    b = await training.createBatch(
      batchInput(p.published.versionId, [student.principal.accountId, outside.principal.accountId]),
      command(),
    );
  const reviewer = {
    ...administrator,
    principal: {
      ...administrator.principal,
      permissions: [{ tenantId: tenant, orgUnitId: unit, permission: 'lms:review' }],
    },
  };
  const scoped = new Training(db, async () => reviewer, liveDirectory);
  assert.equal((await scoped.batch(b.id, true)).members.length, 1);
  assert.equal((await scoped.batch(b.id, true)).members[0]?.accountId, student.principal.accountId);
  const other = new Training(db, async () => otherStudent, liveDirectory);
  await assert.rejects(other.batch(b.id), { code: 'LMS_TRAINING_NOT_FOUND' });
  await assert.rejects(mine.paths(), { code: 'LMS_PERMISSION_DENIED' });
  await assert.rejects(mine.createBatch(batchInput(p.published.versionId), command()), {
    code: 'LMS_PERMISSION_DENIED',
  });
  await assert.rejects(new Training(db, async () => foreign, liveDirectory).batch(b.id, true), {
    code: 'LMS_TRAINING_NOT_FOUND',
  });
});
test('completion uses pinned passing snapshots, and schedule/cancel preserve learning history', async () => {
  const p = await preparePath(),
    b = await training.createBatch(
      { ...batchInput(p.published.versionId), dueAt: Date.now() - 1 },
      command(),
    );
  assert.equal((await mine.batch(b.id)).summary.overdue, 1);
  await learn.submit(
    {
      versionId: p.version.versionId,
      answers: { q1: 1, q2: [0, 2], q3: 'an toàn' },
      tabSwitchCount: 0,
    },
    command(),
  );
  assert.equal((await mine.batch(b.id)).members[0]?.completed, true);
  assert.equal((await mine.batch(b.id)).summary.overdue, 0);
  const before = await training.batch(b.id, true);
  const result = await training.updateBatch(
    {
      id: b.id,
      expectedRevision: before.revision,
      title: before.title,
      startsAt: before.startsAt,
      dueAt: before.dueAt,
      status: 'cancelled',
    },
    command(),
  );
  assert.equal(result.status, 'cancelled');
  await assert.rejects(mine.batch(b.id), { code: 'LMS_TRAINING_NOT_FOUND' });
  assert.equal((await training.batch(b.id, true)).members[0]?.completed, true);
  assert.equal(
    (await learn.history()).items.filter((a) => a.versionId === p.version.versionId).length,
    1,
  );
});
test('source people revocation removes report data and creation fails without eligible recipients', async () => {
  const p = await preparePath(),
    b = await training.createBatch(batchInput(p.published.versionId), command()),
    index = livePeople.indexOf(student);
  livePeople.splice(index, 1);
  try {
    assert.equal((await training.batch(b.id, true)).members.length, 0);
    await assert.rejects(training.createBatch(batchInput(p.published.versionId), command()), {
      code: 'LMS_TRAINING_PARTICIPANT_CHANGED',
    });
  } finally {
    livePeople.splice(index, 0, student);
  }
});
test('new path publications do not change old batches, and stale version cannot create a new batch', async () => {
  const p = await preparePath(),
    b = await training.createBatch(batchInput(p.published.versionId), command());
  const next = await training.savePath(
    {
      id: p.saved.id,
      expectedRevision: p.published.revision,
      spec: { ...p.draft, title: 'Bản mới' },
    },
    command(),
  );
  await training.publishPath(next.id, next.revision, command());
  assert.equal((await mine.batch(b.id)).pathTitle, p.draft.title);
  assert.equal((await mine.batch(b.id)).pathVersion, 1);
  await assert.rejects(training.createBatch(batchInput(p.published.versionId), command()), {
    code: 'LMS_TRAINING_VERSION_STALE',
  });
});
test('auditing failure rolls back batch and all memberships', async () => {
  const p = await preparePath(),
    before = await training.batches(true);
  await db
    .prepare(
      "CREATE TRIGGER fail_training_audit BEFORE INSERT ON aio_audit WHEN NEW.action='training.batch_created' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END",
    )
    .run();
  try {
    await assert.rejects(training.createBatch(batchInput(p.published.versionId), command()));
  } finally {
    await db.prepare('DROP TRIGGER fail_training_audit').run();
  }
  assert.equal((await training.batches(true)).items.length, before.items.length);
});

test('archived source cannot receive new batches and existing assigned work signals unavailable content', async () => {
  const p = await preparePath(),
    b = await training.createBatch(batchInput(p.published.versionId), command());
  await admin.setStatus(p.course.id, p.version.revision, 'archived', command());
  await assert.rejects(training.createBatch(batchInput(p.published.versionId), command()), {
    code: 'LMS_TRAINING_COURSE_UNAVAILABLE',
  });
  assert.equal((await mine.batch(b.id)).members[0]?.courses[0]?.available, false);
});
