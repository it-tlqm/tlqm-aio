import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { DirectoryService } from '../src/management/directory.js';
import { GovernanceService } from '../src/management/governance.js';
import { PersonnelOperations } from '../src/management/personnel-operations.js';
import type { PersonnelInput } from '../src/management/personnel-operations.js';
import type { MutationContext } from '../src/management/mutations.js';
import { ids } from '../src/fixtures.js';
const runtime = await loadLocalConfig(),
  pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 2 }),
  store = new Store(pool),
  service = new PersonnelOperations(store),
  directory = new DirectoryService(store);
const ctx = (): MutationContext => ({
  identity: {
    issuer: runtime.issuer,
    subject: ids.admin,
    authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ['pwd', 'otp'],
  },
  tenantId: ids.tenantA,
  appCode: 'aio-foundation',
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
  reason: 'Kiểm thử vận hành nhân sự giả lập',
});
before(async () =>
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  ),
);
after(() => pool.end());
test('onboarding, transfer and offboarding preview/commit preserve history and atomic idempotency', async () => {
  const actor = await store.principal(ctx().identity, 'aio-foundation'),
    positions = (await directory.list('positions', actor, ids.tenantA)).items.filter(
      (p) => p.active && p.legalEntityId === ids.legalA,
    );
  const input: PersonnelInput = {
    kind: 'onboard',
    displayName: 'Luồng nhân sự ' + randomUUID().slice(0, 8),
    employeeCode: 'OP-' + randomUUID().slice(0, 8),
    legalEntityId: ids.legalA,
    positionId: String(positions[0]!.id),
    effectiveAt: new Date(Date.now() - 10000).toISOString(),
    revokeBindingIds: [],
  };
  const before = (await pool.query('SELECT count(*) AS count FROM persons')).rows[0].count;
  const preview = await service.preview(actor, ids.tenantA, input);
  assert.equal((await pool.query('SELECT count(*) AS count FROM persons')).rows[0].count, before);
  const request = ctx(),
    joined = await service.commit(request, input, preview.snapshot);
  assert.deepEqual(await service.commit(request, input, preview.snapshot), joined);
  const person = joined.records[0]!,
    employment = joined.records[1]!;
  const account = await directory.save('accounts', ctx(), { personId: person.id });
  const governance = new GovernanceService(store);
  await governance.saveGrant(
    ctx(),
    { appCode: 'aio-foundation', accountId: String(account.id), active: true },
    0,
  );
  const binding = await governance.saveBinding(ctx(), {
    appCode: 'aio-foundation',
    accountId: String(account.id),
    roleCode: 'reader',
    orgUnitId: ids.unitA,
  });
  const transfer: PersonnelInput = {
    kind: 'transfer',
    employmentId: employment.id,
    positionId: String(positions.at(-1)!.id),
    effectiveAt: new Date(Date.now() - 5000).toISOString(),
    revokeBindingIds: [String(binding.id)],
  };
  const old = await service.preview(actor, ids.tenantA, transfer);
  await directory.save(
    'people',
    ctx(),
    { displayName: input.displayName + ' sửa' },
    String(person.id),
    1,
  );
  await assert.rejects(() => service.commit(ctx(), transfer, old.snapshot), {
    code: 'PERSONNEL_PREVIEW_STALE',
  });
  await service.commit(
    ctx(),
    transfer,
    (await service.preview(actor, ids.tenantA, transfer)).snapshot,
  );
  const assignments = (
    await pool.query('SELECT * FROM assignments WHERE employment_id=$1 ORDER BY valid_from', [
      employment.id,
    ])
  ).rows;
  assert.equal(assignments.length, 2);
  assert.equal(new Date(assignments[0].valid_until).toISOString(), transfer.effectiveAt);
  assert.equal(assignments[1].position_id, transfer.positionId);
  assert.equal(
    (await pool.query('SELECT active FROM role_bindings WHERE id=$1', [binding.id])).rows[0].active,
    false,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT active FROM application_grants WHERE account_id=$1 AND app_code=$2',
        [account.id, 'aio-foundation'],
      )
    ).rows[0].active,
    true,
  );
  const offboard: PersonnelInput = {
    kind: 'offboard',
    personId: person.id,
    effectiveAt: new Date().toISOString(),
    revokeBindingIds: [],
  };
  await service.commit(
    ctx(),
    offboard,
    (await service.preview(actor, ids.tenantA, offboard)).snapshot,
  );
  assert.equal(
    (await pool.query('SELECT active FROM accounts WHERE id=$1', [account.id])).rows[0].active,
    false,
  );
  assert.equal(
    (await pool.query('SELECT active FROM persons WHERE id=$1', [person.id])).rows[0].active,
    false,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT active FROM application_grants WHERE account_id=$1 AND app_code=$2',
        [account.id, 'aio-foundation'],
      )
    ).rows[0].active,
    false,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) AS count FROM assignments WHERE employment_id=$1 AND valid_until IS NULL',
        [employment.id],
      )
    ).rows[0].count,
    '0',
  );
});
