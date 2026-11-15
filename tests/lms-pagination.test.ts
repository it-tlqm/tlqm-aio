import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { lmsMigrations } from '../src/lms/migrations.js';
import { Courses } from '../src/lms/courses.js';
import type { CourseActor } from '../src/lms/courses.js';
import type { D1Database } from '../src/lms/types.js';
import type { CourseSpec } from '../src/lms/course-contracts.js';
import { gradeCourse } from '../src/lms/course-contracts.js';
import { encodeListCursor, listCursor, legacyCursor } from '../src/lms/list-cursor.js';
test('List cursors validate shape and purpose without becoming authorization claims', () => {
  const id = randomUUID(),
    value = encodeListCursor('courses', [123, id]);
  assert.deepEqual(listCursor(value, 'courses'), [123, id]);
  for (const bad of [
    '',
    'not-json',
    encodeListCursor('media', [123, id]),
    encodeListCursor('courses', [-1, id]),
    encodeListCursor('courses', [123, 'bad']),
  ])
    assert.throws(() => listCursor(bad, 'courses'), { code: 'INVALID_CURSOR' });
  const legacy = encodeListCursor('legacy', ['legacy employee', 'progress-a']);
  assert.deepEqual(legacyCursor(legacy), ['legacy employee', 'progress-a']);
  assert.throws(() => legacyCursor(value), { code: 'INVALID_CURSOR' });
});
test('More than 500 tied-timestamp courses, media and attempts traverse complete pages with audience/tenant enforcement and live authorization', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("paging fixture")}}',
    host: '127.0.0.1',
    port: 0,
    d1Databases: ['DB'],
    log: new Log(LogLevel.NONE),
  });
  try {
    const db = (await mf.getD1Database('DB')) as unknown as D1Database;
    for (const migration of lmsMigrations)
      await db.batch(migration.statements.map((sql) => db.prepare(sql)));
    const tenant = randomUUID(),
      unit = randomUUID(),
      otherUnit = randomUUID(),
      employee = randomUUID(),
      account = randomUUID(),
      otherTenant = randomUUID();
    const actor: CourseActor = {
      sessionHash: 'fixture',
      link: {
        account_id: account,
        person_id: account,
        employee_id: employee,
        tenant_id: tenant,
        org_unit_id: unit,
        active: 1,
        auth_not_before: 0,
        name: 'Synthetic',
        code: 'fixture',
        department: 'Fixture',
        role: 'admin',
        credential_kind: 'sso-only',
      },
      principal: {
        version: 1,
        appCode: 'aio-lms-sandbox',
        issuer: 'http://127.0.0.1/fixture',
        subject: account,
        accountId: account,
        personId: account,
        displayName: 'Synthetic',
        tenantIds: [tenant],
        units: [{ tenantId: tenant, orgUnitId: unit }],
        permissions: ['lms:learn', 'lms:admin'].map((permission) => ({
          tenantId: tenant,
          orgUnitId: null,
          permission,
        })),
        authenticatedAt: 1,
        authenticationMethods: ['pwd', 'otp'],
        maxAgeSeconds: 0,
      },
    };
    const courses = new Courses(db, async () => actor, {
      units: async () => [],
      people: async () => [],
    });
    await db
      .prepare(
        "INSERT INTO employees(id,code,name,department,role,password_hash,credential_kind,created_at,updated_at) VALUES (?,?,'Synthetic','Fixture','learner',NULL,'sso-only','','')",
      )
      .bind(employee, employee)
      .run();
    const rows = [];
    for (let i = 0; i < 505; i++) {
      const course = randomUUID(),
        version = randomUUID(),
        media = randomUUID(),
        attempt = randomUUID();
      const spec: CourseSpec = {
        schemaVersion: 1,
        title: 'Course ' + String(i).padStart(3, '0'),
        subtitle: 'Paging fixture',
        series: 'Fixture',
        duration: 1,
        video: { kind: 'youtube', id: 'abcdefghijk' },
        deadline: '',
        isMandatory: false,
        audienceUnits: [i < 501 ? unit : otherUnit],
        checkpoints: [],
        questions: [{ id: 'q', type: 'single', question: 'Synthetic?', options: ['A', 'B'] }],
        answerKey: { q: { answer: 0, explanation: 'Synthetic' } },
        attachments: [],
      };
      rows.push(
        db
          .prepare(
            'INSERT INTO lms_courses(id,tenant_id,owner_unit_id,code,draft_json,published_version_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            course,
            tenant,
            unit,
            'course-' + i,
            JSON.stringify(spec),
            version,
            account,
            123,
            123,
          ),
        db
          .prepare(
            'INSERT INTO lms_course_versions(id,course_id,version,spec_json,checksum,published_by,published_at) VALUES (?,?,1,?,?,?,123)',
          )
          .bind(version, course, JSON.stringify(spec), 'fixture', account),
      );
      if (i < 501)
        rows.push(
          db
            .prepare(
              "INSERT INTO lms_media(id,tenant_id,owner_unit_id,kind,object_key,name,mime_type,size,sha256,created_by,created_at) VALUES (?,?,?,'video',?,?,'video/mp4',8,?,?,123)",
            )
            .bind(
              media,
              tenant,
              unit,
              'fixture/' + media,
              'Video ' + i,
              'synthetic-checksum',
              account,
            ),
          db
            .prepare(
              `INSERT INTO lms_attempts(id,employee_id,version_id,score,answers_json,snapshot_json,created_at) VALUES (?,?,?,100,'{"q":0}',?,123)`,
            )
            .bind(
              attempt,
              employee,
              version,
              JSON.stringify({
                schemaVersion: 1,
                lessonTitle: spec.title,
                series: spec.series,
                version: 1,
                checksum: 'fixture',
                tabSwitchCount: 0,
                ...gradeCourse(spec, { q: 0 }),
              }),
            ),
        );
    }
    for (let offset = 0; offset < rows.length; offset += 100)
      await db.batch(rows.slice(offset, offset + 100));
    const collect = async <T extends { id: string }>(
      get: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
    ) => {
      const result: T[] = [],
        seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await get(cursor);
        assert.ok(page.items.length <= 100);
        result.push(...page.items);
        if (!page.nextCursor) break;
        assert.equal(seen.has(page.nextCursor), false);
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (true);
      assert.equal(new Set(result.map((r) => r.id)).size, result.length);
      return result;
    };
    const publicRows = await collect((cursor) => courses.list(false, cursor));
    assert.equal(publicRows.length, 501);
    assert.equal(
      publicRows.every((r) => !('answerKey' in r.spec)),
      true,
    );
    assert.equal((await collect((cursor) => courses.list(true, cursor))).length, 505);
    assert.equal((await collect((cursor) => courses.mediaList(cursor))).length, 501);
    assert.equal((await collect((cursor) => courses.history(cursor))).length, 501);
    const first = await courses.list();
    actor.principal.permissions = [];
    await assert.rejects(() => courses.list(false, first.nextCursor!), {
      code: 'LMS_PERMISSION_DENIED',
    });
    actor.link.tenant_id = otherTenant;
    actor.principal.tenantIds = [otherTenant];
    actor.principal.permissions = ['lms:learn', 'lms:admin'].map((permission) => ({
      tenantId: otherTenant,
      orgUnitId: null,
      permission,
    }));
    assert.equal((await courses.list(true, first.nextCursor!)).items.length, 0);
    assert.equal((await courses.mediaList()).items.length, 0);
    assert.equal((await courses.history()).items.length, 0);
  } finally {
    await mf.dispose();
  }
});
