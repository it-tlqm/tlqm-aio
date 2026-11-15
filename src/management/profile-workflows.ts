import { randomUUID } from 'node:crypto';
import type { Store, Principal, Identity } from '../store.js';
import { HttpError } from '../security.js';
import { formHash } from '../forms/service.js';
import { parseAnswers, schemaFields } from '../forms/contracts.js';
import { DirectoryMetadata } from './metadata.js';
import { mutate, auditMutation } from './mutations.js';
import type { MutationContext } from './mutations.js';
import type { WorkflowsService } from '../workflows/service.js';
import type { WorkflowActor, WorkflowContext } from '../workflows/access.js';
import type { WorkflowSource } from '../workflows/source.js';
import { parseWorkflowSource } from '../workflows/source.js';

type Row = Record<string, any>;
export type ProfileDispatch = Parameters<WorkflowsService['start']>[1] & { reason: string };
export type ProfileWorkflowLink = {
  id: string;
  tenant_id: string;
  proposal_id: string;
  initiated_by: string;
  source: WorkflowSource;
  dispatch: ProfileDispatch;
  run_id: string | null;
  revision: number;
  applied_at: string | null;
};
export const profileChecksum = (p: Row) =>
  formHash({
    tenantId: p.tenant_id,
    proposalId: p.id,
    personId: p.person_id,
    schemaVersion: p.schema_version,
    baseRevision: p.base_revision,
    patch: p.patch,
  });
/** The source adapter is injected by the Foundation BFF, never by an HTTP body. */
export class ProfileWorkflows {
  constructor(
    readonly store: Store,
    readonly workflows: WorkflowsService,
    readonly workflowActor: (identity: Identity) => Promise<WorkflowActor>,
  ) {}
  private async actor(c: MutationContext) {
    if (c.appCode !== 'aio-foundation') throw new HttpError(403, 'PERMISSION_DENIED');
    const a = await this.store.principal(c.identity, c.appCode);
    this.store.require(a, 'people:manage', c.tenantId);
    this.store.require(a, 'people:read', c.tenantId);
    return a;
  }
  private context(c: MutationContext): WorkflowContext {
    return { tenantId: c.tenantId, actor: () => this.workflowActor(c.identity) };
  }
  async choices(c: MutationContext) {
    await this.actor(c);
    const data = await this.workflows.definitions(this.context(c));
    const items = data.items.filter(
      (d) => d.startUnits.length && d.version?.spec.nodes.some((n) => n.kind === 'approval'),
    );
    const units = (
      await this.store.pool.query(
        'SELECT id,name FROM org_units WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND active ORDER BY name',
        [c.tenantId, [...new Set(items.flatMap((d) => d.startUnits))]],
      )
    ).rows as { id: string; name: string }[];
    return { items: items.map((d) => ({ ...d, name: d.version!.spec.name })), units };
  }
  async selections(c: MutationContext, id: string, unitId: string, versionId: string) {
    await this.actor(c);
    return this.workflows.startSelections(this.context(c), id, unitId, versionId);
  }
  private async proposal(c: MutationContext, a: Principal, id: string) {
    const row = (
      await this.store.pool.query(
        'SELECT q.*,p.display_name FROM directory_profile_proposals q JOIN persons p ON p.id=q.person_id AND p.home_tenant_id=q.tenant_id WHERE q.tenant_id=$1 AND q.id=$2',
        [c.tenantId, id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'RECORD_NOT_FOUND');
    if (row.person_id === a.personId) throw new HttpError(403, 'SELF_MANAGEMENT_FORBIDDEN');
    return row;
  }
  async link(c: MutationContext, id: string) {
    const a = await this.actor(c);
    await this.proposal(c, a, id);
    return (
      await this.store.pool.query(
        'SELECT * FROM directory_profile_workflows WHERE tenant_id=$1 AND proposal_id=$2',
        [c.tenantId, id],
      )
    ).rows[0] as ProfileWorkflowLink | undefined;
  }
  async state(c: MutationContext, id: string) {
    const link = await this.link(c, id);
    if (!link) return { link: null, run: null, canApply: false };
    const p = await this.proposal(c, await this.actor(c), id);
    const run = await this.workflows.sourceRun(this.context(c), link.source);
    return {
      link: {
        id: link.id,
        runId: link.run_id,
        initiatedBy: link.initiated_by,
        revision: link.revision,
        appliedAt: link.applied_at,
      },
      run: run
        ? {
            id: run.id,
            status: run.status,
            revision: run.revision,
            approvalCount: run.approvalCount,
          }
        : null,
      canApply:
        p.status === 'pending' &&
        !!link.run_id &&
        !link.applied_at &&
        run?.status === 'completed' &&
        run.approvalCount > 0,
    };
  }
  async send(
    c: MutationContext,
    id: string,
    input: {
      expectedRevision: number;
      definitionId: string;
      versionId: string;
      unitId: string;
      answers: unknown;
      selections?: unknown;
    },
  ) {
    const a = await this.actor(c),
      proposal = await this.proposal(c, a, id);
    const existing = await this.link(c, id);
    let link: ProfileWorkflowLink;
    if (existing) {
      if (
        existing.dispatch.definitionId !== input.definitionId ||
        existing.dispatch.versionId !== input.versionId ||
        existing.dispatch.unitId !== input.unitId ||
        formHash(existing.dispatch.answers) !== formHash(input.answers) ||
        formHash(existing.dispatch.selections) !== formHash(input.selections ?? {})
      )
        throw new HttpError(409, 'PROFILE_WORKFLOW_ALREADY_LINKED');
      if (existing.initiated_by !== a.accountId)
        throw new HttpError(403, 'PROFILE_DISPATCH_OWNER_REQUIRED');
      if (proposal.status !== 'pending' || proposal.revision !== input.expectedRevision)
        throw new HttpError(409, 'REVISION_CONFLICT');
      link = existing;
    } else {
      const choice = (await this.choices(c)).items.find(
        (d) =>
          d.id === input.definitionId &&
          d.version?.id === input.versionId &&
          d.startUnits.includes(input.unitId),
      );
      if (!choice?.version) throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
      const answers = parseAnswers(choice.version.spec.input, input.answers, 'submit');
      await this.selections(c, input.definitionId, input.unitId, input.versionId);
      link = await mutate(
        this.store,
        c,
        'people:manage',
        'profile.workflow_prepare',
        { id, input },
        async (db, actor) => {
          this.store.require(actor, 'people:read', c.tenantId);
          const row = await this.proposal(c, actor, id);
          if (row.status !== 'pending' || row.revision !== input.expectedRevision)
            throw new HttpError(409, 'REVISION_CONFLICT');
          if (
            (
              await db.query(
                'SELECT 1 FROM directory_profile_workflows WHERE tenant_id=$1 AND proposal_id=$2',
                [c.tenantId, id],
              )
            ).rowCount
          )
            throw new HttpError(409, 'PROFILE_WORKFLOW_ALREADY_LINKED');
          const current = await new DirectoryMetadata(this.store).record(
            actor,
            c.tenantId,
            'people',
            row.person_id,
          );
          if (current.revision !== row.base_revision) throw new HttpError(409, 'REVISION_CONFLICT');
          if (current.schemaVersion !== row.schema_version)
            throw new HttpError(409, 'PROFILE_SCHEMA_CHANGED');
          const fields = schemaFields(current.schema!),
            linkId = randomUUID();
          const source = parseWorkflowSource({
            kind: 'directory-profile',
            id: linkId,
            proposalId: id,
            subjectPersonId: row.person_id,
            subjectName: row.display_name,
            checksum: profileChecksum(row),
            changes: Object.entries(row.patch).map(([key, value]) => {
              const field = fields.find((f) => f.id === key);
              const format = (v: unknown): string =>
                Array.isArray(v)
                  ? v.map(format).join(', ')
                  : v === null || v === undefined
                    ? '(Trống)'
                    : (field?.options?.find((o) => o.id === v)?.label ??
                      (typeof v === 'boolean' ? (v ? 'Có' : 'Không') : String(v)));
              return {
                label: field?.label ?? key,
                before: format(current.answers[key]),
                after: format(value),
              };
            }),
          });
          const dispatch: ProfileDispatch = {
            definitionId: input.definitionId,
            versionId: input.versionId,
            unitId: input.unitId,
            title: ('Cập nhật hồ sơ · ' + row.display_name).slice(0, 200),
            answers,
            selections: input.selections ?? {},
            reason: c.reason,
          };
          const result = (
            await db.query(
              'INSERT INTO directory_profile_workflows(id,tenant_id,proposal_id,initiated_by,source,dispatch) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
              [
                linkId,
                c.tenantId,
                id,
                actor.accountId,
                JSON.stringify(source),
                JSON.stringify(dispatch),
              ],
            )
          ).rows[0] as ProfileWorkflowLink;
          await auditMutation(
            db,
            c,
            actor,
            'profile.workflow_prepared',
            'profile-proposal',
            id,
            null,
            {
              linkId,
              sourceChecksum: source.checksum,
              definitionId: dispatch.definitionId,
              versionId: dispatch.versionId,
            },
          );
          return result;
        },
      );
    }
    return this.dispatch(c, link);
  }
  async retry(c: MutationContext, id: string) {
    const link = await this.link(c, id);
    if (!link) throw new HttpError(404, 'RECORD_NOT_FOUND');
    return this.dispatch(c, link);
  }
  private async dispatch(c: MutationContext, link: ProfileWorkflowLink) {
    const a = await this.actor(c),
      p = await this.proposal(c, a, link.proposal_id);
    if (a.accountId !== link.initiated_by)
      throw new HttpError(403, 'PROFILE_DISPATCH_OWNER_REQUIRED');
    if (p.status !== 'pending' || profileChecksum(p) !== link.source.checksum)
      throw new HttpError(409, 'REVISION_CONFLICT');
    const current = await this.workflows.sourceRun(this.context(c), link.source);
    const run =
      current ??
      (await this.workflows.start(
        {
          ...this.context(c),
          requestId: c.requestId,
          idempotencyKey: link.id,
          reason: link.dispatch.reason,
        },
        link.dispatch,
        link.source,
      ));
    return mutate(
      this.store,
      { ...c, idempotencyKey: link.id + '_attach', reason: link.dispatch.reason },
      'people:manage',
      'profile.workflow_attach',
      { id: link.id, runId: run.id },
      async (db, actor) => {
        const row = (
          await db.query('SELECT * FROM directory_profile_workflows WHERE tenant_id=$1 AND id=$2', [
            c.tenantId,
            link.id,
          ])
        ).rows[0];
        const proposal = await this.proposal(c, actor, link.proposal_id);
        if (proposal.status !== 'pending') throw new HttpError(409, 'REVISION_CONFLICT');
        if (row.run_id && row.run_id !== run.id)
          throw new HttpError(409, 'PROFILE_WORKFLOW_MISMATCH');
        if (!row.run_id)
          await db.query(
            'UPDATE directory_profile_workflows SET run_id=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2',
            [c.tenantId, link.id, run.id],
          );
        await auditMutation(
          db,
          c,
          actor,
          'profile.workflow_attached',
          'profile-proposal',
          link.proposal_id,
          null,
          { linkId: link.id, runId: run.id, sourceChecksum: link.source.checksum },
        );
        return { id: link.proposal_id, runId: run.id };
      },
    );
  }
  async apply(c: MutationContext, id: string, expectedRevision: number) {
    await this.actor(c);
    if (!(await this.link(c, id))) throw new HttpError(409, 'PROFILE_WORKFLOW_REQUIRED');
    const service = new DirectoryMetadata(this.store, async (ctx, link, proposal) => {
      if (!link.run_id || link.source.checksum !== profileChecksum(proposal))
        throw new HttpError(409, 'PROFILE_WORKFLOW_MISMATCH');
      const run = await this.workflows.sourceRun(this.context(ctx), link.source);
      if (
        !run ||
        run.id !== link.run_id ||
        run.version_id !== link.dispatch.versionId ||
        run.owner_account_id !== link.initiated_by ||
        formHash(run.inputs) !== formHash(link.dispatch.answers)
      )
        throw new HttpError(409, 'PROFILE_WORKFLOW_MISMATCH');
      if (run.status !== 'completed' || run.approvalCount < 1)
        throw new HttpError(409, 'PROFILE_WORKFLOW_NOT_APPROVED');
    });
    return service.review(c, id, 'approved', expectedRevision);
  }
}
