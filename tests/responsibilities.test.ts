import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { DirectoryService } from '../src/management/directory.js';
import type { MutationContext } from '../src/management/mutations.js';
import { ids } from '../src/fixtures.js';
const config = await loadLocalConfig(),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(config), max: 2 }),
  store = new Store(pool),
  service = new DirectoryService(store);
const ctx = (): MutationContext => ({
  identity: {
    issuer: config.issuer,
    subject: ids.admin,
    authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ['pwd', 'otp'],
  },
  appCode: 'aio-foundation',
  tenantId: ids.tenantA,
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
  reason: 'Kiểm thử trách nhiệm tổ chức',
});
const start = '2026-01-01T00:00:00.000Z',
  end = '2027-01-01T00:00:00.000Z';
const employmentIds: string[] = [];
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  for (let i = 0; i < 3; i++) {
    const p = await service.save('people', ctx(), {
      displayName: 'Trách nhiệm giả lập ' + randomUUID().slice(0, 8),
    });
    const e = await service.save('employments', ctx(), {
      personId: p.id,
      legalEntityId: ids.legalA,
      employeeCode: 'REL-' + randomUUID().slice(0, 8),
      validFrom: start,
    });
    employmentIds.push(String(e.id));
  }
});
after(() => pool.end());
const row = (a: number, b: number) => ({
  legalEntityId: ids.legalA,
  employmentId: employmentIds[a],
  managerEmploymentId: employmentIds[b],
  validFrom: start,
  validUntil: end,
});
test('reporting lines preserve idempotency and reject overlapping, cyclic and cross-tenant relationships', async () => {
  const context = ctx(),
    first = await service.save('reporting-lines', context, row(0, 1));
  assert.deepEqual(await service.save('reporting-lines', context, row(0, 1)), first);
  await assert.rejects(() => service.save('reporting-lines', ctx(), row(0, 2)), {
    code: 'RESPONSIBILITY_OVERLAP',
  });
  await service.save('reporting-lines', ctx(), row(1, 2));
  await assert.rejects(() => service.save('reporting-lines', ctx(), row(2, 0)), {
    code: 'RESPONSIBILITY_CYCLE',
  });
  await assert.rejects(
    () => service.save('reporting-lines', ctx(), { ...row(2, 0), legalEntityId: ids.legalB }),
    { code: 'RESPONSIBILITY_EMPLOYMENT_INVALID' },
  );
  await assert.rejects(
    () => service.save('reporting-lines', ctx(), { active: false }, String(first.id), 2),
    { code: 'REVISION_CONFLICT' },
  );
  const disabled = await service.save(
    'reporting-lines',
    ctx(),
    { active: false },
    String(first.id),
    1,
  );
  assert.equal(disabled.revision, 2);
  const audit = await pool.query('SELECT 1 FROM audit_events WHERE request_id=$1', [
    context.requestId,
  ]);
  assert.equal(audit.rowCount, 1);
});
test('unit leadership and substitutes use separate explicit records and create no roles', async () => {
  const unit = await service.save('org-units', ctx(), {
    legalEntityId: ids.legalA,
    code: 'REL-' + randomUUID().slice(0, 8),
    name: 'Đơn vị trách nhiệm giả lập',
  });
  const before = (await pool.query('SELECT count(*) AS count FROM role_bindings')).rows[0].count;
  const leader = {
    legalEntityId: ids.legalA,
    orgUnitId: unit.id,
    employmentId: employmentIds[0],
    validFrom: start,
    validUntil: end,
  };
  await service.save('unit-leaders', ctx(), leader);
  await assert.rejects(
    () => service.save('unit-leaders', ctx(), { ...leader, employmentId: employmentIds[1] }),
    { code: 'RESPONSIBILITY_OVERLAP' },
  );
  await service.save('approval-substitutions', ctx(), {
    legalEntityId: ids.legalA,
    employmentId: employmentIds[0],
    substituteEmploymentId: employmentIds[1],
    validFrom: start,
    validUntil: end,
  });
  await assert.rejects(
    () =>
      service.save('approval-substitutions', ctx(), {
        legalEntityId: ids.legalA,
        employmentId: employmentIds[1],
        substituteEmploymentId: employmentIds[0],
        validFrom: start,
        validUntil: end,
      }),
    { code: 'RESPONSIBILITY_CYCLE' },
  );
  assert.equal(
    (await pool.query('SELECT count(*) AS count FROM role_bindings')).rows[0].count,
    before,
  );
});
