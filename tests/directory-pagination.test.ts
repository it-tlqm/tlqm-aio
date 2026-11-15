import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/store.js';
import { DirectoryService } from '../src/management/directory.js';
import { IdentityService } from '../src/management/identities.js';
import { apiCollection } from '../frontend/src/lib/api.js';

test('Directory and identity cursors retain more than 500 records and equal-name targets within current permission scope', async () => {
  const runtime = await loadLocalConfig(),
    pool = new pg.Pool({ connectionString: testDatabaseUrl(runtime) }),
    client = await pool.connect();
  try {
    assert.equal(
      (await client.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
      'tlqm-aio-test',
    );
    await client.query('BEGIN');
    const tenant = randomUUID(),
      foreign = randomUUID();
    await client.query('INSERT INTO tenants(id,code,name) VALUES ($1,$2,$3),($4,$5,$6)', [
      tenant,
      'page-' + tenant,
      'Synthetic pagination',
      foreign,
      'foreign-' + foreign,
      'Other pagination',
    ]);
    const people = (
      await client.query(
        "INSERT INTO persons(id,home_tenant_id,display_name) SELECT gen_random_uuid(),$1,'Đồng tên' FROM generate_series(1,503) RETURNING id",
        [tenant],
      )
    ).rows;
    await client.query(
      "INSERT INTO persons(id,home_tenant_id,display_name) VALUES (gen_random_uuid(),$1,'Đồng tên')",
      [foreign],
    );
    await client.query(
      'INSERT INTO accounts(id,person_id) SELECT gen_random_uuid(),id FROM persons WHERE home_tenant_id=$1',
      [tenant],
    );
    await client.query(
      'INSERT INTO tenant_memberships(account_id,tenant_id) SELECT a.id,$1 FROM accounts a JOIN persons p ON p.id=a.person_id WHERE p.home_tenant_id=$1',
      [tenant],
    );
    const store = new Store(client as unknown as pg.Pool),
      directory = new DirectoryService(store),
      identity = new IdentityService(store, runtime, {
        access: async () => {
          throw new Error('Unused provider');
        },
      });
    const principal: Principal = {
      accountId: randomUUID(),
      personId: randomUUID(),
      displayName: 'Synthetic operator',
      permissions: ['people:read', 'accounts:manage', 'identity:link'].map((permission) => ({
        tenantId: tenant,
        permission,
        managedAppCode: null,
        orgUnitId: null,
      })),
    };
    const first = await directory.list('people', principal, tenant);
    assert.equal(first.items.length, 500);
    assert.ok(first.nextCursor);
    const second = await directory.list('people', principal, tenant, first.nextCursor);
    assert.equal(second.items.length, 3);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [...first.items, ...second.items].map((row) => row.id).sort(),
      people.map((row) => row.id).sort(),
    );
    const targets = await identity.targets(principal, tenant);
    assert.equal(targets.items.length, 500);
    assert.ok(targets.nextCursor);
    const remaining = await identity.targets(principal, tenant, targets.nextCursor);
    assert.equal(remaining.items.length, 3);
    assert.equal(remaining.nextCursor, null);
    assert.equal(new Set([...targets.items, ...remaining.items].map((row) => row.id)).size, 503);
    await assert.rejects(() => identity.targets(principal, foreign, targets.nextCursor!), {
      code: 'PERMISSION_DENIED',
    });
    await assert.rejects(() => directory.list('people', principal, tenant, 'invalid'), {
      code: 'INVALID_REQUEST',
    });
    await assert.rejects(() => identity.targets(principal, tenant, 'invalid'), {
      code: 'INVALID_REQUEST',
    });
    principal.permissions = [];
    await assert.rejects(() => directory.list('people', principal, tenant, first.nextCursor!), {
      code: 'PERMISSION_DENIED',
    });
    await assert.rejects(() => identity.targets(principal, tenant, targets.nextCursor!), {
      code: 'PERMISSION_DENIED',
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
test('Collection loading follows cursors and never exposes partial data after later-page denial', async () => {
  const original = globalThis.fetch,
    paths: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      paths.push(String(input));
      return Response.json(
        paths.length === 1 ? { items: [1], nextCursor: 'next' } : { items: [2], nextCursor: null },
      );
    };
    assert.deepEqual(await apiCollection<number>('/api/v1/manage/people?tenantId=test'), {
      items: [1, 2],
    });
    assert.deepEqual(paths, [
      '/api/v1/manage/people?tenantId=test',
      '/api/v1/manage/people?tenantId=test&cursor=next',
    ]);
    let emptyCalls = 0;
    globalThis.fetch = async () =>
      Response.json(
        ++emptyCalls === 1
          ? { items: [], nextCursor: 'after-ineligible-targets' }
          : { items: [3], nextCursor: null },
      );
    assert.deepEqual(await apiCollection<number>('/api/admin'), { items: [3] });
    let calls = 0;
    globalThis.fetch = async () =>
      ++calls === 1
        ? Response.json({ items: [1], nextCursor: 'next' })
        : Response.json({ error: 'PERMISSION_DENIED' }, { status: 403 });
    await assert.rejects(() => apiCollection('/api/v1/manage/people?tenantId=test'), {
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    globalThis.fetch = async () => Response.json({ items: [1], nextCursor: 'repeated' });
    await assert.rejects(() => apiCollection('/api/v1/manage/people?tenantId=test'), {
      code: 'INVALID_RESPONSE',
    });
  } finally {
    globalThis.fetch = original;
  }
});
