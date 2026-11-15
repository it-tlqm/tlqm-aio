import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { bootstrapFixtures } from '../src/database/bootstrap.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { grantModuleRuntime } from '../src/database/module-grants.js';
import { ids } from '../src/fixtures.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { parseWorkflow } from '../src/workflows/contracts.js';
import { migrateForms } from '../src/forms/database.js';
import { stagingModuleDatabase, stagingTarget } from '../src/staging-config.js';
import { migrateTasks } from '../src/tasks/database.js';
import { migrateWorkflows } from '../src/workflows/database.js';

const modules = { forms: migrateForms, tasks: migrateTasks, workflows: migrateWorkflows };
type Module = keyof typeof modules;
type Use = <T>(
  store: Module | 'foundation' | 'audit',
  action: (db: PoolClient) => Promise<T>,
) => Promise<T>;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const slot = 'a';
const issuer = stagingTarget(slot).issuer;
const foundationPort = stagingTarget(slot).foundation;
const { tenantA: tenant, learner: actor, unitA: unit, admin } = ids;

export async function seedRecoveryFixtures(
  artifact: string,
  instance: string,
  use: Use,
  tasksMigrationArtifact = artifact,
) {
  const request = randomUUID();
  const workflow = randomUUID(),
    definition = randomUUID(),
    version = randomUUID(),
    file = randomUUID();
  const form = randomUUID(),
    formVersion = randomUUID(),
    submission = randomUUID(),
    project = randomUUID();
  const content = Buffer.from('TLQM AIO synthetic recovery attachment\n');
  const checksum = sha(content);
  const fingerprint = sha('{}');
  await use('foundation', async (db) => {
    await migrateDatabase(db, 'tlqm-aio-test', join(artifact, 'infrastructure/database'));
    const client = {
      code: 'aio-foundation',
      name: 'AIO Foundation recovery',
      port: foundationPort,
      baseUrl: 'https://127.0.0.1:' + foundationPort,
      clientId: 'aio-foundation',
      clientSecret: randomUUID(),
      audience: 'aio-foundation',
    };
    await bootstrapFixtures(db, { clients: [client], issuer, users: [] });
    await db.query('INSERT INTO bootstrap_receipts(name) VALUES ($1)', [
      'enterprise-staging:' + instance,
    ]);
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.query('GRANT USAGE ON SCHEMA public TO aio_runtime');
    await db.query(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO aio_runtime',
    );
    await db.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO aio_runtime');
    await db.query(
      'REVOKE INSERT,UPDATE,DELETE ON schema_migrations,environment_marker,bootstrap_receipts FROM aio_runtime',
    );
    await db.query('REVOKE UPDATE,DELETE ON audit_events,mutation_receipts FROM aio_runtime');
    await db.query(
      `INSERT INTO audit_events(tenant_id,actor_account_id,app_code,action,request_id)
      VALUES ($1,$2,'aio-foundation','recovery.checkpoint',$3)`,
      [tenant, actor, request],
    );
  });
  for (const module of ['forms', 'tasks', 'workflows'] as const) {
    await use(module, async (db) => {
      await db.query('SET ROLE ' + stagingModuleDatabase(slot, module).owner);
      try {
        await modules[module](db, instance, {
          slot,
          directory: join(
            module === 'tasks' ? tasksMigrationArtifact : artifact,
            'infrastructure',
            module,
          ),
        });
        await grantModuleRuntime(db, module);
      } finally {
        await db.query('RESET ROLE');
      }
    });
  }
  await use('forms', async (db) => {
    await db.query(
      `INSERT INTO forms(id,tenant_id,code,title,owner_account_id,org_unit_id,latest_version)
      VALUES ($1,$2,'recovery-fixture','Synthetic recovery form',$3,$4,2)`,
      [form, tenant, actor, unit],
    );
    await db.query(
      `INSERT INTO form_versions(id,tenant_id,form_id,version,schema,checksum,published_by)
      VALUES ($1,$2,$3,1,'{}',$4,$5),($6,$2,$3,2,'{}',$4,$5)`,
      [formVersion, tenant, form, fingerprint, actor, randomUUID()],
    );
    await db.query(
      `INSERT INTO submissions(id,tenant_id,form_id,version_id,account_id,person_id,org_unit_id,status,answers,submitted_at)
      VALUES ($1,$2,$3,$4,$5,$5,$6,'submitted','{}',now())`,
      [submission, tenant, form, formVersion, actor, unit],
    );
    await db.query(
      `INSERT INTO form_receipts(tenant_id,actor_account_id,idempotency_key,operation,request_hash,response)
      VALUES ($1,$2,$3,'recovery.fixture',$4,jsonb_build_object('submission',$5::text))`,
      [tenant, actor, request, fingerprint, submission],
    );
    await db.query(
      `INSERT INTO form_audit(tenant_id,form_id,org_unit_id,actor_account_id,action,target_id,reason,request_id)
      VALUES ($1,$2,$3,$4,'recovery.checkpoint',$5,'synthetic',$6)`,
      [tenant, form, unit, actor, submission, request],
    );
  });
  await use('tasks', async (db) => {
    await db.query(
      `INSERT INTO task_projects(id,tenant_id,org_unit_id,name,description,owner_account_id,owner_person_id)
      VALUES ($1,$2,$3,'Synthetic recovery project','',$4,$4)`,
      [project, tenant, unit, actor],
    );
    await db.query(
      `INSERT INTO task_project_members(tenant_id,project_id,account_id,person_id,name,role)
      VALUES ($1,$2,$3,$3,'Synthetic member','manager')`,
      [tenant, project, actor],
    );
    await db.query(
      `INSERT INTO task_audit(tenant_id,project_id,actor_account_id,actor_name,action,reason,request_id,details)
      VALUES ($1,$2,$3,'Synthetic member','recovery.checkpoint','synthetic',$4,'{}')`,
      [tenant, project, actor, request],
    );
  });
  const intake = await use('workflows', async (db) => {
    const draft = workflowTemplate('leave');
    draft.audienceUnits = [unit];
    for (const step of draft.nodes)
      if (step.kind === 'task' || step.kind === 'approval') step.assignee = admin;
    const spec = JSON.stringify(parseWorkflow(draft));
    await db.query(
      `INSERT INTO workflow_definitions(id,tenant_id,code,name,category,org_unit_id,owner_account_id,draft,status,latest_version)
      VALUES ($1,$2,'recovery-fixture','Synthetic recovery workflow','general',$3,$4,'{}','published',2)`,
      [definition, tenant, unit, admin],
    );
    await db.query(
      `INSERT INTO workflow_versions(id,tenant_id,definition_id,version,spec,checksum,published_by)
      VALUES ($1,$2,$3,1,$7,$4,$5),($6,$2,$3,2,$7,$4,$5)`,
      [version, tenant, definition, sha(spec), admin, randomUUID(), spec],
    );
    await db.query(
      `INSERT INTO workflow_runs(id,tenant_id,definition_id,version_id,org_unit_id,owner_account_id,owner_person_id,title,status,inputs)
      VALUES ($1,$2,$3,$4,$5,$6,$6,'Synthetic recovery workflow','running','{}')`,
      [workflow, tenant, definition, version, unit, actor],
    );
    await db.query(
      `INSERT INTO workflow_run_inputs(tenant_id,run_id,round,inputs) VALUES ($1,$2,1,'{}')`,
      [tenant, workflow],
    );
    await db.query(
      `INSERT INTO workflow_intake_rules(tenant_id,definition_id,version_id,org_unit_id,kind,recipient_account_id,recipient_person_id,mapping,created_by)
      VALUES ($1,$2,$3,$4,'lms-training',$5,$5,'{}',$5)`,
      [tenant, definition, version, unit, admin],
    );
    await db.query(
      `INSERT INTO workflow_attachments(id,tenant_id,run_id,round,field_id,uploader_account_id,uploader_person_id,file_name,format,byte_count,checksum,scan_status,content)
      VALUES ($1,$2,$3,1,'supporting-file',$4,$4,'recovery.txt','txt',$5,$6,'ready',$7)`,
      [file, tenant, workflow, actor, content.length, checksum, content],
    );
    await db.query(
      `INSERT INTO workflow_attachment_links(tenant_id,run_id,round,field_id,attachment_id)
      VALUES ($1,$2,1,'supporting-file',$3)`,
      [tenant, workflow, file],
    );
    await db.query(
      `UPDATE workflow_runs SET status='completed',revision=revision+1,finished_at=now() WHERE id=$1 AND revision=1`,
      [workflow],
    );
    const jobs = await db.query<{ id: string }>(
      `SELECT id FROM workflow_intake_jobs WHERE source_run_id=$1 AND status='queued'`,
      [workflow],
    );
    assert.equal(jobs.rowCount, 1);
    await db.query(
      `INSERT INTO workflow_audit(tenant_id,definition_id,run_id,org_unit_id,actor_account_id,action,reason,request_id)
      VALUES ($1,$2,$3,$4,$5,'recovery.checkpoint','synthetic',$6)`,
      [tenant, definition, workflow, unit, actor, request],
    );
    return {
      id: jobs.rows[0]!.id,
      kind: 'lms-training',
      tenantId: tenant,
      unitId: unit,
      runId: workflow,
      versionId: version,
      round: 1,
      accountId: admin,
      personId: admin,
    } as const;
  });
  await use('audit', async (db) => {
    for (const migration of ['001-staging-audit.sql', '002-staging-infrastructure-audit.sql'])
      await db.query(await readFile(join(artifact, 'infrastructure/audit', migration), 'utf8'));
    await db.query(
      `INSERT INTO audit_projection.environment_marker VALUES (true,$1,'tlqm-aio-audit-staging')`,
      [instance],
    );
    await db.query(
      'GRANT USAGE ON SCHEMA audit_projection TO aio_audit_read,aio_audit_ingress,aio_audit_collect',
    );
    await db.query(
      'GRANT SELECT ON audit_projection.events,audit_projection.infrastructure_events TO aio_audit_read',
    );
    await db.query(
      'GRANT INSERT ON audit_projection.infrastructure_events TO aio_audit_ingress,aio_audit_collect',
    );
    await db.query(
      `INSERT INTO audit_projection.events(source,source_id,occurred_at,app_code,tenant_id,actor_account_id,action,request_id)
      SELECT source,1,now(),app,$1,$2,'recovery.checkpoint',$3 FROM (VALUES
      ('foundation','aio-foundation'),('forms','aio-forms'),('workflows','aio-workflows'),('tasks','aio-tasks')) AS apps(source,app)`,
      [tenant, actor, request],
    );
  });
  return {
    instance,
    tenant,
    actor,
    workflow,
    version,
    file,
    checksum,
    form,
    submission,
    formVersion,
    project,
    request,
    intake,
  };
}

type Fixture = Awaited<ReturnType<typeof seedRecoveryFixtures>>;

export async function verifyRecoveryFixtures(use: Use, f: Fixture, later: string) {
  await use('foundation', async (db) => {
    const state = (
      await db.query(
        `SELECT a.active, g.active AS granted FROM external_identities e
      JOIN accounts a ON a.id=e.account_id JOIN application_grants g ON g.account_id=a.id
      WHERE e.issuer=$1 AND e.subject=$2 AND e.active AND g.tenant_id=$3 AND g.app_code='aio-foundation'`,
        [issuer, f.actor, f.tenant],
      )
    ).rows;
    assert.deepEqual(state, [{ active: true, granted: true }]);
    assert.equal(
      (
        await db.query(`SELECT 1 FROM application_grants WHERE account_id=$1 AND tenant_id=$2`, [
          f.actor,
          ids.tenantB,
        ])
      ).rowCount,
      0,
    );
    assert.deepEqual(
      (
        await db.query('SELECT request_id FROM audit_events WHERE request_id IN ($1,$2)', [
          f.request,
          later,
        ])
      ).rows,
      [{ request_id: f.request }],
    );
    assert.equal(
      (
        await db.query('SELECT 1 FROM bootstrap_receipts WHERE name=$1', [
          'enterprise-staging:' + f.instance,
        ])
      ).rowCount,
      1,
    );
  });
  await use('forms', async (db) => {
    assert.deepEqual(
      (
        await db.query(
          `SELECT v.id, v.version, f.latest_version, r.response->>'submission' AS submission
      FROM submissions s JOIN form_versions v ON v.id=s.version_id JOIN forms f ON f.id=s.form_id
      JOIN form_receipts r ON r.tenant_id=s.tenant_id AND r.actor_account_id=s.account_id
      WHERE s.id=$1 AND s.status='submitted' AND r.idempotency_key=$2`,
          [f.submission, f.request],
        )
      ).rows,
      [{ id: f.formVersion, version: 1, latest_version: 2, submission: f.submission }],
    );
  });
  await use('tasks', async (db) => {
    assert.equal(
      (
        await db.query(
          `SELECT 1 FROM task_projects p JOIN task_project_members m
      ON (m.tenant_id,m.project_id)=(p.tenant_id,p.id) WHERE p.id=$1 AND m.account_id=$2 AND m.active AND m.role='manager'`,
          [f.project, f.actor],
        )
      ).rowCount,
      1,
    );
  });
  await use('workflows', async (db) => {
    const rows = (
      await db.query(
        `SELECT v.id, v.version, d.latest_version, j.status, j.attempts,
      a.checksum, encode(sha256(a.content),'hex') AS bytes_sha256 FROM workflow_runs r
      JOIN workflow_versions v ON v.id=r.version_id JOIN workflow_definitions d ON d.id=r.definition_id
      JOIN workflow_intake_jobs j ON j.source_run_id=r.id AND j.source_round=r.round
      JOIN workflow_attachment_links l ON l.run_id=r.id AND l.round=r.round
      JOIN workflow_attachments a ON a.id=l.attachment_id
      WHERE r.id=$1 AND r.status='completed' AND a.id=$2`,
        [f.workflow, f.file],
      )
    ).rows;
    assert.deepEqual(rows, [
      {
        id: f.version,
        version: 1,
        latest_version: 2,
        status: 'queued',
        attempts: 0,
        checksum: f.checksum,
        bytes_sha256: f.checksum,
      },
    ]);
  });
  for (const [store, role, table, appendOnlyCode] of [
    ['foundation', 'aio_runtime', 'audit_events', '42501'],
    ['forms', 'aio_forms_runtime', 'form_audit', '42501'],
    ['tasks', 'aio_tasks_runtime', 'task_audit', '23514'],
    ['workflows', 'aio_workflows_runtime', 'workflow_audit', '42501'],
  ] as const) {
    await use(store, async (db) => {
      assert.equal(
        (await db.query('SELECT 1 FROM ' + table + ' WHERE request_id=$1', [f.request])).rowCount,
        1,
      );
      await assert.rejects(
        () => db.query('UPDATE ' + table + ' SET reason=reason WHERE request_id=$1', [f.request]),
        { code: appendOnlyCode },
      );
      await db.query('SET ROLE ' + role);
      try {
        assert.equal(
          (await db.query('SELECT 1 FROM ' + table + ' WHERE request_id=$1', [f.request])).rowCount,
          1,
        );
        await assert.rejects(
          () => db.query('DELETE FROM ' + table + ' WHERE request_id=$1', [f.request]),
          { code: '42501' },
        );
        await assert.rejects(() => db.query('UPDATE schema_migrations SET checksum=checksum'), {
          code: '42501',
        });
      } finally {
        await db.query('RESET ROLE');
      }
    });
  }
  await use('audit', async (db) => {
    assert.equal(
      (
        await db.query('SELECT 1 FROM audit_projection.environment_marker WHERE instance_id=$1', [
          f.instance,
        ])
      ).rowCount,
      1,
    );
    await db.query('SET ROLE aio_audit_read');
    try {
      assert.deepEqual(
        (
          await db.query(
            'SELECT source FROM audit_projection.events WHERE request_id=$1 ORDER BY source',
            [f.request],
          )
        ).rows.map(({ source }) => source),
        ['forms', 'foundation', 'tasks', 'workflows'],
      );
      await assert.rejects(
        () => db.query('DELETE FROM audit_projection.events WHERE request_id=$1', [f.request]),
        { code: '42501' },
      );
    } finally {
      await db.query('RESET ROLE');
    }
  });
  return {
    identityAndGrant: true,
    formsPinnedVersionAndReceipt: true,
    tasksMembership: true,
    workflowPinnedVersionAttachmentAndQueuedIntake: true,
    correlatedAuditSources: 4,
    auditAppendOnly: true,
    journalRuntimeWritesDenied: true,
  };
}
