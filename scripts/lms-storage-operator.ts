import assert from 'node:assert/strict';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { loadLocalConfig, applicationDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { OidcClient } from '../src/oidc.js';
import { ids } from '../src/fixtures.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localContainer } from './local-docker.js';
export type StorageOperator = { accountId: string; tenantId: string; assertFresh(): Promise<void> };
/** Platform recovery authority, identical to the guarded local adapter-control boundary.
 * Not a browser role grant or a Worker connection to the Identity database.
 */
export async function withStorageOperator<T>(
  test: boolean,
  work: (actor: StorageOperator) => Promise<T>,
): Promise<T> {
  const runtime = await loadLocalConfig();
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  const browser = await chromium.launch({ headless: true }),
    pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, test), max: 1 });
  let failed = false;
  pool.on('error', () => {
    failed = true;
    console.error('Storage operator database unavailable; connection details omitted.');
  });
  try {
    assert.equal(
      (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
      test ? 'tlqm-aio-test' : 'tlqm-aio-local',
    );
    const proof = await authenticateMfaFixture(browser, runtime, ids.admin),
      oidc = await OidcClient.create(
        runtime,
        runtime.clients.find((c) => c.code === 'aio-foundation')!,
      ),
      store = new Store(pool),
      governance = new GovernanceService(store);
    const actor: StorageOperator = {
      accountId: ids.admin,
      tenantId: ids.tenantA,
      async assertFresh() {
        assert.equal(failed, false);
        assert.ok(
          Date.now() / 1000 - proof.authTime < 90,
          'Fresh operator authentication required',
        );
        const identity = await oidc.access(proof.accessToken);
        const principal = await store.principal(identity, 'aio-foundation');
        assert.equal(principal.accountId, ids.admin);
        store.require(principal, 'identity:link', ids.tenantA);
        await governance.assertApp(
          pool,
          principal,
          ids.tenantA,
          'aio-lms-sandbox',
          'access:manage',
        );
      },
    };
    await actor.assertFresh();
    const result = await work(actor);
    assert.equal(failed, false);
    return result;
  } finally {
    await browser.close();
    await pool.end();
  }
}
