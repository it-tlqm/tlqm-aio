import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/store.js';
import { ids } from '../src/fixtures.js';
import { identityProof, verifyIdentityProof } from '../src/integration-identity-proof.js';
import { directoryProof } from '../src/integration-directory-proof.js';
import { subjectProof } from '../src/integration-proof.js';
import { integrationIdentity } from '../src/integration-identity.js';
test('Identity provisioning proof binds target, unit, tenant, caller token, app and purpose', async () => {
  const secret = 'synthetic-proof-secret',
    app = 'aio-test',
    token = 'synthetic-token',
    query = { tenantId: randomUUID(), accountId: randomUUID(), orgUnitId: randomUUID() };
  const proof = await identityProof(secret, app, token, query);
  assert.equal(await verifyIdentityProof(secret, app, token, query, proof), true);
  for (const key of ['tenantId', 'accountId', 'orgUnitId'])
    assert.equal(
      await verifyIdentityProof(secret, app, token, { ...query, [key]: randomUUID() }, proof),
      false,
    );
  assert.equal(await verifyIdentityProof(secret, 'aio-other', token, query, proof), false);
  assert.equal(await verifyIdentityProof(secret, app, 'other', query, proof), false);
  for (const invalid of [
    await identityProof(secret, app, token, query, Math.floor(Date.now() / 1000) - 40),
    await directoryProof(secret, app, token, {
      kind: 'people',
      tenantId: query.tenantId,
      accountIds: [query.accountId],
    }),
    await subjectProof(secret, app, token, [query.accountId]),
  ])
    assert.equal(await verifyIdentityProof(secret, app, token, query, invalid), false);
});
test('Verified identity targets require explicit provisioning and Directory rights, live grants, active units and unambiguous issuer ownership', async () => {
  const config = await loadLocalConfig(),
    pool = new pg.Pool({ connectionString: testDatabaseUrl(config), max: 1 }),
    db = await pool.connect();
  try {
    assert.equal(
      (await db.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
      'tlqm-aio-test',
    );
    await db.query('BEGIN');
    const actor: Principal = {
        accountId: ids.admin,
        personId: randomUUID(),
        displayName: 'Fixture',
        permissions: ['identity:provision', 'directory:lookup'].map((permission) => ({
          tenantId: ids.tenantA,
          orgUnitId: null,
          permission,
          managedAppCode: null,
        })),
      },
      app = 'aio-lms-sandbox',
      store = new Store(db as unknown as pg.Pool),
      query = { tenantId: ids.tenantA, accountId: ids.learner, orgUnitId: ids.unitA };
    const target = await integrationIdentity(store, actor, app, config.issuer, query);
    assert.equal(target.accountId, ids.learner);
    assert.equal(target.issuer, config.issuer);
    assert.equal(target.subject, ids.learner);
    assert.equal('email' in target, false);
    assert.equal('password_hash' in target, false);
    for (const actor2 of [
      {
        ...actor,
        permissions: actor.permissions.filter((p) => p.permission !== 'identity:provision'),
      },
      {
        ...actor,
        permissions: actor.permissions.map((p) => ({ ...p, managedAppCode: 'aio-other' })),
      },
      { ...actor, permissions: actor.permissions.map((p) => ({ ...p, orgUnitId: ids.unitA })) },
    ])
      await assert.rejects(() => integrationIdentity(store, actor2, app, config.issuer, query), {
        code: 'PERMISSION_DENIED',
      });
    await assert.rejects(
      () =>
        integrationIdentity(store, actor, app, config.issuer, { ...query, tenantId: ids.tenantB }),
      { code: 'PERMISSION_DENIED' },
    );
    await assert.rejects(
      () =>
        integrationIdentity(store, actor, app, config.issuer, { ...query, orgUnitId: ids.unitB }),
      { code: 'IDENTITY_TARGET_UNAVAILABLE' },
    );
    await db.query('INSERT INTO external_identities(issuer,subject,account_id) VALUES ($1,$2,$3)', [
      config.issuer,
      randomUUID(),
      ids.learner,
    ]);
    await assert.rejects(() => integrationIdentity(store, actor, app, config.issuer, query), {
      code: 'IDENTITY_TARGET_AMBIGUOUS',
    });
    await db.query(
      'UPDATE application_grants SET active=false WHERE account_id=$1 AND app_code=$2',
      [ids.learner, app],
    );
    await assert.rejects(() => integrationIdentity(store, actor, app, config.issuer, query), {
      code: 'IDENTITY_TARGET_UNAVAILABLE',
    });
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
});
