import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { DirectoryService } from '../src/management/directory.js';
import { mutate, auditMutation } from '../src/management/mutations.js';
import type { MutationContext } from '../src/management/mutations.js';
import { ids } from '../src/fixtures.js';

const config = await loadLocalConfig();
const pool = new pg.Pool({ connectionString: testDatabaseUrl(config), max: 4 });
const store = new Store(pool);
const directory = new DirectoryService(store);
function context(subject: string = ids.admin, tenantId: string = ids.tenantA): MutationContext {
  return {
    identity: {
      issuer: config.issuer,
      subject,
      authenticatedAt: Math.floor(Date.now() / 1000),
      authenticationMethods: ['pwd', 'otp'],
    },
    appCode: 'aio-foundation',
    tenantId,
    idempotencyKey: randomUUID(),
    requestId: randomUUID(),
    reason: 'Kiểm thử quản trị giả lập',
  };
}
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
});
after(() => pool.end());

test('directory mutation has atomic audit and exactly one effect for the same idempotency key', async () => {
  const request = context();
  const data = { code: 'J-' + randomUUID().slice(0, 8), name: 'Chức danh thử nghiệm' };
  const created = await directory.save('job-titles', request, data);
  const retry = await directory.save('job-titles', request, data);
  assert.deepEqual(retry, created);
  const audit = await pool.query('SELECT details FROM audit_events WHERE request_id=$1', [
    request.requestId,
  ]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].details.before, null);
  assert.equal(audit.rows[0].details.after.code, data.code);
  await assert.rejects(
    () => directory.save('job-titles', request, { ...data, name: 'Different payload' }),
    { code: 'IDEMPOTENCY_KEY_REUSED' },
  );
  await directory.save(
    'job-titles',
    context(),
    { active: false },
    String(created.id),
    Number(created.revision),
  );
});
test('concurrent changes with the same revision cannot silently overwrite each other', async () => {
  const created = await directory.save('job-titles', context(), {
    code: 'J-' + randomUUID().slice(0, 8),
    name: 'Concurrent title',
  });
  const results = await Promise.allSettled([
    directory.save('job-titles', context(), { name: 'Change A' }, String(created.id), 1),
    directory.save('job-titles', context(), { name: 'Change B' }, String(created.id), 1),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT');
  const row = (await pool.query('SELECT revision FROM job_titles WHERE id=$1', [created.id]))
    .rows[0];
  assert.equal(row.revision, 2);
  await directory.save('job-titles', context(), { active: false }, String(created.id), 2);
});
test('audit insert failure rolls back the data mutation and idempotency receipt', async () => {
  const request = context();
  const id = randomUUID();
  await assert.rejects(
    () =>
      mutate(store, request, 'directory:manage', 'atomicity-test', { id }, async (db, actor) => {
        const row = (
          await db.query(
            'INSERT INTO job_titles(id,tenant_id,code,name) VALUES ($1,$2,$3,$4) RETURNING *',
            [id, ids.tenantA, 'J-' + id.slice(0, 8), 'Rollback fixture'],
          )
        ).rows[0];
        await auditMutation(
          db,
          request,
          actor,
          'test.mutation',
          'job-title',
          id,
          null,
          row,
          randomUUID(),
        );
        return row;
      }),
    { code: 'INVALID_RELATION' },
  );
  assert.equal((await pool.query('SELECT 1 FROM job_titles WHERE id=$1', [id])).rowCount, 0);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM mutation_receipts WHERE idempotency_key=$1', [
        request.idempotencyKey,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM audit_events WHERE request_id=$1', [request.requestId]))
      .rowCount,
    0,
  );
});
test('management denies reader writes, cross-tenant writes and protected account edits', async () => {
  const adminRevision = (await pool.query('SELECT revision FROM accounts WHERE id=$1', [ids.admin]))
    .rows[0].revision;
  const data = { code: 'DENIED', name: 'Must not exist' };
  await assert.rejects(() => directory.save('job-titles', context(ids.learner), data), {
    code: 'PERMISSION_DENIED',
  });
  await assert.rejects(() => directory.save('job-titles', context(ids.admin, ids.tenantB), data), {
    code: 'PERMISSION_DENIED',
  });
  await assert.rejects(
    () => directory.save('accounts', context(), { active: false }, ids.admin, adminRevision),
    { code: 'PROTECTED_ACCOUNT' },
  );
  await assert.rejects(() => directory.save('people', context(), { active: false }, ids.admin, 1), {
    code: 'SELF_MANAGEMENT_FORBIDDEN',
  });
});
test('org-unit scoped list returns only its permitted unit and related legal entity', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      "UPDATE role_bindings SET org_unit_id=$1 WHERE account_id=$2 AND app_code='aio-foundation'",
      [ids.unitA, ids.learner],
    );
    const principal = await store.principal(
      { issuer: config.issuer, subject: ids.learner },
      'aio-foundation',
      db,
    );
    const units = await directory.list('org-units', principal, ids.tenantA);
    assert.deepEqual(
      units.items.map((row) => row.id),
      [ids.unitA],
    );
    const entities = await directory.list('legal-entities', principal, ids.tenantA);
    assert.deepEqual(
      entities.items.map((row) => row.id),
      [ids.legalA],
    );
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});
test('hierarchy updates reject cycles through the management service and preserve the prior revision', async () => {
  const parent = await directory.save('org-units', context(), {
    legalEntityId: ids.legalA,
    code: 'P-' + randomUUID().slice(0, 8),
    name: 'Parent test',
  });
  const child = await directory.save('org-units', context(), {
    legalEntityId: ids.legalA,
    parentId: parent.id,
    code: 'C-' + randomUUID().slice(0, 8),
    name: 'Child test',
  });
  await assert.rejects(
    () => directory.save('org-units', context(), { parentId: child.id }, String(parent.id), 1),
    { code: 'ORGANIZATION_CYCLE' },
  );
  assert.equal(
    (await pool.query('SELECT revision FROM org_units WHERE id=$1', [parent.id])).rows[0].revision,
    1,
  );
  await assert.rejects(
    () => directory.save('org-units', context(), { active: false }, String(parent.id), 1),
    { code: 'ACTIVE_DEPENDENCIES' },
  );
  await directory.save('org-units', context(), { active: false }, String(child.id), 1);
  await directory.save('org-units', context(), { active: false }, String(parent.id), 1);
});
