import assert from 'node:assert/strict';
import { randomBytes, randomUUID, pbkdf2Sync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { loadLocalConfig, applicationDatabaseUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { ids } from '../src/fixtures.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { clientLoginProof } from './client-login-proof.js';
import { startLocalLms, migrateLms } from './lms-local.js';
import { localContainer } from './local-docker.js';
import type { FormsFixture } from './forms-fixtures.js';
import type { D1Database } from '../src/lms/types.js';

export type LmsFixture = {
  accountId: string;
  personId: string;
  subject: string;
  employeeId: string;
  tenantId: string;
  orgUnitId: string;
  legacyRole: 'learner' | 'admin' | 'manager';
  roleCode: string;
};
const appCode = 'aio-lms-sandbox';
const rolePermissions = {
  learner: ['lms:learn'],
  manager: ['lms:learn', 'lms:review'],
  admin: ['lms:learn', 'lms:review', 'lms:admin'],
};
const permissionNames = {
  'lms:learn': 'Xem dữ liệu học của tôi',
  'lms:review': 'Xem tiến độ trong phạm vi',
  'lms:admin': 'Quản trị LMS',
};
const pools: pg.Pool[] = [];
const workers: Awaited<ReturnType<typeof startLocalLms>>[] = [];
let stage = 'preflight';
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  const runtime = await loadLocalConfig(),
    client = runtime.clients.find(
      (entry) => entry.code === appCode && entry.kind === 'external-application',
    );
  assert.ok(client);
  const forms = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as {
    instanceId: string;
    users: FormsFixture[];
  };
  assert.equal(forms.instanceId, runtime.instanceId);
  const choices = [
    {
      user: runtime.users.find((user) => user.id === ids.learner)!,
      employeeId: 'legacy-lms-a',
      orgUnitId: ids.unitA,
      legacyRole: 'learner' as const,
      roleCode: 'learner',
      mfa: false,
    },
    {
      user: forms.users.find((user) => user.role === 'respondent')!,
      employeeId: 'legacy-lms-c',
      orgUnitId: ids.unitC,
      legacyRole: 'learner' as const,
      roleCode: 'learner',
      mfa: false,
    },
    {
      user: forms.users.find((user) => user.role === 'publisher')!,
      employeeId: 'legacy-lms-admin',
      orgUnitId: ids.unitA,
      legacyRole: 'admin' as const,
      roleCode: 'admin',
      mfa: true,
    },
    {
      user: forms.users.find((user) => user.role === 'reviewer')!,
      employeeId: 'legacy-lms-manager',
      orgUnitId: ids.unitA,
      legacyRole: 'manager' as const,
      roleCode: 'manager',
      mfa: false,
    },
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    stage = 'verify operator MFA';
    const proof = await authenticateMfaFixture(browser, runtime, ids.admin);
    const identity = {
      issuer: runtime.issuer,
      subject: proof.subject,
      authenticatedAt: proof.authTime,
      authenticationMethods: proof.authenticationMethods ?? [],
    };
    const context = (reason: string) => ({
      identity,
      appCode: 'aio-foundation',
      tenantId: ids.tenantA,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      reason: 'Local LMS sandbox: ' + reason,
    });
    const stores: Store[] = [];
    for (const test of [false, true]) {
      const pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, test), max: 2 });
      pools.push(pool);
      assert.equal(
        (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
        test ? 'tlqm-aio-test' : 'tlqm-aio-local',
      );
      const store = new Store(pool);
      stores.push(store);
      const governance = new GovernanceService(store),
        actor = await store.principal(identity, 'aio-foundation');
      assert.equal(actor.accountId, ids.admin);
      await governance.assertApp(pool, actor, ids.tenantA, appCode, 'roles:manage');
      stage = 'explicit LMS roles and grants';
      for (const [code, name] of Object.entries(permissionNames))
        if (
          !(
            await pool.query('SELECT 1 FROM permission_catalog WHERE app_code=$1 AND code=$2', [
              appCode,
              code,
            ])
          ).rowCount
        )
          await governance.savePermission(context('permission catalog'), { appCode, code, name });
      for (const [code, permissions] of Object.entries(rolePermissions))
        if (
          !(
            await pool.query(
              'SELECT 1 FROM app_roles WHERE tenant_id=$1 AND app_code=$2 AND code=$3',
              [ids.tenantA, appCode, code],
            )
          ).rowCount
        )
          await governance.saveRole(context('application role'), {
            appCode,
            code,
            name: 'LMS ' + code,
            permissions,
          });
      for (const choice of choices) {
        if (
          !(
            await pool.query(
              'SELECT 1 FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
              [choice.user.id, ids.tenantA, appCode],
            )
          ).rowCount
        )
          await governance.saveGrant(context('fixture app grant'), {
            appCode,
            accountId: choice.user.id,
            active: true,
          });
        if (
          !(
            await pool.query(
              'SELECT 1 FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 AND role_code=$4',
              [choice.user.id, ids.tenantA, appCode, choice.roleCode],
            )
          ).rowCount
        )
          await governance.saveBinding(context('fixture role binding'), {
            appCode,
            accountId: choice.user.id,
            roleCode: choice.roleCode,
            orgUnitId: choice.roleCode === 'manager' ? choice.orgUnitId : null,
          });
      }
      stage = 'initialize isolated Worker D1';
      const worker = await startLocalLms(test, 0);
      workers.push(worker);
      await migrateLms(worker.db, worker.config);
      await seedLegacy(worker.db);
      console.log(
        (test ? 'Test' : 'Local') + ' LMS sandbox schema and synthetic legacy rows ready.',
      );
    }
    stage = 'verify explicit identity-to-legacy mappings';
    const mappings: LmsFixture[] = [];
    for (const choice of choices) {
      const subject = choice.user.subject ?? choice.user.id;
      const existing = await Promise.all(
        workers.map((worker) =>
          worker.db
            .prepare(
              'SELECT * FROM aio_account_links a JOIN aio_external_links i ON i.account_id=a.account_id WHERE i.issuer=? AND i.subject=?',
            )
            .bind(runtime.issuer, subject)
            .first<Record<string, unknown>>(),
        ),
      );
      let targetIdentity = identity;
      if (existing.some((row) => !row)) {
        const verified = await clientLoginProof(browser, runtime, client, choice.user, choice.mfa);
        targetIdentity = {
          issuer: runtime.issuer,
          subject: verified.subject,
          authenticatedAt: verified.authTime!,
          authenticationMethods: verified.authenticationMethods ?? [],
        };
      }
      const sourceAccount = (
        await stores[0]!.pool.query('SELECT person_id FROM accounts WHERE id=$1', [choice.user.id])
      ).rows[0];
      assert.ok(sourceAccount);
      const mapping: LmsFixture = {
        accountId: choice.user.id,
        personId: sourceAccount.person_id as string,
        subject,
        employeeId: choice.employeeId,
        tenantId: ids.tenantA,
        orgUnitId: choice.orgUnitId,
        legacyRole: choice.legacyRole,
        roleCode: choice.roleCode,
      };
      for (const [index, worker] of workers.entries()) {
        const prior = existing[index];
        if (prior) {
          assert.equal(prior.employee_id, mapping.employeeId);
          assert.equal(prior.account_id, mapping.accountId);
          assert.equal(prior.person_id, mapping.personId);
          continue;
        }
        const principal = await stores[index]!.principal(targetIdentity, appCode);
        assert.equal(principal.accountId, mapping.accountId);
        assert.equal(principal.personId, mapping.personId);
        assert.ok(
          (await stores[index]!.activeUnits(principal.personId)).some(
            (unit) => unit.tenantId === mapping.tenantId && unit.orgUnitId === mapping.orgUnitId,
          ),
        );
        const actor = await stores[index]!.principal(identity, 'aio-foundation');
        stores[index]!.require(actor, 'identity:link', ids.tenantA);
        await worker.db.batch([
          worker.db
            .prepare(
              'INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by) VALUES (?,?,?,?,?,?,?)',
            )
            .bind(
              mapping.accountId,
              mapping.personId,
              mapping.employeeId,
              mapping.tenantId,
              mapping.orgUnitId,
              Date.now(),
              actor.accountId,
            ),
          worker.db
            .prepare(
              'INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES (?,?,?,?,?)',
            )
            .bind(runtime.issuer, mapping.subject, mapping.accountId, Date.now(), actor.accountId),
          worker.db
            .prepare(
              "INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,subject_account_id,employee_id,tenant_id,action,reason,request_id,details) VALUES (?,?,?,?,?,?,'mapping.verified','Explicit local operator review and signed OIDC proof',?,?)",
            )
            .bind(
              randomUUID(),
              Date.now(),
              actor.accountId,
              mapping.accountId,
              mapping.employeeId,
              mapping.tenantId,
              randomUUID(),
              JSON.stringify({
                issuer: runtime.issuer,
                subject: mapping.subject,
                personId: mapping.personId,
                orgUnitId: mapping.orgUnitId,
              }),
            ),
        ]);
      }
      mappings.push(mapping);
    }
    await writeFile(
      '.local/lms-fixtures.json',
      JSON.stringify({ instanceId: runtime.instanceId, mappings }, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log(
      'PASS: local/test LMS identity mapping verified; legacy IDs, hashes and business history retained; no default user creation on login.',
    );
  } finally {
    await browser.close();
  }
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    'LMS setup failed at: ' +
      stage +
      (code && /^[A-Z0-9_]{1,50}$/.test(code) ? ' (' + code + ')' : '') +
      '. Database and credentials omitted.',
  );
  process.exitCode = 1;
} finally {
  await Promise.all(workers.map((worker) => worker.mf.dispose()));
  await Promise.all(pools.map((pool) => pool.end()));
}

async function seedLegacy(db: D1Database) {
  if (
    await db
      .prepare('SELECT 1 FROM aio_bootstrap_receipts WHERE name=?')
      .bind('legacy-fixtures-v1')
      .first()
  )
    return;
  const now = new Date().toISOString(),
    statements = [];
  for (const [index, entry] of [
    { id: 'legacy-lms-a', role: 'learner', department: 'Legacy department A' },
    { id: 'legacy-lms-c', role: 'learner', department: 'Legacy department C' },
    { id: 'legacy-lms-admin', role: 'admin', department: 'Legacy operations' },
    { id: 'legacy-lms-manager', role: 'manager', department: 'Legacy training' },
  ].entries()) {
    // These are new legacy-login fixtures with genuine password hashes, never dummy values for SSO accounts.
    const salt = randomBytes(16).toString('hex'),
      password = randomBytes(32).toString('hex');
    const derived = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString(
      'hex',
    );
    statements.push(
      db
        .prepare(
          'INSERT INTO employees(id,code,name,department,role,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind(
          entry.id,
          'LMS-DEMO-' + index,
          'Học viên legacy ' + index,
          entry.department,
          entry.role,
          salt + ':' + derived,
          now,
          now,
        ),
    );
    statements.push(
      db
        .prepare('INSERT INTO learning_progress VALUES (?,?,?,?,?,?,?,?)')
        .bind(
          entry.id + ':lesson-local',
          entry.id,
          'lesson-local',
          120 + index * 20,
          300 + index * 20,
          '{}',
          0,
          now,
        ),
    );
    statements.push(
      db
        .prepare('INSERT INTO learning_attempts VALUES (?,?,?,?,?,?,?)')
        .bind(
          'attempt-' + entry.id,
          entry.id,
          'lesson-local',
          '{"q1":"a"}',
          80 + index * 5,
          '[]',
          now,
        ),
    );
    statements.push(
      db
        .prepare('INSERT INTO learning_notes VALUES (?,?,?,?,?,?)')
        .bind(
          'note-' + entry.id,
          entry.id,
          'lesson-local',
          60,
          'Ghi chú học tập giả lập ' + index,
          now,
        ),
    );
  }
  statements.push(
    db
      .prepare('INSERT INTO lessons VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(
        'lesson-local',
        'Bài học giả lập: quy trình số',
        'Dữ liệu sandbox',
        'AIO local',
        'Legacy departments',
        '30/11/2026',
        1,
        600,
        '',
        '',
        '[]',
        '[]',
        '{}',
        'published',
        1,
        now,
        now,
      ),
  );
  statements.push(
    db
      .prepare('INSERT INTO aio_bootstrap_receipts VALUES (?,?)')
      .bind('legacy-fixtures-v1', Date.now()),
  );
  await db.batch(statements);
}
