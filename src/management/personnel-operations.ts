import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Principal, Store } from '../store.js';
import { HttpError } from '../security.js';
import { DirectoryService } from './directory.js';
import { GovernanceService } from './governance.js';
import { auditMutation, mutate, databaseError } from './mutations.js';
import type { MutationContext } from './mutations.js';
import type { PersonnelWorkflowIntake } from './personnel-workflow-intakes.js';

export type PersonnelInput = {
  kind: 'onboard' | 'transfer' | 'offboard';
  personId?: string;
  displayName?: string;
  employmentId?: string;
  legalEntityId?: string;
  positionId?: string;
  employeeCode?: string;
  workflowIntakeId?: string;
  effectiveAt: string;
  revokeBindingIds: string[];
};
type RecordRow = Record<string, any>;
type Change = { resource: string; data: Record<string, unknown>; id?: string; revision?: number };
export class PersonnelOperations {
  constructor(
    private store: Store,
    private intakes?: PersonnelWorkflowIntake,
  ) {}
  private async plan(db: PoolClient, actor: Principal, tenant: string, input: PersonnelInput) {
    this.store.require(actor, 'people:manage', tenant);
    this.store.require(actor, 'people:read', tenant);
    this.store.require(actor, 'directory:read', tenant);
    const when = Date.parse(input.effectiveAt);
    if (!Number.isFinite(when) || Math.abs(when - Date.now()) > 15 * 60_000)
      throw new HttpError(400, 'PERSONNEL_PREVIEW_EXPIRED');
    const changes: Change[] = [],
      state: RecordRow[] = [];
    if (input.workflowIntakeId && (input.kind !== 'onboard' || !this.intakes))
      throw new HttpError(400, 'PERSONNEL_WORKFLOW_INTAKE_INVALID');
    const intake = input.workflowIntakeId
      ? await this.intakes!.draft(db, actor, tenant, input.workflowIntakeId)
      : undefined;
    const get = async (table: string, id: string | undefined) => {
      const column = table === 'persons' ? 'home_tenant_id' : 'tenant_id';
      const row = (
        await db.query('SELECT * FROM ' + table + ' WHERE ' + column + '=$1 AND id=$2', [
          tenant,
          id ?? null,
        ])
      ).rows[0];
      if (!row) throw new HttpError(400, 'INVALID_RELATION');
      state.push(row);
      return row as RecordRow;
    };
    let person: RecordRow | undefined,
      employment: RecordRow | undefined,
      position: RecordRow | undefined;
    if (input.kind === 'onboard') {
      if (input.personId) person = await get('persons', input.personId);
      else if (!input.displayName?.trim() || input.displayName.length > 160)
        throw new HttpError(400, 'INVALID_REQUEST');
      if (person && !person.active) throw new HttpError(400, 'INVALID_RELATION');
      if (!input.employeeCode || !/^[A-Za-z0-9_-]{2,48}$/.test(input.employeeCode))
        throw new HttpError(400, 'INVALID_REQUEST');
      position = await get('positions', input.positionId);
      if (position.legal_entity_id !== input.legalEntityId || !position.active)
        throw new HttpError(400, 'INVALID_RELATION');
      const entity = await get('legal_entities', input.legalEntityId),
        unit = await get('org_units', position.org_unit_id);
      if (!entity.active || !unit.active) throw new HttpError(400, 'INVALID_RELATION');
      if (intake && intake.unitId !== unit.id)
        throw new HttpError(403, 'PERSONNEL_WORKFLOW_INTAKE_UNIT_DENIED');
      if (
        (
          await db.query(
            'SELECT 1 FROM employments WHERE legal_entity_id=$1 AND employee_code=$2',
            [input.legalEntityId, input.employeeCode],
          )
        ).rowCount
      )
        throw new HttpError(409, 'DUPLICATE_RECORD');
      if (input.revokeBindingIds.length) throw new HttpError(400, 'INVALID_REQUEST');
    } else {
      if (input.kind === 'transfer') {
        employment = await get('employments', input.employmentId);
        person = await get('persons', employment.person_id);
      } else person = await get('persons', input.personId);
      if (!person.active || person.id === actor.personId)
        throw new HttpError(403, 'SELF_MANAGEMENT_FORBIDDEN');
    }
    const accounts: RecordRow[] = person
      ? (await db.query('SELECT * FROM accounts WHERE person_id=$1 ORDER BY id', [person.id])).rows
      : [];
    if (input.kind !== 'onboard') {
      this.store.require(actor, 'accounts:manage', tenant);
      if (accounts.some((a) => a.is_protected || a.id === actor.accountId))
        throw new HttpError(403, 'PROTECTED_ACCOUNT');
      // Disabling a global account must never silently affect a second security tenant.
      if (
        input.kind === 'offboard' &&
        (
          await db.query(
            'SELECT 1 FROM tenant_memberships WHERE account_id=ANY($1::uuid[]) AND tenant_id<>$2 AND active',
            [accounts.map((a) => a.id), tenant],
          )
        ).rowCount
      )
        throw new HttpError(409, 'PERSONNEL_OTHER_TENANT_MEMBERSHIPS');
    }
    const bindings: RecordRow[] =
      input.kind === 'onboard'
        ? []
        : (
            await db.query(
              'SELECT * FROM role_bindings WHERE tenant_id=$1 AND account_id=ANY($2::uuid[]) AND active ORDER BY id',
              [tenant, accounts.map((a) => a.id)],
            )
          ).rows;
    const grants: RecordRow[] =
      input.kind === 'onboard'
        ? []
        : (
            await db.query(
              'SELECT * FROM application_grants WHERE tenant_id=$1 AND account_id=ANY($2::uuid[]) AND active ORDER BY account_id,app_code',
              [tenant, accounts.map((a) => a.id)],
            )
          ).rows;
    const governance = new GovernanceService(this.store);
    for (const app of new Set([...bindings, ...grants].map((r) => r.app_code))) {
      await governance.assertApp(db, actor, tenant, app, 'access:manage');
      if (bindings.some((r) => r.app_code === app))
        await governance.assertApp(db, actor, tenant, app, 'roles:manage');
    }
    if (
      new Set(input.revokeBindingIds).size !== input.revokeBindingIds.length ||
      input.revokeBindingIds.some((id) => !bindings.some((b) => b.id === id))
    )
      throw new HttpError(400, 'INVALID_RELATION');
    if (input.kind === 'transfer') {
      position = await get('positions', input.positionId);
      if (!position.active || position.legal_entity_id !== employment!.legal_entity_id)
        throw new HttpError(400, 'INVALID_RELATION');
      const unit = await get('org_units', position.org_unit_id);
      if (!unit.active) throw new HttpError(400, 'INVALID_RELATION');
      if (
        new Date(employment!.valid_from).getTime() > when ||
        (employment!.valid_until && new Date(employment!.valid_until).getTime() <= when)
      )
        throw new HttpError(400, 'PERSONNEL_EMPLOYMENT_ENDED');
      const assignments: RecordRow[] = (
        await db.query(
          'SELECT * FROM assignments WHERE employment_id=$1 AND is_primary AND (valid_until IS NULL OR valid_until>$2) ORDER BY id',
          [employment!.id, input.effectiveAt],
        )
      ).rows;
      state.push(...assignments);
      for (const a of assignments) {
        if (new Date(a.valid_from).getTime() >= when)
          throw new HttpError(409, 'PERSONNEL_FUTURE_ASSIGNMENT');
        changes.push({
          resource: 'assignments',
          id: a.id,
          revision: a.revision,
          data: { validUntil: input.effectiveAt },
        });
      }
      changes.push({
        resource: 'assignments',
        data: {
          legalEntityId: employment!.legal_entity_id,
          employmentId: employment!.id,
          positionId: position.id,
          isPrimary: true,
          validFrom: input.effectiveAt,
          validUntil: employment!.valid_until
            ? new Date(employment!.valid_until).toISOString()
            : null,
        },
      });
    }
    if (input.kind === 'offboard') {
      const employments: RecordRow[] = (
        await db.query(
          'SELECT * FROM employments WHERE tenant_id=$1 AND person_id=$2 AND (valid_until IS NULL OR valid_until>$3) ORDER BY id',
          [tenant, person!.id, input.effectiveAt],
        )
      ).rows;
      const assignments: RecordRow[] = (
        await db.query(
          'SELECT a.* FROM assignments a JOIN employments e ON e.id=a.employment_id WHERE e.tenant_id=$1 AND e.person_id=$2 AND (a.valid_until IS NULL OR a.valid_until>$3) ORDER BY a.id',
          [tenant, person!.id, input.effectiveAt],
        )
      ).rows;
      state.push(...employments, ...assignments);
      if ([...employments, ...assignments].some((a) => new Date(a.valid_from).getTime() >= when))
        throw new HttpError(409, 'PERSONNEL_FUTURE_ASSIGNMENT');
      for (const a of assignments)
        changes.push({
          resource: 'assignments',
          id: a.id,
          revision: a.revision,
          data: { validUntil: input.effectiveAt },
        });
      for (const e of employments)
        changes.push({
          resource: 'employments',
          id: e.id,
          revision: e.revision,
          data: { validUntil: input.effectiveAt },
        });
      for (const a of accounts)
        if (a.active)
          changes.push({
            resource: 'accounts',
            id: a.id,
            revision: a.revision,
            data: { active: false },
          });
      changes.push({
        resource: 'people',
        id: person!.id,
        revision: person!.revision,
        data: { active: false },
      });
    }
    if (input.kind !== 'onboard') {
      const employmentIds = (
        await db.query('SELECT id FROM employments WHERE tenant_id=$1 AND person_id=$2', [
          tenant,
          person!.id,
        ])
      ).rows.map((e) => e.id);
      for (const [resource, table, extra] of [
        ['reporting-lines', 'reporting_lines', 'manager_employment_id'],
        ['unit-leaders', 'unit_leaders', 'employment_id'],
        ['approval-substitutions', 'approval_substitutions', 'substitute_employment_id'],
      ]) {
        const rows: RecordRow[] = (
          await db.query(
            'SELECT * FROM ' +
              table +
              ' WHERE tenant_id=$1 AND active AND (employment_id=ANY($2::uuid[]) OR ' +
              extra +
              '=ANY($2::uuid[])) AND (valid_until IS NULL OR valid_until>$3) ORDER BY id',
            [tenant, employmentIds, input.effectiveAt],
          )
        ).rows;
        state.push(...rows);
        if (input.kind === 'offboard')
          for (const row of rows)
            changes.unshift({
              resource: resource!,
              id: row.id,
              revision: row.revision,
              data:
                new Date(row.valid_from).getTime() >= when
                  ? { active: false }
                  : { validUntil: input.effectiveAt },
            });
      }
    }
    const snapshot = createHash('sha256')
      .update(JSON.stringify({ input, state, accounts, bindings, grants, intake }))
      .digest('hex');
    return {
      snapshot,
      changes,
      person,
      employment,
      position,
      accounts,
      bindings,
      grants,
      intake,
      summary: {
        kind: input.kind,
        personName: person?.display_name ?? input.displayName,
        positionName: position?.name ?? null,
        changes: changes.map((c) => ({ resource: c.resource, id: c.id ?? null, data: c.data })),
        bindings: bindings.map((b) => ({
          id: b.id,
          accountId: b.account_id,
          appCode: b.app_code,
          roleCode: b.role_code,
          orgUnitId: b.org_unit_id,
          revoke: input.kind === 'offboard' || input.revokeBindingIds.includes(b.id),
        })),
        grants: grants.map((g) => ({
          accountId: g.account_id,
          appCode: g.app_code,
          revoke: input.kind === 'offboard',
        })),
        accountsDisabled: input.kind === 'offboard' ? accounts.filter((a) => a.active).length : 0,
      },
    };
  }
  async preview(actor: Principal, tenant: string, input: PersonnelInput) {
    const db = await this.store.pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const plan = await this.plan(db, actor, tenant, input);
      await db.query('ROLLBACK');
      return { snapshot: plan.snapshot, summary: plan.summary };
    } catch (error) {
      await db.query('ROLLBACK');
      return databaseError(error);
    } finally {
      db.release();
    }
  }
  async commit(context: MutationContext, input: PersonnelInput, snapshot: string) {
    if (context.appCode !== 'aio-foundation') throw new HttpError(403, 'FOUNDATION_ONLY');
    return mutate(
      this.store,
      context,
      'people:manage',
      'personnel.' + input.kind,
      { input, snapshot },
      async (db, actor) => {
        const plan = await this.plan(db, actor, context.tenantId, input);
        if (plan.snapshot !== snapshot) throw new HttpError(409, 'PERSONNEL_PREVIEW_STALE');
        const directory = new DirectoryService(this.store),
          result: RecordRow[] = [];
        if (input.kind === 'onboard') {
          const person =
            plan.person ??
            (await directory.saveInTransaction(db, actor, 'people', context, {
              displayName: input.displayName!.trim(),
            }));
          const employment = await directory.saveInTransaction(db, actor, 'employments', context, {
            personId: person.id,
            legalEntityId: input.legalEntityId,
            employeeCode: input.employeeCode,
            validFrom: input.effectiveAt,
          });
          result.push(
            person,
            employment,
            await directory.saveInTransaction(db, actor, 'assignments', context, {
              legalEntityId: input.legalEntityId,
              employmentId: employment.id,
              positionId: input.positionId,
              isPrimary: true,
              validFrom: input.effectiveAt,
            }),
          );
          if (plan.intake) {
            const current = await this.intakes!.draft(db, actor, context.tenantId, plan.intake.id);
            if (JSON.stringify(current) !== JSON.stringify(plan.intake))
              throw new HttpError(409, 'PERSONNEL_PREVIEW_STALE');
            const consumed = await db.query(
              `UPDATE personnel_workflow_intakes SET accepted_at=now(),employment_id=$3
               WHERE (tenant_id,id)=($1,$2) AND employment_id IS NULL`,
              [context.tenantId, current.id, employment.id],
            );
            if (consumed.rowCount !== 1)
              throw new HttpError(409, 'PERSONNEL_WORKFLOW_INTAKE_APPLIED');
            await auditMutation(
              db,
              context,
              actor,
              'personnel.workflow_intake_applied',
              'personnel_workflow_intake',
              current.id,
              null,
              {
                runId: current.runId,
                versionId: current.versionId,
                round: current.round,
                employmentId: employment.id,
              },
            );
          }
        }
        for (const change of plan.changes)
          result.push(
            await directory.saveInTransaction(
              db,
              actor,
              change.resource,
              context,
              change.data,
              change.id,
              change.revision,
            ),
          );
        const bindings = plan.bindings.filter(
          (b) => input.kind === 'offboard' || input.revokeBindingIds.includes(b.id),
        );
        for (const b of bindings) {
          await db.query(
            'UPDATE role_bindings SET active=false,revision=revision+1 WHERE id=$1 AND tenant_id=$2',
            [b.id, context.tenantId],
          );
          await auditMutation(
            db,
            context,
            actor,
            'binding.revoked',
            'binding',
            b.id,
            b,
            { ...b, active: false, revision: b.revision + 1 },
            b.account_id,
          );
        }
        if (input.kind === 'offboard')
          for (const g of plan.grants) {
            await db.query(
              'UPDATE application_grants SET active=false,revision=revision+1 WHERE account_id=$1 AND tenant_id=$2 AND app_code=$3',
              [g.account_id, context.tenantId, g.app_code],
            );
            await auditMutation(
              db,
              context,
              actor,
              'grant.revoked',
              'grant',
              g.account_id,
              g,
              { ...g, active: false, revision: g.revision + 1 },
              g.account_id,
            );
          }
        await auditMutation(
          db,
          context,
          actor,
          'personnel.' + input.kind,
          'person',
          String(plan.person?.id ?? result[0]?.id),
          plan.summary,
          { records: result, bindingsRevoked: bindings.length },
        );
        return {
          records: result,
          bindingsRevoked: bindings.length,
          grantsRevoked: input.kind === 'offboard' ? plan.grants.length : 0,
        };
      },
      async (db, actor) => {
        for (const permission of [
          'people:read',
          'directory:read',
          ...(input.kind === 'onboard' ? [] : ['accounts:manage', 'access:manage', 'roles:manage']),
        ])
          this.store.require(actor, permission, context.tenantId);
        if (input.workflowIntakeId) {
          if (input.kind !== 'onboard' || !this.intakes)
            throw new HttpError(400, 'PERSONNEL_WORKFLOW_INTAKE_INVALID');
          await this.intakes.draft(db, actor, context.tenantId, input.workflowIntakeId, true);
        }
      },
    );
  }
}
