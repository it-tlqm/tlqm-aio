import { randomUUID } from 'node:crypto';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { localLmsConfig, migrateLms } from '../../scripts/lms-local.js';
import type { D1Database } from '../../src/lms/types.js';
import type { CourseActor } from '../../src/lms/courses.js';
import { TrainingNotices } from '../../src/lms/training-notices.js';
import { defaultLearningPolicy } from '../../src/lms/learning-policy.js';
export async function trainingFixture() {
  const config = await localLmsConfig(true),
    mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      host: '127.0.0.1',
      port: 0,
      d1Databases: ['DB'],
      log: new Log(LogLevel.NONE),
    }),
    db = (await mf.getD1Database('DB')) as unknown as D1Database,
    tenant = randomUUID(),
    unit = randomUUID();
  await migrateLms(db, config);
  const create = async (admin = false): Promise<CourseActor> => {
    const accountId = randomUUID(),
      personId = randomUUID(),
      employeeId = randomUUID(),
      sessionHash = randomUUID(),
      now = Date.now(),
      authenticatedAt = Math.floor(now / 1000);
    await db.batch([
      db
        .prepare(
          "INSERT INTO employees(id,code,name,department,role,password_hash,credential_kind,created_at,updated_at) VALUES(?,?,?,'Đơn vị giả lập',?,NULL,'sso-only','','')",
        )
        .bind(employeeId, 'DEMO-' + employeeId, 'Học viên giả lập', admin ? 'admin' : 'learner'),
      db
        .prepare(
          'INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by) VALUES(?,?,?,?,?,?,?)',
        )
        .bind(accountId, personId, employeeId, tenant, unit, now, accountId),
      db
        .prepare(
          'INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES(?,?,?,?,?)',
        )
        .bind(config.issuer, accountId, accountId, now, accountId),
      db
        .prepare(
          'INSERT INTO aio_sessions(hash,account_id,employee_id,issuer,subject,sid,authenticated_at,encrypted_payload,created_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          sessionHash,
          accountId,
          employeeId,
          config.issuer,
          accountId,
          randomUUID(),
          authenticatedAt,
          'isolated-domain-test',
          now,
          now + 900000,
          now + 3600000,
        ),
    ]);
    return {
      sessionHash,
      principal: {
        version: 1,
        appCode: config.clientId,
        issuer: config.issuer,
        subject: accountId,
        accountId,
        personId,
        displayName: 'Học viên giả lập',
        tenantIds: [tenant],
        units: [{ tenantId: tenant, orgUnitId: unit }],
        permissions: [
          { tenantId: tenant, orgUnitId: null, permission: 'lms:learn' },
          ...(admin ? [{ tenantId: tenant, orgUnitId: null, permission: 'lms:admin' }] : []),
        ],
        authenticatedAt,
        authenticationMethods: admin ? ['pwd', 'otp'] : ['pwd'],
        maxAgeSeconds: 0,
      },
      link: {
        account_id: accountId,
        person_id: personId,
        employee_id: employeeId,
        tenant_id: tenant,
        org_unit_id: unit,
        active: 1,
        auth_not_before: 0,
        name: 'Học viên giả lập',
        code: 'DEMO-' + employeeId,
        department: 'Đơn vị giả lập',
        role: admin ? 'admin' : 'learner',
        credential_kind: 'sso-only',
      },
    };
  };
  const administrator = await create(true),
    student = await create(),
    other = await create(),
    actors = [administrator, student, other],
    directory = {
      units: async () => [
        {
          id: unit,
          name: 'Đơn vị giả lập',
          code: 'DEMO',
          legalEntityId: tenant,
          legalEntityName: 'Đơn vị thử',
        },
      ],
      people: async (_tenant: string, ids: string[]) =>
        actors
          .filter((a) => ids.includes(a.principal.accountId))
          .map((a) => ({
            accountId: a.principal.accountId,
            personId: a.principal.personId,
            displayName: a.principal.displayName,
            units: [{ id: unit, name: 'Đơn vị giả lập', employeeCodes: [a.link.code] }],
          })),
    },
    admin = new TrainingNotices(db, async () => administrator, directory),
    learn = new TrainingNotices(db, async () => student, directory),
    command = () => ({ key: randomUUID(), reason: 'Nghiệm thu đào tạo giả lập' });
  const makeBatch = async (dueAt = Date.now() + 30000) => {
    const saved = await admin.save(
        {
          code: 'reminder-' + randomUUID().slice(0, 8),
          ownerUnitId: unit,
          expectedRevision: 0,
          spec: {
            schemaVersion: 3,
            title: 'Khóa học ' + randomUUID().slice(0, 6),
            subtitle: 'Nội dung giả lập',
            series: 'TLQM',
            duration: 10,
            video: { kind: 'youtube', id: 'abcdefghijk' },
            deadline: '',
            isMandatory: true,
            audienceUnits: [unit],
            checkpoints: [],
            questions: [
              { id: 'q', type: 'single', question: 'Quy tắc giả lập?', options: ['Đúng', 'Sai'] },
            ],
            answerKey: { q: { answer: 0, explanation: 'Đã đối chiếu' } },
            attachments: [],
            policy: {
              ...defaultLearningPolicy,
              requireVideoCompletion: false,
              checkpointPolicy: 'none',
            },
          },
        },
        command(),
      ),
      course = await admin.publish(saved.id, saved.revision, command()),
      path = await admin.savePath(
        {
          expectedRevision: 0,
          spec: {
            schemaVersion: 1,
            title: 'Lộ trình nhắc hạn',
            description: 'Dữ liệu thử',
            audienceUnits: [unit],
            courseVersionIds: [course.versionId],
          },
        },
        command(),
      ),
      published = await admin.publishPath(path.id, path.revision, command()),
      input = {
        title: 'Đợt đào tạo ' + randomUUID().slice(0, 6),
        pathVersionId: published.versionId,
        ownerUnitId: unit,
        startsAt: Date.now() - 86400000,
        dueAt,
        accountIds: [student.principal.accountId],
      },
      batch = await admin.createBatch(input, command());
    return { batch, input, course };
  };
  return {
    db,
    mf,
    config,
    tenant,
    unit,
    administrator,
    student,
    other,
    directory,
    admin,
    learn,
    command,
    makeBatch,
  };
}
