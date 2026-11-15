import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadLocalConfig, testDatabaseUrl } from '../src/config.js';
import { loadWorkflowsConfig, workflowsDatabaseUrl } from '../src/workflows/database.js';
import { localContainer } from './local-docker.js';
const execute = promisify(execFile),
  runtime = await loadLocalConfig(),
  config = await loadWorkflowsConfig(runtime.instanceId);
const foundation = new pg.Pool({ connectionString: testDatabaseUrl(runtime), max: 1 }),
  workflow = new pg.Pool({ connectionString: workflowsDatabaseUrl(config, true), max: 1 });
let stage = 'preflight',
  restore: (() => Promise<void>) | undefined;
const run = async (script: string) => {
  try {
    await execute(process.execPath, ['--import', 'tsx', script], {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 2 ** 20,
    });
  } catch {
    throw new Error('Guarded script failed; output omitted.');
  }
};
try {
  assert.equal((await localContainer('foundation-db')).running, true);
  assert.equal((await localContainer('keycloak')).running, true);
  assert.equal(
    (await foundation.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-test',
  );
  assert.equal(
    (await workflow.query('SELECT purpose FROM environment_marker')).rows[0].purpose,
    'tlqm-aio-workflows-test',
  );
  const fixtures = JSON.parse(await readFile('.local/workflows-fixtures.json', 'utf8')) as {
    instanceId: string;
    choices: { accountId: string; role: string }[];
  };
  assert.equal(fixtures.instanceId, runtime.instanceId);
  const target = fixtures.choices.find((choice) => choice.role === 'handler')!;
  const before = (
    await foundation.query(
      "SELECT g.active AS grant_active,b.id,b.active AS binding_active FROM application_grants g JOIN role_bindings b ON b.tenant_id=g.tenant_id AND b.account_id=g.account_id AND b.app_code=g.app_code WHERE g.account_id=$1 AND g.app_code='aio-workflows' AND b.role_code='handler'",
      [target.accountId],
    )
  ).rows[0];
  assert.ok(before);
  const modify = async (grant: boolean, binding: boolean) => {
    const db = await foundation.connect();
    try {
      await db.query('BEGIN');
      await db.query(
        "UPDATE application_grants SET active=$1 WHERE app_code='aio-workflows' AND account_id=$2",
        [grant, target.accountId],
      );
      await db.query('UPDATE role_bindings SET active=$1 WHERE id=$2', [binding, before.id]);
      await db.query(
        "INSERT INTO audit_events(subject_account_id,app_code,action,reason,request_id) VALUES($1,'aio-workflows','test.fixture_changed','Setup preservation and explicit restoration',$2)",
        [target.accountId, randomUUID()],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  };
  restore = () => modify(before.grant_active, before.binding_active);
  await modify(false, false);
  const credentials = await readFile('.local/workflows.json');
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all(
        [
          'workflow_versions',
          'workflow_run_inputs',
          'workflow_task_results',
          'workflow_run_assignments',
          'workflow_groups',
          'workflow_group_members',
        ].map(
          async (table) =>
            (
              await workflow.query(
                'SELECT to_jsonb(t) AS row FROM ' + table + ' t ORDER BY to_jsonb(t)::text',
              )
            ).rows,
        ),
      ),
    );
  const history = await snapshot();
  stage = 'setup rerun';
  await run('scripts/workflows-database.ts');
  stage = 'fixture rerun';
  await run('scripts/workflows-fixtures.ts');
  assert.equal(credentials.equals(await readFile('.local/workflows.json')), true);
  assert.equal(await snapshot(), history);
  assert.equal(
    (
      await foundation.query(
        "SELECT active FROM application_grants WHERE app_code='aio-workflows' AND account_id=$1",
        [target.accountId],
      )
    ).rows[0].active,
    false,
  );
  assert.equal(
    (await foundation.query('SELECT active FROM role_bindings WHERE id=$1', [before.id])).rows[0]
      .active,
    false,
  );
  await restore();
  restore = undefined;
  await writeFile(
    '.local/evidence/workflows-rehearsal.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        result: 'pass',
        checks: [
          'guarded local setup and MFA fixture rerun',
          'credentials retained',
          'revoked grant/binding not restored by setup',
          'published versions, inputs, task results, assignment snapshots and groups unchanged',
          'explicit audited fixture restoration',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: Workflows setup preserves credentials, revoked access and immutable business histories.',
  );
} catch {
  console.error('Workflows rehearsal failed at ' + stage + '. Sensitive details omitted.');
  process.exitCode = 1;
} finally {
  try {
    await restore?.();
  } catch {
    console.error('Workflow fixture restoration requires review.');
    process.exitCode = 1;
  }
  await workflow.end();
  await foundation.end();
}
