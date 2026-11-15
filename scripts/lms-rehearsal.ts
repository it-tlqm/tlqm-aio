import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { loadLocalConfig, applicationDatabaseUrl } from '../src/config.js';
import { ids } from '../src/fixtures.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { controlLms } from '../src/lms/lifecycle.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localContainer } from './local-docker.js';
import type { LmsFixture } from './lms-setup.js';

const execute = promisify(execFile),
  runtime = await loadLocalConfig();
const browser = await chromium.launch({ headless: true }),
  pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, true), max: 2 });
let worker: Awaited<ReturnType<typeof startLocalLms>> | undefined;
let stage = 'preflight';
const cleanups: (() => Promise<void>)[] = [];
const run = async (script: string, args: string[] = []) => {
  try {
    await execute(process.execPath, ['--import', 'tsx', script, ...args], {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const result = error as { code?: string | number; stderr?: string; killed?: boolean };
    const safe = result.stderr
      ?.split(/\r?\n/)
      .filter(
        (line) =>
          line.startsWith('LMS setup failed at:') ||
          line.startsWith('LMS operator command rejected'),
      );
    if (safe?.length) console.error(safe.join('\n'));
    console.error(
      'Child result: ' +
        (result.killed ? 'timeout' : typeof result.code === 'number' ? result.code : 'failed'),
    );
    throw new Error('Guarded child command failed; sensitive output omitted.');
  }
};
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  assert.equal(
    (await pool.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  const mapping = JSON.parse(await readFile('.local/lms-fixtures.json', 'utf8')) as {
    instanceId: string;
    mappings: LmsFixture[];
  };
  assert.equal(mapping.instanceId, runtime.instanceId);
  const target = mapping.mappings.find((row) => row.employeeId === 'legacy-lms-c')!;
  assert.ok(target);
  const credentialSnapshot = async () => {
    const configuration = await Promise.all(
      ['.local/runtime.json', '.local/lms-adapter.json'].map((file) => readFile(file, 'utf8')),
    );
    const mfa = JSON.parse(await readFile('.local/mfa.json', 'utf8')) as Record<
      string,
      { secret: string }
    >;
    // The replay-use counter is expected to advance; the OTP seeds must remain unchanged.
    return JSON.stringify([
      ...configuration,
      Object.keys(mfa)
        .sort()
        .map((id) => [id, mfa[id]!.secret]),
    ]);
  };
  const secretsBefore = await credentialSnapshot();
  stage = 'operator proof';
  const proof = await authenticateMfaFixture(browser, runtime, ids.admin);
  const identity = {
    issuer: runtime.issuer,
    subject: proof.subject,
    authenticatedAt: proof.authTime,
    authenticationMethods: proof.authenticationMethods ?? [],
  };
  const store = new Store(pool),
    governance = new GovernanceService(store),
    actor = await store.principal(identity, 'aio-foundation');
  store.require(actor, 'identity:link', ids.tenantA);
  await governance.assertApp(pool, actor, ids.tenantA, 'aio-lms-sandbox', 'access:manage');
  const context = () => ({
    identity,
    appCode: 'aio-foundation',
    tenantId: ids.tenantA,
    reason: 'LMS setup preservation rehearsal',
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  const grant = async () =>
    (
      await pool.query(
        "SELECT active,revision FROM application_grants WHERE account_id=$1 AND app_code='aio-lms-sandbox'",
        [target.accountId],
      )
    ).rows[0] as { active: boolean; revision: number };
  const binding = async () =>
    (
      await pool.query(
        "SELECT id,active,revision,role_code,org_unit_id FROM role_bindings WHERE account_id=$1 AND app_code='aio-lms-sandbox'",
        [target.accountId],
      )
    ).rows[0] as {
      id: string;
      active: boolean;
      revision: number;
      role_code: string;
      org_unit_id: string | null;
    };
  const beforeGrant = await grant(),
    beforeBinding = await binding();
  const setGrant = async (active: boolean) => {
    const row = await grant();
    await governance.saveGrant(
      context(),
      { accountId: target.accountId, appCode: 'aio-lms-sandbox', active },
      row.revision,
    );
  };
  const setBinding = async (active: boolean) => {
    const row = await binding();
    await governance.saveBinding(
      context(),
      {
        accountId: target.accountId,
        appCode: 'aio-lms-sandbox',
        roleCode: row.role_code,
        orgUnitId: row.org_unit_id,
        active,
      },
      row.id,
      row.revision,
    );
  };
  cleanups.push(async () => {
    await setGrant(beforeGrant.active);
    await setBinding(beforeBinding.active);
  });
  await setGrant(false);
  await setBinding(false);
  worker = await startLocalLms(true, 0);
  await migrateLms(worker.db, worker.config);
  const legacy = async () =>
    JSON.stringify(
      await Promise.all(
        ['employees', 'learning_progress', 'learning_attempts', 'learning_notes', 'lessons'].map(
          async (table) =>
            (await worker!.db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()).results,
        ),
      ),
    );
  const original = await legacy();
  const oldMapping = await worker.db
    .prepare('SELECT active,revision FROM aio_account_links WHERE account_id=?')
    .bind(target.accountId)
    .first<{ active: number; revision: number }>();
  const controlActor = { accountId: actor.accountId, tenantId: ids.tenantA };
  await controlLms(worker.db, controlActor, {
    target: 'mapping',
    accountId: target.accountId,
    enabled: false,
    expectedRevision: oldMapping!.revision,
    reason: 'Rehearsal mapping suspension',
    commandKey: randomUUID(),
  });
  cleanups.push(async () => {
    if (!worker) worker = await startLocalLms(true, 0);
    const row = await worker.db
      .prepare('SELECT revision FROM aio_account_links WHERE account_id=?')
      .bind(target.accountId)
      .first<{ revision: number }>();
    await controlLms(worker.db, controlActor, {
      target: 'mapping',
      accountId: target.accountId,
      enabled: oldMapping!.active === 1,
      expectedRevision: row!.revision,
      reason: 'Explicit rehearsal fixture restoration',
      commandKey: randomUUID(),
    });
  });
  const beforeAdapter = await worker.db
    .prepare('SELECT enabled,revision FROM aio_adapter_control WHERE id=1')
    .first<{ enabled: number; revision: number }>();
  assert.equal(beforeAdapter!.enabled, 1);
  await worker.mf.dispose();
  worker = undefined;
  cleanups.push(async () => {
    if (worker) {
      await worker.mf.dispose();
      worker = undefined;
    }
    const inspector = await startLocalLms(true, 0);
    const row = await inspector.db
      .prepare('SELECT enabled,revision FROM aio_adapter_control WHERE id=1')
      .first<{ enabled: number; revision: number }>();
    await inspector.mf.dispose();
    if (row!.enabled === 0)
      await run('scripts/lms-control.ts', [
        'test',
        'adapter',
        'enable',
        String(row!.revision),
        'Explicit rehearsal restoration',
      ]);
  });
  stage = 'CLI MFA adapter disable';
  console.log('LMS rehearsal: guarded operator disable and setup rerun.');
  await run('scripts/lms-control.ts', [
    'test',
    'adapter',
    'disable',
    String(beforeAdapter!.revision),
    'Rehearsal disabled adapter',
  ]);
  stage = 'setup rerun while revoked';
  await run('scripts/lms-setup.ts');
  worker = await startLocalLms(true, 0);
  assert.equal(await legacy(), original);
  assert.equal((await grant()).active, false);
  assert.equal((await binding()).active, false);
  assert.equal(
    (await worker.db
      .prepare('SELECT active FROM aio_account_links WHERE account_id=?')
      .bind(target.accountId)
      .first<{ active: number }>())!.active,
    0,
  );
  assert.equal(
    (await worker.db
      .prepare('SELECT enabled FROM aio_adapter_control WHERE id=1')
      .first<{ enabled: number }>())!.enabled,
    0,
  );
  stage = 'credential preservation';
  assert.equal((await credentialSnapshot()) === secretsBefore, true);
  stage = 'explicit restore';
  while (cleanups.length) {
    await cleanups.at(-1)!();
    cleanups.pop();
  }
  await writeFile(
    '.local/evidence/lms-rehearsal.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        checks: [
          'CLI verifies real operator MFA and delegation',
          'setup preserves disabled adapter/mapping and revoked Foundation grant/binding',
          'legacy IDs/password hashes/progress/scores/notes unchanged',
          'credentials unchanged',
          'explicit audited restoration only; old sessions remain revoked',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: LMS operator MFA, setup/rollback preservation, credentials and legacy history retained.',
  );
} catch {
  console.error('LMS rehearsal failed at ' + stage + '. Sensitive details omitted.');
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups.reverse())
    try {
      await cleanup();
    } catch {
      console.error('LMS fixture restoration requires review.');
      process.exitCode = 1;
    }
  await worker?.mf.dispose();
  await pool.end();
  await browser.close();
}
