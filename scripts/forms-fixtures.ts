import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { loadLocalConfig, applicationDatabaseUrl, assertLocalDatabase } from '../src/config.js';
import { localKeycloakAdmin } from '../src/local-keycloak-admin.js';
import { Store } from '../src/store.js';
import { GovernanceService } from '../src/management/governance.js';
import { auditMutation } from '../src/management/mutations.js';
import type { MutationContext } from '../src/management/mutations.js';
import { formsPermissions } from '../src/forms/access.js';
import { ids } from '../src/fixtures.js';
import { authenticateMfaFixture } from './mfa-browser.js';
import { localContainer } from './local-docker.js';

export type FormsFixture = {
  role: 'designer' | 'publisher' | 'reviewer' | 'analyst' | 'respondent';
  id: string;
  personId: string;
  employmentId: string;
  assignmentId: string;
  username: string;
  name: string;
  tenantId: string;
  unitId: string;
  password: string;
  subject?: string;
};
type Receipt = { instanceId: string; purpose: 'tlqm-aio-forms-fixtures'; users: FormsFixture[] };
let stage = 'preflight';
const pools: pg.Pool[] = [];
const runtime = await loadLocalConfig();
const roles = {
  designer: ['forms:design'],
  publisher: ['forms:publish'],
  reviewer: ['forms:review'],
  analyst: ['forms:analyze', 'forms:export'],
  respondent: ['forms:respond'],
};
const privileged = (role: string) => role === 'designer' || role === 'publisher';
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.ok(
    runtime.clients.some((client) => client.code === 'aio-forms' && client.kind === 'application'),
  );
  let receipt: Receipt;
  try {
    receipt = JSON.parse(await readFile('.local/forms-fixtures.json', 'utf8')) as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    receipt = {
      instanceId: runtime.instanceId,
      purpose: 'tlqm-aio-forms-fixtures',
      users: Object.keys(roles).map((role) => ({
        role: role as FormsFixture['role'],
        id: randomUUID(),
        personId: randomUUID(),
        employmentId: randomUUID(),
        assignmentId: randomUUID(),
        username: 'forms.' + role,
        name: 'Forms ' + role + ' giả lập',
        tenantId: ids.tenantA,
        unitId: role === 'respondent' ? ids.unitC : ids.unitA,
        password: randomBytes(32).toString('hex'),
      })),
    };
    await writeFile('.local/forms-fixtures.json', JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  assert.equal(receipt.instanceId, runtime.instanceId);
  assert.equal(receipt.purpose, 'tlqm-aio-forms-fixtures');
  assert.deepEqual(receipt.users.map((user) => user.role).sort(), Object.keys(roles).sort());
  for (const user of receipt.users) {
    assert.equal(user.username, 'forms.' + user.role);
    assert.equal(user.tenantId, ids.tenantA);
    assert.equal(user.unitId, user.role === 'respondent' ? ids.unitC : ids.unitA);
    assert.match(user.password, /^[0-9a-f]{64}$/);
    for (const id of [user.id, user.personId, user.employmentId, user.assignmentId])
      assert.match(id, /^[0-9a-f-]{36}$/);
  }
  const save = async () => {
    await writeFile('.local/forms-fixtures.next.json', JSON.stringify(receipt, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename('.local/forms-fixtures.next.json', '.local/forms-fixtures.json');
  };
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
    const context = (reason: string): MutationContext => ({
      identity,
      appCode: 'aio-foundation',
      tenantId: ids.tenantA,
      reason: 'Local Forms fixtures: ' + reason,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const stores: Store[] = [];
    const owners: pg.Pool[] = [];
    for (const test of [false, true]) {
      const pool = new pg.Pool({ connectionString: applicationDatabaseUrl(runtime, test), max: 2 });
      pools.push(pool);
      assert.equal(
        (await pool.query('SELECT purpose FROM environment_marker')).rows[0]?.purpose,
        test ? 'tlqm-aio-test' : 'tlqm-aio-local',
      );
      const store = new Store(pool);
      stores.push(store);
      const actor = await store.principal(identity, 'aio-foundation');
      assert.equal(actor.accountId, ids.admin);
      await new GovernanceService(store).assertApp(
        pool,
        actor,
        ids.tenantA,
        'aio-forms',
        'roles:manage',
      );
      const url = new URL(runtime.databaseUrl);
      url.pathname = test ? '/aio_foundation_test' : '/aio_foundation';
      assertLocalDatabase(url.href, test);
      const owner = new pg.Pool({ connectionString: url.href, max: 1 });
      pools.push(owner);
      owners.push(owner);
    }
    const admin = await localKeycloakAdmin(runtime);
    stage = 'declare admin-only fixture marker attributes';
    const profile = (await (await admin('/users/profile')).json()) as {
      attributes: {
        name: string;
        permissions?: { view: string[]; edit: string[] };
        [key: string]: unknown;
      }[];
      [key: string]: unknown;
    };
    let profileChanged = false;
    for (const name of ['aio.local.instance', 'aio.local.fixture']) {
      const prior = profile.attributes.find((attribute) => attribute.name === name);
      if (prior) assert.deepEqual(prior.permissions, { view: ['admin'], edit: ['admin'] });
      else {
        profile.attributes.push({
          name,
          displayName: name,
          permissions: { view: ['admin'], edit: ['admin'] },
          multivalued: false,
          validations: { length: { max: 64 } },
        });
        profileChanged = true;
      }
    }
    if (profileChanged) await admin('/users/profile', 'PUT', profile);
    const mfaRole = await (await admin('/roles/aio-mfa-required')).json();
    for (const user of receipt.users) {
      stage = 'provision synthetic identity';
      if (!user.subject) {
        const existing = (await (
          await admin('/users?username=' + encodeURIComponent(user.username) + '&exact=true')
        ).json()) as { id: string }[];
        assert.equal(
          existing.length,
          0,
          'Existing username without creation receipt cannot be claimed.',
        );
        const created = await admin('/users', 'POST', {
          username: user.username,
          enabled: true,
          firstName: 'Forms',
          lastName: user.role,
          email: user.username + '@example.test',
          emailVerified: true,
          attributes: {
            'aio.local.instance': [runtime.instanceId],
            'aio.local.fixture': ['forms'],
          },
          credentials: [{ type: 'password', value: user.password, temporary: false }],
        });
        const subject = created.headers.get('location')?.split('/').pop();
        assert.ok(subject && /^[0-9a-f-]{36}$/.test(subject));
        user.subject = subject;
        await save();
      }
      let existing = (await (await admin('/users/' + user.subject)).json()) as {
        id: string;
        username: string;
        attributes?: Record<string, string[]>;
      };
      stage = 'verify identity subject and username';
      assert.equal(existing.id, user.subject);
      assert.equal(existing.username, user.username);
      stage = 'verify identity ownership markers';
      // Keycloak drops undeclared attributes. Repair only identities with our saved POST Location receipt;
      // a pre-existing username without that receipt was already refused above.
      if (
        !existing.attributes?.['aio.local.instance'] &&
        !existing.attributes?.['aio.local.fixture']
      ) {
        await admin('/users/' + user.subject, 'PUT', {
          ...existing,
          attributes: {
            ...existing.attributes,
            'aio.local.instance': [runtime.instanceId],
            'aio.local.fixture': ['forms'],
          },
        });
        existing = (await (await admin('/users/' + user.subject)).json()) as typeof existing;
      }
      assert.equal(existing.attributes?.['aio.local.instance']?.[0], runtime.instanceId);
      assert.equal(existing.attributes?.['aio.local.fixture']?.[0], 'forms');
      if (privileged(user.role)) {
        stage = 'verify Forms administrator MFA';
        await admin('/users/' + user.subject + '/role-mappings/realm', 'POST', [mfaRole]);
        await authenticateMfaFixture(
          browser,
          { ...runtime, users: [...runtime.users, user] },
          user.id,
          true,
        );
      }
      for (const [index, owner] of owners.entries()) {
        stage = 'record synthetic directory identity';
        const db = await owner.connect();
        try {
          await db.query('BEGIN');
          await db.query('SELECT pg_advisory_xact_lock(71092027)');
          const actor = await stores[index]!.principal(identity, 'aio-foundation', db);
          stores[index]!.require(actor, 'accounts:manage', ids.tenantA);
          const recorded = await db.query('SELECT name FROM bootstrap_receipts WHERE name=$1', [
            'forms-fixture-v1:' + user.id,
          ]);
          if (!recorded.rowCount) {
            // Creation receipts are explicit issuer/subject ownership, never email-based discovery.
            assert.equal(
              (
                await db.query('SELECT 1 FROM external_identities WHERE issuer=$1 AND subject=$2', [
                  runtime.issuer,
                  user.subject,
                ])
              ).rowCount,
              0,
            );
            await db.query(
              'INSERT INTO persons(id,home_tenant_id,display_name) VALUES ($1,$2,$3)',
              [user.personId, ids.tenantA, user.name],
            );
            await db.query('INSERT INTO accounts(id,person_id,mfa_required) VALUES ($1,$2,$3)', [
              user.id,
              user.personId,
              privileged(user.role),
            ]);
            await db.query(
              "INSERT INTO external_identities(issuer,subject,account_id,verified_at,verified_by,verification_method) VALUES ($1,$2,$3,now(),$4,'forms-local-provisioning')",
              [runtime.issuer, user.subject, user.id, actor.accountId],
            );
            await db.query('INSERT INTO tenant_memberships(account_id,tenant_id) VALUES ($1,$2)', [
              user.id,
              ids.tenantA,
            ]);
            await db.query(
              'INSERT INTO employments(id,person_id,tenant_id,legal_entity_id,employee_code) VALUES ($1,$2,$3,$4,$5)',
              [
                user.employmentId,
                user.personId,
                ids.tenantA,
                ids.legalA,
                'FORMS-' + user.role.toUpperCase(),
              ],
            );
            const position =
              user.unitId === ids.unitC
                ? '70000000-0000-4000-8000-000000000002'
                : '70000000-0000-4000-8000-000000000001';
            await db.query(
              'INSERT INTO assignments(id,tenant_id,legal_entity_id,employment_id,position_id,is_primary) VALUES ($1,$2,$3,$4,$5,true)',
              [user.assignmentId, ids.tenantA, ids.legalA, user.employmentId, position],
            );
            await db.query('INSERT INTO bootstrap_receipts(name) VALUES ($1)', [
              'forms-fixture-v1:' + user.id,
            ]);
            await auditMutation(
              db,
              context('provision owned synthetic identity'),
              actor,
              'forms.fixture.created',
              'account',
              user.id,
              null,
              {
                personId: user.personId,
                issuer: runtime.issuer,
                subject: user.subject,
                unitId: user.unitId,
              },
              user.id,
            );
          } else {
            const account = (
              await db.query('SELECT person_id FROM accounts WHERE id=$1', [user.id])
            ).rows[0];
            assert.equal(account?.person_id, user.personId);
            assert.equal(
              (
                await db.query(
                  'SELECT account_id FROM external_identities WHERE issuer=$1 AND subject=$2',
                  [runtime.issuer, user.subject],
                )
              ).rows[0]?.account_id,
              user.id,
            );
          }
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        } finally {
          db.release();
        }
      }
    }
    for (const store of stores) {
      stage = 'provision explicit Forms permissions and roles';
      const governance = new GovernanceService(store);
      for (const [code, name] of Object.entries(formsPermissions)) {
        if (
          !(
            await store.pool.query(
              'SELECT 1 FROM permission_catalog WHERE app_code=$1 AND code=$2',
              ['aio-forms', code],
            )
          ).rowCount
        )
          await governance.savePermission(context('create permission'), {
            appCode: 'aio-forms',
            code,
            name,
          });
      }
      for (const [code, permissions] of Object.entries(roles)) {
        if (
          !(
            await store.pool.query(
              'SELECT 1 FROM app_roles WHERE tenant_id=$1 AND app_code=$2 AND code=$3',
              [ids.tenantA, 'aio-forms', code],
            )
          ).rowCount
        )
          await governance.saveRole(context('create role'), {
            appCode: 'aio-forms',
            code,
            name: 'Forms ' + code,
            permissions,
          });
      }
      for (const user of [
        ...receipt.users,
        { id: ids.learner, role: 'respondent', unitId: null },
      ]) {
        if (
          !(
            await store.pool.query(
              'SELECT 1 FROM application_grants WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
              [user.id, ids.tenantA, 'aio-forms'],
            )
          ).rowCount
        )
          await governance.saveGrant(context('create fixture grant'), {
            appCode: 'aio-forms',
            accountId: user.id,
            active: true,
          });
        if (
          !(
            await store.pool.query(
              'SELECT 1 FROM role_bindings WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3 AND role_code=$4',
              [user.id, ids.tenantA, 'aio-forms', user.role],
            )
          ).rowCount
        )
          await governance.saveBinding(context('create fixture binding'), {
            appCode: 'aio-forms',
            accountId: user.id,
            roleCode: user.role,
            orgUnitId: ['reviewer', 'analyst'].includes(user.role) ? user.unitId : null,
          });
      }
    }
    console.log(
      'PASS: five owned synthetic Forms identities, MFA designer/publisher, explicit role/grant scope; reruns preserve existing rights and credentials.',
    );
  } finally {
    await browser.close();
  }
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    'Forms fixture setup failed at: ' +
      stage +
      (code && /^[A-Z0-9_]{1,60}$/.test(code) ? ' (' + code + ')' : '') +
      '. Credentials and browser payloads omitted.',
  );
  process.exitCode = 1;
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
}
