import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../security.js';
import type { Principal, Store } from '../store.js';
import type {
  IntakeDestination,
  IntakeKind,
  IntakeProjection,
  IntakeReference,
} from '../workflows/intakes.js';

const app = 'aio-foundation';
const permissions = ['people:manage', 'people:read', 'directory:read'];
const kind = 'hr-onboarding' as const;
type Db = Pool | PoolClient;
type Row = Omit<IntakeReference, 'kind'> & { employmentId: string | null };
type ReadSource = (
  tenant: string,
  id: string,
  account: string,
  person: string,
  kind: IntakeKind,
) => Promise<IntakeProjection>;
const columns = `id,tenant_id AS "tenantId",org_unit_id AS "unitId",source_run_id AS "runId",
  source_version_id AS "versionId",source_round AS round,recipient_account_id AS "accountId",
  recipient_person_id AS "personId",employment_id AS "employmentId"`;

export class PersonnelWorkflowIntake implements IntakeDestination {
  constructor(
    private store: Store,
    private readSource?: ReadSource,
  ) {}

  private async permitted(db: Db, tenant: string, unit: string, account: string, person: string) {
    const personScope = await db.query(
      `SELECT 1 FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active
       JOIN external_identities i ON i.account_id=a.id AND i.active
       JOIN applications app ON app.code='aio-foundation' AND app.status='active'
       JOIN org_units u ON u.tenant_id=$1 AND u.id=$2 AND u.active
       JOIN legal_entities l ON l.id=u.legal_entity_id AND l.active
       WHERE (a.id,a.person_id)=($3,$4) AND a.active`,
      [tenant, unit, account, person],
    );
    if (!personScope.rowCount) return false;
    const grants = await this.store.applicationPermissions(account, app, db);
    return permissions.every((permission) =>
      grants.some(
        (p) =>
          p.tenantId === tenant &&
          p.orgUnitId === null &&
          p.permission === permission &&
          (p.managedAppCode === null || p.managedAppCode === app),
      ),
    );
  }

  async assertRecipient(
    target: IntakeKind,
    tenant: string,
    unit: string,
    account: string,
    person: string,
  ) {
    if (target !== kind) throw new HttpError(400, 'WORKFLOW_INTAKE_UNAVAILABLE');
    if (!(await this.permitted(this.store.pool, tenant, unit, account, person)))
      throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
  }

  async recipients(target: IntakeKind, tenant: string, unit: string, search: string) {
    if (target !== kind) throw new HttpError(400, 'WORKFLOW_INTAKE_UNAVAILABLE');
    const candidates = (
      await this.store.pool.query<{ id: string; personId: string; name: string }>(
        `SELECT a.id,a.person_id AS "personId",p.display_name AS name
       FROM accounts a JOIN persons p ON p.id=a.person_id AND p.active
       WHERE a.active AND strpos(lower(p.display_name),lower($2))>0 AND EXISTS (
         SELECT 1 FROM tenant_memberships m JOIN application_grants g ON (g.tenant_id,g.account_id)=(m.tenant_id,m.account_id)
         WHERE (m.tenant_id,m.account_id)=($1,a.id) AND m.active AND g.active AND g.app_code='aio-workflows'
           AND (g.valid_until IS NULL OR g.valid_until>now())
       ) ORDER BY lower(p.display_name),a.id LIMIT 100`,
        [tenant, search],
      )
    ).rows;
    const items = [];
    for (const { id, personId, name } of candidates) {
      if (await this.permitted(this.store.pool, tenant, unit, id, personId))
        items.push({ id, name });
      if (items.length === 30) break;
    }
    return items;
  }

  async receive(reference: IntakeReference) {
    const { id, tenantId, unitId, runId, versionId, round, accountId, personId } = reference;
    if (reference.kind !== kind) throw new HttpError(400, 'WORKFLOW_INTAKE_UNAVAILABLE');
    const db = await this.store.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(71092027)');
      if (!(await this.permitted(db, tenantId, unitId, accountId, personId)))
        throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
      const inserted = await db.query(
        `INSERT INTO personnel_workflow_intakes(id,tenant_id,org_unit_id,source_run_id,source_version_id,
          source_round,recipient_account_id,recipient_person_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, tenantId, unitId, runId, versionId, round, accountId, personId],
      );
      if (inserted.rowCount) {
        await db.query(
          `INSERT INTO audit_events(subject_account_id,tenant_id,app_code,action,request_id,target_type,target_id,details)
           VALUES($1,$2,'aio-foundation','personnel.workflow_intake_received',$3,'personnel_workflow_intake',$3,$4)`,
          [accountId, tenantId, id, JSON.stringify({ runId, versionId, round, unitId })],
        );
      } else {
        const exact = await db.query(
          `SELECT 1 FROM personnel_workflow_intakes WHERE (id,tenant_id,org_unit_id,source_run_id,source_version_id,
            source_round,recipient_account_id,recipient_person_id)=($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, tenantId, unitId, runId, versionId, round, accountId, personId],
        );
        if (!exact.rowCount) throw new HttpError(409, 'WORKFLOW_INTAKE_REFERENCE_CONFLICT');
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  private requireOperator(actor: Principal, tenant: string) {
    for (const permission of permissions) this.store.require(actor, permission, tenant);
  }

  private async project(row: Row) {
    if (!this.readSource) throw new HttpError(503, 'WORKFLOW_INTAKE_UNAVAILABLE');
    const { id, tenantId, accountId, personId } = row;
    const data = await this.readSource(tenantId, id, accountId, personId, kind);
    if (
      data.kind !== kind ||
      data.unitId !== row.unitId ||
      data.runId !== row.runId ||
      data.versionId !== row.versionId ||
      data.round !== row.round
    )
      throw new HttpError(409, 'WORKFLOW_INTAKE_REFERENCE_CONFLICT');
    return {
      id,
      unitId: row.unitId,
      runId: row.runId,
      versionId: row.versionId,
      round: row.round,
      title: data.title,
      displayName: data.values.displayName,
      employeeCode: data.values.employeeCode,
    };
  }

  async list(actor: Principal, tenant: string) {
    this.requireOperator(actor, tenant);
    if (!this.readSource) return { items: [] };
    const rows = (
      await this.store.pool.query<Row>(
        `SELECT ${columns} FROM personnel_workflow_intakes
       WHERE (tenant_id,recipient_account_id,recipient_person_id)=($1,$2,$3) AND employment_id IS NULL
       ORDER BY created_at DESC,id LIMIT 50`,
        [tenant, actor.accountId, actor.personId],
      )
    ).rows;
    const items = [];
    for (const row of rows) {
      try {
        items.push(await this.project(row));
      } catch (error) {
        if (!(error instanceof HttpError) || ![403, 404, 409].includes(error.statusCode))
          throw error;
      }
    }
    return { items };
  }

  async draft(db: PoolClient, actor: Principal, tenant: string, id: string, allowAccepted = false) {
    this.requireOperator(actor, tenant);
    const row = (
      await db.query<Row>(
        `SELECT ${columns} FROM personnel_workflow_intakes
       WHERE (tenant_id,id,recipient_account_id,recipient_person_id)=($1,$2,$3,$4)`,
        [tenant, id, actor.accountId, actor.personId],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'PERSONNEL_WORKFLOW_INTAKE_NOT_FOUND');
    if (!allowAccepted && row.employmentId)
      throw new HttpError(409, 'PERSONNEL_WORKFLOW_INTAKE_APPLIED');
    return this.project(row);
  }
}
