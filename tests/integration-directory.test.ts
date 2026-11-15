import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/store.js';
import { ids } from '../src/fixtures.js';
import { integrationDirectory } from '../src/integration-directory.js';
import { directoryProof, verifyDirectoryProof } from '../src/integration-directory-proof.js';
import { subjectProof } from '../src/integration-proof.js';
test('Directory proof binds all filters, caller token and proof purpose without accepting subjects proof', async () => {
  const secret = 'synthetic-directory-test',
    app = 'aio-test',
    token = 'synthetic-token',
    query = {
      kind: 'people' as const,
      tenantId: randomUUID(),
      orgUnitId: randomUUID(),
      accountIds: [randomUUID()],
      search: 'Nguyễn',
      cursor: randomUUID(),
    };
  const proof = await directoryProof(secret, app, token, query);
  assert.equal(await verifyDirectoryProof(secret, app, token, query, proof), true);
  for (const changed of [
    { ...query, search: 'Other' },
    { ...query, kind: 'units' as const },
    { ...query, accountIds: [randomUUID()] },
    { ...query, orgUnitId: randomUUID() },
    { ...query, tenantId: randomUUID() },
    { ...query, cursor: randomUUID() },
  ])
    assert.equal(await verifyDirectoryProof(secret, app, token, changed, proof), false);
  assert.equal(await verifyDirectoryProof(secret, app, 'other-token', query, proof), false);
  assert.equal(await verifyDirectoryProof(secret, 'aio-other', token, query, proof), false);
  assert.equal(
    await verifyDirectoryProof(
      secret,
      app,
      token,
      query,
      await subjectProof(secret, app, token, query.accountIds),
    ),
    false,
  );
  assert.equal(
    await verifyDirectoryProof(
      secret,
      app,
      token,
      query,
      await directoryProof(secret, app, token, query, Math.floor(Date.now() / 1000) - 40),
    ),
    false,
  );
});
test('Directory requires app-bound lookup permission, live app grant and unit scope; cursor preserves >100 equal-name people', async () => {
  const config = await loadLocalConfig(),
    pool = new pg.Pool({ connectionString: testDatabaseUrl(config) }),
    client = await pool.connect();
  try {
    assert.equal(
      (await client.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
      'tlqm-aio-test',
    );
    await client.query('BEGIN');
    const store = new Store(client as unknown as pg.Pool),
      app = 'aio-lms-sandbox';
    const actor: Principal = {
      accountId: ids.admin,
      personId: randomUUID(),
      displayName: 'Fixture',
      permissions: [
        {
          tenantId: ids.tenantA,
          orgUnitId: ids.unitA,
          permission: 'directory:lookup',
          managedAppCode: null,
        },
      ],
    };
    const units = await integrationDirectory(store, actor, app, {
      kind: 'units',
      tenantId: ids.tenantA,
    });
    assert.deepEqual(
      units.items.map((row) => ('id' in row ? row.id : null)),
      [ids.unitA],
    );
    await assert.rejects(
      () => integrationDirectory(store, actor, app, { kind: 'units', tenantId: ids.tenantB }),
      { code: 'PERMISSION_DENIED' },
    );
    await assert.rejects(
      () =>
        integrationDirectory(store, actor, app, {
          kind: 'people',
          tenantId: ids.tenantA,
          orgUnitId: ids.unitC,
        }),
      { code: 'PERMISSION_DENIED' },
    );
    await assert.rejects(
      () =>
        integrationDirectory(
          store,
          {
            ...actor,
            permissions: actor.permissions.map((item) => ({
              ...item,
              managedAppCode: 'aio-other',
            })),
          },
          app,
          { kind: 'units', tenantId: ids.tenantA },
        ),
      { code: 'PERMISSION_DENIED' },
    );
    const learner = await integrationDirectory(store, actor, app, {
      kind: 'people',
      tenantId: ids.tenantA,
      accountIds: [ids.learner],
    });
    assert.equal(learner.items.length, 1);
    const person = learner.items[0]!;
    assert.ok('units' in person);
    assert.deepEqual(
      person.units.map((unit) => unit.id),
      [ids.unitA],
    );
    assert.equal('email' in person, false);
    assert.equal('subject' in person, false);
    await client.query(
      'UPDATE application_grants SET active=false WHERE account_id=$1 AND app_code=$2 AND tenant_id=$3',
      [ids.learner, app, ids.tenantA],
    );
    assert.equal(
      (
        await integrationDirectory(store, actor, app, {
          kind: 'people',
          tenantId: ids.tenantA,
          accountIds: [ids.learner],
        })
      ).items.length,
      0,
    );
    const name = 'Directory-page-' + randomUUID(),
      position = (
        await client.query('SELECT id FROM positions WHERE org_unit_id=$1 AND active LIMIT 1', [
          ids.unitA,
        ])
      ).rows[0].id;
    for (let i = 0; i < 105; i++) {
      const personId = randomUUID(),
        accountId = randomUUID(),
        employmentId = randomUUID();
      await client.query('INSERT INTO persons(id,home_tenant_id,display_name) VALUES ($1,$2,$3)', [
        personId,
        ids.tenantA,
        name,
      ]);
      await client.query('INSERT INTO accounts(id,person_id) VALUES ($1,$2)', [
        accountId,
        personId,
      ]);
      await client.query('INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)', [
        accountId,
        ids.tenantA,
      ]);
      await client.query(
        'INSERT INTO application_grants(account_id,tenant_id,app_code) VALUES ($1,$2,$3)',
        [accountId, ids.tenantA, app],
      );
      await client.query(
        'INSERT INTO external_identities(issuer,subject,account_id) VALUES ($1,$2,$3)',
        [config.issuer, 'directory-test-' + accountId, accountId],
      );
      await client.query(
        "INSERT INTO employments(id,tenant_id,person_id,legal_entity_id,employee_code,valid_from) VALUES ($1,$2,$3,$4,$5,now()-interval '1 day')",
        [employmentId, ids.tenantA, personId, ids.legalA, 'DP-' + accountId],
      );
      await client.query(
        "INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary,valid_from) VALUES ($1,$2,$3,$4,$5,true,now()-interval '1 day')",
        [randomUUID(), ids.tenantA, ids.legalA, employmentId, position],
      );
    }
    const first = await integrationDirectory(store, actor, app, {
      kind: 'people',
      tenantId: ids.tenantA,
      search: name,
    });
    assert.equal(first.items.length, 100);
    assert.ok(first.nextCursor);
    const second = await integrationDirectory(store, actor, app, {
      kind: 'people',
      tenantId: ids.tenantA,
      search: name,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 5);
    assert.equal(second.nextCursor, null);
    assert.equal(
      new Set(
        [...first.items, ...second.items].map((row) => ('accountId' in row ? row.accountId : null)),
      ).size,
      105,
    );
    actor.permissions = [];
    await assert.rejects(
      () =>
        integrationDirectory(store, actor, app, {
          kind: 'people',
          tenantId: ids.tenantA,
          search: name,
          cursor: first.nextCursor!,
        }),
      { code: 'PERMISSION_DENIED' },
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
