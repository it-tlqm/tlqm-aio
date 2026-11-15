import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import pg from 'pg';
import { applicationDatabaseUrl, loadLocalConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { ids } from '../src/fixtures.js';
import { controlLms } from '../src/lms/lifecycle.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localContainer } from './local-docker.js';
import { startLocalLms, migrateLms } from './lms-local.js';

const [environment, target, action, revisionText, reason, accountId, orgUnitId] =
  process.argv.slice(2);
let worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
let pool: pg.Pool | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  assert.ok(environment === 'local' || environment === 'test');
  assert.ok(target === 'adapter' || target === 'mapping');
  assert.ok(action === 'enable' || action === 'disable');
  assert.ok(reason && reason.length >= 5 && Number(revisionText) >= 1);
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  const runtime = await loadLocalConfig();
  browser = await chromium.launch({ headless: true });
  const proof = await authenticateMfaFixture(browser, runtime, ids.admin);
  pool = new pg.Pool({
    connectionString: applicationDatabaseUrl(runtime, environment === 'test'),
    max: 1,
  });
  const store = new Store(pool);
  const actor = await store.principal(
    {
      issuer: runtime.issuer,
      subject: proof.subject,
      authenticatedAt: proof.authTime,
      authenticationMethods: proof.authenticationMethods ?? [],
    },
    'aio-foundation',
  );
  store.require(actor, 'identity:link', ids.tenantA);
  await new GovernanceService(store).assertApp(
    pool,
    actor,
    ids.tenantA,
    'aio-lms-sandbox',
    'access:manage',
  );
  assert.ok(Date.now() / 1000 - proof.authTime < 90);
  worker = await startLocalLms(environment === 'test', 0);
  await migrateLms(worker.db, worker.config);
  if (orgUnitId) {
    assert.equal(target, 'mapping');
    const mapping = await worker.db
      .prepare('SELECT person_id,tenant_id FROM aio_account_links WHERE account_id=?')
      .bind(accountId ?? '')
      .first<{ person_id: string; tenant_id: string }>();
    assert.ok(mapping && mapping.tenant_id === ids.tenantA);
    assert.ok(
      (await store.activeUnits(mapping.person_id)).some(
        (unit) => unit.tenantId === ids.tenantA && unit.orgUnitId === orgUnitId,
      ),
    );
  }
  const result = await controlLms(
    worker.db,
    { accountId: actor.accountId, tenantId: ids.tenantA },
    {
      target,
      enabled: action === 'enable',
      expectedRevision: Number(revisionText),
      reason,
      commandKey: randomUUID(),
      ...(accountId ? { accountId } : {}),
      ...(orgUnitId ? { orgUnitId } : {}),
    },
  );
  console.log(
    'LMS ' +
      target +
      ' ' +
      action +
      ' completed, revision ' +
      result.revision +
      '. Mapping, passwords and learning history retained.',
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    'LMS operator command rejected' +
      (code && /^[A-Z_]+$/.test(code) ? ': ' + code : '') +
      '. Usage: lms:control -- local|test adapter|mapping enable|disable EXPECTED_REVISION "reason" [accountId] [orgUnitId]. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await worker?.mf.dispose();
  await pool?.end();
}
