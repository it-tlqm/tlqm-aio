import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { DirectoryService } from '../src/management/directory.js';
import { organizationResponsibility } from '../src/organization-resolution.js';
import { ids } from '../src/fixtures.js';
import type { MutationContext } from '../src/management/mutations.js';
const config = await loadLocalConfig(),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(config), max: 2 }),
  store = new Store(pool),
  directory = new DirectoryService(store);
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
  reason: 'Kiểm thử người phụ trách tổ chức',
});
before(async () =>
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  ),
);
after(() => pool.end());
test('Foundation projection resolves explicit manager, unit head and substitute; missing/cross-tenant/chain fails closed', async () => {
  const code = 'R' + randomUUID().slice(0, 7),
    from = new Date(Date.now() - 86400000).toISOString();
  const unit = await directory.save('org-units', ctx(), {
      legalEntityId: ids.legalA,
      code,
      name: 'Đơn vị người duyệt',
    }),
    title = await directory.save('job-titles', ctx(), { code, name: 'Chuyên viên' }),
    pos = await directory.save('positions', ctx(), {
      legalEntityId: ids.legalA,
      orgUnitId: unit.id,
      jobTitleId: title.id,
      name: 'Vị trí người duyệt',
    });
  const people: Record<string, unknown>[] = [],
    employments: Record<string, unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    const p = await directory.save('people', ctx(), { displayName: code + ' ' + i }),
      e = await directory.save('employments', ctx(), {
        personId: p.id,
        legalEntityId: ids.legalA,
        employeeCode: code + i,
        validFrom: from,
      });
    people.push(p);
    employments.push(e);
    await directory.save('assignments', ctx(), {
      legalEntityId: ids.legalA,
      employmentId: e.id,
      positionId: pos.id,
      isPrimary: true,
      validFrom: from,
    });
  }
  const resolve = (kind: 'manager' | 'unit-head' = 'manager') =>
    organizationResponsibility(store, ids.tenantA, String(unit.id), String(people[0]!.id), kind);
  await assert.rejects(resolve, { code: 'WORKFLOW_ORGANIZATION_RESPONSIBLE_MISSING' });
  await directory.save('reporting-lines', ctx(), {
    legalEntityId: ids.legalA,
    employmentId: employments[0]!.id,
    managerEmploymentId: employments[1]!.id,
    validFrom: from,
  });
  assert.equal((await resolve()).personId, people[1]!.id);
  await directory.save('unit-leaders', ctx(), {
    legalEntityId: ids.legalA,
    orgUnitId: unit.id,
    employmentId: employments[1]!.id,
    validFrom: from,
  });
  assert.equal((await resolve('unit-head')).personId, people[1]!.id);
  await directory.save('approval-substitutions', ctx(), {
    legalEntityId: ids.legalA,
    employmentId: employments[1]!.id,
    substituteEmploymentId: employments[2]!.id,
    validFrom: from,
  });
  assert.equal((await resolve()).personId, people[2]!.id);
  assert.equal((await resolve()).basis.length, 2);
  await assert.rejects(
    () =>
      organizationResponsibility(
        store,
        ids.tenantB,
        String(unit.id),
        String(people[0]!.id),
        'manager',
      ),
    { code: 'WORKFLOW_ORGANIZATION_EMPLOYMENT_AMBIGUOUS' },
  );
  await directory.save('approval-substitutions', ctx(), {
    legalEntityId: ids.legalA,
    employmentId: employments[2]!.id,
    substituteEmploymentId: employments[3]!.id,
    validFrom: from,
  });
  await assert.rejects(resolve, { code: 'WORKFLOW_ORGANIZATION_SUBSTITUTE_CHAIN' });
});
