import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { GovernanceService } from '../src/management/governance.js';
import type { Identity } from '../src/store.js';
import { loadLocalConfig, testDatabaseUrl, assertLocalDatabase } from '../src/config.js';
import { Store } from '../src/store.js';
import { ids } from '../src/fixtures.js';

const config = await loadLocalConfig();
const databaseUrl = testDatabaseUrl(config);
assertLocalDatabase(databaseUrl, true);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const store = new Store(pool);
async function changeGrant(
  actor: Identity,
  actorApp: string,
  change: { accountId: string; tenantId: string; appCode: string; reason: string },
  active: boolean,
  requestId: string,
) {
  const current = (
    await pool.query(
      'SELECT revision FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
      [change.accountId, change.tenantId, change.appCode],
    )
  ).rows[0];
  return new GovernanceService(store).saveGrant(
    {
      identity: actor,
      appCode: actorApp,
      tenantId: change.tenantId,
      requestId,
      idempotencyKey: randomUUID(),
      reason: change.reason,
    },
    { accountId: change.accountId, appCode: change.appCode, active },
    current?.revision ?? 0,
  );
}
const identity = (subject: string) => ({
  issuer: config.issuer,
  subject,
  authenticatedAt: Math.floor(Date.now() / 1000),
  authenticationMethods: ['pwd', 'otp'],
});
before(async () => {
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
    'tlqm-aio-test',
  );
});
after(() => pool.end());

test('issuer-subject mapping does not auto-provision unknown identities', async () => {
  await assert.rejects(() => store.principal(identity('unknown'), 'aio-foundation'), {
    code: 'ACCOUNT_UNAVAILABLE',
  });
  await assert.rejects(
    () =>
      store.principal(
        { issuer: 'https://other.example.test', subject: ids.admin },
        'aio-foundation',
      ),
    { code: 'ACCOUNT_UNAVAILABLE' },
  );
});
test('blocked accounts and users without an application grant are denied', async () => {
  await assert.rejects(() => store.principal(identity(ids.blocked), 'aio-foundation'), {
    code: 'ACCOUNT_UNAVAILABLE',
  });
  await assert.rejects(() => store.principal(identity(ids.noAccess), 'aio-foundation'), {
    code: 'APPLICATION_ACCESS_DENIED',
  });
});
test('directory permissions are tenant scoped and cannot grant management rights', async () => {
  const user = await store.principal(identity(ids.learner), 'aio-foundation');
  store.require(user, 'directory:read', ids.tenantA);
  assert.throws(() => store.require(user, 'directory:read', ids.tenantB), {
    code: 'PERMISSION_DENIED',
  });
  assert.throws(() => store.require(user, 'access:manage', ids.tenantA, 'aio-probe'), {
    code: 'PERMISSION_DENIED',
  });
});
test('delegated administration rejects cross-tenant and inactive app grants', async () => {
  const admin = identity(ids.admin);
  await assert.rejects(
    () =>
      changeGrant(
        admin,
        'aio-foundation',
        {
          accountId: ids.other,
          tenantId: ids.tenantB,
          appCode: 'aio-probe',
          reason: 'Synthetic cross-tenant check',
        },
        true,
        'test',
      ),
    { code: 'PERMISSION_DENIED' },
  );
  await assert.rejects(
    () =>
      changeGrant(
        admin,
        'aio-foundation',
        {
          accountId: ids.learner,
          tenantId: ids.tenantA,
          appCode: 'tlqm-lms',
          reason: 'Not delegated',
        },
        true,
        'test',
      ),
    { code: 'APPLICATION_DELEGATION_DENIED' },
  );
});
test('revoking an app grant immediately removes access and app visibility with an audit record', async () => {
  const change = {
    accountId: ids.learner,
    tenantId: ids.tenantA,
    appCode: 'aio-probe',
    reason: 'Synthetic revocation test',
  };
  try {
    await changeGrant(identity(ids.admin), 'aio-foundation', change, false, 'test-revoke');
    await assert.rejects(() => store.principal(identity(ids.learner), 'aio-probe'), {
      code: 'APPLICATION_ACCESS_DENIED',
    });
    assert.equal(
      (await store.applications(ids.learner)).some(
        (app: { code: string }) => app.code === 'aio-probe',
      ),
      false,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM audit_events WHERE request_id='test-revoke' AND action='access.revoked'",
        )
      ).rows[0].count !== '0',
      true,
    );
    // The same person's other application remains available.
    await store.principal(identity(ids.learner), 'aio-foundation');
  } finally {
    await changeGrant(identity(ids.admin), 'aio-foundation', change, true, 'test-restore');
  }
});
test('person, account and concurrent assignments remain separate', async () => {
  const assignments = await store.assignments(ids.learner);
  assert.equal(assignments.length, 2);
  assert.equal(assignments.filter((row: { isPrimary: boolean }) => row.isPrimary).length, 1);
});
