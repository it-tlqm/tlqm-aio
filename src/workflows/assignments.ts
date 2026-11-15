import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../security.js';
import { decisionPath, selectsAtHandoff, workflowUuid } from './contracts.js';
import type { HumanStep, WorkflowSpec } from './contracts.js';
import type { WorkflowDirectory } from './access.js';
type Db = Pool | PoolClient;
export type WorkflowGroup = {
  id: string;
  tenant_id: string;
  org_unit_id: string | null;
  name: string;
  active: boolean;
  revision: number;
};
export type WorkflowSelection = {
  stepId: string;
  label: string;
  groupId: string;
  groupName: string;
  groupRevision: number;
  candidates: { id: string; name: string; personId: string }[];
};
type ResolvedAssignment = {
  accountId: string;
  groupId: string | null;
  members?: WorkflowSelection['candidates'];
  approvalPolicy?: { mode: 'all' | 'any' | 'quorum'; required: number; groupRevision: number };
  organizationRule?: { kind: 'manager' | 'unit-head'; ownerPersonId: string };
  basis?: { id: string; revision: number }[];
};
export function startGroupSteps(spec: WorkflowSpec) {
  const first = new Set(
    decisionPath(spec.nodes, spec.nodes.find((node) => node.kind === 'start')?.id).map(
      (node) => node.id,
    ),
  );
  return spec.nodes.filter(
    (node): node is HumanStep =>
      'assigneeRule' in node &&
      node.assigneeRule?.kind === 'group' &&
      (!selectsAtHandoff(node) || first.has(node.id)),
  );
}
/** Adapted from BOS selector normalization: explicit, bounded, unique and canonical candidates.
 * UUIDs and live AIO permission checks replace BOS numeric IDs/Prisma responsibility snapshots.
 */
export function workflowCandidateIds(value: unknown) {
  if (!Array.isArray(value) || value.length > 50)
    throw new HttpError(400, 'WORKFLOW_INVALID_GROUP_MEMBERS');
  const ids = value.map((id) => {
    workflowUuid(id);
    return id.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'WORKFLOW_INVALID_GROUP_MEMBERS');
  return ids.sort();
}
export class WorkflowAssignments {
  constructor(private readonly directory: WorkflowDirectory) {}
  async group(db: Db, tenant: string, groupId: string) {
    workflowUuid(groupId);
    const row = (
      await db.query('SELECT * FROM workflow_groups WHERE tenant_id=$1 AND id=$2', [
        tenant,
        groupId,
      ])
    ).rows[0] as WorkflowGroup | undefined;
    if (!row) throw new HttpError(400, 'WORKFLOW_GROUP_UNAVAILABLE');
    return row;
  }
  async member(db: Db, tenant: string, unit: string, groupId: string, accountId: string) {
    const g = await this.group(db, tenant, groupId);
    if (
      !g.active ||
      (g.org_unit_id !== null && g.org_unit_id !== unit) ||
      !(
        await db.query(
          'SELECT 1 FROM workflow_group_members WHERE tenant_id=$1 AND group_id=$2 AND account_id=$3 AND active',
          [tenant, groupId, accountId],
        )
      ).rowCount
    )
      throw new HttpError(403, 'WORKFLOW_GROUP_MEMBER_DENIED');
    return this.directory.assignee(tenant, unit, accountId);
  }
  async candidates(
    db: Db,
    tenant: string,
    unit: string,
    step: HumanStep,
    owner?: { accountId: string; personId: string },
  ): Promise<WorkflowSelection> {
    if (step.assigneeRule?.kind !== 'group' && step.assigneeRule?.kind !== 'pool')
      throw new HttpError(400, 'WORKFLOW_ASSIGNMENT_INVALID');
    const group = await this.group(db, tenant, step.assigneeRule.groupId);
    if (!group.active || (group.org_unit_id !== null && group.org_unit_id !== unit))
      throw new HttpError(400, 'WORKFLOW_GROUP_UNAVAILABLE');
    const members = (
      await db.query(
        'SELECT account_id FROM workflow_group_members WHERE tenant_id=$1 AND group_id=$2 AND active ORDER BY account_id',
        [tenant, group.id],
      )
    ).rows as { account_id: string }[];
    const candidates: WorkflowSelection['candidates'] = [];
    for (const member of members) {
      try {
        const user = await this.directory.assignee(tenant, unit, member.account_id);
        if (
          owner &&
          step.kind === 'approval' &&
          (member.account_id === owner.accountId || user.personId === owner.personId)
        )
          continue;
        candidates.push({ id: member.account_id, ...user });
      } catch (error) {
        if (!(error instanceof HttpError && error.statusCode === 400)) throw error;
      }
    }
    return {
      stepId: step.id,
      label: step.label,
      groupId: group.id,
      groupName: group.name,
      groupRevision: group.revision,
      candidates,
    };
  }
  async options(
    db: Db,
    tenant: string,
    unit: string,
    spec: WorkflowSpec,
    owner?: { accountId: string; personId: string },
  ) {
    const result: WorkflowSelection[] = [];
    for (const step of startGroupSteps(spec))
      result.push(await this.candidates(db, tenant, unit, step, owner));
    return result;
  }
  async validatePublish(db: Db, tenant: string, unit: string, spec: WorkflowSpec) {
    for (const step of spec.nodes) {
      if (step.kind !== 'approval' && step.kind !== 'task') continue;
      if (!step.assigneeRule) await this.directory.assignee(tenant, unit, step.assignee);
      else if (
        (step.assigneeRule.kind === 'group' || step.assigneeRule.kind === 'pool') &&
        !(await this.candidates(db, tenant, unit, step)).candidates.length
      )
        throw new HttpError(400, 'WORKFLOW_GROUP_EMPTY');
      if (step.assigneeRule?.kind === 'pool') {
        const options = await this.candidates(db, tenant, unit, step);
        if (new Set(options.candidates.map((c) => c.personId)).size !== options.candidates.length)
          throw new HttpError(400, 'WORKFLOW_POOL_DUPLICATE_PERSON');
        if (
          step.assigneeRule.mode === 'quorum' &&
          step.assigneeRule.quorum! > options.candidates.length
        )
          throw new HttpError(400, 'WORKFLOW_POOL_INSUFFICIENT');
      }
    }
  }
  async validateSelections(
    db: Db,
    tenant: string,
    unit: string,
    spec: WorkflowSpec,
    value: unknown,
    owner: { accountId: string; personId: string },
  ) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new HttpError(400, 'WORKFLOW_ASSIGNMENT_INVALID');
    const choices = value as Record<string, unknown>,
      options = await this.options(db, tenant, unit, spec, owner),
      normalized: Record<string, string> = {},
      revisions: Record<string, number> = {};
    if (Object.keys(choices).some((id) => !options.some((option) => option.stepId === id)))
      throw new HttpError(400, 'WORKFLOW_ASSIGNMENT_INVALID');
    for (const option of options) {
      const selected = choices[option.stepId];
      if (
        typeof selected !== 'string' ||
        !option.candidates.some((candidate) => candidate.id === selected)
      )
        throw new HttpError(400, 'WORKFLOW_SELECTION_REQUIRED');
      normalized[option.stepId] = selected;
      revisions[option.stepId] = option.groupRevision;
    }
    return { choices: normalized, groupRevisions: revisions };
  }
  async resolve(
    db: Db,
    tenant: string,
    run: { id: string; round: number; org_unit_id?: string; owner_person_id?: string },
    node: HumanStep,
  ): Promise<ResolvedAssignment> {
    if (!node.assigneeRule) return { accountId: node.assignee, groupId: null };
    if (node.assigneeRule.kind === 'pool') {
      if (!run.org_unit_id || !run.owner_person_id)
        throw new HttpError(400, 'WORKFLOW_ASSIGNMENT_INVALID');
      const options = await this.candidates(db, tenant, run.org_unit_id, node, {
        accountId: '',
        personId: run.owner_person_id,
      });
      if (new Set(options.candidates.map((c) => c.personId)).size !== options.candidates.length)
        throw new HttpError(400, 'WORKFLOW_POOL_DUPLICATE_PERSON');
      const required =
        node.assigneeRule.mode === 'all'
          ? options.candidates.length
          : node.assigneeRule.mode === 'any'
            ? 1
            : node.assigneeRule.quorum!;
      if (!options.candidates.length || required > options.candidates.length)
        throw new HttpError(400, 'WORKFLOW_POOL_INSUFFICIENT');
      return {
        accountId: options.candidates[0]!.id,
        groupId: node.assigneeRule.groupId,
        members: options.candidates,
        approvalPolicy: {
          mode: node.assigneeRule.mode,
          required,
          groupRevision: options.groupRevision,
        },
      };
    }
    if (node.assigneeRule.kind === 'organization') {
      if (!this.directory.responsible || !run.org_unit_id || !run.owner_person_id)
        throw new HttpError(400, 'WORKFLOW_ORGANIZATION_RESPONSIBLE_MISSING');
      const resolved = await this.directory.responsible(
        tenant,
        run.org_unit_id,
        run.owner_person_id,
        node.assigneeRule.relation,
      );
      if (node.kind === 'approval' && resolved.personId === run.owner_person_id)
        throw new HttpError(403, 'WORKFLOW_SELF_APPROVAL');
      return {
        accountId: resolved.accountId,
        groupId: null,
        organizationRule: { kind: node.assigneeRule.relation, ownerPersonId: run.owner_person_id },
        basis: resolved.basis,
      };
    }
    if (node.assigneeRule.kind === 'previous') {
      const prior = (
        await db.query(
          `SELECT result.actor_account_id FROM workflow_tasks task
           JOIN workflow_task_results result ON result.tenant_id=task.tenant_id AND result.task_id=task.id
           LEFT JOIN workflow_task_supersessions s
            ON (s.tenant_id,s.run_id,s.round,s.task_id)=(task.tenant_id,task.run_id,task.round,task.id)
           WHERE task.tenant_id=$1 AND task.run_id=$2 AND task.round=$3 AND task.node_id=$4
            AND task.status IN ('completed','rejected') AND s.task_id IS NULL`,
          [tenant, run.id, run.round, node.assigneeRule.stepId],
        )
      ).rows[0];
      if (!prior) throw new HttpError(409, 'WORKFLOW_PREVIOUS_ACTOR_UNAVAILABLE');
      return { accountId: prior.actor_account_id as string, groupId: null };
    }
    const receipt = (
      await db.query(
        'SELECT choices FROM workflow_run_assignments WHERE tenant_id=$1 AND run_id=$2 AND round=$3',
        [tenant, run.id, run.round],
      )
    ).rows[0];
    const id = receipt?.choices?.[node.id];
    workflowUuid(id);
    return { accountId: id, groupId: node.assigneeRule.groupId };
  }
  async eligible(
    db: Db,
    tenant: string,
    unit: string,
    task: {
      assignee_account_id: string;
      assignment_group_id?: string | null;
      organization_rule?: { kind: 'manager' | 'unit-head'; ownerPersonId: string } | null;
      id?: string;
      approval_policy?: { mode: string; required: number } | null;
    },
    accountId = task.assignee_account_id,
  ) {
    try {
      if (task.approval_policy) {
        const snapshot = (
          await db.query(
            'SELECT person_id FROM workflow_approval_members WHERE tenant_id=$1 AND task_id=$2 AND account_id=$3 AND active',
            [tenant, task.id, accountId],
          )
        ).rows[0];
        if (!snapshot) return false;
        const current = task.assignment_group_id
          ? await this.member(db, tenant, unit, task.assignment_group_id, accountId)
          : await this.directory.assignee(tenant, unit, accountId);
        return current.personId === snapshot.person_id;
      }
      if (accountId !== task.assignee_account_id) return false;
      if (task.organization_rule) {
        if (!this.directory.responsible) return false;
        const current = await this.directory.responsible(
          tenant,
          unit,
          task.organization_rule.ownerPersonId,
          task.organization_rule.kind,
        );
        if (current.accountId !== task.assignee_account_id) return false;
      }
      if (task.assignment_group_id)
        await this.member(db, tenant, unit, task.assignment_group_id, task.assignee_account_id);
      else await this.directory.assignee(tenant, unit, task.assignee_account_id);
      return true;
    } catch (error) {
      if (error instanceof HttpError && [400, 403].includes(error.statusCode)) return false;
      throw error;
    }
  }
}
