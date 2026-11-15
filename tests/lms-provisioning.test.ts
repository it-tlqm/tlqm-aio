import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Miniflare, Log, LogLevel } from 'miniflare';
import type { D1Database } from '../src/lms/types.js';
import { lmsMigrations } from '../src/lms/migrations.js';
import { Learners } from '../src/lms/learners.js';
import type { CourseActor } from '../src/lms/courses.js';
import type { LearnerDirectory } from '../src/lms/learner-directory.js';
import { LmsError } from '../src/lms/security.js';
import { requirePermission } from '../src/lms/access.js';
import type { IntegrationIdentity } from '../src/integration-identity-proof.js';

async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    host: '127.0.0.1',
    port: 0,
    d1Databases: ['DB'],
    log: new Log(LogLevel.NONE),
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const m of lmsMigrations) await db.batch(m.statements.map((sql) => db.prepare(sql)));
  const tenant = randomUUID(),
    unit = randomUUID(),
    otherUnit = randomUUID(),
    account = randomUUID(),
    employee = randomUUID(),
    person = randomUUID(),
    session = randomUUID();
  const actor: CourseActor = {
    sessionHash: session,
    link: {
      account_id: account,
      person_id: person,
      employee_id: employee,
      tenant_id: tenant,
      org_unit_id: unit,
      active: 1,
      auth_not_before: 0,
      name: 'Operator',
      code: 'OP',
      department: 'Test',
      role: 'learner',
      credential_kind: 'sso-only',
    },
    principal: {
      version: 1,
      appCode: 'aio-lms-sandbox',
      issuer: 'http://127.0.0.1/fixture',
      subject: account,
      accountId: account,
      personId: person,
      displayName: 'Operator',
      tenantIds: [tenant],
      units: [{ tenantId: tenant, orgUnitId: unit }],
      permissions: ['lms:admin', 'lms:learn', 'identity:provision', 'directory:lookup'].map(
        (permission) => ({ tenantId: tenant, orgUnitId: null, permission }),
      ),
      authenticatedAt: 1,
      authenticationMethods: ['pwd', 'otp'],
      maxAgeSeconds: 0,
    },
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO employees(id,code,name,department,role,password_hash,credential_kind,created_at,updated_at) VALUES (?,?,'Operator','Test','learner',NULL,'sso-only','','')",
      )
      .bind(employee, 'OP'),
    db
      .prepare(
        'INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by) VALUES (?,?,?,?,?,1,?)',
      )
      .bind(account, person, employee, tenant, unit, account),
    db
      .prepare(
        'INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES (?,?,?,1,?)',
      )
      .bind(actor.principal.issuer, account, account, account),
    db
      .prepare(
        "INSERT INTO aio_sessions(hash,account_id,employee_id,issuer,subject,sid,authenticated_at,encrypted_payload,created_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,'fixture',1,'fixture',1,?,?)",
      )
      .bind(
        session,
        account,
        employee,
        actor.principal.issuer,
        account,
        Date.now() + 600000,
        Date.now() + 600000,
      ),
  ]);
  const targets = new Map<string, IntegrationIdentity>(),
    units = [unit, otherUnit].map((id) => ({
      id,
      code: id,
      name: 'Unit ' + id,
      legalEntityId: tenant,
      legalEntityName: 'Fixture',
    }));
  let revoked = false,
    verifyCount = 0,
    revokeAt = 0;
  const directory: LearnerDirectory = {
    units: async () => units,
    people: async (_tenant, ids) =>
      revoked
        ? []
        : [...targets.values()]
            .filter((t) => ids.includes(t.accountId))
            .map((t) => ({
              accountId: t.accountId,
              personId: t.personId,
              displayName: t.displayName,
              units: [{ id: t.orgUnitId, name: t.unitName, employeeCodes: [] }],
            })),
    discover: async () => ({ items: [], nextCursor: null }),
    identity: async (query) => {
      verifyCount++;
      if (revoked || revokeAt === verifyCount)
        throw new LmsError(409, 'LMS_IDENTITY_TARGET_UNAVAILABLE');
      const target = targets.get(query.accountId);
      if (!target || target.tenantId !== query.tenantId || target.orgUnitId !== query.orgUnitId)
        throw new LmsError(409, 'LMS_IDENTITY_TARGET_UNAVAILABLE');
      return { ...target };
    },
  };
  const service = new Learners(db, async () => actor, directory);
  const add = () => {
    const id = randomUUID();
    const target = {
      accountId: id,
      personId: randomUUID(),
      tenantId: tenant,
      orgUnitId: unit,
      issuer: actor.principal.issuer,
      subject: randomUUID(),
      displayName: 'Học viên SSO',
      unitName: 'Đơn vị thử',
    };
    targets.set(id, target);
    return { accountId: id, orgUnitId: unit, expectedRevision: 0 };
  };
  return {
    mf,
    db,
    actor,
    service,
    add,
    targets,
    unit,
    otherUnit,
    setRevoked: (value: boolean) => {
      revoked = value;
    },
    revokeOnNextRecheck: () => {
      revokeAt = verifyCount + 2;
    },
  };
}
const command = () => ({ key: randomUUID(), reason: 'Nghiệm thu quản trị học viên' });
test('SSO provisioning is passwordless, idempotent, immutable and controlled by live IAM plus MFA', async () => {
  const f = await fixture();
  try {
    const data = f.add(),
      request = command(),
      created = await f.service.change('provision', data, request);
    assert.deepEqual(await f.service.change('provision', data, request), created);
    const stored = await f.db
      .prepare(
        'SELECT password_hash,credential_kind,must_change_password,role FROM employees WHERE id=?',
      )
      .bind(String(created.employeeId))
      .first();
    assert.deepEqual(stored, {
      password_hash: null,
      credential_kind: 'sso-only',
      must_change_password: 0,
      role: 'learner',
    });
    assert.equal(
      await f.db
        .prepare("SELECT count(*) n FROM aio_audit WHERE action='learner.provisioned'")
        .first('n'),
      1,
    );
    await assert.rejects(() => f.service.change('provision', data, command()), {
      code: 'LMS_ACCOUNT_ALREADY_LINKED',
    });
    await assert.rejects(
      () => f.service.change('provision', f.add(), { ...request, reason: 'Different reason' }),
      { code: 'IDEMPOTENCY_KEY_REUSED' },
    );
    await assert.rejects(() =>
      f.db
        .prepare('UPDATE aio_account_links SET person_id=? WHERE account_id=?')
        .bind(randomUUID(), data.accountId)
        .run(),
    );
    const permissions = f.actor.principal.permissions;
    f.actor.principal.permissions = permissions.filter(
      (p) => p.permission !== 'identity:provision',
    );
    await assert.rejects(() => f.service.change('provision', f.add(), command()), {
      code: 'LMS_PROVISIONING_DENIED',
    });
    f.actor.principal.permissions = permissions;
    f.actor.principal.authenticationMethods = ['pwd'];
    await assert.rejects(() => f.service.mappings(), { code: 'MFA_REQUIRED' });
    f.actor.principal.authenticationMethods = ['pwd', 'otp'];
    // Stored learner role is not a second source of privileges for SSO-only profiles.
    requirePermission(f.actor.principal, f.actor.link, 'lms:admin');
    f.actor.principal.permissions = permissions.filter((p) => p.permission !== 'lms:admin');
    assert.throws(() => requirePermission(f.actor.principal, f.actor.link, 'lms:admin'), {
      code: 'LMS_PERMISSION_DENIED',
    });
    f.actor.principal.permissions = permissions;
    f.actor.link.credential_kind = 'legacy-retained';
    assert.throws(() => requirePermission(f.actor.principal, f.actor.link, 'lms:admin'), {
      code: 'LMS_PERMISSION_DENIED',
    });
  } finally {
    await f.mf.dispose();
  }
});
test('learner disable, reconcile and enable revoke sessions, keep employee/history, enforce CAS and fresh identity', async () => {
  const f = await fixture();
  try {
    const data = f.add(),
      created = await f.service.change('provision', data, command()),
      target = f.targets.get(data.accountId)!;
    const employee = String(created.employeeId),
      session = randomUUID();
    await f.db.batch([
      f.db
        .prepare("INSERT INTO learning_attempts VALUES ('history',?,'legacy','{}',85,'{}','2020')")
        .bind(employee),
      f.db
        .prepare(
          "INSERT INTO aio_sessions(hash,account_id,employee_id,issuer,subject,sid,authenticated_at,encrypted_payload,created_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,'target',1,'fixture',1,?,?)",
        )
        .bind(
          session,
          data.accountId,
          employee,
          target.issuer,
          target.subject,
          Date.now() + 600000,
          Date.now() + 600000,
        ),
    ]);
    const disabled = await f.service.change('disable', { ...data, expectedRevision: 1 }, command());
    assert.equal(disabled.active, false);
    assert.equal(
      await f.db.prepare('SELECT 1 FROM aio_sessions WHERE hash=?').bind(session).first(),
      null,
    );
    await assert.rejects(
      () => f.service.change('enable', { ...data, expectedRevision: 1 }, command()),
      { code: 'REVISION_CONFLICT' },
    );
    f.setRevoked(true);
    await assert.rejects(
      () => f.service.change('enable', { ...data, expectedRevision: 2 }, command()),
      { code: 'LMS_IDENTITY_TARGET_UNAVAILABLE' },
    );
    f.setRevoked(false);
    f.targets.set(data.accountId, { ...target, orgUnitId: f.otherUnit });
    assert.equal(
      (await f.service.mappings()).items.find((row) => row.accountId === data.accountId)!.state,
      'disabled',
    );
    const reconciled = await f.service.change(
      'reconcile',
      { ...data, orgUnitId: f.otherUnit, expectedRevision: 2 },
      command(),
    );
    assert.equal(reconciled.active, false);
    const enableRequest = command(),
      enableData = { ...data, orgUnitId: f.otherUnit, expectedRevision: 3 };
    await f.service.change('enable', enableData, enableRequest);
    assert.equal(
      (await f.service.mappings()).items.find((row) => row.accountId === data.accountId)!.state,
      'ready',
    );
    assert.equal(
      await f.db
        .prepare("SELECT user_id FROM learning_attempts WHERE id='history'")
        .first('user_id'),
      employee,
    );
    assert.equal(
      await f.db.prepare('SELECT 1 FROM aio_sessions WHERE hash=?').bind(session).first(),
      null,
    );
    f.setRevoked(true);
    await assert.rejects(() => f.service.change('enable', enableData, enableRequest), {
      code: 'LMS_IDENTITY_TARGET_UNAVAILABLE',
    });
    f.setRevoked(false);
    f.targets.set(data.accountId, { ...target, orgUnitId: f.otherUnit, subject: randomUUID() });
    await assert.rejects(
      () => f.service.change('enable', { ...enableData, expectedRevision: 4 }, command()),
      { code: 'LMS_IDENTITY_OWNERSHIP_MISMATCH' },
    );
  } finally {
    await f.mf.dispose();
  }
});
test('provisioning rolls back on failed audit and rejects target revocation between checks; mapping pages do not truncate', async () => {
  const f = await fixture();
  try {
    const data = f.add();
    await f.db
      .prepare(
        "CREATE TRIGGER fail_learner_audit BEFORE INSERT ON aio_audit WHEN NEW.action='learner.provisioned' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END",
      )
      .run();
    await assert.rejects(() => f.service.change('provision', data, command()));
    assert.equal(await f.db.prepare('SELECT count(*) n FROM employees').first('n'), 1);
    assert.equal(
      await f.db
        .prepare('SELECT 1 FROM aio_account_links WHERE account_id=?')
        .bind(data.accountId)
        .first(),
      null,
    );
    await f.db.prepare('DROP TRIGGER fail_learner_audit').run();
    f.revokeOnNextRecheck();
    await assert.rejects(() => f.service.change('provision', data, command()), {
      code: 'LMS_IDENTITY_TARGET_UNAVAILABLE',
    });
    assert.equal(await f.db.prepare('SELECT count(*) n FROM employees').first('n'), 1);
    for (let i = 0; i < 52; i++) await f.service.change('provision', f.add(), command());
    const first = await f.service.mappings(),
      second = await f.service.mappings(first.nextCursor!);
    assert.equal(first.items.length, 50);
    assert.equal(second.items.length, 3); // includes the original operator mapping
    assert.equal(new Set([...first.items, ...second.items].map((p) => p.accountId)).size, 53);
    assert.equal(second.nextCursor, null);
  } finally {
    await f.mf.dispose();
  }
});
