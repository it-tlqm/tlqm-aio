import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import pg from 'pg';
import { ids } from '../src/fixtures.js';
import { assertStagingConfig, stagingDatabaseTls, stagingTarget } from '../src/staging-config.js';
import type { StagingConfig } from '../src/staging-config.js';
import { captureAudit } from './staging-audit.js';
import type { AuditEvidence } from './staging-audit.js';

const worker = 'SYN-WORKER-01';
const applySignature = 'personnel_sync.apply_snapshot(uuid, text, integer, boolean)';
type PersonnelSnapshot = { sourceId: string; revision: number; employed: boolean };
type Receipt = {
  outcome: 'applied' | 'replay' | 'stale' | 'conflict' | 'unlinked';
  request_id: string | null;
};

export async function verifyStagingPersonnel(
  runtime: StagingConfig,
  owner: pg.Pool,
  ca: string,
  sessions: { portal: Page; forms: Page; workflows: Page; tasks: Page; lms: Page },
  operator: Page,
  audit: AuditEvidence[],
  phase: (name: string) => void,
) {
  assertStagingConfig(runtime);
  const target = stagingTarget(runtime.slot);
  phase('personnel connector role and explicit binding');
  assert.deepEqual(
    (await owner.query('SELECT current_database() AS name, current_user AS owner')).rows[0],
    { name: target.database, owner: 'aio_stage_owner' },
  );
  const credential = new URL(runtime.databaseUrl);
  credential.username = 'aio_stage_personnel';
  credential.password = randomBytes(32).toString('hex');
  const admin = await owner.connect();
  try {
    await admin.query('BEGIN');
    assert.equal(
      (
        await admin.query('SELECT 1 FROM bootstrap_receipts WHERE name=$1', [
          'enterprise-staging:' + runtime.instanceId,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await admin.query(
          `INSERT INTO personnel_sync.bindings (source_id, tenant_id, employment_id, account_id)
           SELECT $1, e.tenant_id, e.id, a.id FROM employments e JOIN accounts a ON a.person_id = e.person_id
             JOIN persons p ON p.id = a.person_id AND p.home_tenant_id = e.tenant_id
             WHERE a.id = $2 AND e.tenant_id = $3 AND NOT a.is_protected`,
          [worker, ids.learner, ids.tenantA],
        )
      ).rowCount,
      1,
    );
    await admin.query(
      'CREATE ROLE aio_stage_personnel LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ' +
        admin.escapeLiteral(credential.password),
    );
    await admin.query('CREATE ROLE aio_stage_personnel_executor NOLOGIN NOINHERIT');
    await admin.query(`
      GRANT CONNECT ON DATABASE ${target.database} TO aio_stage_personnel;
      GRANT USAGE ON SCHEMA personnel_sync TO aio_stage_personnel, aio_stage_personnel_executor;
      GRANT SELECT ON personnel_sync.bindings TO aio_stage_personnel_executor;
      GRANT UPDATE (source_revision, employed, last_request_id) ON personnel_sync.bindings TO aio_stage_personnel_executor;
      GRANT SELECT (purpose) ON environment_marker TO aio_stage_personnel_executor;
      GRANT SELECT (name) ON bootstrap_receipts TO aio_stage_personnel_executor;
      GRANT SELECT (id, person_id, is_protected, active, revision) ON accounts TO aio_stage_personnel_executor;
      GRANT UPDATE (active, revision) ON accounts TO aio_stage_personnel_executor;
      GRANT SELECT (id, home_tenant_id) ON persons TO aio_stage_personnel_executor;
      GRANT SELECT (id, person_id, tenant_id) ON employments TO aio_stage_personnel_executor;
      GRANT SELECT (account_id), DELETE ON sessions TO aio_stage_personnel_executor;
      GRANT INSERT (subject_account_id, tenant_id, app_code, action, request_id, details) ON audit_events TO aio_stage_personnel_executor;
      ALTER FUNCTION ${applySignature} OWNER TO aio_stage_personnel_executor;
      ALTER FUNCTION personnel_sync.guard_activation() OWNER TO aio_stage_personnel_executor;
      GRANT EXECUTE ON FUNCTION ${applySignature} TO aio_stage_personnel;
    `);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  } finally {
    admin.release();
  }

  const connection = new pg.Pool({
    connectionString: credential.href,
    ssl: stagingDatabaseTls(ca),
    max: 2,
    connectionTimeoutMillis: 3000,
    statement_timeout: 8000,
  });
  const apply = async (snapshot: PersonnelSnapshot, instance = runtime.instanceId) =>
    (
      await connection.query<Receipt>('SELECT * FROM personnel_sync.apply_snapshot($1,$2,$3,$4)', [
        instance,
        snapshot.sourceId,
        snapshot.revision,
        snapshot.employed,
      ])
    ).rows[0]!;
  const state = async () =>
    (
      await owner.query<{ active: boolean; revision: number; boundary: number; sessions: number }>(
        `SELECT active, revision, auth_not_before::float8 AS boundary,
           (SELECT count(*)::int FROM sessions WHERE account_id=a.id) AS sessions FROM accounts a WHERE id=$1`,
        [ids.learner],
      )
    ).rows[0]!;
  const preserved = async () =>
    (
      await owner.query(
        `SELECT (SELECT jsonb_agg(g ORDER BY g.tenant_id,g.app_code) FROM application_grants g WHERE g.account_id=a.id) AS grants,
           (SELECT jsonb_agg(e ORDER BY e.id) FROM employments e WHERE e.person_id=a.person_id) AS employments,
           (SELECT jsonb_agg(i ORDER BY i.id) FROM external_identities i WHERE i.account_id=a.id) AS identities
         FROM accounts a WHERE id=$1`,
        [ids.learner],
      )
    ).rows[0];
  const probe = async (page: Page, path: string) =>
    page.evaluate(async (path) => {
      const response = await fetch(path);
      return {
        status: response.status,
        error: response.ok ? null : (await response.json()).error,
        requestId: response.headers.get('x-request-id'),
      };
    }, path);
  const activate = async (revision: number) =>
    operator.evaluate(
      async ({ revision, tenantId, accountId, key }) => {
        const { csrfToken } = await (await fetch('/api/v1/me')).json();
        const response = await fetch('/api/v1/manage/accounts/' + accountId, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
            'idempotency-key': key,
          },
          body: JSON.stringify({
            tenantId,
            expectedRevision: revision,
            data: { active: true },
            reason: 'Synthetic personnel lifecycle rehearsal',
          }),
        });
        return {
          status: response.status,
          error: response.ok ? null : (await response.json()).error,
        };
      },
      { revision, tenantId: ids.tenantA, accountId: ids.learner, key: randomUUID() },
    );

  try {
    assert.deepEqual(
      (
        await connection.query(`SELECT
        has_table_privilege(current_user, 'public.accounts', 'SELECT') AS read_accounts,
        has_column_privilege(current_user, 'public.accounts', 'active', 'UPDATE') AS write_accounts,
        has_table_privilege(current_user, 'personnel_sync.bindings', 'UPDATE') AS write_bindings,
        has_database_privilege(current_user, 'aio_stage_identity', 'CONNECT') AS connect_idp,
        has_function_privilege('aio_runtime', '${applySignature}', 'EXECUTE') AS bff_can_apply,
        has_function_privilege(current_user, '${applySignature}', 'EXECUTE') AS can_apply`)
      ).rows[0],
      {
        read_accounts: false,
        write_accounts: false,
        write_bindings: false,
        connect_idp: false,
        bff_can_apply: false,
        can_apply: true,
      },
    );
    const employed = { sourceId: worker, revision: 1, employed: true };
    await assert.rejects(apply(employed, randomUUID()), { code: '42501' });
    assert.deepEqual(await apply({ ...employed, sourceId: 'SYN-UNLINKED' }), {
      outcome: 'unlinked',
      request_id: null,
    });

    phase('personnel employed snapshot and active module sessions');
    const initial = await apply(employed);
    assert.equal(initial.outcome, 'applied');
    captureAudit(audit, 'foundation', 'personnel-source.employed')(initial.request_id);
    const before = await state();
    assert.ok(before.active && before.sessions >= 4);
    const previous = await preserved();
    const endpoints = [
      ['portal', '/api/v1/applications', 401],
      ['forms', '/api/v1/forms?tenantId=' + ids.tenantA, 401],
      ['workflows', '/api/v1/workflows/definitions?tenantId=' + ids.tenantA, 401],
      ['tasks', '/api/v1/tasks/projects?tenantId=' + ids.tenantA, 401],
      ['lms', '/api/lms/courses', 403],
    ] as const;
    for (const [app, path] of endpoints) {
      phase('personnel active session at ' + app);
      assert.equal((await probe(sessions[app], path)).status, 200, app);
    }

    phase('personnel departure and next request on all five sources');
    const departure = { ...employed, revision: 2, employed: false };
    const submittedAt = performance.now();
    const replies = await Promise.all([apply(departure), apply(departure)]);
    const acknowledgedAt = performance.now();
    assert.deepEqual(replies.map(({ outcome }) => outcome).sort(), ['applied', 'replay']);
    assert.equal(replies[0].request_id, replies[1].request_id);
    captureAudit(audit, 'foundation', 'personnel-source.departed')(replies[0].request_id);
    const firstDenied = await Promise.all(
      endpoints.map(async ([app, path, expected]) => {
        const startedAt = performance.now();
        const response = await probe(sessions[app], path);
        const deniedAt = performance.now();
        assert.equal(response.status, expected, app);
        if (app === 'lms') {
          assert.equal(response.error, 'ACCOUNT_UNAVAILABLE');
          captureAudit(audit, 'lms', 'session.revoked')(response.requestId);
        }
        return {
          app,
          status: response.status,
          afterAcknowledgementMs: Math.round(deniedAt - acknowledgedAt),
          requestMs: Math.round(deniedAt - startedAt),
        };
      }),
    );
    const disabled = await state();
    assert.deepEqual(
      { active: disabled.active, revision: disabled.revision, sessions: disabled.sessions },
      { active: false, revision: before.revision + 1, sessions: 0 },
    );
    assert.ok(disabled.boundary > before.boundary);
    assert.deepEqual(await apply(employed), { outcome: 'stale', request_id: null });
    assert.deepEqual(await apply({ ...departure, employed: true }), {
      outcome: 'conflict',
      request_id: null,
    });
    assert.deepEqual(await activate(disabled.revision), {
      status: 409,
      error: 'PERSONNEL_SOURCE_ACTIVATION_BLOCKED',
    });

    phase('personnel return and explicit IAM reactivation');
    const returned = await apply({ ...employed, revision: 3 });
    assert.equal(returned.outcome, 'applied');
    captureAudit(audit, 'foundation', 'personnel-source.employed')(returned.request_id);
    assert.deepEqual(await state(), disabled);
    assert.equal((await activate(disabled.revision)).status, 200);
    assert.deepEqual(await state(), { ...disabled, active: true, revision: disabled.revision + 1 });
    assert.deepEqual(await preserved(), previous);
    for (const [app, path] of endpoints) {
      const response = await probe(sessions[app], path);
      assert.equal(response.status, 401, app);
      assert.equal(response.error, 'SESSION_EXPIRED', app);
    }
    const portalOrigin = new URL(sessions.portal.url()).origin;
    await sessions.portal.goto(portalOrigin + '/auth/login', { timeout: 15000 });
    await sessions.portal
      .locator('[data-auth-error="REAUTHENTICATION_REQUIRED"]')
      .waitFor({ timeout: 8000 });
    await delay(Math.max(0, (disabled.boundary + 1) * 1000 - Date.now() + 50));
    return {
      wrongInstanceRefused: true,
      executeOnlyRole: true,
      unknownSourceIdIgnored: true,
      concurrentReplay: true,
      staleAndConflictIgnored: true,
      foundationSessionsRemoved: before.sessions,
      submitToAcknowledgementMs: Math.round(acknowledgedAt - submittedAt),
      firstDenied,
      returnRequiresIamApproval: true,
      oldSessionsDeniedAfterReactivation: true,
      staleSsoRequiresNewAuthentication: true,
      employmentIdentityAndGrantsPreserved: true,
    };
  } finally {
    await connection.end();
  }
}
