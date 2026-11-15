import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { lmsMigrations } from '../src/lms/migrations.js';
import { learnerMigration } from '../src/lms/learner-migration.js';
import type { D1Database } from '../src/lms/types.js';

const preserved = [
  'employees',
  'sessions',
  'learning_progress',
  'learning_attempts',
  'learning_notes',
  'aio_account_links',
  'aio_external_links',
  'aio_sessions',
  'lms_progress',
  'lms_attempts',
  'lms_notes',
  'lms_certificates',
  'aio_audit',
  'aio_receipts',
];
const employeeColumns =
  'id,code,name,department,role,password_hash,must_change_password,is_active,created_at,updated_at';
async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("migration test")}}',
    host: '127.0.0.1',
    port: 0,
    d1Databases: ['DB'],
    log: new Log(LogLevel.NONE),
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const migration of lmsMigrations.filter((m) => m.version < '006'))
    await db.batch(migration.statements.map((sql) => db.prepare(sql)));
  await db.batch([
    db.prepare(
      "INSERT INTO employees VALUES ('old','LEGACY','Học viên giả lập','Lịch sử đơn vị','learner','synthetic-preserved-hash',1,1,'2020','2021')",
    ),
    db.prepare(
      "INSERT INTO employees VALUES ('inactive','INACTIVE','Hồ sơ nghỉ','Lịch sử cũ','manager','synthetic-inactive-hash',0,0,'2019','2020')",
    ),
    db.prepare("INSERT INTO sessions VALUES ('legacy-session','old','2030','2020')"),
    db.prepare("INSERT INTO learning_progress VALUES ('lp','old','old-lesson',4,5,'{}',0,'2020')"),
    db.prepare(
      "INSERT INTO learning_attempts VALUES ('la','old','old-lesson','{}',90,'{}','2020')",
    ),
    db.prepare("INSERT INTO learning_notes VALUES ('ln','old','old-lesson',3,'Ghi chú cũ','2020')"),
    db.prepare(
      "INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by) VALUES ('account','person','old','tenant','unit',1,'operator')",
    ),
    db.prepare(
      "INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES ('http://127.0.0.1/fixture','subject','account',1,'operator')",
    ),
    db.prepare(
      "INSERT INTO aio_sessions(hash,account_id,employee_id,issuer,subject,sid,authenticated_at,encrypted_payload,created_at,idle_expires_at,absolute_expires_at) VALUES ('session','account','old','http://127.0.0.1/fixture','subject','sid',1,'synthetic-test-payload',1,10,20)",
    ),
    db.prepare(
      "INSERT INTO lms_courses(id,tenant_id,owner_unit_id,code,draft_json,created_by,created_at,updated_at) VALUES ('course','tenant','unit','course','{}','account',0,0)",
    ),
    db.prepare(
      "INSERT INTO lms_course_versions VALUES ('version','course',1,'{}','synthetic-checksum','account',0)",
    ),
    db.prepare(
      "INSERT INTO lms_progress(id,employee_id,version_id,position,watched,answers_json,updated_at) VALUES ('progress','old','version',8,9,'{}',4)",
    ),
    db.prepare(
      "INSERT INTO lms_attempts(id,employee_id,version_id,score,answers_json,snapshot_json,created_at) VALUES ('attempt','old','version',100,'{}','{}',4)",
    ),
    db.prepare("INSERT INTO lms_notes VALUES ('note','old','version',3,'Ghi chú mới',4)"),
    db.prepare("INSERT INTO lms_certificates VALUES ('attempt','old','tenant','CERT','{}',4)"),
    db.prepare(
      "INSERT INTO aio_audit(event_id,occurred_at,action,reason,request_id) VALUES ('old-audit',1,'fixture','Synthetic migration fixture','request')",
    ),
    db.prepare("INSERT INTO aio_receipts VALUES ('account','request','synthetic-checksum','{}')"),
  ]);
  return { mf, db };
}
async function snapshot(db: D1Database) {
  return Promise.all(
    preserved.map(async (table) => [
      table,
      (
        await db
          .prepare(
            'SELECT ' +
              (table === 'employees' ? employeeColumns : '*') +
              ' FROM ' +
              table +
              ' ORDER BY 1',
          )
          .all()
      ).results,
    ]),
  );
}
const migrate = (db: D1Database) =>
  db.batch(learnerMigration.statements.map((sql) => db.prepare(sql)));

test('006 preserves all legacy/new history, sessions and ownership; SSO-only has no credential and guards remain enforced', async () => {
  const { mf, db } = await fixture();
  try {
    const before = await snapshot(db);
    await migrate(db);
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
    assert.equal(await db.prepare('SELECT count(*) n FROM lms_write_guards').first('n'), 0);
    assert.equal(
      await db
        .prepare("SELECT credential_kind FROM employees WHERE id='old'")
        .first('credential_kind'),
      'legacy-retained',
    );
    await db
      .prepare(
        "INSERT INTO employees(id,code,name,department,role,password_hash,credential_kind,created_at,updated_at) VALUES ('sso','SSO','SSO giả lập','Đơn vị','learner',NULL,'sso-only','2026','2026')",
      )
      .run();
    assert.equal(
      await db.prepare("SELECT password_hash FROM employees WHERE id='sso'").first('password_hash'),
      null,
    );
    for (const sql of [
      "UPDATE employees SET password_hash='changed' WHERE id='old'",
      "UPDATE employees SET must_change_password=0 WHERE id='old'",
      "UPDATE employees SET credential_kind='legacy-retained',password_hash='dummy' WHERE id='sso'",
      "UPDATE employees SET password_hash='dummy' WHERE id='sso'",
      "DELETE FROM employees WHERE id='old'",
      "UPDATE aio_account_links SET employee_id='sso' WHERE account_id='account'",
      "UPDATE aio_external_links SET subject='other' WHERE account_id='account'",
      "UPDATE lms_attempts SET score=0 WHERE id='attempt'",
      "DELETE FROM lms_certificates WHERE id='attempt'",
      "INSERT INTO lms_notes VALUES ('bad','missing','version',3,'invalid',0)",
    ])
      await assert.rejects(() => db.prepare(sql).run());
    // Recreated session guard still rejects disabled employees and revokes an already-open session.
    await db.prepare("UPDATE employees SET is_active=0 WHERE id='old'").run();
    assert.equal(await db.prepare('SELECT count(*) n FROM aio_sessions').first('n'), 0);
    assert.ok(
      Number(
        await db.prepare('SELECT auth_not_before FROM aio_account_links').first('auth_not_before'),
      ) > 0,
    );
    await assert.rejects(() =>
      db
        .prepare(
          "INSERT INTO aio_sessions(hash,account_id,employee_id,issuer,subject,sid,authenticated_at,encrypted_payload,created_at,idle_expires_at,absolute_expires_at) VALUES ('rejected','account','old','http://127.0.0.1/fixture','subject','sid',9999999999,'fixture',1,10,20)",
        )
        .run(),
    );
  } finally {
    await mf.dispose();
  }
});

test('006 failure after copy, drop, rename or guard restoration rolls back complete schema and data', async () => {
  const { mf, db } = await fixture();
  try {
    const before = await snapshot(db),
      schema = (
        await db
          .prepare(
            "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
      ).results;
    for (const cut of [5, 7, 8, 12]) {
      await assert.rejects(() =>
        db.batch([
          ...learnerMigration.statements.slice(0, cut).map((sql) => db.prepare(sql)),
          db.prepare("INSERT INTO lms_write_guards VALUES ('injected-migration-failure',0)"),
        ]),
      );
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual(
        (
          await db
            .prepare(
              "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all()
        ).results,
        schema,
      );
      assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
      await assert.rejects(() =>
        db.prepare("INSERT INTO lms_notes VALUES ('bad','missing','version',1,'invalid',0)").run(),
      );
    }
    await migrate(db);
    assert.deepEqual(await snapshot(db), before);
  } finally {
    await mf.dispose();
  }
});
