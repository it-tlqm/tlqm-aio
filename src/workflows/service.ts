import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../security.js';
import type { ConfigurationImportEvidence } from '../configuration-package.js';
import {
  parsePerformanceReport,
  reportCsv,
  reportDetail,
  reportFieldRows,
  reportFieldSpec,
  reportSummary,
  reportVersions,
} from './performance-reports.js';
import type { ReportQuery, ReportScope } from './performance-reports.js';
import { fieldReportProjection } from './report-field-projection.js';
import { reportUsesFields } from './report-options.js';
import { compareWorkflowVersions } from './version-history.js';
import { WorkflowDocumentLibrary } from './document-library.js';
import { documentActions } from './document-library-options.js';
import type { DocumentAction, DocumentDraftInput } from './document-library-options.js';
import type { WorkflowVersionItem } from './version-history.js';
import type { PerformanceReportQuery } from './report-options.js';
import { printOutputHtml, renderOutput, validateOutputTemplate } from './output-templates.js';
import type { OutputJob, OutputTemplate, OutputTemplateInput } from './output-templates.js';
import { projectIntakeValues, validateIntakeMapping } from './intakes.js';
import type {
  IntakeDestination,
  IntakeJob,
  IntakeKind,
  IntakeProjection,
  IntakeRule,
  IntakeRuleInput,
} from './intakes.js';
import { formHash } from '../forms/service.js';
import { fieldState, schemaFields } from '../forms/contracts.js';
import { isReferenceAnswer } from '../forms/references.js';
import type { Answers, FormSchema } from '../forms/contracts.js';
import { maxAttachmentBytes } from '../forms/attachment-fields.js';
import {
  actionDestination,
  decisionPath,
  parseWorkflow,
  selectsAtHandoff,
  workflowUuid,
  advanceWorkflow,
  hasStepBranchSources,
  priorStepMode,
} from './contracts.js';
import type { WorkflowAction, WorkflowSpec, HumanStep } from './contracts.js';
import { workflowAllowed, workflowRequire } from './access.js';
import type {
  WorkflowActor,
  WorkflowContext,
  WorkflowCommand,
  WorkflowDirectory,
  WorkflowPermission,
} from './access.js';
import { startGroupSteps, WorkflowAssignments, workflowCandidateIds } from './assignments.js';
import type { WorkflowGroup } from './assignments.js';
import { CalendarError, workflowDeadline } from './calendar.js';
import { poolVote } from './pool-approvals.js';
import { parseWorkflowSource } from './source.js';
import type { WorkflowSource } from './source.js';
import { mayReadField, visibleAnswers, visibleSpec } from './field-access.js';
import type { FieldAudience } from './field-access.js';
import { referenceOptions, workflowAnswers } from './references.js';
import type { WorkflowReferenceQuery } from './access.js';
import { stepActionForm, stepInputPrefix } from './step-input.js';
import {
  attachmentLinks,
  attachmentReferences,
  attachmentRows,
  attachmentSummaries,
  insertAttachment,
  linkAttachments,
  ownsAttachment,
  verifyAttachmentAnswers,
} from './attachments.js';
import type { AttachmentLocation } from './attachments.js';
import { inspectAttachment, verifyStoredWorkflowAttachment } from './attachment-content.js';
import type { UploadScan } from '../upload-scan.js';
import {
  canRecallSubmission,
  priorAttempts,
  priorCursor,
  recallableAttempts,
  supersedeAttempts,
  supersedeRecall,
} from './step-attempts.js';
import type { ExecutionTask } from './step-attempts.js';
import {
  activeBranch,
  arriveBranch,
  closeSplit,
  openSplit,
  planExecution,
} from './parallel-execution.js';
import type { ExecutionCursor } from './parallel-execution.js';
import {
  activeFollower,
  followerColumns,
  followerSpec,
  liveRelatedTask,
  relatedSteps,
} from './collaboration.js';
import type { Follower } from './collaboration.js';
import {
  linkedAnswers,
  linkSourceFields,
  requireLinkFields,
  validateLinkFields,
  validateLinkInput,
} from './linked-requests.js';
import type { WorkflowLinkInput, WorkflowLinkJob, WorkflowLinkRule } from './linked-requests.js';
import { processDraftJobs } from './automation-jobs.js';
import { operationHistory, operationRows } from './operations.js';
import type { OperationRow } from './operations.js';
import { operationKinds, operationViews } from './operations-options.js';
import type { OperationItem, OperationQuery } from './operations-options.js';
import {
  enqueueScheduledDrafts,
  nextScheduleOccurrence,
  parseSchedule,
  vietnamScheduleDate,
} from './scheduled-requests.js';
import type {
  WorkflowDraftSchedule,
  WorkflowScheduleInput,
  WorkflowScheduleJob,
} from './scheduled-requests.js';
import {
  workflowDueFilters,
  workflowRunStatuses,
  workspaceColumnPattern,
} from './workspace-options.js';
import type {
  WorkflowRunView,
  WorkspaceFilters,
  WorkspaceSettings,
  WorkspacePreset,
} from './workspace-options.js';
export type { WorkflowRunView } from './workspace-options.js';
type Db = Pool | PoolClient;
type HandoffChoice = { stepId: string; accountId: string };
export type AttachmentUploadScope = 'request' | 'revision' | 'task';
export type AttachmentUpload = { fieldId: string; fileName: string; content: string };

const requestAttachmentLocation = (id: string): AttachmentLocation => ({
  requestId: id,
  runId: null,
  round: null,
  taskId: null,
  nodeId: null,
});
const revisionAttachmentLocation = (run: Run): AttachmentLocation => ({
  requestId: null,
  runId: run.id,
  round: run.round + 1,
  taskId: null,
  nodeId: null,
});
const taskAttachmentLocation = (task: Task): AttachmentLocation => ({
  requestId: null,
  runId: task.run_id,
  round: task.round,
  taskId: task.id,
  nodeId: task.node_id,
});
type TaskTransition = {
  taskId: string;
  action: WorkflowAction;
  handoff?: HandoffChoice;
  handoffs?: HandoffChoice[];
  priorTaskId?: string;
  recalledTask?: ExecutionTask;
};
type TaskActionInput = {
  expectedRevision: number;
  action: WorkflowAction;
  answers: unknown;
  returnTarget?: string;
};
export type WorkflowStartInput = {
  definitionId: string;
  versionId: string;
  unitId: string;
  title: string;
  answers: unknown;
  selections?: unknown;
};
export type WorkflowRequest = {
  id: string;
  tenant_id: string;
  definition_id: string;
  version_id: string;
  org_unit_id: string;
  owner_account_id: string;
  owner_person_id: string;
  title: string;
  answers: Answers;
  selections: Record<string, string>;
  revision: number;
  status: 'draft' | 'submitted';
  run_id: string | null;
  updated_at: string;
};
export type Definition = {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  category: string;
  org_unit_id: string;
  owner_account_id: string;
  draft: WorkflowSpec;
  status: 'draft' | 'published' | 'paused';
  revision: number;
  latest_version: number;
};
export type WorkflowVersion = {
  id: string;
  tenant_id: string;
  definition_id: string;
  version: number;
  spec: WorkflowSpec;
  checksum: string;
};
export type Run = {
  id: string;
  tenant_id: string;
  definition_id: string;
  version_id: string;
  org_unit_id: string;
  owner_account_id: string;
  owner_person_id: string;
  title: string;
  status: 'running' | 'needs_revision' | 'completed' | 'rejected' | 'cancelled';
  round: number;
  inputs: Answers;
  current_step: string | null;
  revision: number;
  source_context: WorkflowSource | null;
};
export type Task = {
  id: string;
  tenant_id: string;
  run_id: string;
  round: number;
  node_id: string;
  attempt: number;
  execution_branch_id?: string | null;
  label: string;
  kind: 'approval' | 'task';
  assignee_account_id: string;
  assignee_name: string;
  assignment_group_id: string | null;
  approval_policy: {
    mode: 'all' | 'any' | 'quorum';
    required: number;
    groupRevision: number;
  } | null;
  organization_rule?: { kind: 'manager' | 'unit-head'; ownerPersonId: string } | null;
  status: string;
  revision: number;
};
function revision(current: number, expected: number) {
  if (!Number.isInteger(expected) || current !== expected)
    throw new HttpError(409, 'REVISION_CONFLICT');
}
export class WorkflowsService {
  readonly assignment: WorkflowAssignments;
  private readonly documentLibrary: WorkflowDocumentLibrary;
  constructor(
    readonly pool: Pool,
    readonly directory: WorkflowDirectory,
    readonly intake?: IntakeDestination,
    private readonly reportFieldKey?: string,
    private readonly uploadScan?: UploadScan,
  ) {
    this.assignment = new WorkflowAssignments(directory);
    this.documentLibrary = new WorkflowDocumentLibrary(directory, uploadScan);
  }
  private async actor(context: WorkflowContext) {
    workflowUuid(context.tenantId);
    const actor = await context.actor();
    if (actor.appCode !== 'aio-workflows' || !actor.tenantIds.includes(context.tenantId))
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    return actor;
  }
  private async get<T>(
    db: Db,
    table:
      | 'workflow_definitions'
      | 'workflow_versions'
      | 'workflow_runs'
      | 'workflow_tasks'
      | 'workflow_requests',
    tenant: string,
    id: string,
  ) {
    workflowUuid(id);
    const row = (
      await db.query('SELECT * FROM ' + table + ' WHERE tenant_id=$1 AND id=$2', [tenant, id])
    ).rows[0] as T | undefined;
    if (!row) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
    return row;
  }
  private async audit(
    db: PoolClient,
    c: WorkflowCommand,
    a: WorkflowActor,
    action: string,
    unit: string | null,
    definitionId: string | null,
    runId: string | null,
    details: unknown,
  ) {
    await db.query(
      'INSERT INTO workflow_audit(tenant_id,definition_id,run_id,org_unit_id,actor_account_id,action,reason,request_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        c.tenantId,
        definitionId,
        runId,
        unit,
        a.accountId,
        action,
        c.reason,
        c.requestId,
        JSON.stringify(details),
      ],
    );
  }
  private async command<T>(
    c: WorkflowCommand,
    operation: string,
    input: unknown,
    authorize: (db: PoolClient, a: WorkflowActor) => Promise<void>,
    action: (db: PoolClient, a: WorkflowActor) => Promise<T>,
    beforeCommit?: (db: PoolClient, a: WorkflowActor) => Promise<void>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(c.idempotencyKey))
      throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    if (typeof c.reason !== 'string' || c.reason.trim().length < 5 || c.reason.length > 240)
      throw new HttpError(400, 'REASON_REQUIRED');
    const db = await this.pool.connect(),
      hash = formHash({ operation, input, reason: c.reason });
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'aio-workflows:' + c.tenantId,
      ]);
      const actor = await this.actor(c);
      await authorize(db, actor);
      const old = (
        await db.query(
          'SELECT * FROM workflow_receipts WHERE tenant_id=$1 AND actor_account_id=$2 AND idempotency_key=$3',
          [c.tenantId, actor.accountId, c.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (old.operation !== operation || old.request_hash !== hash)
          throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
        const response = await this.publicResult(db, c, actor, old.response as T);
        await db.query('COMMIT');
        return response;
      }
      const result = JSON.parse(JSON.stringify(await action(db, actor))) as T;
      const current = await this.actor(c);
      if (current.accountId !== actor.accountId || current.personId !== actor.personId)
        throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      await authorize(db, current);
      await beforeCommit?.(db, current);
      await db.query('INSERT INTO workflow_receipts VALUES($1,$2,$3,$4,$5,$6)', [
        c.tenantId,
        actor.accountId,
        c.idempotencyKey,
        operation,
        hash,
        JSON.stringify(result),
      ]);
      const response = await this.publicResult(db, c, current, result);
      await db.query('COMMIT');
      return response;
    } catch (error) {
      await db.query('ROLLBACK');
      const code = (error as { code?: string }).code;
      if (code === '23505') throw new HttpError(409, 'WORKFLOW_DUPLICATE');
      if (code === '23514' || code === '23503')
        throw new HttpError(400, 'WORKFLOW_INVALID_RELATION');
      if (error instanceof CalendarError) throw new HttpError(400, error.code);
      throw error;
    } finally {
      db.release();
    }
  }
  private async fieldAudience(
    db: Db,
    c: WorkflowContext,
    a: WorkflowActor,
    run: Run,
    scopedTasks?: Task[],
  ): Promise<FieldAudience> {
    const who: FieldAudience = {
      owner:
        run.owner_account_id === a.accountId &&
        workflowAllowed(a, c.tenantId, 'workflows:start', run.org_unit_id),
      manager: workflowAllowed(a, c.tenantId, 'workflows:manage', run.org_unit_id),
      steps: new Set(),
    };
    if (workflowAllowed(a, c.tenantId, 'workflows:act', run.org_unit_id)) {
      const tasks =
        scopedTasks ??
        (
          await db.query<Task>('SELECT * FROM workflow_tasks WHERE tenant_id=$1 AND run_id=$2', [
            c.tenantId,
            run.id,
          ])
        ).rows;
      for (const task of tasks)
        if (await this.assignment.eligible(db, c.tenantId, run.org_unit_id, task, a.accountId))
          who.steps.add(task.node_id);
    }
    return who;
  }
  private async publicResult<T>(
    db: Db,
    c: WorkflowContext,
    a: WorkflowActor,
    value: T,
  ): Promise<T> {
    if (
      value &&
      typeof value === 'object' &&
      'version_id' in value &&
      'inputs' in value &&
      'owner_account_id' in value
    ) {
      const run = value as unknown as Run,
        version = await this.version(db, c.tenantId, run.version_id);
      if (version.spec.fieldReaders)
        return {
          ...run,
          inputs: visibleAnswers(
            version.spec,
            'input',
            run.inputs,
            await this.fieldAudience(db, c, a, run),
          ),
        } as T;
    }
    return value;
  }
  private scope(c: WorkflowContext, id: string, p: WorkflowPermission) {
    return async (db: PoolClient, a: WorkflowActor) => {
      const d = await this.get<Definition>(db, 'workflow_definitions', c.tenantId, id);
      workflowRequire(a, c.tenantId, p, d.org_unit_id);
    };
  }
  async saveDefinition(
    c: WorkflowCommand,
    input: { code: string; orgUnitId: string; spec: unknown },
    id?: string,
    expectedRevision?: number,
    importEvidence?: ConfigurationImportEvidence,
  ) {
    if (!/^[a-z][a-z0-9-]{2,50}$/.test(input.code))
      throw new HttpError(400, 'WORKFLOW_INVALID_CODE');
    workflowUuid(input.orgUnitId);
    const spec = parseWorkflow(input.spec, false);
    return this.command(
      c,
      'definition.save',
      {
        input,
        id: id ?? null,
        expectedRevision: expectedRevision ?? null,
        ...(importEvidence && { importEvidence }),
      },
      async (db, a) => {
        workflowRequire(a, c.tenantId, 'workflows:design', input.orgUnitId);
        await this.directory.validateUnit(c.tenantId, input.orgUnitId);
        if (id) {
          const old = await this.get<Definition>(db, 'workflow_definitions', c.tenantId, id);
          if (old.org_unit_id !== input.orgUnitId || old.code !== input.code)
            throw new HttpError(400, 'WORKFLOW_OWNERSHIP_IMMUTABLE');
        }
      },
      async (db, a) => {
        let result: Definition;
        if (id) {
          const old = await this.get<Definition>(db, 'workflow_definitions', c.tenantId, id);
          revision(old.revision, expectedRevision!);
          result = (
            await db.query(
              'UPDATE workflow_definitions SET name=$3,category=$4,draft=$5,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
              [c.tenantId, id, spec.name, spec.category, JSON.stringify(spec)],
            )
          ).rows[0];
        } else
          result = (
            await db.query(
              'INSERT INTO workflow_definitions(id,tenant_id,code,name,category,org_unit_id,owner_account_id,draft) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
              [
                randomUUID(),
                c.tenantId,
                input.code,
                spec.name,
                spec.category,
                input.orgUnitId,
                a.accountId,
                JSON.stringify(spec),
              ],
            )
          ).rows[0];
        await this.audit(
          db,
          c,
          a,
          id ? 'definition.updated' : 'definition.created',
          result.org_unit_id,
          result.id,
          null,
          {
            revision: result.revision,
            checksum: formHash(spec),
            ...(importEvidence && { configurationImport: importEvidence }),
          },
        );
        return result;
      },
    );
  }
  async publish(c: WorkflowCommand, id: string, expectedRevision: number) {
    return this.publishVersion(c, id, expectedRevision);
  }

  async restoreVersion(c: WorkflowCommand, id: string, expectedRevision: number, sourceId: string) {
    workflowUuid(sourceId);
    return this.publishVersion(c, id, expectedRevision, sourceId);
  }

  private async publishVersion(
    c: WorkflowCommand,
    id: string,
    expectedRevision: number,
    sourceId?: string,
  ) {
    const source = (db: Db) =>
      sourceId ? this.definitionVersion(db, c.tenantId, id, sourceId) : null;
    return this.command(
      c,
      sourceId ? 'definition.restore' : 'definition.publish',
      { id, expectedRevision, ...(sourceId && { sourceId }) },
      async (db, a) => {
        const d = await this.get<Definition>(db, 'workflow_definitions', c.tenantId, id);
        workflowRequire(a, c.tenantId, 'workflows:publish', d.org_unit_id);
        const previous = await source(db);
        const spec = parseWorkflow(previous?.spec ?? d.draft);
        for (const node of spec.nodes) {
          if (node.kind === 'approval' || node.kind === 'task')
            workflowDeadline(
              new Date(),
              node.deadlineMinutes ?? node.dueHours * 60,
              node.deadlineMode === 'business' ? spec.calendar : undefined,
            );
        }
        for (const unit of spec.audienceUnits) {
          workflowRequire(a, c.tenantId, 'workflows:publish', unit);
          await this.directory.validateUnit(c.tenantId, unit);
          await this.assignment.validatePublish(db, c.tenantId, unit, spec);
        }
      },
      async (db, a) => {
        const d = await this.get<Definition>(db, 'workflow_definitions', c.tenantId, id);
        revision(d.revision, expectedRevision);
        const previous = await source(db);
        if (previous?.version === d.latest_version)
          throw new HttpError(409, 'WORKFLOW_VERSION_CURRENT');
        const spec = parseWorkflow(previous?.spec ?? d.draft);
        const version = (
          await db.query(
            'INSERT INTO workflow_versions(id,tenant_id,definition_id,version,spec,checksum,published_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              randomUUID(),
              c.tenantId,
              id,
              d.latest_version + 1,
              JSON.stringify(spec),
              formHash(spec),
              a.accountId,
            ],
          )
        ).rows[0] as WorkflowVersion;
        await db.query(
          "UPDATE workflow_definitions SET latest_version=$3,status='published',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [c.tenantId, id, version.version],
        );
        await this.audit(
          db,
          c,
          a,
          previous ? 'definition.restored' : 'definition.published',
          d.org_unit_id,
          id,
          null,
          {
            version: version.version,
            checksum: version.checksum,
            ...(previous && { sourceVersion: previous.version, sourceVersionId: previous.id }),
          },
        );
        return {
          version,
          definition: await this.get<Definition>(db, 'workflow_definitions', c.tenantId, id),
        };
      },
    );
  }
  async setStatus(
    c: WorkflowCommand,
    id: string,
    expectedRevision: number,
    status: 'published' | 'paused',
  ) {
    if (!['published', 'paused'].includes(status)) throw new HttpError(400, 'INVALID_REQUEST');
    return this.command(
      c,
      'definition.status',
      { id, expectedRevision, status },
      this.scope(c, id, 'workflows:publish'),
      async (db, a) => {
        const d = await this.get<Definition>(db, 'workflow_definitions', c.tenantId, id);
        revision(d.revision, expectedRevision);
        if (!d.latest_version) throw new HttpError(409, 'WORKFLOW_NOT_PUBLISHED');
        await db.query(
          'UPDATE workflow_definitions SET status=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [c.tenantId, id, status],
        );
        await this.audit(db, c, a, 'definition.status', d.org_unit_id, id, null, {
          before: d.status,
          after: status,
        });
        return this.get<Definition>(db, 'workflow_definitions', c.tenantId, id);
      },
    );
  }
  private async version(db: Db, tenant: string, id: string) {
    const value = await this.get<WorkflowVersion>(db, 'workflow_versions', tenant, id);
    value.spec = parseWorkflow(value.spec);
    return value;
  }
  private async definitionVersion(db: Db, tenant: string, definitionId: string, id: string) {
    const { rows } = await db.query<WorkflowVersion & { published_at: Date }>(
      'SELECT * FROM workflow_versions WHERE (tenant_id,definition_id,id)=($1,$2,$3)',
      [tenant, definitionId, id],
    );
    if (!rows[0]) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
    return rows[0];
  }

  private async versionHistoryAccess(c: WorkflowContext, id: string) {
    const actor = await this.actor(c);
    const definition = await this.get<Definition>(
      this.pool,
      'workflow_definitions',
      c.tenantId,
      id,
    );
    const canPublish = workflowAllowed(
      actor,
      c.tenantId,
      'workflows:publish',
      definition.org_unit_id,
    );
    if (!canPublish) workflowRequire(actor, c.tenantId, 'workflows:design', definition.org_unit_id);
    return { definition, canPublish };
  }

  async versionHistory(c: WorkflowContext, id: string, before?: number) {
    if (before !== undefined && (!Number.isInteger(before) || before < 1 || before > 2_147_483_647))
      throw new HttpError(400, 'INVALID_REQUEST');
    const { definition, canPublish } = await this.versionHistoryAccess(c, id);
    const { rows } = await this.pool.query<
      Omit<WorkflowVersionItem, 'publishedAt'> & { publishedAt: Date }
    >(
      `SELECT id, version, spec->>'name' AS name, published_at AS "publishedAt"
       FROM workflow_versions WHERE (tenant_id,definition_id)=($1,$2)
       AND version<=$3 AND ($4::int IS NULL OR version<$4) ORDER BY version DESC LIMIT 101`,
      [c.tenantId, id, definition.latest_version, before ?? null],
    );
    const items = rows
      .slice(0, 100)
      .map((row) => ({ ...row, publishedAt: row.publishedAt.toISOString() }));
    return {
      items,
      canPublish,
      revision: definition.revision,
      latestVersion: definition.latest_version,
      nextBefore: rows.length > 100 ? items.at(-1)!.version : null,
    };
  }

  async versionComparison(c: WorkflowContext, id: string, beforeId: string, afterId: string) {
    await this.versionHistoryAccess(c, id);
    workflowUuid(beforeId);
    workflowUuid(afterId);
    const [before, after] = await Promise.all([
      this.definitionVersion(this.pool, c.tenantId, id, beforeId),
      this.definitionVersion(this.pool, c.tenantId, id, afterId),
    ]);
    const brief = ({ id, version, spec, published_at }: typeof before) => ({
      id,
      version,
      name: spec.name,
      publishedAt: published_at.toISOString(),
    });
    return {
      before: brief(before),
      after: brief(after),
      changes: compareWorkflowVersions(parseWorkflow(before.spec), parseWorkflow(after.spec)),
    };
  }

  async documents(
    c: WorkflowContext,
    filters: { after?: string; search?: string; versionId?: string; folderId?: string },
  ) {
    return this.documentLibrary.list(this.pool, c.tenantId, await this.actor(c), filters);
  }

  private validateDocumentVersion(version?: number) {
    if (
      version !== undefined &&
      (!Number.isInteger(version) || version < 1 || version > 2_147_483_647)
    )
      throw new HttpError(400, 'WORKFLOW_DOCUMENT_INVALID');
  }

  async documentDetail(c: WorkflowContext, id: string, version?: number, issuedOnly?: boolean) {
    this.validateDocumentVersion(version);
    return this.documentLibrary.detail(
      this.pool,
      c.tenantId,
      await this.actor(c),
      id,
      version,
      issuedOnly,
    );
  }

  async downloadDocumentFile(
    c: WorkflowContext,
    id: string,
    fileId: string,
    version?: number,
    issuedOnly?: boolean,
  ) {
    this.validateDocumentVersion(version);
    return this.documentLibrary.download(
      this.pool,
      c.tenantId,
      await this.actor(c),
      id,
      fileId,
      version,
      issuedOnly,
    );
  }

  async saveDocumentFolder(
    c: WorkflowCommand,
    input: { unitId: string; parentId: string | null; name: string },
    id?: string,
    revision?: number,
  ) {
    return this.command(
      c,
      'document.folder_saved',
      { input, id, revision },
      (db, a) =>
        this.documentLibrary.authorizeFolder(db, c.tenantId, a, input.unitId, input.parentId, id),
      async (db, a) => {
        const result = await this.documentLibrary.saveFolder(
          db,
          c.tenantId,
          a,
          input,
          id,
          revision,
        );
        await this.audit(db, c, a, 'document.folder_saved', input.unitId, null, null, {
          folderId: result.id,
          revision: result.revision,
        });
        return result;
      },
    );
  }

  async saveDocument(
    c: WorkflowCommand,
    input: DocumentDraftInput,
    id?: string,
    revision?: number,
  ) {
    return this.command(
      c,
      'document.saved',
      { input, id, revision },
      (db, a) => this.documentLibrary.authorizeDraft(db, c.tenantId, a, input, id),
      async (db, a) => {
        const saved = await this.documentLibrary.saveDraft(db, c.tenantId, a, input, id, revision);
        const result = { id: saved.id, revision: saved.revision, version: saved.draft_version };
        await this.audit(db, c, a, 'document.saved', input.unitId, null, null, {
          documentId: saved.id,
          actorName: a.displayName,
          version: result.version,
          revision: result.revision,
        });
        return result;
      },
    );
  }

  async transitionDocument(
    c: WorkflowCommand,
    id: string,
    action: DocumentAction,
    expectedRevision: number,
  ) {
    if (!documentActions.includes(action)) throw new HttpError(400, 'WORKFLOW_DOCUMENT_INVALID');
    return this.command(
      c,
      'document.' + action,
      { id, action, expectedRevision },
      async (db, a) => {
        await this.documentLibrary.authorizeAction(db, c.tenantId, a, id, action);
      },
      async (db, a) => {
        const doc = await this.documentLibrary.get(db, c.tenantId, id);
        const updated = await this.documentLibrary.transition(db, doc, a, action, expectedRevision);
        const version = (
          action === 'issue' || action === 'withdraw'
            ? updated.issued_version
            : updated.draft_version
        )!;
        await this.audit(db, c, a, 'document.' + action, doc.org_unit_id, null, null, {
          documentId: id,
          actorName: a.displayName,
          version,
          reviewState: updated.review_state,
          published: updated.published,
          revision: updated.revision,
        });
        return { id, revision: updated.revision, version };
      },
    );
  }

  async restoreDocumentDraft(
    c: WorkflowCommand,
    id: string,
    source: number,
    expectedRevision: number,
  ) {
    this.validateDocumentVersion(source);
    return this.command(
      c,
      'document.restore',
      { id, source, expectedRevision },
      async (db, a) => {
        await this.documentLibrary.authorizeAction(db, c.tenantId, a, id, 'restore');
      },
      async (db, a) => {
        const doc = await this.documentLibrary.get(db, c.tenantId, id);
        const restored = await this.documentLibrary.restoreDraft(
          db,
          doc,
          a,
          source,
          expectedRevision,
        );
        await this.audit(db, c, a, 'document.restore', doc.org_unit_id, null, null, {
          documentId: id,
          actorName: a.displayName,
          sourceVersion: source,
          version: restored.draft_version,
          revision: restored.revision,
        });
        return { id, revision: restored.revision, version: restored.draft_version };
      },
    );
  }

  async definitions(c: WorkflowContext) {
    const a = await this.actor(c);
    const definitions = (
        await this.pool.query(
          'SELECT * FROM workflow_definitions WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 200',
          [c.tenantId],
        )
      ).rows as Definition[],
      items = [];
    // Keep the versions pinned to the first query's latest_version values.
    // Fetch them together instead of issuing one round trip per definition.
    const versions = definitions.length
      ? ((
          await this.pool.query(
            'SELECT v.* FROM workflow_versions v JOIN unnest($2::uuid[], $3::integer[]) AS target(id, version) ON v.definition_id=target.id AND v.version=target.version WHERE v.tenant_id=$1',
            [c.tenantId, definitions.map((d) => d.id), definitions.map((d) => d.latest_version)],
          )
        ).rows as WorkflowVersion[])
      : [];
    const published = new Map(versions.map((v) => [v.definition_id, v]));
    for (const d of definitions) {
      const manage =
        workflowAllowed(a, c.tenantId, 'workflows:design', d.org_unit_id) ||
        workflowAllowed(a, c.tenantId, 'workflows:publish', d.org_unit_id);
      const version = published.get(d.id);
      const units =
        version?.spec.audienceUnits.filter(
          (unit) =>
            workflowAllowed(a, c.tenantId, 'workflows:start', unit) &&
            a.units.some((own) => own.tenantId === c.tenantId && own.orgUnitId === unit),
        ) ?? [];
      if (manage || (d.status === 'published' && units.length))
        items.push({
          ...d,
          draft: manage ? d.draft : null,
          name: manage ? d.name : version!.spec.name,
          category: manage ? d.category : version!.spec.category,
          version: version ?? null,
          startUnits: d.status === 'published' ? units : [],
          canDesign: workflowAllowed(a, c.tenantId, 'workflows:design', d.org_unit_id),
          canPublish: workflowAllowed(a, c.tenantId, 'workflows:publish', d.org_unit_id),
        });
    }
    return { items };
  }
  async groups(c: WorkflowContext) {
    const a = await this.actor(c),
      permissions = ['workflows:design', 'workflows:publish', 'workflows:manage'];
    if (!a.permissions.some((p) => p.tenantId === c.tenantId && permissions.includes(p.permission)))
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const rows = (
      await this.pool.query(
        "SELECT g.*,COALESCE((SELECT json_agg(m.account_id ORDER BY m.account_id) FROM workflow_group_members m WHERE m.tenant_id=g.tenant_id AND m.group_id=g.id AND m.active),'[]'::json) AS account_ids FROM workflow_groups g WHERE g.tenant_id=$1 ORDER BY g.name,g.id LIMIT 200",
        [c.tenantId],
      )
    ).rows as (WorkflowGroup & { account_ids: string[] })[];
    return {
      items: rows
        .filter(
          (g) =>
            g.org_unit_id === null ||
            permissions.some((p) =>
              workflowAllowed(a, c.tenantId, p as WorkflowPermission, g.org_unit_id),
            ),
        )
        .map((g) => ({
          ...g,
          account_ids: workflowAllowed(a, c.tenantId, 'workflows:manage', g.org_unit_id)
            ? g.account_ids
            : undefined,
          canManage: workflowAllowed(a, c.tenantId, 'workflows:manage', g.org_unit_id),
        })),
    };
  }
  async saveGroup(
    c: WorkflowCommand,
    input: { name: string; orgUnitId: string | null; accountIds: unknown; active: boolean },
    id?: string,
    expectedRevision?: number,
  ) {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 120 ||
      typeof input.active !== 'boolean'
    )
      throw new HttpError(400, 'WORKFLOW_INVALID_GROUP');
    if (input.orgUnitId !== null) workflowUuid(input.orgUnitId);
    if (id) workflowUuid(id);
    const accountIds = workflowCandidateIds(input.accountIds);
    let additions: string[] | undefined;
    const authorize = async (db: PoolClient, a: WorkflowActor) => {
      workflowRequire(a, c.tenantId, 'workflows:manage', input.orgUnitId);
      if (input.orgUnitId) await this.directory.validateUnit(c.tenantId, input.orgUnitId);
      if (id) {
        const prior = await this.assignment.group(db, c.tenantId, id);
        if (prior.org_unit_id !== input.orgUnitId)
          throw new HttpError(400, 'WORKFLOW_OWNERSHIP_IMMUTABLE');
      }
      if (!additions) {
        const prior = id
          ? ((
              await db.query(
                'SELECT account_id FROM workflow_group_members WHERE tenant_id=$1 AND group_id=$2 AND active',
                [c.tenantId, id],
              )
            ).rows as { account_id: string }[])
          : [];
        additions = accountIds.filter((account) => !prior.some((p) => p.account_id === account));
      }
      for (const account of additions)
        await this.directory.assignee(c.tenantId, input.orgUnitId, account);
    };
    return this.command(
      c,
      'group.save',
      { ...input, accountIds, id: id ?? null, expectedRevision: expectedRevision ?? null },
      authorize,
      async (db, a) => {
        let group: WorkflowGroup;
        const groupId = id ?? randomUUID();
        let before: WorkflowGroup | null = null;
        if (id) {
          before = await this.assignment.group(db, c.tenantId, id);
          revision(before.revision, expectedRevision!);
          group = (
            await db.query(
              'UPDATE workflow_groups SET name=$3,active=$4,revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING *',
              [c.tenantId, id, input.name.trim(), input.active],
            )
          ).rows[0];
        } else
          group = (
            await db.query(
              'INSERT INTO workflow_groups(id,tenant_id,org_unit_id,name,active) VALUES($1,$2,$3,$4,$5) RETURNING *',
              [groupId, c.tenantId, input.orgUnitId, input.name.trim(), input.active],
            )
          ).rows[0];
        const prior = (
          await db.query(
            'SELECT account_id FROM workflow_group_members WHERE tenant_id=$1 AND group_id=$2 AND active',
            [c.tenantId, groupId],
          )
        ).rows as { account_id: string }[];
        await db.query(
          'UPDATE workflow_group_members SET active=false WHERE tenant_id=$1 AND group_id=$2',
          [c.tenantId, groupId],
        );
        for (const account of accountIds)
          await db.query(
            'INSERT INTO workflow_group_members(tenant_id,group_id,account_id,active) VALUES($1,$2,$3,true) ON CONFLICT(tenant_id,group_id,account_id) DO UPDATE SET active=true',
            [c.tenantId, groupId, account],
          );
        await this.audit(
          db,
          c,
          a,
          id ? 'group.updated' : 'group.created',
          group.org_unit_id,
          null,
          null,
          {
            groupId,
            before: before
              ? {
                  active: before.active,
                  revision: before.revision,
                  accountIds: prior.map((p) => p.account_id),
                }
              : null,
            after: { active: group.active, revision: group.revision, accountIds },
          },
        );
        return { ...group, account_ids: accountIds, canManage: true };
      },
    );
  }
  async startSelections(c: WorkflowContext, id: string, unit: string, versionId: string) {
    workflowUuid(unit);
    const a = await this.actor(c);
    workflowRequire(a, c.tenantId, 'workflows:start', unit);
    if (!a.units.some((own) => own.tenantId === c.tenantId && own.orgUnitId === unit))
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const d = await this.get<Definition>(this.pool, 'workflow_definitions', c.tenantId, id),
      v = await this.version(this.pool, c.tenantId, versionId);
    if (d.status !== 'published' || v.definition_id !== d.id || v.version !== d.latest_version)
      throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
    if (!v.spec.audienceUnits.includes(unit)) throw new HttpError(403, 'WORKFLOW_AUDIENCE_DENIED');
    return { items: await this.assignment.options(this.pool, c.tenantId, unit, v.spec, a) };
  }
  async runSelections(c: WorkflowContext, id: string) {
    const a = await this.actor(c),
      r = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, id);
    workflowRequire(a, c.tenantId, 'workflows:start', r.org_unit_id);
    if (
      r.owner_account_id !== a.accountId ||
      r.owner_person_id !== a.personId ||
      !a.units.some((unit) => unit.tenantId === c.tenantId && unit.orgUnitId === r.org_unit_id)
    )
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    if (r.status !== 'needs_revision') throw new HttpError(409, 'WORKFLOW_RUN_CLOSED');
    return {
      items: await this.assignment.options(
        this.pool,
        c.tenantId,
        r.org_unit_id,
        (await this.version(this.pool, c.tenantId, r.version_id)).spec,
        a,
      ),
    };
  }
  async taskCandidates(c: WorkflowContext, id: string) {
    const a = await this.actor(c),
      t = await this.get<Task>(this.pool, 'workflow_tasks', c.tenantId, id),
      r = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, t.run_id);
    const spec = t.assignment_group_id
      ? (await this.version(this.pool, c.tenantId, r.version_id)).spec
      : undefined;
    const authority = await this.reassignAuthority(this.pool, c, a, r, t, spec);
    if (!authority) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    if (t.status !== 'pending' || r.status !== 'running')
      throw new HttpError(409, 'WORKFLOW_TASK_CLOSED');
    if (!t.assignment_group_id)
      return {
        restricted: false,
        unitId: r.org_unit_id,
        candidates: [] as { id: string; name: string }[],
      };
    const step = spec!.nodes.find((node) => node.id === t.node_id) as HumanStep;
    return {
      restricted: true,
      unitId: r.org_unit_id,
      candidates: (
        await this.assignment.candidates(this.pool, c.tenantId, r.org_unit_id, step, {
          accountId: r.owner_account_id,
          personId: r.owner_person_id,
        })
      ).candidates
        .filter(
          (candidate) =>
            authority === 'manager' ||
            (candidate.id !== t.assignee_account_id &&
              (t.kind !== 'approval' || candidate.personId !== r.source_context?.subjectPersonId)),
        )
        .map(({ id, name }) => ({ id, name })),
    };
  }
  private async branchEvaluator(
    db: Db,
    run: Run,
    spec: WorkflowSpec,
    proposed?: { nodeId: string; answers: Answers },
  ) {
    const stepResults: Record<string, Answers> = hasStepBranchSources(spec)
      ? Object.fromEntries(
          (
            await db.query<{ node_id: string; answers: Answers }>(
              `SELECT t.node_id,r.answers FROM workflow_tasks t
               JOIN workflow_task_results r ON r.tenant_id=t.tenant_id AND r.task_id=t.id
               LEFT JOIN workflow_task_supersessions s ON (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id)
               WHERE t.tenant_id=$1 AND t.run_id=$2 AND t.round=$3
                AND t.status IN ('completed','rejected') AND s.task_id IS NULL`,
              [run.tenant_id, run.id, run.round],
            )
          ).rows.map((row) => [row.node_id, row.answers]),
        )
      : {};
    if (proposed) stepResults[proposed.nodeId] = proposed.answers;
    return (from: string) => advanceWorkflow(spec, from, run.inputs, stepResults);
  }

  private async handoffRecipient(db: Db, run: Run, step: HumanStep, choice: HandoffChoice) {
    if (step.assigneeRule?.kind !== 'group' || choice.stepId !== step.id)
      throw new HttpError(409, 'WORKFLOW_HANDOFF_CHANGED');
    workflowUuid(choice.accountId);
    const accountId = choice.accountId.toLowerCase();
    const recipient = await this.assignment.member(
      db,
      run.tenant_id,
      run.org_unit_id,
      step.assigneeRule.groupId,
      accountId,
    );
    if (
      step.kind === 'approval' &&
      (accountId === run.owner_account_id ||
        recipient.personId === run.owner_person_id ||
        recipient.personId === run.source_context?.subjectPersonId)
    )
      throw new HttpError(403, 'WORKFLOW_SELF_APPROVAL');
    return { accountId, groupId: step.assigneeRule.groupId, ...recipient };
  }

  private async queueTask(
    db: PoolClient,
    c: WorkflowCommand,
    a: WorkflowActor,
    run: Run,
    version: WorkflowVersion,
    work: Extract<Awaited<ReturnType<typeof planExecution>>[number], { kind: 'task' }>,
    choice?: HandoffChoice,
    action?: TaskTransition,
  ) {
    const { node, cursor } = work;
    const recipient = choice ? await this.handoffRecipient(db, run, node, choice) : undefined;
    const recalled = action?.recalledTask?.node_id === node.id ? action.recalledTask : undefined;
    const retained =
      recalled && !recalled.approval_policy
        ? {
            accountId: recalled.assignee_account_id,
            groupId: recalled.assignment_group_id,
            ...(recalled.organization_rule && { organizationRule: recalled.organization_rule }),
          }
        : undefined;
    const resolved: Awaited<ReturnType<WorkflowAssignments['resolve']>> =
      recipient ?? retained ?? (await this.assignment.resolve(db, c.tenantId, run, node));
    if (node.kind === 'approval' && run.source_context) {
      const persons = resolved.members?.map((m) => m.personId) ?? [
        (await this.directory.assignee(c.tenantId, run.org_unit_id, resolved.accountId)).personId,
      ];
      if (persons.includes(run.source_context.subjectPersonId))
        throw new HttpError(403, 'WORKFLOW_SOURCE_SELF_APPROVAL');
    }
    let name = 'Người xử lý cần đối soát';
    try {
      name = (await this.directory.assignee(c.tenantId, run.org_unit_id, resolved.accountId)).name;
    } catch (error) {
      if (!(error instanceof HttpError && error.statusCode === 400)) throw error;
    }
    if (resolved.members) name = `${resolved.members.length} người phê duyệt`;
    const dueAt =
      recalled?.due_at ??
      workflowDeadline(
        (await db.query('SELECT now() AS now')).rows[0].now as Date,
        node.deadlineMinutes ?? node.dueHours * 60,
        node.deadlineMode === 'business' ? version.spec.calendar : undefined,
      );
    const task = (
      await db.query<{ id: string }>(
        `INSERT INTO workflow_tasks(id,tenant_id,run_id,round,node_id,label,kind,assignee_account_id,assignee_name,due_at,assignment_group_id,organization_rule,approval_policy,attempt,execution_branch_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,(
          SELECT COALESCE(max(attempt),0)+1 FROM workflow_tasks
          WHERE tenant_id=$2 AND run_id=$3 AND round=$4 AND node_id=$5
         ),$14) RETURNING id`,
        [
          randomUUID(),
          c.tenantId,
          run.id,
          run.round,
          node.id,
          node.label,
          node.kind,
          resolved.accountId,
          name,
          dueAt,
          resolved.groupId,
          resolved.organizationRule ? JSON.stringify(resolved.organizationRule) : null,
          resolved.approvalPolicy ? JSON.stringify(resolved.approvalPolicy) : null,
          cursor.branchId,
        ],
      )
    ).rows[0]!;
    for (const member of resolved.members ?? [])
      await db.query(
        'INSERT INTO workflow_approval_members(tenant_id,task_id,account_id,person_id,name) VALUES($1,$2,$3,$4,$5)',
        [c.tenantId, task.id, member.id, member.personId, member.name],
      );
    if (cursor.predecessors.length)
      await db.query(
        `INSERT INTO workflow_task_dependencies(tenant_id,run_id,round,task_id,prerequisite_task_id)
         SELECT $1,$2,$3,$4,unnest($5::uuid[])`,
        [c.tenantId, run.id, run.round, task.id, cursor.predecessors],
      );
    await this.audit(db, c, a, 'task.assigned', run.org_unit_id, run.definition_id, run.id, {
      taskId: task.id,
      nodeId: node.id,
      assignee: resolved.accountId,
      approvalPolicy: resolved.approvalPolicy ?? null,
      members: resolved.members?.map((m) => m.id) ?? null,
      assignmentRule: node.assigneeRule ?? { kind: 'account' },
      organizationBasis: resolved.basis ?? null,
      traversed: work.traversed,
      ...(cursor.branchId && { branchId: cursor.branchId }),
      ...(recipient && { handedOffFrom: action!.taskId }),
      ...(action?.priorTaskId && { replayOf: action.priorTaskId }),
    });
    return { id: task.id, node, choice, handoffPersonId: recipient?.personId };
  }

  private async queue(
    db: PoolClient,
    c: WorkflowCommand,
    a: WorkflowActor,
    run: Run,
    version: WorkflowVersion,
    from: string,
    action?: TaskTransition,
    cursor: ExecutionCursor = { branchId: null, predecessors: [] },
  ) {
    const resolve = await this.branchEvaluator(db, run, version.spec);
    const effects = await planExecution(db, run, from, cursor, resolve);
    const requested = action?.handoff ? [action.handoff] : (action?.handoffs ?? []);
    const choices = new Map(requested.map((choice) => [choice.stepId, choice]));
    const required = effects.flatMap((effect) =>
      action &&
      effect.kind === 'task' &&
      selectsAtHandoff(effect.node) &&
      action.recalledTask?.node_id !== effect.node.id
        ? [effect.node.id]
        : [],
    );
    if (
      choices.size !== requested.length ||
      [...choices.keys()].some((id) => !required.includes(id))
    )
      throw new HttpError(409, 'WORKFLOW_HANDOFF_CHANGED');
    if (required.some((id) => !choices.has(id)))
      throw new HttpError(400, 'WORKFLOW_HANDOFF_REQUIRED');
    const queued: Awaited<ReturnType<WorkflowsService['queueTask']>>[] = [];
    let end: Extract<(typeof effects)[number], { kind: 'end' }> | undefined;
    for (const effect of effects) {
      if (effect.kind === 'task') {
        queued.push(
          await this.queueTask(db, c, a, run, version, effect, choices.get(effect.node.id), action),
        );
      } else if (effect.kind === 'open') {
        await openSplit(db, run, effect.execution, effect.predecessors);
        await this.audit(
          db,
          c,
          a,
          'run.parallel_opened',
          run.org_unit_id,
          run.definition_id,
          run.id,
          {
            executionId: effect.execution.id,
            nodeId: effect.execution.split,
          },
        );
      } else if (effect.kind === 'arrive') {
        await arriveBranch(db, run, effect);
        await this.audit(
          db,
          c,
          a,
          'run.parallel_arrived',
          run.org_unit_id,
          run.definition_id,
          run.id,
          {
            executionId: effect.executionId,
            branchId: effect.branchId,
          },
        );
      } else if (effect.kind === 'join') {
        await closeSplit(db, run, effect.executionId);
        await this.audit(
          db,
          c,
          a,
          'run.parallel_joined',
          run.org_unit_id,
          run.definition_id,
          run.id,
          {
            executionId: effect.executionId,
            nodeId: effect.nodeId,
          },
        );
      } else end = effect;
    }
    if (end) {
      const status =
        action?.action === 'reject' && !effects.some((effect) => effect.kind === 'join')
          ? 'rejected'
          : 'completed';
      await db.query(
        'UPDATE workflow_runs SET status=$4,current_step=$3,finished_at=now(),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [c.tenantId, run.id, end.node.id, status],
      );
      await this.audit(db, c, a, 'run.' + status, run.org_unit_id, run.definition_id, run.id, {
        traversed: end.traversed,
      });
    } else {
      const root = (
        await db.query<{ node_id: string }>(
          `SELECT node_id FROM workflow_tasks
           WHERE (tenant_id,run_id,round)=($1,$2,$3) AND status='pending' AND execution_branch_id IS NULL
           UNION ALL
           SELECT split_node_id FROM workflow_parallel_executions
           WHERE (tenant_id,run_id,round)=($1,$2,$3) AND status='open' AND parent_branch_id IS NULL`,
          [c.tenantId, run.id, run.round],
        )
      ).rows;
      if (root.length !== 1) throw new HttpError(409, 'WORKFLOW_PARALLEL_CHANGED');
      await db.query(
        'UPDATE workflow_runs SET current_step=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [c.tenantId, run.id, root[0]!.node_id],
      );
    }
    return queued;
  }

  private async isOpenTask(db: Db, run: Run, task: Task) {
    if (run.status !== 'running' || task.round !== run.round || task.status !== 'pending')
      return false;
    return task.execution_branch_id
      ? !!(await activeBranch(db, run, task.execution_branch_id))
      : task.node_id === run.current_step;
  }

  private async closePendingTasks(db: PoolClient, run: Run) {
    await db.query(
      "UPDATE workflow_tasks SET status='cancelled',finished_at=now(),revision=revision+1 WHERE tenant_id=$1 AND run_id=$2 AND round=$3 AND status='pending'",
      [run.tenant_id, run.id, run.round],
    );
    await db.query(
      "UPDATE workflow_parallel_executions SET status='cancelled' WHERE tenant_id=$1 AND run_id=$2 AND round=$3 AND status='open'",
      [run.tenant_id, run.id, run.round],
    );
  }

  private async requireReplayRecipient(db: Db, run: Run, task: Task) {
    if (!(await this.assignmentAvailable(db, run.tenant_id, run.org_unit_id, task)))
      throw new HttpError(409, 'WORKFLOW_ASSIGNEE_UNAVAILABLE');
    if (task.kind === 'approval' && !task.approval_policy) {
      const recipient = await this.directory.assignee(
        run.tenant_id,
        run.org_unit_id,
        task.assignee_account_id,
      );
      if (
        task.assignee_account_id === run.owner_account_id ||
        recipient.personId === run.owner_person_id ||
        recipient.personId === run.source_context?.subjectPersonId
      )
        throw new HttpError(403, 'WORKFLOW_SELF_APPROVAL');
    }
  }
  private async authorizeStart(
    db: PoolClient,
    c: WorkflowCommand,
    a: WorkflowActor,
    input: WorkflowStartInput,
    snapshot: WorkflowSource | null,
  ) {
    workflowRequire(a, c.tenantId, 'workflows:start', input.unitId);
    if (snapshot && snapshot.subjectPersonId === a.personId)
      throw new HttpError(403, 'WORKFLOW_SOURCE_SELF_APPROVAL');
    if (!a.units.some((unit) => unit.tenantId === c.tenantId && unit.orgUnitId === input.unitId))
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const d = await this.get<Definition>(
        db,
        'workflow_definitions',
        c.tenantId,
        input.definitionId,
      ),
      v = await this.version(db, c.tenantId, input.versionId);
    if (d.status !== 'published' || v.definition_id !== d.id || v.version !== d.latest_version)
      throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
    if (!v.spec.audienceUnits.includes(input.unitId))
      throw new HttpError(403, 'WORKFLOW_AUDIENCE_DENIED');
    await this.directory.validateUnit(c.tenantId, input.unitId);
    await this.assignment.validatePublish(db, c.tenantId, input.unitId, v.spec);
    await this.assignment.validateSelections(
      db,
      c.tenantId,
      input.unitId,
      v.spec,
      input.selections ?? {},
      a,
    );
  }
  private async createRun(
    db: PoolClient,
    c: WorkflowCommand,
    a: WorkflowActor,
    input: WorkflowStartInput,
    snapshot: WorkflowSource | null,
    draftId?: string,
  ) {
    const v = await this.version(db, c.tenantId, input.versionId),
      answers = await workflowAnswers(
        this.directory,
        a,
        c.tenantId,
        input.unitId,
        v.spec.input,
        input.answers,
        'submit',
      );
    await verifyAttachmentAnswers(
      db,
      c.tenantId,
      a,
      v.spec.input,
      answers,
      draftId ? requestAttachmentLocation(draftId) : undefined,
    );
    const run = (
      await db.query(
        "INSERT INTO workflow_runs(id,tenant_id,definition_id,version_id,org_unit_id,owner_account_id,owner_person_id,title,status,inputs,source_context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10) RETURNING *",
        [
          randomUUID(),
          c.tenantId,
          input.definitionId,
          v.id,
          input.unitId,
          a.accountId,
          a.personId,
          input.title.trim(),
          JSON.stringify(answers),
          snapshot ? JSON.stringify(snapshot) : null,
        ],
      )
    ).rows[0] as Run;
    await db.query(
      'INSERT INTO workflow_run_inputs(tenant_id,run_id,round,inputs) VALUES($1,$2,1,$3)',
      [c.tenantId, run.id, JSON.stringify(answers)],
    );
    const selections = await this.assignment.validateSelections(
      db,
      c.tenantId,
      input.unitId,
      v.spec,
      input.selections ?? {},
      a,
    );
    await db.query(
      'INSERT INTO workflow_run_assignments(tenant_id,run_id,round,choices,group_revisions) VALUES($1,$2,1,$3,$4)',
      [
        c.tenantId,
        run.id,
        JSON.stringify(selections.choices),
        JSON.stringify(selections.groupRevisions),
      ],
    );
    await this.audit(db, c, a, 'run.started', run.org_unit_id, run.definition_id, run.id, {
      versionId: v.id,
      checksum: formHash(answers),
    });
    await this.queue(db, c, a, run, v, v.spec.nodes.find((node) => node.kind === 'start')!.id);
    return this.get<Run>(db, 'workflow_runs', c.tenantId, run.id);
  }
  async start(c: WorkflowCommand, input: WorkflowStartInput, source?: WorkflowSource) {
    const snapshot = source ? parseWorkflowSource(source) : null;
    workflowUuid(input.unitId);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)
      throw new HttpError(400, 'WORKFLOW_TITLE_REQUIRED');
    return this.command(
      c,
      'run.start',
      snapshot ? { input, source: snapshot } : input,
      (db, a) => this.authorizeStart(db, c, a, input, snapshot),
      (db, a) => this.createRun(db, c, a, input, snapshot),
      async (db, a) => {
        await workflowAnswers(
          this.directory,
          a,
          c.tenantId,
          input.unitId,
          (await this.version(db, c.tenantId, input.versionId)).spec.input,
          input.answers,
          'submit',
        );
      },
    );
  }
  private async getLinkRule(db: Db, tenant: string, id: string) {
    const rule = (
      await db.query<WorkflowLinkRule>(
        'SELECT * FROM workflow_link_rules WHERE (tenant_id,id)=($1,$2)',
        [tenant, id],
      )
    ).rows[0];
    if (!rule) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
    return rule;
  }

  async linkRules(c: WorkflowContext) {
    const a = await this.actor(c);
    const units = a.permissions
      .filter((p) => p.tenantId === c.tenantId && p.permission === 'workflows:publish')
      .map((p) => p.orgUnitId);
    if (!units.length) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const items = (
      await this.pool.query(
        `SELECT r.*,s.spec->>'name' AS source_name,s.version AS source_version,
        t.spec->>'name' AS target_name,t.version AS target_version,
        (SELECT node->>'label' FROM jsonb_array_elements(s.spec->'nodes') node
         WHERE node->>'id'=r.source_step_id LIMIT 1) AS source_step_label
       FROM workflow_link_rules r
       JOIN workflow_versions s ON (s.tenant_id,s.definition_id,s.id)=(r.tenant_id,r.source_definition_id,r.source_version_id)
       JOIN workflow_versions t ON (t.tenant_id,t.definition_id,t.id)=(r.tenant_id,r.target_definition_id,r.target_version_id)
       JOIN workflow_definitions sd ON (sd.tenant_id,sd.id)=(r.tenant_id,r.source_definition_id)
       JOIN workflow_definitions td ON (td.tenant_id,td.id)=(r.tenant_id,r.target_definition_id)
       WHERE r.tenant_id=$1 AND ($2 OR (r.org_unit_id=ANY($3::uuid[])
         AND sd.org_unit_id=ANY($3::uuid[]) AND td.org_unit_id=ANY($3::uuid[])))
       ORDER BY r.enabled DESC,r.created_at DESC,r.id DESC LIMIT 200`,
        [c.tenantId, units.includes(null), units.filter((unit) => unit !== null)],
      )
    ).rows;
    return { items };
  }

  async operations(c: WorkflowContext, query: OperationQuery) {
    const actor = await this.actor(c);
    if (!operationKinds.includes(query.kind) || !operationViews.includes(query.view))
      throw new HttpError(400, 'INVALID_REQUEST');
    if (query.after !== undefined) workflowUuid(query.after);
    const scopes = actor.permissions
      .filter(
        ({ tenantId, permission }) => tenantId === c.tenantId && permission === 'workflows:publish',
      )
      .map(({ orgUnitId }) => orgUnitId);
    if (!scopes.length) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    if (query.runId !== undefined) {
      const run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, query.runId);
      await this.mayRead(this.pool, c, actor, run);
    }
    const linkRules = new Map<string, { rule: WorkflowLinkRule; spec: WorkflowSpec }>();
    const visible = async (row: OperationRow) => {
      if (query.kind !== 'link') return true;
      let link = linkRules.get(row.configurationId);
      if (!link) {
        const rule = await this.getLinkRule(this.pool, c.tenantId, row.configurationId);
        link = { rule, spec: (await this.version(this.pool, c.tenantId, row.versionId)).spec };
        linkRules.set(row.configurationId, link);
      }
      return this.canObserveLinkJob(
        this.pool,
        c,
        actor,
        link.rule,
        link.spec,
        row.runId!,
        row.sourceTaskId,
      );
    };
    if (query.after) {
      const [cursor] = await operationRows(this.pool, c.tenantId, scopes, query, query.after, true);
      if (!cursor || !(await visible(cursor))) return { items: [], nextCursor: null };
    }
    const selected: OperationRow[] = [];
    let after = query.after ?? null;
    for (let scanned = 0; selected.length < 51; scanned++) {
      if (scanned === 20) throw new HttpError(503, 'WORKFLOW_OPERATIONS_TOO_MANY');
      const rows = await operationRows(this.pool, c.tenantId, scopes, query, after);
      for (const row of rows) {
        if (await visible(row)) selected.push(row);
        if (selected.length === 51) break;
      }
      if (rows.length < 51) break;
      after = rows.at(-1)!.id;
    }
    const page = selected.slice(0, 50);
    const history = await operationHistory(
      this.pool,
      c.tenantId,
      query.kind,
      page.map(({ id }) => id),
    );
    const runAccess = new Map<string, boolean>();
    const items: OperationItem[] = [];
    for (const row of page) {
      if (row.runId && !runAccess.has(row.runId)) {
        const run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, row.runId);
        runAccess.set(row.runId, await this.canReadRun(actor, c.tenantId, run));
      }
      items.push({
        id: row.id,
        configurationId: row.configurationId,
        unitId: row.unitId,
        workflowName: row.workflowName,
        version: row.version,
        status: row.status,
        attempts: row.attempts,
        errorCode: row.errorCode,
        updatedAt: row.updatedAt.toISOString(),
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
        overdue: row.overdue,
        canRetry: row.status === 'blocked' && row.enabled,
        runId: row.runId && runAccess.get(row.runId) ? row.runId : null,
        history: history.get(row.id) ?? [],
      });
    }
    return { items, nextCursor: selected.length > 50 ? page.at(-1)!.id : null };
  }

  async linkJobs(c: WorkflowContext, ruleId: string, after?: string) {
    const a = await this.actor(c);
    workflowUuid(ruleId);
    if (after) workflowUuid(after);
    const rule = await this.getLinkRule(this.pool, c.tenantId, ruleId);
    await this.linkAuthority(
      this.pool,
      c,
      a,
      rule.org_unit_id,
      rule.source_definition_id,
      rule.target_definition_id,
    );
    const spec = (await this.version(this.pool, c.tenantId, rule.source_version_id)).spec;
    const rows = (
      await this.pool.query(
        `WITH page AS (
         SELECT id,source_run_id,source_task_id,status,attempts,error_code,created_at,next_attempt_at,updated_at
         FROM workflow_link_jobs j WHERE (j.tenant_id,j.rule_id)=($1,$2)
          AND ($3::uuid IS NULL OR (j.created_at,j.id)<(SELECT created_at,id FROM workflow_link_jobs
           WHERE (tenant_id,rule_id,id)=($1,$2,$3)))
         ORDER BY created_at DESC,id DESC LIMIT 51
       )
       SELECT page.*,COALESCE(history.entries,'[]'::jsonb) AS history FROM page
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attempt DESC) AS entries FROM (
           SELECT attempt,status,error_code,recorded_at FROM workflow_link_attempts
           WHERE (tenant_id,job_id)=($1,page.id) ORDER BY attempt DESC LIMIT 10
         ) a
       ) history ON true ORDER BY page.created_at DESC,page.id DESC`,
        [c.tenantId, ruleId, after ?? null],
      )
    ).rows;
    const items = [];
    for (const { source_run_id: runId, source_task_id: taskId, ...item } of rows.slice(0, 50)) {
      if (await this.canObserveLinkJob(this.pool, c, a, rule, spec, runId, taskId))
        items.push(item);
    }
    return { items, nextCursor: rows.length > 50 ? rows[49].id : null };
  }

  private async canObserveLinkJob(
    db: Db,
    c: WorkflowContext,
    actor: WorkflowActor,
    rule: WorkflowLinkRule,
    spec: WorkflowSpec,
    runId: string,
    taskId: string | null,
  ) {
    const protectedFields = linkSourceFields(rule).filter(({ scope, id }) =>
      Object.hasOwn(spec.fieldReaders ?? {}, scope + '.' + id),
    );
    if (!protectedFields.length) return true;
    const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, runId);
    if (!(await this.canReadRun(actor, c.tenantId, run, db))) return false;
    const task = taskId
      ? await this.get<Task>(db, 'workflow_tasks', c.tenantId, taskId)
      : undefined;
    const who = await this.linkFieldAudience(db, c, actor, run, task);
    return protectedFields.every(({ id, scope }) => mayReadField(spec, scope, id, who));
  }

  async retryLinkJob(c: WorkflowCommand, id: string, expectedAttempts: number) {
    workflowUuid(id);
    const getJob = async (db: Db) => {
      const job = (
        await db.query<WorkflowLinkJob>(
          'SELECT * FROM workflow_link_jobs WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id],
        )
      ).rows[0];
      if (!job) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
      return job;
    };
    return this.command(
      c,
      'link.retry',
      { id, expectedAttempts },
      async (db, a) => {
        const job = await getJob(db);
        const rule = await this.getLinkRule(db, c.tenantId, job.rule_id);
        await this.linkAuthority(
          db,
          c,
          a,
          rule.org_unit_id,
          rule.source_definition_id,
          rule.target_definition_id,
        );
        const { spec } = await this.version(db, c.tenantId, rule.source_version_id);
        if (
          !(await this.canObserveLinkJob(
            db,
            c,
            a,
            rule,
            spec,
            job.source_run_id,
            job.source_task_id,
          ))
        )
          throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      },
      async (db, a) => {
        const job = await getJob(db);
        revision(job.attempts, expectedAttempts);
        const rule = await this.getLinkRule(db, c.tenantId, job.rule_id);
        if (!rule.enabled || job.status !== 'blocked')
          throw new HttpError(409, 'WORKFLOW_LINK_RETRY_UNAVAILABLE');
        await db.query(
          `UPDATE workflow_link_jobs SET status='queued',error_code=NULL,next_attempt_at=now(),updated_at=now()
         WHERE (tenant_id,id)=($1,$2)`,
          [c.tenantId, id],
        );
        await this.audit(
          db,
          c,
          a,
          'link.retry_requested',
          rule.org_unit_id,
          rule.source_definition_id,
          null,
          {
            ruleId: rule.id,
            jobId: id,
            attempts: job.attempts,
          },
        );
        return { id, status: 'queued' };
      },
    );
  }

  async relatedRequests(c: WorkflowContext, runId: string) {
    const a = await this.actor(c);
    const run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, runId);
    await this.mayRead(this.pool, c, a, run);
    const rows = (
      await this.pool.query<
        WorkflowRequest & {
          source_step_label: string | null;
          source_attempt: number | null;
          source_round: number;
          source_superseded: boolean;
        }
      >(
        `SELECT q.*,t.label AS source_step_label,t.attempt AS source_attempt,j.source_round,
         (x.task_id IS NOT NULL) AS source_superseded FROM workflow_link_jobs j
       JOIN workflow_requests q ON (q.tenant_id,q.id)=(j.tenant_id,j.target_request_id)
       LEFT JOIN workflow_tasks t ON (t.tenant_id,t.id)=(j.tenant_id,j.source_task_id)
       LEFT JOIN workflow_task_supersessions x ON (x.tenant_id,x.run_id,x.round,x.task_id)=
         (t.tenant_id,t.run_id,t.round,t.id)
       WHERE (j.tenant_id,j.source_run_id)=($1,$2) ORDER BY j.created_at,j.id`,
        [c.tenantId, run.id],
      )
    ).rows;
    const items = [];
    for (const request of rows) {
      const step = request.source_step_label
        ? {
            sourceStep: request.source_step_label,
            sourceAttempt: request.source_attempt,
            sourceRound: request.source_round,
          }
        : {};
      if (request.run_id) {
        const target = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, request.run_id);
        if (await this.canReadRun(a, c.tenantId, target))
          items.push({ title: target.title, status: target.status, runId: target.id, ...step });
      } else if (
        request.owner_account_id === a.accountId &&
        request.owner_person_id === a.personId &&
        workflowAllowed(a, c.tenantId, 'workflows:start', request.org_unit_id) &&
        a.units.some(
          (unit) => unit.tenantId === c.tenantId && unit.orgUnitId === request.org_unit_id,
        )
      )
        items.push({
          title: request.title,
          status:
            request.source_step_label &&
            (request.source_superseded ||
              request.source_round !== run.round ||
              !['running', 'completed'].includes(run.status))
              ? 'inactive_draft'
              : 'draft',
          requestId: request.id,
          ...step,
        });
    }
    return { items };
  }

  private async linkAuthority(
    db: Db,
    c: WorkflowContext,
    a: WorkflowActor,
    unitId: string,
    sourceId: string,
    targetId: string,
  ) {
    workflowRequire(a, c.tenantId, 'workflows:publish', unitId);
    const source = await this.get<Definition>(db, 'workflow_definitions', c.tenantId, sourceId);
    const target = await this.get<Definition>(db, 'workflow_definitions', c.tenantId, targetId);
    workflowRequire(a, c.tenantId, 'workflows:publish', source.org_unit_id);
    workflowRequire(a, c.tenantId, 'workflows:publish', target.org_unit_id);
    return { source, target };
  }

  async createLinkRule(c: WorkflowCommand, input: WorkflowLinkInput) {
    validateLinkInput(input);
    input = {
      ...input,
      sourceDefinitionId: input.sourceDefinitionId.toLowerCase(),
      sourceVersionId: input.sourceVersionId.toLowerCase(),
      targetDefinitionId: input.targetDefinitionId.toLowerCase(),
      targetVersionId: input.targetVersionId.toLowerCase(),
      unitId: input.unitId.toLowerCase(),
      ...(input.recipientAccountId && {
        recipientAccountId: input.recipientAccountId.toLowerCase(),
      }),
    };
    const authorize = async (db: PoolClient, a: WorkflowActor) => {
      await this.linkAuthority(
        db,
        c,
        a,
        input.unitId,
        input.sourceDefinitionId,
        input.targetDefinitionId,
      );
    };
    return this.command(c, 'link.create', input, authorize, async (db, a) => {
      const { source, target } = await this.linkAuthority(
        db,
        c,
        a,
        input.unitId,
        input.sourceDefinitionId,
        input.targetDefinitionId,
      );
      const from = await this.version(db, c.tenantId, input.sourceVersionId);
      const to = await this.version(db, c.tenantId, input.targetVersionId);
      if (
        from.definition_id !== source.id ||
        to.definition_id !== target.id ||
        from.version !== source.latest_version ||
        to.version !== target.latest_version ||
        source.status !== 'published' ||
        target.status !== 'published'
      )
        throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
      if (![from, to].every((version) => version.spec.audienceUnits.includes(input.unitId)))
        throw new HttpError(403, 'WORKFLOW_AUDIENCE_DENIED');
      await this.directory.validateUnit(c.tenantId, input.unitId);
      validateLinkFields(from.spec, to.spec, input);
      const recipient = input.recipientAccountId
        ? await this.linkRecipient(c.tenantId, input.unitId, input.recipientAccountId)
        : null;
      const limits = (
        await db.query<{ cyclic: boolean; count: number }>(
          `WITH RECURSIVE reachable(id) AS (
           VALUES($3::uuid)
           UNION
           SELECT r.target_definition_id FROM workflow_link_rules r
           JOIN reachable p ON r.source_definition_id=p.id
           WHERE r.tenant_id=$1 AND r.org_unit_id=$2 AND r.enabled
         )
         SELECT EXISTS(SELECT 1 FROM reachable WHERE id=$4) AS cyclic,
          (SELECT count(*)::int FROM workflow_link_rules
           WHERE tenant_id=$1 AND org_unit_id=$2 AND source_version_id=$5 AND enabled) AS count`,
          [c.tenantId, input.unitId, target.id, source.id, from.id],
        )
      ).rows[0]!;
      if (limits.cyclic) throw new HttpError(409, 'WORKFLOW_LINK_CYCLE');
      if (limits.count >= 12) throw new HttpError(409, 'WORKFLOW_LINK_LIMIT');
      const row = (
        await db.query<WorkflowLinkRule>(
          `INSERT INTO workflow_link_rules(id,tenant_id,org_unit_id,source_definition_id,source_version_id,
           target_definition_id,target_version_id,name,mapping,predicate,recipient_account_id,recipient_person_id,created_by,
           source_step_id,recipient_is_step_actor)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [
            randomUUID(),
            c.tenantId,
            input.unitId,
            source.id,
            from.id,
            target.id,
            to.id,
            input.name.trim(),
            JSON.stringify(input.mapping),
            input.predicate ? JSON.stringify(input.predicate) : null,
            recipient?.accountId ?? null,
            recipient?.personId ?? null,
            a.accountId,
            input.sourceStepId ?? null,
            input.recipientIsStepActor ?? false,
          ],
        )
      ).rows[0]!;
      await this.audit(db, c, a, 'link.enabled', row.org_unit_id, source.id, null, {
        ruleId: row.id,
      });
      return row;
    });
  }

  async disableLinkRule(c: WorkflowCommand, id: string, expectedRevision: number) {
    workflowUuid(id);
    const rule = async (db: Db) => {
      const row = (
        await db.query<WorkflowLinkRule>(
          'SELECT * FROM workflow_link_rules WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
      return row;
    };
    return this.command(
      c,
      'link.disable',
      { id, expectedRevision },
      async (db, a) => {
        const row = await rule(db);
        await this.linkAuthority(
          db,
          c,
          a,
          row.org_unit_id,
          row.source_definition_id,
          row.target_definition_id,
        );
      },
      async (db, a) => {
        const row = await rule(db);
        revision(row.revision, expectedRevision);
        if (!row.enabled) throw new HttpError(409, 'WORKFLOW_LINK_DISABLED');
        const next = (
          await db.query<WorkflowLinkRule>(
            'UPDATE workflow_link_rules SET enabled=false,revision=revision+1 WHERE (tenant_id,id)=($1,$2) RETURNING *',
            [c.tenantId, id],
          )
        ).rows[0]!;
        await this.audit(
          db,
          c,
          a,
          'link.disabled',
          row.org_unit_id,
          row.source_definition_id,
          null,
          { ruleId: id },
        );
        return next;
      },
    );
  }

  private async linkRecipient(
    tenant: string,
    unit: string,
    accountId: string,
    personId?: string,
    unavailable = 'WORKFLOW_LINK_RECIPIENT_UNAVAILABLE',
  ) {
    if (!this.directory.linkRecipient) throw new HttpError(503, 'WORKFLOW_DIRECTORY_UNAVAILABLE');
    const actor = await this.directory.linkRecipient(tenant, accountId);
    if (
      !actor ||
      actor.accountId !== accountId.toLowerCase() ||
      (personId && actor.personId !== personId) ||
      !workflowAllowed(actor, tenant, 'workflows:start', unit) ||
      !actor.units.some((own) => own.tenantId === tenant && own.orgUnitId === unit)
    )
      throw new HttpError(403, unavailable);
    return actor;
  }

  private async effectiveLinkStep(db: Db, run: Run, job: WorkflowLinkJob, rule: WorkflowLinkRule) {
    const step = (
      await db.query<
        Task & { answers: Answers; actor_account_id: string; actor_person_id: string }
      >(
        `SELECT t.*,result.answers,result.actor_account_id,result.actor_person_id
       FROM workflow_tasks t JOIN workflow_task_results result ON (result.tenant_id,result.task_id)=(t.tenant_id,t.id)
       JOIN workflow_runs r ON (r.tenant_id,r.id,r.round)=(t.tenant_id,t.run_id,t.round)
       WHERE (t.tenant_id,t.run_id,t.round,t.id,t.node_id)=($1,$2,$3,$4,$5)
         AND t.status='completed' AND result.action IN('approve','complete')
         AND r.status IN('running','completed')
         AND NOT EXISTS(SELECT 1 FROM workflow_task_supersessions s
           WHERE (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id))`,
        [run.tenant_id, run.id, job.source_round, job.source_task_id, rule.source_step_id],
      )
    ).rows[0];
    if (!step) throw new HttpError(409, 'WORKFLOW_LINK_STEP_INACTIVE');
    return step;
  }

  private async linkFieldAudience(
    db: Db,
    c: WorkflowContext,
    actor: WorkflowActor,
    run: Run,
    step?: Task,
  ) {
    const audience = await this.fieldAudience(db, c, actor, run);
    // Participation in another attempt of the same step cannot grant this attempt's fields.
    if (
      step &&
      audience.steps.has(step.node_id) &&
      !(await this.assignment.eligible(db, c.tenantId, run.org_unit_id, step, actor.accountId))
    )
      audience.steps.delete(step.node_id);
    return audience;
  }

  private async stepLinkJob(db: Db, tenant: string, id: string) {
    return (
      await db.query<WorkflowLinkJob>(
        'SELECT * FROM workflow_link_jobs WHERE (tenant_id,target_request_id)=($1,$2) AND source_task_id IS NOT NULL',
        [tenant, id],
      )
    ).rows[0];
  }

  private async validateStepLinkSource(
    db: Db,
    c: WorkflowContext,
    actor: WorkflowActor,
    job: WorkflowLinkJob,
  ) {
    const rule = await this.getLinkRule(db, c.tenantId, job.rule_id);
    const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, job.source_run_id);
    if (!(await this.canReadRun(actor, c.tenantId, run, db)))
      throw new HttpError(403, 'WORKFLOW_LINK_SOURCE_DENIED');
    const step = await this.effectiveLinkStep(db, run, job, rule);
    const { spec } = await this.version(db, c.tenantId, run.version_id);
    requireLinkFields(rule, spec, await this.linkFieldAudience(db, c, actor, run, step));
  }

  private async requireStepLinkedDraft(
    db: Db,
    c: WorkflowContext,
    actor: WorkflowActor,
    id: string,
  ) {
    const job = await this.stepLinkJob(db, c.tenantId, id);
    if (job) await this.validateStepLinkSource(db, c, actor, job);
  }

  private async createLinkedDraft(db: PoolClient, job: WorkflowLinkJob) {
    const rule = (
      await db.query<WorkflowLinkRule>(
        'SELECT * FROM workflow_link_rules WHERE (tenant_id,id)=($1,$2)',
        [job.tenant_id, job.rule_id],
      )
    ).rows[0]!;
    const run = await this.get<Run>(db, 'workflow_runs', job.tenant_id, job.source_run_id);
    if (!rule.enabled) throw new HttpError(409, 'WORKFLOW_LINK_DISABLED');
    if (
      (!rule.source_step_id && run.status !== 'completed') ||
      Boolean(rule.source_step_id) !== Boolean(job.source_task_id) ||
      run.round !== job.source_round ||
      run.org_unit_id !== rule.org_unit_id ||
      run.definition_id !== rule.source_definition_id ||
      run.version_id !== rule.source_version_id
    )
      throw new HttpError(409, 'WORKFLOW_LINK_SOURCE_CHANGED');
    const step = rule.source_step_id ? await this.effectiveLinkStep(db, run, job, rule) : undefined;
    const depth = (
      await db.query<{ depth: number }>(
        `WITH RECURSIVE chain(id,depth) AS (
         VALUES($2::uuid,0)
         UNION ALL
         SELECT j.source_run_id,c.depth+1 FROM chain c
         JOIN workflow_requests q ON q.tenant_id=$1 AND q.run_id=c.id
         JOIN workflow_link_jobs j ON (j.tenant_id,j.target_request_id)=(q.tenant_id,q.id)
         WHERE c.depth<4
       )
       SELECT max(depth)::int AS depth FROM chain`,
        [job.tenant_id, run.id],
      )
    ).rows[0]!.depth;
    if (depth >= 4) throw new HttpError(409, 'WORKFLOW_LINK_DEPTH');
    const source = await this.version(db, job.tenant_id, rule.source_version_id);
    const target = await this.version(db, job.tenant_id, rule.target_version_id);
    const definition = await this.get<Definition>(
      db,
      'workflow_definitions',
      job.tenant_id,
      rule.target_definition_id,
    );
    if (definition.status !== 'published' || definition.latest_version !== target.version)
      throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
    if (!target.spec.audienceUnits.includes(run.org_unit_id))
      throw new HttpError(403, 'WORKFLOW_AUDIENCE_DENIED');
    const c: WorkflowCommand = {
      tenantId: job.tenant_id,
      actor: () =>
        this.linkRecipient(
          job.tenant_id,
          run.org_unit_id,
          rule.recipient_is_step_actor
            ? step!.actor_account_id
            : (rule.recipient_account_id ?? run.owner_account_id),
          rule.recipient_is_step_actor
            ? step!.actor_person_id
            : (rule.recipient_person_id ?? run.owner_person_id),
        ),
      requestId: job.id,
      idempotencyKey: job.id,
      reason: 'Tự động tạo bản nháp từ quy trình liên kết',
    };
    const resolve = async () => {
      const actor = await c.actor();
      await this.directory.validateUnit(c.tenantId, run.org_unit_id);
      await this.mayRead(db, c, actor, run);
      const mapped = linkedAnswers(
        rule,
        source.spec,
        run.inputs,
        await this.linkFieldAudience(db, c, actor, run, step),
        step?.answers,
      );
      const answers =
        mapped &&
        (await workflowAnswers(
          this.directory,
          actor,
          c.tenantId,
          run.org_unit_id,
          target.spec.input,
          mapped,
          'draft',
        ));
      return { actor, answers };
    };
    const { actor, answers } = await resolve();
    if (!answers) return null;
    const draft = await this.insertRequestDraft(
      db,
      c,
      actor,
      {
        definitionId: definition.id,
        versionId: target.id,
        unitId: run.org_unit_id,
        title: (rule.name + ' · ' + run.title).slice(0, 200),
        answers,
      },
      answers,
      {},
    );
    await this.requestHistory(db, c, actor, draft, { jobId: job.id, ruleId: rule.id });
    const current = await resolve();
    if (!current.answers || formHash(current.answers) !== formHash(answers))
      throw new HttpError(409, 'WORKFLOW_LINK_SOURCE_CHANGED');
    return draft.id;
  }

  async processLinkedDrafts() {
    return processDraftJobs<WorkflowLinkJob>(this.pool, 'link', (db, job) =>
      this.createLinkedDraft(db, job),
    );
  }

  private async scheduleAuthority(
    db: Db,
    c: WorkflowContext,
    actor: WorkflowActor,
    unitId: string,
    definitionId: string,
  ) {
    workflowRequire(actor, c.tenantId, 'workflows:publish', unitId);
    const definition = await this.get<Definition>(
      db,
      'workflow_definitions',
      c.tenantId,
      definitionId,
    );
    workflowRequire(actor, c.tenantId, 'workflows:publish', definition.org_unit_id);
    return definition;
  }

  async draftScheduleRecipients(
    c: WorkflowContext,
    definitionId: string,
    unitId: string,
    search: string,
  ) {
    const actor = await this.actor(c);
    workflowUuid(unitId);
    await this.scheduleAuthority(this.pool, c, actor, unitId, definitionId);
    await this.directory.validateUnit(c.tenantId, unitId);
    if (!this.directory.draftRecipients) throw new HttpError(503, 'WORKFLOW_DIRECTORY_UNAVAILABLE');
    const items = await this.directory.draftRecipients(c.tenantId, unitId, search.trim());
    return { items: items.map(({ accountId, name }) => ({ id: accountId, name })) };
  }

  private async getIntakeRule(db: Db, tenant: string, id: string) {
    workflowUuid(id);
    const row = (
      await db.query<IntakeRule>(
        'SELECT * FROM workflow_intake_rules WHERE (tenant_id,id)=($1,$2)',
        [tenant, id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
    return row;
  }

  async intakeRecipients(
    c: WorkflowContext,
    kind: IntakeKind,
    definitionId: string,
    unitId: string,
    search: string,
  ) {
    await this.scheduleAuthority(this.pool, c, await this.actor(c), unitId, definitionId);
    await this.directory.validateUnit(c.tenantId, unitId);
    if (!this.intake) throw new HttpError(503, 'WORKFLOW_INTAKE_UNAVAILABLE');
    return { items: await this.intake.recipients(kind, c.tenantId, unitId, search.trim()) };
  }

  async intakeRules(c: WorkflowContext) {
    const actor = await this.actor(c);
    const units = actor.permissions
      .filter((p) => p.tenantId === c.tenantId && p.permission === 'workflows:publish')
      .map((p) => p.orgUnitId);
    if (!units.length) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const rows = (
      await this.pool.query(
        `SELECT r.*,v.version AS workflow_version,v.spec->>'name' AS workflow_name
       FROM workflow_intake_rules r JOIN workflow_definitions d ON (r.tenant_id,r.definition_id)=(d.tenant_id,d.id)
       JOIN workflow_versions v ON (r.tenant_id,r.definition_id,r.version_id)=(v.tenant_id,v.definition_id,v.id)
       WHERE r.tenant_id=$1 AND ($2 OR (r.org_unit_id=ANY($3::uuid[]) AND d.org_unit_id=ANY($3::uuid[])))
       ORDER BY r.enabled DESC,r.created_at DESC,r.id LIMIT 200`,
        [c.tenantId, units.includes(null), units.filter((unit) => unit !== null)],
      )
    ).rows;
    return { items: rows };
  }

  private async intakeRecipient(kind: IntakeKind, tenant: string, unit: string, account: string) {
    if (!this.intake || !this.directory.linkRecipient)
      throw new HttpError(503, 'WORKFLOW_INTAKE_UNAVAILABLE');
    await this.directory.validateUnit(tenant, unit);
    const actor = await this.directory.linkRecipient(tenant, account);
    if (!actor) throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
    await this.intake.assertRecipient(kind, tenant, unit, account, actor.personId);
    return actor;
  }

  async createIntakeRule(c: WorkflowCommand, input: IntakeRuleInput) {
    workflowUuid(input.unitId);
    workflowUuid(input.recipientAccountId);
    const resolve = () =>
      this.intakeRecipient(input.kind, c.tenantId, input.unitId, input.recipientAccountId);
    let personId: string;
    return this.command(
      c,
      'intake.create',
      input,
      async (db, actor) => {
        await this.scheduleAuthority(db, c, actor, input.unitId, input.definitionId);
      },
      async (db, actor) => {
        const definition = await this.get<Definition>(
          db,
          'workflow_definitions',
          c.tenantId,
          input.definitionId,
        );
        const version = await this.version(db, c.tenantId, input.versionId);
        if (
          definition.status !== 'published' ||
          version.definition_id !== definition.id ||
          version.version !== definition.latest_version
        )
          throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
        if (!version.spec.audienceUnits.includes(input.unitId))
          throw new HttpError(403, 'WORKFLOW_AUDIENCE_DENIED');
        validateIntakeMapping(input, version.spec.input);
        personId = (await resolve()).personId;
        const rule = (
          await db.query<IntakeRule>(
            `INSERT INTO workflow_intake_rules(tenant_id,definition_id,version_id,org_unit_id,kind,
             recipient_account_id,recipient_person_id,mapping,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              c.tenantId,
              definition.id,
              version.id,
              input.unitId,
              input.kind,
              input.recipientAccountId,
              personId,
              JSON.stringify(input.mapping),
              actor.accountId,
            ],
          )
        ).rows[0]!;
        await this.audit(db, c, actor, 'intake.created', input.unitId, definition.id, null, {
          ruleId: rule.id,
          kind: rule.kind,
        });
        return rule;
      },
      async () => {
        if ((await resolve()).personId !== personId)
          throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
      },
    );
  }

  async disableIntakeRule(c: WorkflowCommand, id: string, expectedRevision: number) {
    return this.command(
      c,
      'intake.disable',
      { id, expectedRevision },
      async (db, actor) => {
        const rule = await this.getIntakeRule(db, c.tenantId, id);
        await this.scheduleAuthority(db, c, actor, rule.org_unit_id, rule.definition_id);
      },
      async (db, actor) => {
        const rule = await this.getIntakeRule(db, c.tenantId, id);
        revision(rule.revision, expectedRevision);
        if (!rule.enabled) throw new HttpError(409, 'WORKFLOW_INTAKE_DISABLED');
        await db.query(
          'UPDATE workflow_intake_rules SET enabled=false,revision=revision+1 WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id],
        );
        await this.audit(
          db,
          c,
          actor,
          'intake.disabled',
          rule.org_unit_id,
          rule.definition_id,
          null,
          { ruleId: id },
        );
        return { id, enabled: false, revision: expectedRevision + 1 };
      },
    );
  }

  async intakeJobs(c: WorkflowContext, id: string) {
    const actor = await this.actor(c);
    const rule = await this.getIntakeRule(this.pool, c.tenantId, id);
    await this.scheduleAuthority(this.pool, c, actor, rule.org_unit_id, rule.definition_id);
    const rows = (
      await this.pool.query(
        `SELECT j.id,j.status,j.attempts,j.error_code,j.created_at,COALESCE(h.entries,'[]'::jsonb) AS history
       FROM workflow_intake_jobs j LEFT JOIN LATERAL (
         SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attempt DESC) AS entries FROM (
           SELECT attempt,status,error_code,recorded_at FROM workflow_intake_attempts
           WHERE (tenant_id,job_id)=(j.tenant_id,j.id) ORDER BY attempt DESC LIMIT 10
         ) a
       ) h ON true WHERE (j.tenant_id,j.rule_id)=($1,$2) ORDER BY j.created_at DESC,j.id DESC LIMIT 50`,
        [c.tenantId, id],
      )
    ).rows;
    return { items: rows };
  }

  async retryIntakeJob(c: WorkflowCommand, id: string, expectedAttempts: number) {
    workflowUuid(id);
    const load = async (db: Db) => {
      const job = (
        await db.query<IntakeJob>(
          'SELECT * FROM workflow_intake_jobs WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id],
        )
      ).rows[0];
      if (!job) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
      return { job, rule: await this.getIntakeRule(db, c.tenantId, job.rule_id) };
    };
    return this.command(
      c,
      'intake.retry',
      { id, expectedAttempts },
      async (db, actor) => {
        const { rule } = await load(db);
        await this.scheduleAuthority(db, c, actor, rule.org_unit_id, rule.definition_id);
      },
      async (db, actor) => {
        const { job, rule } = await load(db);
        revision(job.attempts, expectedAttempts);
        if (job.status !== 'blocked' || !rule.enabled)
          throw new HttpError(409, 'WORKFLOW_INTAKE_RETRY_UNAVAILABLE');
        await db.query(
          "UPDATE workflow_intake_jobs SET status='queued',error_code=NULL,next_attempt_at=now(),updated_at=now() WHERE (tenant_id,id)=($1,$2)",
          [c.tenantId, id],
        );
        await this.audit(
          db,
          c,
          actor,
          'intake.retry_requested',
          rule.org_unit_id,
          rule.definition_id,
          null,
          { ruleId: rule.id, jobId: id },
        );
        return { id, status: 'queued' };
      },
    );
  }

  private async intakeProjection(
    db: Db,
    job: IntakeJob,
    rule: IntakeRule,
    actor: WorkflowActor,
  ): Promise<IntakeProjection> {
    const tenantId = job.tenant_id;
    if (
      actor.accountId !== rule.recipient_account_id ||
      actor.personId !== rule.recipient_person_id
    )
      throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
    const run = await this.get<Run>(db, 'workflow_runs', tenantId, job.source_run_id);
    if (
      run.status !== 'completed' ||
      run.round !== job.source_round ||
      run.source_context ||
      run.version_id !== rule.version_id ||
      run.org_unit_id !== rule.org_unit_id ||
      run.definition_id !== rule.definition_id
    )
      throw new HttpError(409, 'WORKFLOW_INTAKE_SOURCE_STALE');
    const data = await this.outputSource(
      db,
      { tenantId, actor: async () => actor },
      run,
      job.source_round,
    );
    return {
      id: job.id,
      kind: rule.kind,
      tenantId,
      unitId: run.org_unit_id,
      runId: run.id,
      versionId: run.version_id,
      round: run.round,
      accountId: actor.accountId,
      personId: actor.personId,
      title: run.title,
      values: projectIntakeValues(rule.mapping, data.version.spec.input, data.run.inputs),
    };
  }

  async moduleIntakeDraft(
    tenantId: string,
    id: string,
    accountId: string,
    personId: string,
    kind: IntakeKind,
  ) {
    workflowUuid(tenantId);
    workflowUuid(id);
    const job = (
      await this.pool.query<IntakeJob>(
        "SELECT * FROM workflow_intake_jobs WHERE (tenant_id,id)=($1,$2) AND status='done'",
        [tenantId, id],
      )
    ).rows[0];
    if (!job) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
    const rule = await this.getIntakeRule(this.pool, tenantId, job.rule_id);
    if (
      kind !== rule.kind ||
      accountId !== rule.recipient_account_id ||
      personId !== rule.recipient_person_id
    )
      throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
    const actor = await this.directory.linkRecipient?.(tenantId, accountId);
    if (!actor) throw new HttpError(403, 'WORKFLOW_INTAKE_RECIPIENT_DENIED');
    return this.intakeProjection(this.pool, job, rule, actor);
  }

  async processModuleIntakes() {
    const destination = this.intake;
    if (!destination) return 0;
    return processDraftJobs<IntakeJob>(this.pool, 'intake', async (db, job) => {
      const rule = await this.getIntakeRule(db, job.tenant_id, job.rule_id);
      if (!rule.enabled) throw new HttpError(409, 'WORKFLOW_INTAKE_DISABLED');
      const actor = await this.intakeRecipient(
        rule.kind,
        job.tenant_id,
        rule.org_unit_id,
        rule.recipient_account_id,
      );
      const {
        title: _,
        values: __,
        ...reference
      } = await this.intakeProjection(db, job, rule, actor);
      await destination.receive(reference);
      return reference.id;
    });
  }

  async trainingIntakeStatus(c: WorkflowContext, runId: string) {
    const actor = await this.actor(c);
    const run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, runId);
    await this.mayRead(this.pool, c, actor, run);
    if (run.status !== 'completed') return { state: null };
    const job = (
      await this.pool.query<
        IntakeJob & Pick<IntakeRule, 'recipient_account_id' | 'recipient_person_id'>
      >(
        `SELECT j.*,r.recipient_account_id,r.recipient_person_id FROM workflow_intake_jobs j
       JOIN workflow_intake_rules r ON (r.tenant_id,r.id)=(j.tenant_id,j.rule_id)
       WHERE (j.tenant_id,j.source_run_id,j.source_round)=($1,$2,$3) AND r.kind='lms-training'
         AND (r.definition_id,r.version_id,r.org_unit_id)=($4,$5,$6)
       ORDER BY j.created_at DESC,j.id LIMIT 1`,
        [c.tenantId, run.id, run.round, run.definition_id, run.version_id, run.org_unit_id],
      )
    ).rows[0];
    if (!job) return { state: null };
    if (job.status !== 'done') return { state: job.status };
    if (!this.intake?.trainingStatus) return { state: 'unavailable' as const };
    try {
      return {
        state: await this.intake.trainingStatus({
          id: job.id,
          kind: 'lms-training',
          tenantId: c.tenantId,
          unitId: run.org_unit_id,
          runId: run.id,
          versionId: run.version_id,
          round: run.round,
          accountId: job.recipient_account_id,
          personId: job.recipient_person_id,
        }),
      };
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode < 500) throw error;
      return { state: 'unavailable' as const };
    }
  }

  private async getDraftSchedule(db: Db, tenant: string, id: string) {
    workflowUuid(id);
    const schedule = (
      await db.query<WorkflowDraftSchedule>(
        `SELECT *,start_date::text AS start_date,end_date::text AS end_date
       FROM workflow_draft_schedules WHERE (tenant_id,id)=($1,$2)`,
        [tenant, id],
      )
    ).rows[0];
    if (!schedule) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
    return schedule;
  }

  async draftSchedules(c: WorkflowContext, after?: string) {
    const actor = await this.actor(c);
    if (after) workflowUuid(after);
    const units = actor.permissions
      .filter((p) => p.tenantId === c.tenantId && p.permission === 'workflows:publish')
      .map((p) => p.orgUnitId);
    if (!units.length) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const rows = (
      await this.pool.query(
        `SELECT s.id,s.title,s.org_unit_id,s.definition_id,s.version_id,s.recipient_account_id,
        s.cadence,s.every,s.start_date::text,s.end_date::text,s.local_time,s.time_zone,s.next_run_at,s.enabled,s.revision,
        v.spec->>'name' AS workflow_name,v.version
       FROM workflow_draft_schedules s
       JOIN workflow_versions v ON (v.tenant_id,v.definition_id,v.id)=(s.tenant_id,s.definition_id,s.version_id)
       JOIN workflow_definitions d ON (d.tenant_id,d.id)=(s.tenant_id,s.definition_id)
       WHERE s.tenant_id=$1 AND ($2 OR (s.org_unit_id=ANY($3::uuid[]) AND d.org_unit_id=ANY($3::uuid[])))
         AND ($4::uuid IS NULL OR (s.created_at,s.id)<(
           SELECT p.created_at,p.id FROM workflow_draft_schedules p
           JOIN workflow_definitions pd ON (pd.tenant_id,pd.id)=(p.tenant_id,p.definition_id)
           WHERE (p.tenant_id,p.id)=($1,$4) AND ($2 OR (p.org_unit_id=ANY($3::uuid[]) AND pd.org_unit_id=ANY($3::uuid[])))
         ))
       ORDER BY s.created_at DESC,s.id DESC LIMIT 51`,
        [c.tenantId, units.includes(null), units.filter((id) => id !== null), after ?? null],
      )
    ).rows;
    return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null };
  }

  async getOutputTemplate(db: Db, tenant: string, id: string) {
    workflowUuid(id);
    const row = (
      await db.query<OutputTemplate>(
        'SELECT * FROM workflow_output_templates WHERE (tenant_id,id)=($1,$2)',
        [tenant, id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
    return row;
  }

  async outputTemplates(c: WorkflowContext) {
    const actor = await this.actor(c);
    const units = actor.permissions
      .filter((p) => p.tenantId === c.tenantId && p.permission === 'workflows:publish')
      .map((p) => p.orgUnitId);
    if (!units.length) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const rows = (
      await this.pool.query(
        `SELECT t.*,v.version AS workflow_version,v.spec->>'name' AS workflow_name
       FROM workflow_output_templates t JOIN workflow_definitions d ON (d.tenant_id,d.id)=(t.tenant_id,t.definition_id)
       JOIN workflow_versions v ON (v.tenant_id,v.definition_id,v.id)=(t.tenant_id,t.definition_id,t.version_id)
       WHERE t.tenant_id=$1 AND ($2 OR (t.org_unit_id=ANY($3::uuid[]) AND d.org_unit_id=ANY($3::uuid[])))
       ORDER BY t.enabled DESC,t.created_at DESC,t.id LIMIT 200`,
        [c.tenantId, units.includes(null), units.filter((unit) => unit !== null)],
      )
    ).rows;
    return { items: rows };
  }

  async createOutputTemplate(c: WorkflowCommand, input: OutputTemplateInput) {
    workflowUuid(input.unitId);
    return this.command(
      c,
      'output.create',
      input,
      async (db, actor) => {
        await this.scheduleAuthority(db, c, actor, input.unitId, input.definitionId);
      },
      async (db, actor) => {
        const definition = await this.get<Definition>(
          db,
          'workflow_definitions',
          c.tenantId,
          input.definitionId,
        );
        const version = await this.version(db, c.tenantId, input.versionId);
        if (
          definition.status !== 'published' ||
          version.definition_id !== definition.id ||
          version.version !== definition.latest_version
        )
          throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
        if (!version.spec.audienceUnits.includes(input.unitId))
          throw new HttpError(403, 'WORKFLOW_AUDIENCE_DENIED');
        validateOutputTemplate(input, version.spec);
        const row = (
          await db.query<OutputTemplate>(
            `INSERT INTO workflow_output_templates(tenant_id,definition_id,version_id,org_unit_id,kind,name,heading,body,fields,event_kind,step_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [
              c.tenantId,
              definition.id,
              version.id,
              input.unitId,
              input.kind,
              input.name.trim(),
              input.heading.trim(),
              input.body,
              JSON.stringify(input.fields),
              input.event ?? null,
              input.stepId ?? null,
              actor.accountId,
            ],
          )
        ).rows[0]!;
        await this.audit(db, c, actor, 'output.created', input.unitId, definition.id, null, {
          templateId: row.id,
          kind: row.kind,
        });
        return row;
      },
    );
  }

  async disableOutputTemplate(c: WorkflowCommand, id: string, expectedRevision: number) {
    return this.command(
      c,
      'output.disable',
      { id, expectedRevision },
      async (db, actor) => {
        const row = await this.getOutputTemplate(db, c.tenantId, id);
        await this.scheduleAuthority(db, c, actor, row.org_unit_id, row.definition_id);
      },
      async (db, actor) => {
        const row = await this.getOutputTemplate(db, c.tenantId, id);
        revision(row.revision, expectedRevision);
        if (!row.enabled) throw new HttpError(409, 'WORKFLOW_OUTPUT_DISABLED');
        await db.query(
          'UPDATE workflow_output_templates SET enabled=false,revision=revision+1 WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id],
        );
        await this.audit(
          db,
          c,
          actor,
          'output.disabled',
          row.org_unit_id,
          row.definition_id,
          null,
          { templateId: id },
        );
        return { id, enabled: false, revision: row.revision + 1 };
      },
    );
  }

  async outputJobs(c: WorkflowContext, templateId: string) {
    const actor = await this.actor(c);
    const row = await this.getOutputTemplate(this.pool, c.tenantId, templateId);
    await this.scheduleAuthority(this.pool, c, actor, row.org_unit_id, row.definition_id);
    const jobs = (
      await this.pool.query(
        `SELECT j.id,j.status,j.attempts,j.error_code,j.created_at,j.updated_at,
        COALESCE(h.entries,'[]'::jsonb) AS history FROM workflow_email_jobs j
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attempt DESC) AS entries FROM (
           SELECT attempt,status,error_code,recorded_at FROM workflow_email_attempts
           WHERE (tenant_id,job_id)=(j.tenant_id,j.id) ORDER BY attempt DESC LIMIT 10
          ) a
        ) h ON true WHERE (j.tenant_id,j.template_id)=($1,$2)
        ORDER BY j.created_at DESC,j.id DESC LIMIT 50`,
        [c.tenantId, templateId],
      )
    ).rows;
    return { items: jobs };
  }

  async retryOutputJob(c: WorkflowCommand, id: string, expectedAttempts: number) {
    workflowUuid(id);
    const load = async (db: Db) => {
      const job = (
        await db.query<OutputJob>(
          'SELECT * FROM workflow_email_jobs WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id],
        )
      ).rows[0];
      if (!job) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
      return { job, template: await this.getOutputTemplate(db, c.tenantId, job.template_id) };
    };
    return this.command(
      c,
      'output.retry',
      { id, expectedAttempts },
      async (db, actor) => {
        const { template } = await load(db);
        await this.scheduleAuthority(db, c, actor, template.org_unit_id, template.definition_id);
      },
      async (db, actor) => {
        const { job, template } = await load(db);
        revision(job.attempts, expectedAttempts);
        if (!template.enabled || job.status !== 'blocked')
          throw new HttpError(409, 'WORKFLOW_OUTPUT_RETRY_UNAVAILABLE');
        await db.query(
          "UPDATE workflow_email_jobs SET status='queued',error_code=NULL,next_attempt_at=now(),updated_at=now() WHERE (tenant_id,id)=($1,$2)",
          [c.tenantId, id],
        );
        await this.audit(
          db,
          c,
          actor,
          'output.retry_requested',
          template.org_unit_id,
          template.definition_id,
          null,
          { templateId: template.id, jobId: id },
        );
        return { id, status: 'queued' };
      },
    );
  }

  async printTemplates(c: WorkflowContext, id: string) {
    const actor = await this.actor(c);
    const run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, id);
    await this.mayRead(this.pool, c, actor, run);
    const rows = (
      await this.pool.query(
        `SELECT id,name FROM workflow_output_templates WHERE (tenant_id,definition_id,version_id,org_unit_id)=($1,$2,$3,$4)
       AND kind='print' AND enabled ORDER BY name,id`,
        [c.tenantId, run.definition_id, run.version_id, run.org_unit_id],
      )
    ).rows;
    return { items: rows };
  }

  async printRun(c: WorkflowContext, id: string, templateId: string) {
    const run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, id);
    const detail = await this.outputSource(this.pool, c, run, run.round);
    const template = await this.getOutputTemplate(this.pool, c.tenantId, templateId);
    if (
      template.kind !== 'print' ||
      !template.enabled ||
      template.version_id !== detail.version.id ||
      template.definition_id !== detail.run.definition_id ||
      template.org_unit_id !== detail.run.org_unit_id
    )
      throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
    return printOutputHtml(renderOutput(template, detail));
  }

  async outputSource(db: Db, c: WorkflowContext, run: Run, round: number, taskId?: string) {
    const actor = await this.actor(c);
    const version = await this.version(db, c.tenantId, run.version_id);
    const whole = await this.canReadRun(actor, c.tenantId, run, db);
    const scoped =
      !whole && taskId && (await relatedSteps(db, actor, run)).some((step) => step.id === taskId);
    if (!whole && !scoped) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const rows = (
      await db.query<
        Task & {
          answers: Answers | null;
          decided_at: Date | null;
          superseded_by_task_id: string | null;
        }
      >(
        `SELECT t.*,a.answers,a.created_at AS decided_at,s.task_id AS superseded_by_task_id
       FROM workflow_tasks t LEFT JOIN workflow_task_results a ON (a.tenant_id,a.task_id)=(t.tenant_id,t.id)
       LEFT JOIN workflow_task_supersessions s ON (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id)
       WHERE (t.tenant_id,t.run_id,t.round)=($1,$2,$3) AND ($4::uuid IS NULL OR t.id=$4)`,
        [c.tenantId, run.id, round, scoped ? taskId : null],
      )
    ).rows;
    const eventTask = taskId ? rows.find((task) => task.id === taskId) : undefined;
    const audienceTasks = rows.filter(
      (task) =>
        !task.superseded_by_task_id &&
        task.status !== 'cancelled' &&
        (task.node_id !== eventTask?.node_id || task.id === eventTask.id),
    );
    const who = await this.fieldAudience(db, c, actor, run, audienceTasks);
    const spec = visibleSpec(version.spec, who);
    const input =
      (
        await db.query<{ inputs: Answers }>(
          'SELECT inputs FROM workflow_run_inputs WHERE (tenant_id,run_id,round)=($1,$2,$3)',
          [c.tenantId, run.id, round],
        )
      ).rows[0]?.inputs ?? (round === run.round ? run.inputs : {});
    const node = scoped ? spec.nodes.find((item) => item.id === rows[0]?.node_id) : undefined;
    const readableInput = visibleAnswers(version.spec, 'input', input, who);
    const allowed = node && 'form' in node ? (node.inputFields ?? {}) : {};
    if (scoped) {
      spec.nodes = node ? [node] : [];
      spec.input = {
        ...spec.input,
        sections: spec.input.sections.map((section) => ({
          ...section,
          fields: section.fields.filter((field) => Object.hasOwn(allowed, field.id)),
        })),
      };
    }
    return {
      run: {
        ...run,
        inputs: scoped
          ? Object.fromEntries(
              Object.entries(readableInput).filter(([id]) => Object.hasOwn(allowed, id)),
            )
          : readableInput,
      },
      version: { ...version, spec },
      tasks: rows.map((task) => ({
        ...task,
        answers: task.answers && visibleAnswers(version.spec, task.node_id, task.answers, who),
      })),
      inputs: [],
    };
  }

  async createDraftSchedule(c: WorkflowCommand, input: WorkflowScheduleInput) {
    const schedule = parseSchedule(input);
    return this.command(
      c,
      'schedule.create',
      schedule,
      async (db, a) => {
        await this.scheduleAuthority(db, c, a, schedule.unitId, schedule.definitionId);
      },
      async (db, a) => {
        const def = await this.get<Definition>(
          db,
          'workflow_definitions',
          c.tenantId,
          schedule.definitionId,
        );
        const version = await this.version(db, c.tenantId, schedule.versionId);
        if (
          def.status !== 'published' ||
          version.definition_id !== def.id ||
          version.version !== def.latest_version
        )
          throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
        if (!version.spec.audienceUnits.includes(schedule.unitId))
          throw new HttpError(403, 'WORKFLOW_AUDIENCE_DENIED');
        await this.directory.validateUnit(c.tenantId, schedule.unitId);
        const recipient = await this.linkRecipient(
          c.tenantId,
          schedule.unitId,
          schedule.recipientAccountId,
          undefined,
          'WORKFLOW_SCHEDULE_RECIPIENT_UNAVAILABLE',
        );
        const { now } = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!;
        const next = nextScheduleOccurrence(schedule, now);
        if (!next) throw new HttpError(400, 'WORKFLOW_SCHEDULE_NO_OCCURRENCE');
        const id = randomUUID();
        await db.query(
          `INSERT INTO workflow_draft_schedules(id,tenant_id,org_unit_id,definition_id,version_id,title,recipient_account_id,
         recipient_person_id,cadence,every,start_date,end_date,local_time,next_run_at,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            id,
            c.tenantId,
            schedule.unitId,
            def.id,
            version.id,
            schedule.title,
            recipient.accountId,
            recipient.personId,
            schedule.cadence,
            schedule.every,
            schedule.startDate,
            schedule.endDate ?? null,
            schedule.localTime,
            next,
            a.accountId,
          ],
        );
        await this.audit(db, c, a, 'schedule.enabled', schedule.unitId, def.id, null, {
          scheduleId: id,
        });
        return { id, revision: 1 };
      },
    );
  }

  async disableDraftSchedule(c: WorkflowCommand, id: string, expectedRevision: number) {
    return this.command(
      c,
      'schedule.disable',
      { id, expectedRevision },
      async (db, a) => {
        const s = await this.getDraftSchedule(db, c.tenantId, id);
        await this.scheduleAuthority(db, c, a, s.org_unit_id, s.definition_id);
      },
      async (db, a) => {
        const s = await this.getDraftSchedule(db, c.tenantId, id);
        revision(s.revision, expectedRevision);
        if (!s.enabled) throw new HttpError(409, 'WORKFLOW_SCHEDULE_DISABLED');
        await db.query(
          'UPDATE workflow_draft_schedules SET enabled=false,next_run_at=NULL,revision=revision+1 WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id],
        );
        await this.audit(db, c, a, 'schedule.disabled', s.org_unit_id, s.definition_id, null, {
          scheduleId: id,
        });
        return { id, revision: s.revision + 1 };
      },
    );
  }

  async draftScheduleJobs(c: WorkflowContext, id: string, after?: string) {
    const actor = await this.actor(c);
    if (after) workflowUuid(after);
    const s = await this.getDraftSchedule(this.pool, c.tenantId, id);
    await this.scheduleAuthority(this.pool, c, actor, s.org_unit_id, s.definition_id);
    const recipient = await this.directory.linkRecipient?.(c.tenantId, s.recipient_account_id);
    const rows = (
      await this.pool.query(
        `WITH page AS (
        SELECT id,scheduled_for,status,attempts,error_code,next_attempt_at,updated_at
        FROM workflow_scheduled_draft_jobs j WHERE (j.tenant_id,j.schedule_id)=($1,$2)
          AND ($3::uuid IS NULL OR (j.scheduled_for,j.id)<(SELECT scheduled_for,id
            FROM workflow_scheduled_draft_jobs WHERE (tenant_id,schedule_id,id)=($1,$2,$3)))
        ORDER BY scheduled_for DESC,id DESC LIMIT 51
      )
      SELECT page.*,COALESCE(history.entries,'[]'::jsonb) AS history FROM page
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attempt DESC) AS entries FROM (
          SELECT attempt,status,error_code,recorded_at FROM workflow_scheduled_draft_attempts
          WHERE (tenant_id,job_id)=($1,page.id) ORDER BY attempt DESC LIMIT 10
        ) a
      ) history ON true ORDER BY page.scheduled_for DESC,page.id DESC`,
        [c.tenantId, id, after ?? null],
      )
    ).rows;
    return {
      items: rows.slice(0, 50),
      nextCursor: rows.length > 50 ? rows[49].id : null,
      recipientName:
        recipient?.personId === s.recipient_person_id ? (recipient.displayName ?? null) : null,
    };
  }

  async retryDraftScheduleJob(c: WorkflowCommand, id: string, expectedAttempts: number) {
    workflowUuid(id);
    const getJob = async (db: Db) => {
      const job = (
        await db.query<WorkflowScheduleJob>(
          'SELECT * FROM workflow_scheduled_draft_jobs WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id],
        )
      ).rows[0];
      if (!job) throw new HttpError(404, 'WORKFLOW_NOT_FOUND');
      return job;
    };
    return this.command(
      c,
      'schedule.retry',
      { id, expectedAttempts },
      async (db, a) => {
        const job = await getJob(db);
        const s = await this.getDraftSchedule(db, c.tenantId, job.schedule_id);
        await this.scheduleAuthority(db, c, a, s.org_unit_id, s.definition_id);
      },
      async (db, a) => {
        const job = await getJob(db);
        const s = await this.getDraftSchedule(db, c.tenantId, job.schedule_id);
        revision(job.attempts, expectedAttempts);
        if (!s.enabled || job.status !== 'blocked')
          throw new HttpError(409, 'WORKFLOW_SCHEDULE_RETRY_UNAVAILABLE');
        await db.query(
          `UPDATE workflow_scheduled_draft_jobs SET status='queued',error_code=NULL,next_attempt_at=now(),updated_at=now()
         WHERE (tenant_id,id)=($1,$2)`,
          [c.tenantId, id],
        );
        await this.audit(
          db,
          c,
          a,
          'schedule.retry_requested',
          s.org_unit_id,
          s.definition_id,
          null,
          { scheduleId: s.id, jobId: id, attempts: job.attempts },
        );
        return { id, status: 'queued' };
      },
    );
  }

  async processScheduledDrafts() {
    const enqueued = await enqueueScheduledDrafts(this.pool);
    const processed = await processDraftJobs<WorkflowScheduleJob>(
      this.pool,
      'schedule',
      async (db, job) => {
        const s = await this.getDraftSchedule(db, job.tenant_id, job.schedule_id);
        if (!s.enabled) throw new HttpError(409, 'WORKFLOW_SCHEDULE_DISABLED');
        const def = await this.get<Definition>(
          db,
          'workflow_definitions',
          job.tenant_id,
          s.definition_id,
        );
        const version = await this.version(db, job.tenant_id, s.version_id);
        if (def.status !== 'published' || def.latest_version !== version.version)
          throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
        if (!version.spec.audienceUnits.includes(s.org_unit_id))
          throw new HttpError(403, 'WORKFLOW_AUDIENCE_DENIED');
        const actor = () =>
          this.linkRecipient(
            job.tenant_id,
            s.org_unit_id,
            s.recipient_account_id,
            s.recipient_person_id,
            'WORKFLOW_SCHEDULE_RECIPIENT_UNAVAILABLE',
          );
        const c: WorkflowCommand = {
          tenantId: job.tenant_id,
          actor,
          idempotencyKey: job.id,
          requestId: job.id,
          reason: 'Tự động tạo bản nháp theo lịch',
        };
        await this.directory.validateUnit(job.tenant_id, s.org_unit_id);
        const recipient = await actor();
        const answers = await workflowAnswers(
          this.directory,
          recipient,
          job.tenant_id,
          s.org_unit_id,
          version.spec.input,
          {},
          'draft',
        );
        const draft = await this.insertRequestDraft(
          db,
          c,
          recipient,
          {
            definitionId: def.id,
            versionId: version.id,
            unitId: s.org_unit_id,
            title: s.title + ' · ' + vietnamScheduleDate(job.scheduled_for),
            answers,
          },
          answers,
          {},
        );
        await this.requestHistory(db, c, recipient, draft, {
          jobId: job.id,
          scheduleId: s.id,
          scheduledFor: job.scheduled_for.toISOString(),
        });
        await actor();
        await this.directory.validateUnit(job.tenant_id, s.org_unit_id);
        return draft.id;
      },
    );
    return { enqueued, processed };
  }

  private requestScope(c: WorkflowContext, a: WorkflowActor, unit: string) {
    workflowRequire(a, c.tenantId, 'workflows:start', unit);
    if (!a.units.some((u) => u.tenantId === c.tenantId && u.orgUnitId === unit))
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
  }
  async referenceOptions(c: WorkflowContext, query: WorkflowReferenceQuery) {
    return referenceOptions(this.directory, await this.actor(c), c.tenantId, query);
  }
  private async ownedRequest(db: Db, c: WorkflowContext, a: WorkflowActor, id: string) {
    const row = await this.get<WorkflowRequest>(db, 'workflow_requests', c.tenantId, id);
    if (row.owner_account_id !== a.accountId || row.owner_person_id !== a.personId)
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    this.requestScope(c, a, row.org_unit_id);
    return row;
  }
  async requestDrafts(c: WorkflowContext, after?: string) {
    const a = await this.actor(c);
    if (after) workflowUuid(after);
    const units = a.units
      .filter(
        (u) =>
          u.tenantId === c.tenantId &&
          workflowAllowed(a, c.tenantId, 'workflows:start', u.orgUnitId),
      )
      .map((u) => u.orgUnitId);
    if (!units.length) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const rows = (
      await this.pool.query(
        `SELECT q.id,q.title,q.revision,q.definition_id,q.version_id,q.org_unit_id,q.updated_at,v.version,v.spec->>'name' AS workflow_name FROM workflow_requests q JOIN workflow_versions v ON v.tenant_id=q.tenant_id AND v.id=q.version_id WHERE q.tenant_id=$1 AND q.owner_account_id=$2 AND q.owner_person_id=$3 AND q.org_unit_id=ANY($4::uuid[]) AND q.status='draft' AND ($5::uuid IS NULL OR (q.updated_at,q.id)<(SELECT updated_at,id FROM workflow_requests WHERE tenant_id=$1 AND owner_account_id=$2 AND id=$5)) ORDER BY q.updated_at DESC,q.id DESC LIMIT 51`,
        [c.tenantId, a.accountId, a.personId, units, after ?? null],
      )
    ).rows;
    return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null };
  }
  async requestDraft(c: WorkflowContext, id: string) {
    const a = await this.actor(c),
      request = await this.ownedRequest(this.pool, c, a, id),
      version = await this.version(this.pool, c.tenantId, request.version_id);
    const definition = await this.get<Definition>(
      this.pool,
      'workflow_definitions',
      c.tenantId,
      request.definition_id,
    );
    const source = (
      await this.pool.query<Run & { source_task_id: string | null }>(
        `SELECT r.*,j.source_task_id FROM workflow_link_jobs j
       JOIN workflow_runs r ON (r.tenant_id,r.id)=(j.tenant_id,j.source_run_id)
       WHERE (j.tenant_id,j.target_request_id)=($1,$2)`,
        [c.tenantId, request.id],
      )
    ).rows[0];
    let blockedReason: string | undefined;
    let visibleRequest = request;
    if (source?.source_task_id && request.status === 'draft') {
      const job = await this.stepLinkJob(this.pool, c.tenantId, id);
      if (job) {
        try {
          await this.validateStepLinkSource(this.pool, c, a, job);
        } catch (error) {
          if (!(error instanceof HttpError) || ![403, 409].includes(error.statusCode)) throw error;
          blockedReason = error.code;
          const rule = await this.getLinkRule(this.pool, c.tenantId, job.rule_id);
          const mappedFields = new Set(rule.mapping.map(({ to }) => to));
          visibleRequest = {
            ...request,
            answers: Object.fromEntries(
              Object.entries(request.answers).filter(([field]) => !mappedFields.has(field)),
            ),
          };
        }
      }
    }
    return {
      request: visibleRequest,
      version,
      ...(blockedReason ? { blockedReason } : {}),
      ...(source && (await this.canReadRun(a, c.tenantId, source))
        ? {
            linkedSource: {
              runId: source.id,
              title: source.title,
              ...(source.source_task_id ? { taskId: source.source_task_id } : {}),
            },
          }
        : {}),
      attachments: await attachmentSummaries(
        this.pool,
        c.tenantId,
        attachmentReferences(version.spec.input, request.answers),
      ),
      canSubmit:
        !blockedReason &&
        request.status === 'draft' &&
        definition.status === 'published' &&
        version.version === definition.latest_version,
    };
  }
  private async requestHistory(
    db: PoolClient,
    c: WorkflowCommand,
    a: WorkflowActor,
    row: WorkflowRequest,
    automation?:
      | { jobId: string; ruleId: string }
      | { jobId: string; scheduleId: string; scheduledFor: string },
  ) {
    await db.query(
      'INSERT INTO workflow_request_history(tenant_id,request_id,revision,title,answers,selections,status,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        c.tenantId,
        row.id,
        row.revision,
        row.title,
        JSON.stringify(row.answers),
        JSON.stringify(row.selections),
        row.status,
        row.run_id,
      ],
    );
    await this.audit(
      db,
      c,
      a,
      automation
        ? 'scheduleId' in automation
          ? 'request.scheduled_draft_created'
          : 'request.automated_draft_created'
        : row.status === 'draft'
          ? 'request.saved'
          : 'request.submitted',
      row.org_unit_id,
      row.definition_id,
      row.run_id,
      { requestId: row.id, revision: row.revision, checksum: formHash(row.answers), ...automation },
    );
  }
  private async insertRequestDraft(
    db: PoolClient,
    c: WorkflowCommand,
    a: WorkflowActor,
    input: WorkflowStartInput,
    answers: Answers,
    selections: unknown,
  ) {
    return (
      await db.query<WorkflowRequest>(
        'INSERT INTO workflow_requests(id,tenant_id,definition_id,version_id,org_unit_id,owner_account_id,owner_person_id,title,answers,selections) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [
          randomUUID(),
          c.tenantId,
          input.definitionId,
          input.versionId,
          input.unitId,
          a.accountId,
          a.personId,
          input.title.trim(),
          JSON.stringify(answers),
          JSON.stringify(selections),
        ],
      )
    ).rows[0]!;
  }
  async saveRequest(
    c: WorkflowCommand,
    input: WorkflowStartInput,
    id?: string,
    expectedRevision?: number,
  ) {
    workflowUuid(input.unitId);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)
      throw new HttpError(400, 'WORKFLOW_TITLE_REQUIRED');
    const authorize = async (db: PoolClient, a: WorkflowActor) => {
      this.requestScope(c, a, input.unitId);
      const d = await this.get<Definition>(
          db,
          'workflow_definitions',
          c.tenantId,
          input.definitionId,
        ),
        v = await this.version(db, c.tenantId, input.versionId);
      if (v.definition_id !== d.id || !v.spec.audienceUnits.includes(input.unitId))
        throw new HttpError(403, 'WORKFLOW_AUDIENCE_DENIED');
      if (id) {
        const old = await this.ownedRequest(db, c, a, id);
        if (old.status === 'draft') await this.requireStepLinkedDraft(db, c, a, id);
        if (
          old.definition_id !== d.id ||
          old.version_id !== v.id ||
          old.org_unit_id !== input.unitId
        )
          throw new HttpError(409, 'WORKFLOW_REQUEST_TARGET_CHANGED');
      } else if (d.status !== 'published' || v.version !== d.latest_version)
        throw new HttpError(409, 'WORKFLOW_VERSION_STALE');
      await this.directory.validateUnit(c.tenantId, input.unitId);
    };
    return this.command(
      c,
      'request.save',
      { input, id: id ?? null, expectedRevision: expectedRevision ?? null },
      authorize,
      async (db, a) => {
        const v = await this.version(db, c.tenantId, input.versionId),
          answers = await workflowAnswers(
            this.directory,
            a,
            c.tenantId,
            input.unitId,
            v.spec.input,
            input.answers,
            'draft',
          );
        await verifyAttachmentAnswers(
          db,
          c.tenantId,
          a,
          v.spec.input,
          answers,
          id ? requestAttachmentLocation(id) : undefined,
        );
        const selections = input.selections ?? {};
        if (!selections || typeof selections !== 'object' || Array.isArray(selections))
          throw new HttpError(400, 'WORKFLOW_ASSIGNMENT_INVALID');
        const groupSteps = startGroupSteps(v.spec).map((n) => n.id);
        for (const [step, value] of Object.entries(selections)) {
          if (!groupSteps.includes(step)) throw new HttpError(400, 'WORKFLOW_ASSIGNMENT_INVALID');
          workflowUuid(value);
        }
        let row: WorkflowRequest;
        if (id) {
          const old = await this.ownedRequest(db, c, a, id);
          revision(old.revision, expectedRevision!);
          if (old.status !== 'draft') throw new HttpError(409, 'WORKFLOW_REQUEST_SUBMITTED');
          row = (
            await db.query(
              'UPDATE workflow_requests SET title=$3,answers=$4,selections=$5,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
              [
                c.tenantId,
                id,
                input.title.trim(),
                JSON.stringify(answers),
                JSON.stringify(selections),
              ],
            )
          ).rows[0];
        } else row = await this.insertRequestDraft(db, c, a, input, answers, selections);
        await this.requestHistory(db, c, a, row);
        return row;
      },
      async (db, a) => {
        await workflowAnswers(
          this.directory,
          a,
          c.tenantId,
          input.unitId,
          (await this.version(db, c.tenantId, input.versionId)).spec.input,
          input.answers,
          'draft',
        );
      },
    );
  }
  async submitRequest(c: WorkflowCommand, id: string, expectedRevision: number) {
    let created = false;
    return this.command(
      c,
      'request.submit',
      { id, expectedRevision },
      async (db, a) => {
        const row = await this.ownedRequest(db, c, a, id);
        // Already submitted receipts may be replayed after a later publication, still under current ownership/scope.
        if (row.status === 'draft' || created) {
          await this.requireStepLinkedDraft(db, c, a, id);
          await this.authorizeStart(
            db,
            c,
            a,
            {
              definitionId: row.definition_id,
              versionId: row.version_id,
              unitId: row.org_unit_id,
              title: row.title,
              answers: row.answers,
              selections: row.selections,
            },
            null,
          );
        }
      },
      async (db, a) => {
        const row = await this.ownedRequest(db, c, a, id);
        revision(row.revision, expectedRevision);
        if (row.status !== 'draft') throw new HttpError(409, 'WORKFLOW_REQUEST_SUBMITTED');
        const run = await this.createRun(
          db,
          c,
          a,
          {
            definitionId: row.definition_id,
            versionId: row.version_id,
            unitId: row.org_unit_id,
            title: row.title,
            answers: row.answers,
            selections: row.selections,
          },
          null,
          row.id,
        );
        const updated = (
          await db.query(
            "UPDATE workflow_requests SET status='submitted',run_id=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [c.tenantId, id, run.id],
          )
        ).rows[0] as WorkflowRequest;
        const { spec } = await this.version(db, c.tenantId, run.version_id);
        await linkAttachments(
          db,
          c.tenantId,
          run.id,
          run.round,
          null,
          attachmentReferences(spec.input, run.inputs),
        );
        await this.requestHistory(db, c, a, updated);
        created = true;
        return run;
      },
      async (db, a) => {
        const row = await this.ownedRequest(db, c, a, id);
        await workflowAnswers(
          this.directory,
          a,
          c.tenantId,
          row.org_unit_id,
          (await this.version(db, c.tenantId, row.version_id)).spec.input,
          row.answers,
          'submit',
        );
      },
    );
  }
  private async uploadTarget(
    db: Db,
    c: WorkflowContext,
    actor: WorkflowActor,
    scope: AttachmentUploadScope,
    id: string,
  ): Promise<{
    location: AttachmentLocation;
    schema: FormSchema | null;
    unitId: string;
    definitionId: string;
  }> {
    if (scope === 'request') {
      const row = await this.ownedRequest(db, c, actor, id);
      if (row.status !== 'draft') throw new HttpError(409, 'WORKFLOW_REQUEST_SUBMITTED');
      const { spec } = await this.version(db, c.tenantId, row.version_id);
      return {
        location: requestAttachmentLocation(id),
        schema: spec.input,
        unitId: row.org_unit_id,
        definitionId: row.definition_id,
      };
    }
    if (scope === 'revision') {
      const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
      if (!this.ownsSubmission(actor, run)) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      if (run.status !== 'needs_revision' || run.source_context)
        throw new HttpError(409, 'WORKFLOW_ATTACHMENT_TARGET_CLOSED');
      const { spec } = await this.version(db, c.tenantId, run.version_id);
      return {
        location: revisionAttachmentLocation(run),
        schema: spec.input,
        unitId: run.org_unit_id,
        definitionId: run.definition_id,
      };
    }
    const { t: task, r: run } = await this.authorizeAction(db, c, actor, id);
    if (
      !(await this.isOpenTask(db, run, task)) ||
      !(await this.canActTask(db, c.tenantId, run.org_unit_id, task, actor.accountId))
    )
      throw new HttpError(409, 'WORKFLOW_ATTACHMENT_TARGET_CLOSED');
    const { spec } = await this.version(db, c.tenantId, run.version_id);
    const node = spec.nodes.find((candidate) => candidate.id === task.node_id);
    return {
      location: taskAttachmentLocation(task),
      schema: node && 'form' in node ? stepActionForm(spec.input, node) : null,
      unitId: run.org_unit_id,
      definitionId: run.definition_id,
    };
  }

  async uploadAttachment(
    c: WorkflowCommand,
    scope: AttachmentUploadScope,
    id: string,
    input: AttachmentUpload,
  ) {
    if (
      typeof input.content !== 'string' ||
      input.content.length > Math.ceil(maxAttachmentBytes / 3) * 4
    )
      throw new HttpError(413, 'WORKFLOW_ATTACHMENT_TOO_LARGE');
    let target: Awaited<ReturnType<WorkflowsService['uploadTarget']>>;
    let field: ReturnType<typeof schemaFields>[number] | undefined;
    return this.command(
      c,
      'attachment.upload',
      {
        scope,
        id,
        fieldId: input.fieldId,
        fileName: input.fileName,
        uploadHash: createHash('sha256').update(input.content).digest('hex'),
      },
      async (db, actor) => {
        target = await this.uploadTarget(db, c, actor, scope, id);
        if (scope === 'request') await this.requireStepLinkedDraft(db, c, actor, id);
        field =
          (target.schema &&
            schemaFields(target.schema).find((item) => item.id === input.fieldId)) ||
          undefined;
        if (field?.type !== 'attachment' || !field.attachments)
          throw new HttpError(400, 'WORKFLOW_ATTACHMENT_FIELD_INVALID');
      },
      async (db, actor) => {
        const file = await inspectAttachment(
          input.fileName,
          input.content,
          field!.attachments!,
          this.uploadScan,
        );
        const attachment = await insertAttachment(
          db,
          c.tenantId,
          actor,
          target.location,
          randomUUID(),
          input.fieldId,
          file,
        );
        await this.audit(
          db,
          c,
          actor,
          'attachment.staged',
          target.unitId,
          target.definitionId,
          null,
          {
            attachmentId: attachment.id,
            status: attachment.status,
          },
        );
        return attachment;
      },
    );
  }

  async downloadAttachment(c: WorkflowContext, id: string) {
    workflowUuid(id);
    const a = await this.actor(c);
    const file = (await attachmentRows(this.pool, c.tenantId, [id]))[0];
    if (!file || file.scan_status !== 'ready')
      throw new HttpError(404, 'WORKFLOW_ATTACHMENT_NOT_FOUND');
    let allowed = false;
    if (file.uploader_account_id === a.accountId && file.uploader_person_id === a.personId) {
      const scope = file.request_id ? 'request' : file.task_id ? 'task' : 'revision';
      try {
        const target = await this.uploadTarget(
          this.pool,
          c,
          a,
          scope,
          (file.request_id ?? file.task_id ?? file.run_id)!,
        );
        allowed = ownsAttachment(file, a, target.location);
      } catch (error) {
        if (!(error instanceof HttpError && [400, 403, 404, 409].includes(error.statusCode)))
          throw error;
      }
    }
    if (!allowed) {
      const links = await attachmentLinks(this.pool, c.tenantId, [id]);
      if (links.length) {
        const run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, links[0]!.run_id);
        const wholeRun = await this.canReadRun(a, c.tenantId, run);
        const scopes = wholeRun ? [] : await relatedSteps(this.pool, a, run);
        if (wholeRun || scopes.length) {
          const { spec } = await this.version(this.pool, c.tenantId, run.version_id);
          const audience = spec.fieldReaders
            ? await this.fieldAudience(this.pool, c, a, run)
            : { owner: false, manager: false, steps: new Set<string>() };
          allowed = links.some((link) => {
            const input = link.task_id && link.field_id.startsWith(stepInputPrefix);
            if (
              !wholeRun &&
              !scopes.some((step) => {
                if (link.round !== step.round) return false;
                if (link.task_id) return link.task_id === step.id;
                const node = spec.nodes.find((item) => item.id === step.nodeId);
                return !!(node && 'form' in node && node.inputFields?.[link.field_id]);
              })
            )
              return false;
            return mayReadField(
              spec,
              input ? 'input' : (link.node_id ?? 'input'),
              input ? link.field_id.slice(stepInputPrefix.length) : link.field_id,
              audience,
            );
          });
        }
      }
    }
    if (!allowed) throw new HttpError(404, 'WORKFLOW_ATTACHMENT_NOT_FOUND');
    const stored = (
      await this.pool.query<{ content: Buffer; checksum: string }>(
        "SELECT content,checksum FROM workflow_attachments WHERE tenant_id=$1 AND id=$2 AND scan_status='ready'",
        [c.tenantId, file.id],
      )
    ).rows[0];
    if (!stored) throw new HttpError(404, 'WORKFLOW_ATTACHMENT_NOT_FOUND');
    if (this.uploadScan)
      await verifyStoredWorkflowAttachment(stored.content, stored.checksum, this.uploadScan);
    return { content: stored.content, fileName: file.file_name };
  }
  /** Trusted adapter lookup; current source permissions apply even to retries and terminal runs. */
  async sourceRun(c: WorkflowContext, source: WorkflowSource) {
    const snapshot = parseWorkflowSource(source),
      a = await this.actor(c);
    const run = (
      await this.pool.query(
        "SELECT * FROM workflow_runs WHERE tenant_id=$1 AND source_context->>'kind'=$2 AND source_context->>'id'=$3",
        [c.tenantId, snapshot.kind, snapshot.id],
      )
    ).rows[0] as Run | undefined;
    if (!run) return null;
    await this.mayRead(this.pool, c, a, run);
    if (formHash(run.source_context) !== formHash(snapshot))
      throw new HttpError(409, 'PROFILE_WORKFLOW_MISMATCH');
    const count = (
      await this.pool.query(
        `SELECT (CASE WHEN bool_or(r.action='reject') THEN 0 ELSE count(*) FILTER (
          WHERE s.task_id IS NULL AND t.status='completed' AND r.action='approve'
           AND r.actor_person_id<>$4 AND r.actor_person_id<>$5
         ) END)::integer AS count
         FROM workflow_tasks t JOIN workflow_task_results r ON r.tenant_id=t.tenant_id AND r.task_id=t.id
         LEFT JOIN workflow_task_supersessions s ON (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id)
         WHERE t.tenant_id=$1 AND t.run_id=$2 AND t.round=$3 AND t.kind='approval'`,
        [c.tenantId, run.id, run.round, snapshot.subjectPersonId, run.owner_person_id],
      )
    ).rows[0].count as number;
    return { ...run, approvalCount: count };
  }
  private async mayRead(db: Db, c: WorkflowContext, a: WorkflowActor, run: Run) {
    if (
      (run.owner_account_id === a.accountId &&
        workflowAllowed(a, c.tenantId, 'workflows:start', run.org_unit_id)) ||
      workflowAllowed(a, c.tenantId, 'workflows:manage', run.org_unit_id)
    )
      return 'participant';
    if (workflowAllowed(a, c.tenantId, 'workflows:act', run.org_unit_id)) {
      const tasks = (
        await db.query(
          'SELECT t.* FROM workflow_tasks t WHERE tenant_id=$1 AND run_id=$2 AND ((approval_policy IS NULL AND assignee_account_id=$3) OR EXISTS(SELECT 1 FROM workflow_approval_members m WHERE m.tenant_id=t.tenant_id AND m.task_id=t.id AND m.account_id=$3 AND m.active))',
          [c.tenantId, run.id, a.accountId],
        )
      ).rows as Task[];
      for (const task of tasks)
        if (await this.assignment.eligible(db, c.tenantId, run.org_unit_id, task, a.accountId))
          return 'participant';
    }
    if (workflowAllowed(a, c.tenantId, 'workflows:report', run.org_unit_id)) return 'report';
    if (await activeFollower(db, a, run)) return 'follower';
    throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
  }
  async canReadRun(actor: WorkflowActor, tenantId: string, run: Run, db: Db = this.pool) {
    if (
      actor.appCode !== 'aio-workflows' ||
      !actor.tenantIds.includes(tenantId) ||
      run.tenant_id !== tenantId
    )
      return false;
    try {
      await this.mayRead(db, { tenantId, actor: async () => actor }, actor, run);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 403) return false;
      throw error;
    }
  }
  private canManageFollowers(c: WorkflowContext, a: WorkflowActor, run: Run) {
    return (
      !run.source_context &&
      (workflowAllowed(a, c.tenantId, 'workflows:manage', run.org_unit_id) ||
        (run.owner_account_id === a.accountId &&
          run.owner_person_id === a.personId &&
          a.units.some(
            (unit) => unit.tenantId === c.tenantId && unit.orgUnitId === run.org_unit_id,
          ) &&
          workflowAllowed(a, c.tenantId, 'workflows:start', run.org_unit_id)))
    );
  }
  private async discussionAccess(
    db: Db,
    c: WorkflowContext,
    a: WorkflowActor,
    run: Run,
    taskId?: string,
  ) {
    const manager = this.canManageFollowers(c, a, run);
    if (!taskId) {
      const access = await this.mayRead(db, c, a, run);
      return { canManage: manager, canComment: access !== 'report' };
    }
    workflowUuid(taskId);
    const task = (
      await db.query<Task & { live: boolean }>(
        `SELECT t.*,(${liveRelatedTask}) AS live FROM workflow_tasks t
       JOIN workflow_runs r ON (r.tenant_id,r.id)=(t.tenant_id,t.run_id)
       WHERE t.tenant_id=$1 AND t.run_id=$2 AND t.id=$3`,
        [c.tenantId, run.id, taskId],
      )
    ).rows[0];
    if (!task || run.source_context) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    if (manager) return { canManage: true, canComment: task.live };
    if (
      workflowAllowed(a, c.tenantId, 'workflows:act', run.org_unit_id) &&
      (await this.assignment.eligible(db, c.tenantId, run.org_unit_id, task, a.accountId))
    )
      return { canManage: false, canComment: task.live };
    if (task.live && (await activeFollower(db, a, run, taskId)))
      return { canManage: false, canComment: true };
    throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
  }
  async discussion(c: WorkflowContext, id: string, after?: string, taskId?: string) {
    if (after) workflowUuid(after);
    const a = await this.actor(c);
    const run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, id);
    const access = await this.discussionAccess(this.pool, c, a, run, taskId);
    const followers = (
      await this.pool.query<Follower>(
        'SELECT ' +
          followerColumns +
          ' FROM workflow_run_followers WHERE tenant_id=$1 AND run_id=$2 AND task_id IS NOT DISTINCT FROM $3::uuid AND active ORDER BY display_name,id',
        [c.tenantId, id, taskId ?? null],
      )
    ).rows;
    const comments = (
      await this.pool.query(
        `SELECT c.id,c.author_name AS "authorName",c.body,c.created_at AS "createdAt",
          COALESCE((SELECT json_agg(f.display_name ORDER BY f.display_name,f.id)
           FROM workflow_comment_mentions m JOIN workflow_run_followers f
           ON (f.tenant_id,f.run_id,f.id)=(m.tenant_id,m.run_id,m.follower_id)
           WHERE (m.tenant_id,m.run_id,m.comment_id)=(c.tenant_id,c.run_id,c.id)),'[]'::json) AS mentions
         FROM workflow_run_comments c
         WHERE c.tenant_id=$1 AND c.run_id=$2 AND c.task_id IS NOT DISTINCT FROM $4::uuid AND ($3::uuid IS NULL OR
          (c.created_at,c.id)<(SELECT p.created_at,p.id FROM workflow_run_comments p
          WHERE p.tenant_id=$1 AND p.run_id=$2 AND p.id=$3 AND p.task_id IS NOT DISTINCT FROM $4::uuid))
         ORDER BY c.created_at DESC,c.id DESC LIMIT 31`,
        [c.tenantId, id, after ?? null, taskId ?? null],
      )
    ).rows;
    return {
      followers: followers.map(({ id, name, revision, personId, accountId }) => ({
        id,
        name,
        revision,
        canMention: personId !== a.personId && accountId !== a.accountId,
      })),
      comments: comments.slice(0, 30),
      nextCursor: comments.length > 30 ? comments[29].id : null,
      ...access,
      canInvite: access.canManage && (!taskId || access.canComment),
    };
  }
  async followerCandidates(c: WorkflowContext, id: string, search: string, taskId?: string) {
    const a = await this.actor(c);
    const run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, id);
    const access = await this.discussionAccess(this.pool, c, a, run, taskId);
    if (!access.canManage || (taskId && !access.canComment))
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const candidates =
      (await this.directory.collaborators?.(c.tenantId, run.org_unit_id, {
        search: search.trim(),
      })) ?? [];
    const active = (
      await this.pool.query<{ person_id: string }>(
        'SELECT person_id FROM workflow_run_followers WHERE tenant_id=$1 AND run_id=$2 AND task_id IS NOT DISTINCT FROM $3::uuid AND active',
        [c.tenantId, id, taskId ?? null],
      )
    ).rows;
    const excluded = new Set([run.owner_person_id, ...active.map((row) => row.person_id)]);
    return {
      items: candidates
        .filter((candidate) => !excluded.has(candidate.personId))
        .map(({ accountId, name }) => ({ accountId, name })),
    };
  }
  private async followerTarget(run: Run, accountId: string) {
    const matches =
      (await this.directory.collaborators?.(run.tenant_id, run.org_unit_id, {
        accountId,
      })) ?? [];
    const target = matches.find((candidate) => candidate.accountId === accountId);
    if (!target || target.personId === run.owner_person_id)
      throw new HttpError(400, 'WORKFLOW_FOLLOWER_UNAVAILABLE');
    return target;
  }
  private followerManager(c: WorkflowContext, id: string, taskId?: string, inviting = false) {
    return async (db: PoolClient, a: WorkflowActor) => {
      const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
      const access = await this.discussionAccess(db, c, a, run, taskId);
      if (!access.canManage || (taskId && inviting && !access.canComment))
        throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    };
  }
  async addFollower(c: WorkflowCommand, id: string, accountId: string, taskId?: string) {
    workflowUuid(accountId);
    let addedPersonId: string;
    return this.command(
      c,
      'follower.add',
      { id, accountId, ...(taskId && { taskId }) },
      this.followerManager(c, id, taskId, true),
      async (db, a) => {
        const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
        const target = await this.followerTarget(run, accountId);
        addedPersonId = target.personId;
        const count = (
          await db.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM workflow_run_followers WHERE tenant_id=$1 AND run_id=$2 AND task_id IS NOT DISTINCT FROM $3::uuid AND active',
            [c.tenantId, id, taskId ?? null],
          )
        ).rows[0]!.count;
        if (count >= 50) throw new HttpError(409, 'WORKFLOW_FOLLOWER_LIMIT');
        const current = (
          await db.query<Follower>(
            'SELECT ' +
              followerColumns +
              ' FROM workflow_run_followers WHERE tenant_id=$1 AND run_id=$2 AND person_id=$3 AND task_id IS NOT DISTINCT FROM $4::uuid',
            [c.tenantId, id, target.personId, taskId ?? null],
          )
        ).rows[0];
        if (current?.active || (current && current.accountId !== accountId))
          throw new HttpError(409, 'WORKFLOW_FOLLOWER_CONFLICT');
        const follower = current
          ? (
              await db.query<Follower>(
                'UPDATE workflow_run_followers SET active=true,revision=revision+1 WHERE tenant_id=$1 AND run_id=$2 AND id=$3 RETURNING ' +
                  followerColumns,
                [c.tenantId, id, current.id],
              )
            ).rows[0]!
          : (
              await db.query<Follower>(
                'INSERT INTO workflow_run_followers(tenant_id,run_id,account_id,person_id,display_name,task_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ' +
                  followerColumns,
                [c.tenantId, id, accountId, target.personId, target.name, taskId ?? null],
              )
            ).rows[0]!;
        await this.audit(db, c, a, 'run.follower_added', run.org_unit_id, run.definition_id, id, {
          followerId: follower.id,
          revision: follower.revision,
          ...(taskId && { taskId }),
        });
        return { id: follower.id, revision: follower.revision };
      },
      async (db) => {
        const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
        if ((await this.followerTarget(run, accountId)).personId !== addedPersonId)
          throw new HttpError(400, 'WORKFLOW_FOLLOWER_UNAVAILABLE');
      },
    );
  }
  async removeFollower(
    c: WorkflowCommand,
    id: string,
    followerId: string,
    expectedRevision: number,
    taskId?: string,
  ) {
    workflowUuid(followerId);
    return this.command(
      c,
      'follower.remove',
      { id, followerId, expectedRevision, ...(taskId && { taskId }) },
      this.followerManager(c, id, taskId),
      async (db, a) => {
        const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
        const updated = (
          await db.query<{ revision: number }>(
            'UPDATE workflow_run_followers SET active=false,revision=revision+1 WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND revision=$4 AND task_id IS NOT DISTINCT FROM $5::uuid AND active RETURNING revision',
            [c.tenantId, id, followerId, expectedRevision, taskId ?? null],
          )
        ).rows[0];
        if (!updated) throw new HttpError(409, 'WORKFLOW_FOLLOWER_CONFLICT');
        await this.audit(db, c, a, 'run.follower_removed', run.org_unit_id, run.definition_id, id, {
          followerId,
          revision: updated.revision,
          ...(taskId && { taskId }),
        });
        return { id: followerId, revision: updated.revision };
      },
    );
  }
  async postComment(
    c: WorkflowCommand,
    id: string,
    body: string,
    mentionIds: string[],
    taskId?: string,
  ) {
    if (
      typeof body !== 'string' ||
      !body.trim() ||
      body.length > 4000 ||
      body.includes('\0') ||
      !Array.isArray(mentionIds) ||
      mentionIds.length > 10 ||
      new Set(mentionIds).size !== mentionIds.length
    )
      throw new HttpError(400, 'WORKFLOW_COMMENT_INVALID');
    mentionIds.forEach(workflowUuid);
    const text = body.trim();
    let mentioned: Follower[] = [];
    const verifyMentions = async (run: Run) => {
      for (const follower of mentioned) {
        const target = await this.followerTarget(run, follower.accountId);
        if (target.personId !== follower.personId)
          throw new HttpError(400, 'WORKFLOW_FOLLOWER_UNAVAILABLE');
      }
    };
    return this.command(
      c,
      'comment.post',
      { id, text, mentionIds, ...(taskId && { taskId }) },
      async (db, a) => {
        const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
        if (!(await this.discussionAccess(db, c, a, run, taskId)).canComment)
          throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      },
      async (db, a) => {
        const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
        mentioned = mentionIds.length
          ? (
              await db.query<Follower>(
                'SELECT ' +
                  followerColumns +
                  ' FROM workflow_run_followers WHERE tenant_id=$1 AND run_id=$2 AND id=ANY($3::uuid[]) AND active AND person_id<>$4 AND account_id<>$5 AND task_id IS NOT DISTINCT FROM $6::uuid',
                [c.tenantId, id, mentionIds, a.personId, a.accountId, taskId ?? null],
              )
            ).rows
          : [];
        if (mentioned.length !== mentionIds.length)
          throw new HttpError(400, 'WORKFLOW_FOLLOWER_UNAVAILABLE');
        await verifyMentions(run);
        const comment = (
          await db.query<{ id: string }>(
            'INSERT INTO workflow_run_comments(tenant_id,run_id,author_account_id,author_person_id,author_name,body,task_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
            [
              c.tenantId,
              id,
              a.accountId,
              a.personId,
              (a.displayName || 'Người dùng AIO').slice(0, 200),
              text,
              taskId ?? null,
            ],
          )
        ).rows[0]!;
        for (const follower of mentioned) {
          const notification = (
            await db.query<{ id: string }>(
              "INSERT INTO workflow_notifications(tenant_id,recipient_account_id,event_key,run_id,kind,task_id) VALUES ($1,$2,$3,$4,'mentioned',$5) RETURNING id",
              [c.tenantId, follower.accountId, 'mention:' + comment.id, id, taskId ?? null],
            )
          ).rows[0]!;
          await db.query(
            'INSERT INTO workflow_comment_mentions(tenant_id,run_id,comment_id,follower_id,follower_revision,notification_id) VALUES ($1,$2,$3,$4,$5,$6)',
            [c.tenantId, id, comment.id, follower.id, follower.revision, notification.id],
          );
        }
        await this.audit(db, c, a, 'run.comment_posted', run.org_unit_id, run.definition_id, id, {
          commentId: comment.id,
          mentionCount: mentioned.length,
          ...(taskId && { taskId }),
        });
        return comment;
      },
      async (db) => verifyMentions(await this.get<Run>(db, 'workflow_runs', c.tenantId, id)),
    );
  }
  async canReadMention(
    db: Db,
    actor: WorkflowActor,
    run: Run,
    notificationId: string,
    taskId?: string,
  ) {
    if (taskId && !(await relatedSteps(db, actor, run)).some((step) => step.id === taskId))
      return false;
    const follower = await activeFollower(db, actor, run, taskId);
    if (!follower) return false;
    return !!(
      await db.query(
        'SELECT 1 FROM workflow_comment_mentions WHERE tenant_id=$1 AND run_id=$2 AND follower_id=$3 AND follower_revision=$4 AND notification_id=$5',
        [run.tenant_id, run.id, follower.id, follower.revision, notificationId],
      )
    ).rowCount;
  }
  private async reassignAuthority(
    db: Db,
    c: WorkflowContext,
    actor: WorkflowActor,
    run: Run,
    task: Task,
    spec?: WorkflowSpec,
  ) {
    if (workflowAllowed(actor, c.tenantId, 'workflows:manage', run.org_unit_id)) return 'manager';
    if (
      !task.assignment_group_id ||
      task.approval_policy ||
      !(await this.isOpenTask(db, run, task))
    )
      return null;
    const version = spec ?? (await this.version(db, c.tenantId, run.version_id)).spec;
    const step = version.nodes.find((node) => node.id === task.node_id);
    if (!step || !('reassignRoles' in step) || !step.reassignRoles?.length) return null;
    const mayAct = workflowAllowed(actor, c.tenantId, 'workflows:act', run.org_unit_id);
    if (
      step.reassignRoles.includes('assignee') &&
      actor.accountId === task.assignee_account_id &&
      mayAct &&
      (await this.assignment.eligible(db, c.tenantId, run.org_unit_id, task, actor.accountId))
    )
      return 'assignee';
    if (!step.reassignRoles.includes('sender')) return null;
    const own =
      actor.accountId === run.owner_account_id &&
      actor.personId === run.owner_person_id &&
      workflowAllowed(actor, c.tenantId, 'workflows:start', run.org_unit_id) &&
      actor.units.some(
        (unit) => unit.tenantId === c.tenantId && unit.orgUnitId === run.org_unit_id,
      );
    if (!own && (!mayAct || !(await this.canReadRun(actor, c.tenantId, run, db)))) return null;
    const source = await db.query(
      "SELECT 1 FROM workflow_audit WHERE tenant_id=$1 AND run_id=$2 AND action='task.assigned' AND details->>'taskId'=$3 AND actor_account_id=$4 LIMIT 1",
      [c.tenantId, run.id, task.id, actor.accountId],
    );
    return source.rowCount ? 'sender' : null;
  }
  async canActTask(db: Db, tenant: string, unit: string, task: Task, accountId: string) {
    if (!(await this.assignment.eligible(db, tenant, unit, task, accountId))) return false;
    if (!task.approval_policy) return true;
    return !(
      await db.query(
        'SELECT 1 FROM workflow_approval_votes WHERE tenant_id=$1 AND task_id=$2 AND account_id=$3',
        [tenant, task.id, accountId],
      )
    ).rowCount;
  }
  private async assignmentAvailable(db: Db, tenant: string, unit: string, task: Task) {
    if (!task.approval_policy) return this.assignment.eligible(db, tenant, unit, task);
    const rows = (
      await db.query(
        'SELECT m.account_id,v.action FROM workflow_approval_members m LEFT JOIN workflow_approval_votes v ON v.tenant_id=m.tenant_id AND v.task_id=m.task_id AND v.account_id=m.account_id WHERE m.tenant_id=$1 AND m.task_id=$2 AND m.active',
        [tenant, task.id],
      )
    ).rows;
    let count = rows.filter((m) => m.action === 'approve').length;
    for (const m of rows)
      if (!m.action && (await this.assignment.eligible(db, tenant, unit, task, m.account_id)))
        count++;
    return count >= task.approval_policy.required;
  }
  async detail(c: WorkflowContext, id: string, taskId?: string) {
    const a = await this.actor(c),
      run = await this.get<Run>(this.pool, 'workflow_runs', c.tenantId, id);
    if (taskId) workflowUuid(taskId);
    const related = await relatedSteps(this.pool, a, run);
    let following = false;
    let relatedTaskId: string | undefined;
    try {
      following = (await this.mayRead(this.pool, c, a, run)) === 'follower';
    } catch (error) {
      if (
        !(error instanceof HttpError && error.statusCode === 403) ||
        !related.some((step) => step.id === taskId)
      )
        throw error;
      relatedTaskId = taskId;
      following = true;
    }
    const v = await this.version(this.pool, c.tenantId, run.version_id);
    const tasks = (
      await this.pool.query(
        `SELECT t.*,r.action,r.answers,r.reason,r.actor_account_id,r.actor_person_id,r.created_at AS decided_at,
          s.caused_by_task_id AS superseded_by_task_id,(t.status='pending' AND t.due_at<now()) AS overdue
         FROM workflow_tasks t LEFT JOIN workflow_task_results r ON r.tenant_id=t.tenant_id AND r.task_id=t.id
         LEFT JOIN workflow_task_supersessions s ON (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id)
         WHERE t.tenant_id=$1 AND t.run_id=$2 AND ($3::uuid IS NULL OR t.id=$3) ORDER BY t.created_at,t.id`,
        [c.tenantId, id, relatedTaskId ?? null],
      )
    ).rows;
    for (const task of tasks) {
      task.members = task.approval_policy
        ? (
            await this.pool.query(
              'SELECT m.account_id,m.person_id,m.name,m.active,m.revision,v.action,v.answers,v.reason,v.created_at AS voted_at FROM workflow_approval_members m LEFT JOIN workflow_approval_votes v ON v.tenant_id=m.tenant_id AND v.task_id=m.task_id AND v.account_id=m.account_id WHERE m.tenant_id=$1 AND m.task_id=$2 ORDER BY m.created_at,m.account_id',
              [c.tenantId, task.id],
            )
          ).rows
        : [];
    }
    const shareable = this.canManageFollowers(c, a, run);
    const history = following
      ? []
      : (
          await this.pool.query(
            `SELECT id,action,reason,actor_account_id,details,occurred_at FROM workflow_audit
             WHERE tenant_id=$1 AND run_id=$2 AND ($3::boolean OR NOT (details ? 'taskId')
               OR action NOT IN ('run.follower_added','run.follower_removed','run.comment_posted'))
             ORDER BY id`,
            [c.tenantId, id, shareable],
          )
        ).rows;
    const mayAct = !following && workflowAllowed(a, c.tenantId, 'workflows:act', run.org_unit_id);
    const causal = v.spec.nodes.some((node) => node.kind === 'parallel');
    const taskActions = [];
    const recallTargets: { taskId: string; label: string }[] = [];
    const canRecall =
      !following &&
      run.status === 'running' &&
      this.ownsSubmission(a, run) &&
      (await canRecallSubmission(this.pool, run));
    for (const task of tasks as ExecutionTask[]) {
      if (!(await this.isOpenTask(this.pool, run, task))) continue;
      const canAct =
        mayAct &&
        (await this.canActTask(this.pool, c.tenantId, run.org_unit_id, task, a.accountId));
      const node = v.spec.nodes.find((item) => item.id === task.node_id);
      const returnTargets =
        canAct &&
        node &&
        'form' in node &&
        (priorStepMode(node, 'return') || priorStepMode(node, 'reject'))
          ? [
              ...(await priorAttempts(this.pool, task, causal)).map((prior) => ({
                id: prior.id,
                stepId: prior.node_id,
                name: prior.label,
              })),
              { id: 'initiator', stepId: null, name: 'Người khởi tạo' },
            ]
          : [];
      taskActions.push({
        taskId: task.id,
        canAct,
        returnTargets,
        canReassign:
          !following && !!(await this.reassignAuthority(this.pool, c, a, run, task, v.spec)),
        assignmentUnavailable: !(await this.assignmentAvailable(
          this.pool,
          c.tenantId,
          run.org_unit_id,
          task,
        )),
      });
    }
    if (run.status === 'running' && mayAct)
      for (const task of tasks) {
        if (
          task.round === run.round &&
          !task.superseded_by_task_id &&
          ['completed', 'rejected'].includes(task.status) &&
          task.actor_account_id === a.accountId &&
          task.actor_person_id === a.personId &&
          (await this.assignment.eligible(
            this.pool,
            c.tenantId,
            run.org_unit_id,
            task,
            a.accountId,
          )) &&
          (await recallableAttempts(this.pool, run, task as ExecutionTask, causal))
        )
          recallTargets.push({ taskId: task.id, label: task.label });
      }
    const selected =
      taskActions.find((action) => action.canAct) ??
      taskActions.find((action) => action.canReassign) ??
      taskActions[0];
    const who = v.spec.fieldReaders
      ? await this.fieldAudience(this.pool, c, a, run)
      : { owner: false, manager: false, steps: new Set<string>() };
    const inputHistory = relatedTaskId
      ? []
      : (
          await this.pool.query(
            'SELECT round,inputs,created_at FROM workflow_run_inputs WHERE tenant_id=$1 AND run_id=$2 ORDER BY round',
            [c.tenantId, id],
          )
        ).rows;
    if (v.spec.fieldReaders)
      for (const task of tasks) {
        if (task.answers) task.answers = visibleAnswers(v.spec, task.node_id, task.answers, who);
        for (const member of task.members)
          if (member.answers)
            member.answers = visibleAnswers(v.spec, task.node_id, member.answers, who);
      }
    const inputs = inputHistory.map((row) => ({
      ...row,
      inputs: visibleAnswers(v.spec, 'input', row.inputs, who),
    }));
    const projected = visibleSpec(v.spec, who);
    const scopedNode = relatedTaskId
      ? projected.nodes.find((node) => node.id === tasks[0]?.node_id)
      : undefined;
    const scopedFields = scopedNode && 'form' in scopedNode ? (scopedNode.inputFields ?? {}) : {};
    const shownInput = relatedTaskId
      ? {
          ...projected.input,
          sections: projected.input.sections
            .map((section) => ({
              ...section,
              fields: section.fields.filter((field) => Object.hasOwn(scopedFields, field.id)),
            }))
            .filter((section) => section.fields.length),
        }
      : projected.input;
    const readableInput = visibleAnswers(v.spec, 'input', run.inputs, who);
    const visibleInput = relatedTaskId
      ? Object.fromEntries(
          Object.entries(readableInput).filter(([fieldId]) => Object.hasOwn(scopedFields, fieldId)),
        )
      : readableInput;
    const fileRefs = [
      ...attachmentReferences(shownInput, visibleInput),
      ...inputs.flatMap((row) => attachmentReferences(v.spec.input, row.inputs)),
    ];
    for (const task of tasks) {
      const node = v.spec.nodes.find((item) => item.id === task.node_id);
      if (!node || !('form' in node)) continue;
      const schema = stepActionForm(v.spec.input, node);
      fileRefs.push(...attachmentReferences(schema, task.answers ?? {}));
      for (const member of task.members)
        fileRefs.push(...attachmentReferences(schema, member.answers ?? {}));
    }
    const discussionSteps = relatedTaskId ? related : [];
    if (!relatedTaskId && !run.source_context)
      for (const task of tasks) {
        if (
          shareable ||
          related.some((step) => step.id === task.id) ||
          (mayAct &&
            (await this.assignment.eligible(
              this.pool,
              c.tenantId,
              run.org_unit_id,
              task,
              a.accountId,
            )))
        )
          discussionSteps.push({
            id: task.id,
            label: task.label,
            round: task.round,
            attempt: task.attempt,
            nodeId: task.node_id,
          });
      }
    if (
      relatedTaskId &&
      !(await relatedSteps(this.pool, a, run)).some((step) => step.id === relatedTaskId)
    )
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const scopedTask = relatedTaskId ? tasks[0] : undefined;
    return {
      run: {
        ...run,
        inputs: visibleInput,
        ...(scopedTask && {
          current_step: scopedTask.node_id,
          status:
            scopedTask.status === 'pending'
              ? 'running'
              : scopedTask.status === 'returned'
                ? 'needs_revision'
                : scopedTask.status,
          revision: scopedTask.revision,
          created_at: scopedTask.created_at,
          updated_at: scopedTask.finished_at ?? scopedTask.created_at,
        }),
      },
      version: {
        ...v,
        spec: relatedTaskId
          ? followerSpec({ ...projected, input: shownInput, nodes: scopedNode ? [scopedNode] : [] })
          : following
            ? followerSpec(projected)
            : projected,
      },
      tasks: tasks.map(({ execution_order: _, actor_person_id: _actor, ...task }) =>
        following
          ? {
              id: task.id,
              node_id: task.node_id,
              round: task.round,
              label: task.label,
              attempt: task.attempt,
              superseded_by_task_id: task.superseded_by_task_id,
              kind: task.kind,
              assignee_name: task.assignee_name,
              status: task.status,
              due_at: task.due_at,
              overdue: task.overdue,
              approval_policy: task.approval_policy,
              members: task.members.map(
                ({
                  account_id,
                  name,
                  active,
                  action,
                  answers,
                  voted_at,
                }: {
                  account_id: string;
                  name: string;
                  active: boolean;
                  action: string | null;
                  answers: Answers | null;
                  voted_at: string | null;
                }) => ({ account_id, name, active, action, answers, voted_at, reason: null }),
              ),
              answers: task.answers,
              reason: null,
              action: task.action,
              decided_at: task.decided_at,
            }
          : task,
      ),
      history: v.spec.fieldReaders
        ? history.map((row) => ({
            ...row,
            details: Object.fromEntries(
              Object.entries(row.details as Record<string, unknown>).filter(
                ([key]) => !['checksum', 'answerChecksum'].includes(key),
              ),
            ),
          }))
        : history,
      inputs,
      attachments: await attachmentSummaries(this.pool, c.tenantId, fileRefs),
      selections: following
        ? []
        : (
            await this.pool.query(
              'SELECT round,choices,group_revisions FROM workflow_run_assignments WHERE tenant_id=$1 AND run_id=$2 ORDER BY round',
              [c.tenantId, id],
            )
          ).rows,
      taskActions,
      canRecallSubmission: canRecall,
      recallTargets,
      activeTaskId: selected?.taskId ?? null,
      assignmentUnavailable: selected?.assignmentUnavailable ?? false,
      canAct: selected?.canAct ?? false,
      returnTargets: selected?.returnTargets ?? [],
      canReassign: selected?.canReassign ?? false,
      canManage: workflowAllowed(a, c.tenantId, 'workflows:manage', run.org_unit_id),
      following,
      relatedTaskId: relatedTaskId ?? null,
      discussionSteps: discussionSteps.map(({ id, label, round, attempt }) => ({
        id,
        label,
        round,
        attempt,
      })),
    };
  }
  private runViewScopes(c: WorkflowContext, a: WorkflowActor, view: WorkflowRunView) {
    const permissions = {
      mine: 'workflows:start',
      inbox: 'workflows:act',
      all: 'workflows:manage',
      followed: 'workflows:collaborate',
      done: 'workflows:act',
    } as const;
    if (!Object.hasOwn(permissions, view)) throw new HttpError(400, 'INVALID_REQUEST');
    const permission = permissions[view];
    const grantedScopes = a.permissions
      .filter(
        (p) =>
          p.tenantId === c.tenantId &&
          (p.permission === permission || (view === 'all' && p.permission === 'workflows:report')),
      )
      .map((p) => p.orgUnitId);
    if (!grantedScopes.length) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    return view === 'followed'
      ? a.units
          .filter(
            (unit) =>
              unit.tenantId === c.tenantId &&
              (grantedScopes.includes(null) || grantedScopes.includes(unit.orgUnitId)),
          )
          .map((unit) => unit.orgUnitId)
      : grantedScopes;
  }
  private workspaceFilters(input: WorkspaceFilters): WorkspaceFilters {
    if (input.unitId) workflowUuid(input.unitId);
    if (
      (input.search !== undefined &&
        (typeof input.search !== 'string' || input.search.length > 120)) ||
      (input.status !== undefined && !workflowRunStatuses.includes(input.status)) ||
      (input.due !== undefined && !workflowDueFilters.includes(input.due))
    )
      throw new HttpError(400, 'WORKFLOW_WORKSPACE_INVALID');
    const search = input.search?.trim();
    return {
      ...(search && { search }),
      ...(input.status && { status: input.status }),
      ...(input.unitId && { unitId: input.unitId }),
      ...(input.due && { due: input.due }),
    };
  }
  async workspaceViews(c: WorkflowContext, view: WorkflowRunView) {
    const a = await this.actor(c);
    this.runViewScopes(c, a, view);
    return {
      items: (
        await this.pool.query<WorkspacePreset>(
          'SELECT id,name,settings,revision FROM workflow_workspace_views WHERE tenant_id=$1 AND account_id=$2 AND person_id=$3 AND view=$4 AND active ORDER BY lower(name),id',
          [c.tenantId, a.accountId, a.personId, view],
        )
      ).rows,
    };
  }
  async saveWorkspaceView(
    c: WorkflowCommand,
    view: WorkflowRunView,
    rawName: string,
    rawSettings: WorkspaceSettings,
    existing?: { id: string; revision: number },
  ) {
    const name = rawName.trim();
    if (!name || name.length > 80) throw new HttpError(400, 'WORKFLOW_WORKSPACE_INVALID');
    if (existing) workflowUuid(existing.id);
    const settings = {
      ...this.workspaceFilters(rawSettings),
      columns: this.workspaceColumns(rawSettings.columns),
    };
    return this.command(
      c,
      'workspace.save',
      { view, name, settings, existing },
      async (_db, a) => {
        this.runViewScopes(c, a, view);
      },
      async (db, a) => {
        const owner = [c.tenantId, a.accountId, a.personId, view];
        if (!existing) {
          const count = (
            await db.query<{ count: number }>(
              'SELECT count(*)::integer AS count FROM workflow_workspace_views WHERE tenant_id=$1 AND account_id=$2 AND person_id=$3 AND view=$4 AND active',
              owner,
            )
          ).rows[0]!.count;
          if (count >= 20) throw new HttpError(409, 'WORKFLOW_WORKSPACE_LIMIT');
        }
        const saved = existing
          ? (
              await db.query<WorkspacePreset>(
                'UPDATE workflow_workspace_views SET name=$5,settings=$6,revision=revision+1 WHERE tenant_id=$1 AND account_id=$2 AND person_id=$3 AND view=$4 AND id=$7 AND revision=$8 AND active RETURNING id,name,settings,revision',
                [...owner, name, settings, existing.id, existing.revision],
              )
            ).rows[0]
          : (
              await db.query<WorkspacePreset>(
                'INSERT INTO workflow_workspace_views(tenant_id,account_id,person_id,view,name,settings) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,settings,revision',
                [...owner, name, settings],
              )
            ).rows[0];
        if (!saved) throw new HttpError(409, 'WORKFLOW_WORKSPACE_CONFLICT');
        await this.audit(db, c, a, 'workspace.view_saved', null, null, null, {
          view,
          id: saved.id,
          revision: saved.revision,
        });
        return saved;
      },
    );
  }
  async archiveWorkspaceView(
    c: WorkflowCommand,
    view: WorkflowRunView,
    id: string,
    expectedRevision: number,
  ) {
    workflowUuid(id);
    return this.command(
      c,
      'workspace.archive',
      { view, id, expectedRevision },
      async (_db, a) => {
        this.runViewScopes(c, a, view);
      },
      async (db, a) => {
        const saved = (
          await db.query<{ revision: number }>(
            'UPDATE workflow_workspace_views SET active=false,revision=revision+1 WHERE tenant_id=$1 AND account_id=$2 AND person_id=$3 AND view=$4 AND id=$5 AND revision=$6 AND active RETURNING revision',
            [c.tenantId, a.accountId, a.personId, view, id, expectedRevision],
          )
        ).rows[0];
        if (!saved) throw new HttpError(409, 'WORKFLOW_WORKSPACE_CONFLICT');
        await this.audit(db, c, a, 'workspace.view_archived', null, null, null, {
          view,
          id,
          revision: saved.revision,
        });
        return { id, revision: saved.revision };
      },
    );
  }
  private workspaceColumns(columns: string[]) {
    if (
      !Array.isArray(columns) ||
      columns.length > 12 ||
      new Set(columns).size !== columns.length ||
      columns.some(
        (key) => typeof key !== 'string' || !new RegExp(workspaceColumnPattern).test(key),
      )
    )
      throw new HttpError(400, 'WORKFLOW_WORKSPACE_INVALID');
    return columns;
  }
  async runs(
    c: WorkflowContext,
    view: WorkflowRunView,
    after?: string,
    options: WorkspaceFilters & { fields?: boolean; columns?: string[] } = {},
  ) {
    const a = await this.actor(c);
    if (after) workflowUuid(after);
    const scopes = this.runViewScopes(c, a, view);
    const filters = this.workspaceFilters(options);
    const requested = new Set(this.workspaceColumns(options.columns ?? []));
    const rows = (
      await this.pool.query(
        `WITH cursor_row AS (
          SELECT r.created_at,r.id,NULL::uuid AS task_id FROM workflow_runs r
           WHERE r.tenant_id=$1 AND r.id=$6::uuid
          UNION ALL
          SELECT r.created_at,r.id,t.id FROM workflow_tasks t
           JOIN workflow_runs r ON (r.tenant_id,r.id)=(t.tenant_id,t.run_id)
           WHERE $4='inbox' AND t.tenant_id=$1 AND t.id=$6::uuid
         )
         SELECT r.id,r.title,display.status,
          CASE WHEN tracked.task_id IS NULL THEN r.revision ELSE t.revision END AS revision,
          r.org_unit_id,CASE WHEN tracked.task_id IS NULL THEN r.created_at ELSE t.created_at END AS created_at,
          CASE WHEN tracked.task_id IS NULL THEN r.updated_at ELSE COALESCE(t.finished_at,t.created_at) END AS updated_at,
          r.definition_id,r.tenant_id,r.owner_account_id,r.owner_person_id,r.source_context,
          CASE WHEN $12::boolean AND tracked.task_id IS NULL THEN r.inputs END AS inputs,
          CASE WHEN $12::boolean AND tracked.task_id IS NULL THEN v.spec END AS spec,
          tracked.task_id AS related_task_id,
          v.spec->>'name' AS workflow_name,t.id AS task_id,t.label AS task_label,t.assignee_name,
          t.assignee_account_id,t.assignment_group_id,t.organization_rule,t.approval_policy,t.due_at,
          $4<>'done' AND t.status='pending' AND t.due_at<now() AS overdue,t.handled_at,t.handled_action
         FROM workflow_runs r JOIN workflow_versions v ON (v.tenant_id,v.id)=(r.tenant_id,r.version_id)
         LEFT JOIN LATERAL (
          SELECT f.id,f.task_id FROM workflow_run_followers f
          LEFT JOIN workflow_tasks t ON (t.tenant_id,t.run_id,t.id)=(f.tenant_id,f.run_id,f.task_id)
          WHERE $4='followed' AND r.source_context IS NULL AND (f.tenant_id,f.run_id)=(r.tenant_id,r.id)
           AND f.account_id=$5 AND f.person_id=$7 AND f.active
           AND (f.task_id IS NULL OR (${liveRelatedTask}))
          ORDER BY (f.task_id IS NOT NULL),t.created_at DESC,f.id LIMIT 1
         ) tracked ON true
         LEFT JOIN LATERAL (
          SELECT pending.*, handled.at AS handled_at,handled.action AS handled_action
          FROM workflow_tasks pending
          LEFT JOIN LATERAL (
           SELECT x.created_at AS at,x.action FROM workflow_task_results x
            WHERE (x.tenant_id,x.task_id,x.actor_account_id,x.actor_person_id)=(pending.tenant_id,pending.id,$5,$7)
           UNION ALL
           SELECT x.created_at AS at,x.action FROM workflow_approval_votes x
            WHERE (x.tenant_id,x.task_id,x.account_id,x.person_id)=(pending.tenant_id,pending.id,$5,$7)
          ) handled ON $4='done'
           WHERE (pending.tenant_id,pending.run_id)=(r.tenant_id,r.id)
            AND (($4='done' AND handled.at IS NOT NULL) OR
                 ($4<>'done' AND pending.round=r.round AND
                  (pending.id=tracked.task_id OR (tracked.task_id IS NULL AND pending.status='pending'))))
            AND ($11::text IS NULL OR (pending.status='pending' AND CASE $11
             WHEN 'overdue' THEN pending.due_at<now()
             WHEN 'today' THEN (pending.due_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
             WHEN 'upcoming' THEN pending.due_at>=now() END))
           ORDER BY handled.at DESC NULLS LAST,pending.due_at,pending.id
           LIMIT (CASE WHEN $4='inbox' THEN NULL ELSE 1 END)
         ) t ON true
         CROSS JOIN LATERAL (
          SELECT CASE WHEN tracked.task_id IS NULL THEN r.status WHEN t.status='pending' THEN 'running'
           WHEN t.status='returned' THEN 'needs_revision' ELSE t.status END AS status
         ) display
         WHERE r.tenant_id=$1 AND ($2::boolean OR r.org_unit_id=ANY($3::uuid[]))
          AND (
           $4='all' OR ($4='mine' AND r.owner_account_id=$5)
           OR ($4='done' AND t.handled_at IS NOT NULL)
           OR ($4='followed' AND tracked.id IS NOT NULL)
           OR ($4='inbox' AND r.status='running' AND (
            (t.approval_policy IS NULL AND t.assignee_account_id=$5) OR EXISTS (
             SELECT 1 FROM workflow_approval_members m
             WHERE (m.tenant_id,m.task_id,m.account_id)=(t.tenant_id,t.id,$5) AND m.active
              AND NOT EXISTS (
               SELECT 1 FROM workflow_approval_votes vote
               WHERE (vote.tenant_id,vote.task_id,vote.account_id)=(m.tenant_id,m.task_id,m.account_id)
              )
            )
           ) AND (
            t.assignment_group_id IS NULL OR EXISTS (
             SELECT 1 FROM workflow_groups g JOIN workflow_group_members m
              ON (m.tenant_id,m.group_id)=(g.tenant_id,g.id)
             WHERE (g.tenant_id,g.id,m.account_id)=(t.tenant_id,t.assignment_group_id,$5)
              AND g.active AND m.active AND (g.org_unit_id IS NULL OR g.org_unit_id=r.org_unit_id)
            )
           ))
          )
          AND ($8::text IS NULL OR display.status=$8)
          AND ($9::uuid IS NULL OR r.org_unit_id=$9)
          AND ($10::text IS NULL OR strpos(lower(r.title),lower($10))>0
            OR strpos(lower(v.spec->>'name'),lower($10))>0 OR strpos(r.id::text,lower($10))=1)
          AND ($11::text IS NULL OR t.id IS NOT NULL)
          AND ($6::uuid IS NULL OR EXISTS (
           SELECT 1 FROM cursor_row c
           WHERE (r.created_at,r.id)<(c.created_at,c.id)
            OR ((r.created_at,r.id)=(c.created_at,c.id) AND t.id<c.task_id)
          ))
         ORDER BY r.created_at DESC,r.id DESC,t.id DESC LIMIT 101`,
        [
          c.tenantId,
          scopes.includes(null),
          scopes.filter(Boolean),
          view,
          a.accountId,
          after ?? null,
          a.personId,
          filters.status ?? null,
          filters.unitId ?? null,
          filters.search ?? null,
          filters.due ?? null,
          !!options.fields,
        ],
      )
    ).rows;
    const items = [];
    const fields = new Map<string, { name: string; label: string }>();
    for (const row of rows.slice(0, 100)) {
      if (
        view === 'inbox' &&
        !(await this.canActTask(
          this.pool,
          c.tenantId,
          row.org_unit_id,
          { ...row, id: row.task_id } as Task,
          a.accountId,
        ))
      )
        continue;
      if (view === 'done' && !(await this.canReadRun(a, c.tenantId, row as Run))) continue;
      const {
        spec,
        inputs,
        source_context: _,
        tenant_id: _tenant,
        owner_account_id: _owner,
        owner_person_id: _person,
        ...item
      } = row;
      if (spec && inputs) {
        const who = spec.fieldReaders
          ? await this.fieldAudience(this.pool, c, a, row as Run)
          : { owner: false, manager: false, steps: new Set<string>() };
        const schema = {
          ...spec.input,
          sections: (spec as WorkflowSpec).input.sections.map((section) => ({
            ...section,
            fields: section.fields.filter((field) => mayReadField(spec, 'input', field.id, who)),
          })),
        };
        const answers = visibleAnswers(spec, 'input', inputs, who);
        const state = fieldState(schema, answers);
        const cells: Record<string, string> = {};
        for (const field of schemaFields(schema)) {
          const key = row.definition_id + '/' + field.id;
          if (!fields.has(key))
            fields.set(key, { name: row.workflow_name + ' · ' + field.label, label: field.label });
          const value = answers[field.id];
          if (
            !requested.has(key) ||
            !state.visible[field.id] ||
            value === undefined ||
            value === null
          )
            continue;
          const format = (value: string | number | boolean) =>
            state.options[field.id]?.find((o) => o.id === value)?.label ??
            (typeof value === 'boolean' ? (value ? 'Có' : 'Không') : String(value));
          if (isReferenceAnswer(value)) cells[key] = value.label;
          else if (field.type === 'attachment' && Array.isArray(value))
            cells[key] = value.length + ' tệp';
          else if (typeof value === 'object' && 'rows' in value)
            cells[key] = value.rows.length + ' dòng';
          else if (Array.isArray(value)) cells[key] = value.map(format).join(', ');
          else if (typeof value !== 'object') cells[key] = format(value);
        }
        item.cells = cells;
      }
      items.push(
        view === 'followed'
          ? {
              ...item,
              assignee_account_id: null,
              assignment_group_id: null,
              organization_rule: null,
              approval_policy: null,
            }
          : item,
      );
    }
    return {
      items,
      ...(options.fields && { fields: [...fields].map(([id, field]) => ({ id, ...field })) }),
      nextCursor: rows.length > 100 ? (view === 'inbox' ? rows[99].task_id : rows[99].id) : null,
    };
  }
  private async authorizeAction(db: Db, c: WorkflowContext, a: WorkflowActor, taskId: string) {
    const t = await this.get<ExecutionTask>(db, 'workflow_tasks', c.tenantId, taskId),
      r = await this.get<Run>(db, 'workflow_runs', c.tenantId, t.run_id);
    workflowRequire(a, c.tenantId, 'workflows:act', r.org_unit_id);
    if (t.approval_policy) {
      if (!(await this.assignment.eligible(db, c.tenantId, r.org_unit_id, t, a.accountId)))
        throw new HttpError(403, 'WORKFLOW_NOT_ASSIGNED');
    } else if (t.assignee_account_id !== a.accountId)
      throw new HttpError(403, 'WORKFLOW_NOT_ASSIGNED');
    if (t.organization_rule && !(await this.assignment.eligible(db, c.tenantId, r.org_unit_id, t)))
      throw new HttpError(409, 'WORKFLOW_ORGANIZATION_CHANGED');
    if (t.assignment_group_id)
      await this.assignment.member(
        db,
        c.tenantId,
        r.org_unit_id,
        t.assignment_group_id,
        a.accountId,
      );
    if (
      t.kind === 'approval' &&
      (a.accountId === r.owner_account_id ||
        a.personId === r.owner_person_id ||
        a.personId === r.source_context?.subjectPersonId)
    )
      throw new HttpError(403, 'WORKFLOW_SELF_APPROVAL');
    return { t, r };
  }

  private async prepareAction(
    db: Db,
    a: WorkflowActor,
    t: ExecutionTask,
    r: Run,
    input: TaskActionInput,
  ) {
    revision(t.revision, input.expectedRevision);
    if (!(await this.isOpenTask(db, r, t))) throw new HttpError(409, 'WORKFLOW_TASK_CLOSED');
    if (
      !['approve', 'reject', 'complete', 'return'].includes(input.action) ||
      (t.kind === 'approval' && input.action === 'complete') ||
      (t.kind === 'task' && ['approve', 'reject'].includes(input.action))
    )
      throw new HttpError(400, 'WORKFLOW_ACTION_INVALID');
    const v = await this.version(db, r.tenant_id, r.version_id);
    const node = v.spec.nodes.find((item) => item.id === t.node_id) as HumanStep;
    if (input.action === 'return' && node.allowReturn === false)
      throw new HttpError(400, 'WORKFLOW_RETURN_DISABLED');
    const mode = priorStepMode(node, input.action);
    if (mode === 'choose' && !input.returnTarget)
      throw new HttpError(400, 'WORKFLOW_RETURN_TARGET_REQUIRED');
    if (mode !== 'choose' && input.returnTarget !== undefined)
      throw new HttpError(409, 'WORKFLOW_RETURN_TARGET_CHANGED');
    const causal = v.spec.nodes.some((item) => item.kind === 'parallel');
    const targets = mode ? await priorAttempts(db, t, causal) : [];
    const targetId = input.returnTarget?.toLowerCase();
    const prior =
      mode === 'previous' ? targets[0] : targets.find((target) => target.id === targetId);
    if (mode === 'choose' && input.returnTarget !== 'initiator' && !prior)
      throw new HttpError(409, 'WORKFLOW_RETURN_TARGET_CHANGED');
    const actionForm = stepActionForm(v.spec.input, node);
    if (!actionForm && Object.keys((input.answers as object) ?? {}).length)
      throw new HttpError(400, 'WORKFLOW_ACTION_INVALID');
    const answers = actionForm
      ? await workflowAnswers(
          this.directory,
          a,
          r.tenant_id,
          r.org_unit_id,
          actionForm,
          input.answers,
          ['return', 'reject'].includes(input.action) ? 'draft' : 'submit',
        )
      : {};
    const fileRefs = await verifyAttachmentAnswers(
      db,
      r.tenant_id,
      a,
      actionForm,
      answers,
      taskAttachmentLocation(t),
    );
    const terminalStatus =
      input.action === 'return' && node.returnMode === 'end'
        ? 'cancelled'
        : input.action === 'return' || mode
          ? 'needs_revision'
          : 'rejected';
    return {
      v,
      answers,
      fileRefs,
      prior,
      causal,
      cursor: prior
        ? await priorCursor(db, t, prior)
        : { branchId: t.execution_branch_id ?? null, predecessors: [t.id] },
      terminalStatus,
      from: prior?.node_id ?? actionDestination(node, input.action),
    };
  }

  async previewHandoff(c: WorkflowContext, taskId: string, input: TaskActionInput) {
    const a = await this.actor(c);
    const { t, r } = await this.authorizeAction(this.pool, c, a, taskId);
    const { v, answers, from, cursor } = await this.prepareAction(this.pool, a, t, r, input);
    if (!from || !decisionPath(v.spec.nodes, from).some(selectsAtHandoff))
      return { selection: null };
    if (t.approval_policy) {
      if (!(await this.canActTask(this.pool, c.tenantId, r.org_unit_id, t, a.accountId)))
        throw new HttpError(409, 'WORKFLOW_ALREADY_VOTED');
      if (input.action === 'approve') {
        const approved = (
          await this.pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM workflow_approval_votes WHERE tenant_id=$1 AND task_id=$2 AND action='approve'",
            [c.tenantId, taskId],
          )
        ).rows[0]!.count;
        if (approved + 1 < t.approval_policy.required) return { selection: null };
      }
    }
    const resolve = await this.branchEvaluator(this.pool, r, v.spec, {
      nodeId: t.node_id,
      answers,
    });
    const effects = await planExecution(this.pool, r, from, cursor, resolve);
    const selections = [];
    for (const effect of effects) {
      if (effect.kind !== 'task' || !selectsAtHandoff(effect.node)) continue;
      const selection = await this.assignment.candidates(
        this.pool,
        c.tenantId,
        r.org_unit_id,
        effect.node,
        { accountId: r.owner_account_id, personId: r.owner_person_id },
      );
      selections.push({
        stepId: selection.stepId,
        label: selection.label,
        groupName: selection.groupName,
        candidates: selection.candidates
          .filter(
            (candidate) =>
              effect.node.kind !== 'approval' ||
              candidate.personId !== r.source_context?.subjectPersonId,
          )
          .map(({ id, name }) => ({ id, name })),
      });
    }
    return selections.length > 1
      ? { selection: null, selections }
      : { selection: selections[0] ?? null };
  }

  async act(
    c: WorkflowCommand,
    taskId: string,
    input: TaskActionInput & { handoff?: HandoffChoice; handoffs?: HandoffChoice[] },
  ) {
    if (!['approve', 'reject', 'complete', 'return'].includes(input.action))
      throw new HttpError(400, 'INVALID_REQUEST');
    if (input.handoff && input.handoffs) throw new HttpError(400, 'WORKFLOW_HANDOFF_CHANGED');
    let queued: Awaited<ReturnType<WorkflowsService['queue']>> = [];
    let rewind = false;
    return this.command(
      c,
      'task.action',
      { taskId, input },
      async (db, a) => {
        await this.authorizeAction(db, c, a, taskId);
      },
      async (db, a) => {
        const t = await this.get<ExecutionTask>(db, 'workflow_tasks', c.tenantId, taskId),
          r = await this.get<Run>(db, 'workflow_runs', c.tenantId, t.run_id);
        const { v, answers, from, prior, terminalStatus, causal, cursor, fileRefs } =
          await this.prepareAction(db, a, t, r, input);
        const hasHandoff = !!(input.handoff || input.handoffs?.length);
        if (!from && hasHandoff) throw new HttpError(409, 'WORKFLOW_HANDOFF_CHANGED');
        await linkAttachments(db, c.tenantId, r.id, r.round, taskId, fileRefs);
        if (t.approval_policy) {
          const vote = await poolVote(
            db,
            c,
            a,
            { id: t.id, approval_policy: t.approval_policy },
            input.action,
            answers,
          );
          await this.audit(db, c, a, 'task.vote', r.org_unit_id, r.definition_id, r.id, {
            taskId,
            action: input.action,
            approved: vote.approved,
            required: t.approval_policy.required,
            answerChecksum: formHash(answers),
          });
          if (!vote.complete) {
            if (hasHandoff) throw new HttpError(409, 'WORKFLOW_HANDOFF_CHANGED');
            // Votes do not invalidate another participant's task revision. Assignment edits do.
            await db.query(
              'UPDATE workflow_runs SET revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
              [c.tenantId, r.id],
            );
            return this.get<Run>(db, 'workflow_runs', c.tenantId, r.id);
          }
        }
        const status =
          input.action === 'return'
            ? 'returned'
            : input.action === 'reject'
              ? 'rejected'
              : 'completed';
        await db.query(
          'UPDATE workflow_tasks SET status=$3,finished_at=now(),revision=revision+1 WHERE tenant_id=$1 AND id=$2',
          [c.tenantId, taskId, status],
        );
        await db.query(
          'INSERT INTO workflow_task_results(tenant_id,task_id,actor_account_id,actor_person_id,action,answers,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            c.tenantId,
            taskId,
            a.accountId,
            a.personId,
            input.action,
            JSON.stringify(answers),
            c.reason,
          ],
        );
        await this.audit(db, c, a, 'task.' + input.action, r.org_unit_id, r.definition_id, r.id, {
          taskId,
          nodeId: t.node_id,
          answerChecksum: formHash(answers),
        });
        if (!from) {
          await this.closePendingTasks(db, r);
          await db.query(
            "UPDATE workflow_runs SET status=$3,current_step=NULL,finished_at=CASE WHEN $3='needs_revision' THEN NULL ELSE now() END,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [c.tenantId, r.id, terminalStatus],
          );
          if (terminalStatus === 'cancelled')
            await this.audit(db, c, a, 'run.cancelled', r.org_unit_id, r.definition_id, r.id, {
              taskId,
            });
        } else {
          const superseded = prior ? await supersedeAttempts(db, t, prior, causal) : undefined;
          queued = await this.queue(
            db,
            c,
            a,
            r,
            v,
            from,
            {
              taskId,
              action: input.action,
              ...(input.handoff && { handoff: input.handoff }),
              ...(input.handoffs && { handoffs: input.handoffs }),
              ...(prior && { priorTaskId: prior.id }),
            },
            cursor,
          );
          if (prior) {
            if (queued.length !== 1) throw new HttpError(409, 'WORKFLOW_RETURN_TARGET_CHANGED');
            rewind = true;
            await this.audit(db, c, a, 'run.step_returned', r.org_unit_id, r.definition_id, r.id, {
              taskId,
              targetTaskId: prior.id,
              targetNodeId: prior.node_id,
              replacementTaskId: queued[0]!.id,
              supersededTaskIds: superseded,
            });
          }
        }
        return this.get<Run>(db, 'workflow_runs', c.tenantId, r.id);
      },
      async (db, a) => {
        const task = await this.get<Task>(db, 'workflow_tasks', c.tenantId, taskId);
        const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, task.run_id);
        for (const work of queued) {
          if (work.choice) {
            const recipient = await this.handoffRecipient(db, run, work.node, work.choice);
            if (recipient.personId !== work.handoffPersonId)
              throw new HttpError(409, 'WORKFLOW_HANDOFF_CHANGED');
          }
          if (!rewind) continue;
          const replacement = await this.get<Task>(db, 'workflow_tasks', c.tenantId, work.id);
          await this.requireReplayRecipient(db, run, replacement);
        }
        const { spec } = await this.version(db, c.tenantId, run.version_id);
        const node = spec.nodes.find((n) => n.id === task.node_id) as HumanStep;
        const actionForm = stepActionForm(spec.input, node);
        if (actionForm)
          await workflowAnswers(
            this.directory,
            a,
            c.tenantId,
            run.org_unit_id,
            actionForm,
            input.answers,
            ['return', 'reject'].includes(input.action) ? 'draft' : 'submit',
          );
      },
    );
  }
  async resubmit(
    c: WorkflowCommand,
    id: string,
    input: { expectedRevision: number; answers: unknown; selections?: unknown },
  ) {
    const authorize = async (db: PoolClient, a: WorkflowActor) => {
      const r = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
      workflowRequire(a, c.tenantId, 'workflows:start', r.org_unit_id);
      if (
        r.owner_account_id !== a.accountId ||
        r.owner_person_id !== a.personId ||
        !a.units.some((unit) => unit.tenantId === c.tenantId && unit.orgUnitId === r.org_unit_id)
      )
        throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      const version = await this.version(db, c.tenantId, r.version_id);
      await this.assignment.validateSelections(
        db,
        c.tenantId,
        r.org_unit_id,
        version.spec,
        input.selections ?? {},
        a,
      );
    };
    return this.command(
      c,
      'run.resubmit',
      { id, input },
      authorize,
      async (db, a) => {
        const r = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
        revision(r.revision, input.expectedRevision);
        if (r.status !== 'needs_revision') throw new HttpError(409, 'WORKFLOW_RUN_CLOSED');
        const v = await this.version(db, c.tenantId, r.version_id),
          answers = await workflowAnswers(
            this.directory,
            a,
            c.tenantId,
            r.org_unit_id,
            v.spec.input,
            input.answers,
            'submit',
          );
        if (r.source_context && formHash(answers) !== formHash(r.inputs))
          throw new HttpError(409, 'WORKFLOW_SOURCE_INPUT_IMMUTABLE');
        const fileRefs = await verifyAttachmentAnswers(
          db,
          c.tenantId,
          a,
          v.spec.input,
          answers,
          revisionAttachmentLocation(r),
        );
        const next = (
          await db.query(
            "UPDATE workflow_runs SET inputs=$3,round=round+1,status='running',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [c.tenantId, id, JSON.stringify(answers)],
          )
        ).rows[0] as Run;
        await db.query(
          'INSERT INTO workflow_run_inputs(tenant_id,run_id,round,inputs) VALUES($1,$2,$3,$4)',
          [c.tenantId, id, next.round, JSON.stringify(answers)],
        );
        await linkAttachments(db, c.tenantId, id, next.round, null, fileRefs);
        const selections = await this.assignment.validateSelections(
          db,
          c.tenantId,
          r.org_unit_id,
          v.spec,
          input.selections ?? {},
          a,
        );
        await db.query(
          'INSERT INTO workflow_run_assignments(tenant_id,run_id,round,choices,group_revisions) VALUES($1,$2,$3,$4,$5)',
          [
            c.tenantId,
            id,
            next.round,
            JSON.stringify(selections.choices),
            JSON.stringify(selections.groupRevisions),
          ],
        );
        await this.audit(db, c, a, 'run.resubmitted', r.org_unit_id, r.definition_id, id, {
          round: next.round,
          checksum: formHash(answers),
        });
        await this.queue(db, c, a, next, v, v.spec.nodes.find((node) => node.kind === 'start')!.id);
        return this.get<Run>(db, 'workflow_runs', c.tenantId, id);
      },
      async (db, a) => {
        const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
        await workflowAnswers(
          this.directory,
          a,
          c.tenantId,
          run.org_unit_id,
          (await this.version(db, c.tenantId, run.version_id)).spec.input,
          input.answers,
          'submit',
        );
      },
    );
  }
  private ownsSubmission(actor: WorkflowActor, run: Run) {
    return (
      actor.accountId === run.owner_account_id &&
      actor.personId === run.owner_person_id &&
      workflowAllowed(actor, run.tenant_id, 'workflows:start', run.org_unit_id) &&
      actor.units.some(
        (unit) => unit.tenantId === run.tenant_id && unit.orgUnitId === run.org_unit_id,
      )
    );
  }

  private async recallAuthority(
    db: Db,
    c: WorkflowCommand,
    a: WorkflowActor,
    runId: string,
    taskId?: string,
  ) {
    const run = await this.get<Run>(db, 'workflow_runs', c.tenantId, runId);
    if (!taskId) {
      if (!this.ownsSubmission(a, run)) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      return { run };
    }
    const { t: task } = await this.authorizeAction(db, c, a, taskId);
    if (
      task.run_id !== run.id ||
      !(await this.assignment.eligible(db, c.tenantId, run.org_unit_id, task, a.accountId))
    )
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const decision = (
      await db.query<{ action: WorkflowAction }>(
        `SELECT action FROM workflow_task_results
         WHERE (tenant_id,task_id,actor_account_id,actor_person_id)=($1,$2,$3,$4)
          AND action IN ('approve','complete','reject')`,
        [c.tenantId, task.id, a.accountId, a.personId],
      )
    ).rows[0];
    if (!decision) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    return { run, task, action: decision.action };
  }

  async recall(
    c: WorkflowCommand,
    id: string,
    input: { expectedRevision: number; sourceTaskId?: string },
  ) {
    if (input.sourceTaskId !== undefined) workflowUuid(input.sourceTaskId);
    const sourceId = input.sourceTaskId?.toLowerCase();
    let authority: Awaited<ReturnType<WorkflowsService['recallAuthority']>>;
    let replacementId: string | undefined;
    return this.command(
      c,
      'run.recall',
      { id, expectedRevision: input.expectedRevision, sourceTaskId: sourceId ?? null },
      async (db, a) => {
        authority = await this.recallAuthority(db, c, a, id, sourceId);
      },
      async (db, a) => {
        const { run, task, action } = authority;
        revision(run.revision, input.expectedRevision);
        if (run.status !== 'running') throw new HttpError(409, 'WORKFLOW_RECALL_UNAVAILABLE');
        const version = await this.version(db, c.tenantId, run.version_id);
        const causal = version.spec.nodes.some((node) => node.kind === 'parallel');
        const affected = task ? await recallableAttempts(db, run, task, causal) : null;
        if (task ? !affected : !(await canRecallSubmission(db, run)))
          throw new HttpError(409, 'WORKFLOW_RECALL_UNAVAILABLE');
        const recallId = randomUUID();
        await db.query(
          `INSERT INTO workflow_recall_events(id,tenant_id,run_id,round,source_task_id,actor_account_id,actor_person_id)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [recallId, c.tenantId, run.id, run.round, task?.id ?? null, a.accountId, a.personId],
        );
        if (task && action && affected) {
          const cursor = await priorCursor(db, task, task);
          await supersedeRecall(db, task, affected, causal, recallId);
          const reopened = await this.queue(
            db,
            c,
            a,
            run,
            version,
            task.node_id,
            { taskId: task.id, action, priorTaskId: task.id, recalledTask: task },
            cursor,
          );
          if (reopened.length !== 1) throw new HttpError(409, 'WORKFLOW_RECALL_UNAVAILABLE');
          replacementId = reopened[0]!.id;
        } else {
          await this.closePendingTasks(db, run);
          await db.query(
            "UPDATE workflow_runs SET status='needs_revision',current_step=NULL,finished_at=NULL,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [c.tenantId, run.id],
          );
        }
        await this.audit(db, c, a, 'run.recalled', run.org_unit_id, run.definition_id, run.id, {
          recallId,
          sourceTaskId: task?.id ?? null,
          ...(replacementId && { replacementTaskId: replacementId }),
          ...(affected && { supersededTaskIds: affected }),
        });
        return this.get<Run>(db, 'workflow_runs', c.tenantId, id);
      },
      async (db, a) => {
        if (!replacementId) return;
        const replacement = await this.get<Task>(db, 'workflow_tasks', c.tenantId, replacementId);
        await this.requireReplayRecipient(db, authority.run, replacement);
        if (
          !(await this.assignment.eligible(
            db,
            c.tenantId,
            authority.run.org_unit_id,
            replacement,
            a.accountId,
          ))
        )
          throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      },
    );
  }

  async cancel(c: WorkflowCommand, id: string, expectedRevision: number) {
    const authorize = async (db: PoolClient, a: WorkflowActor) => {
      const r = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
      if (!(
        r.owner_account_id === a.accountId &&
        workflowAllowed(a, c.tenantId, 'workflows:start', r.org_unit_id)
      ))
        workflowRequire(a, c.tenantId, 'workflows:manage', r.org_unit_id);
    };
    return this.command(c, 'run.cancel', { id, expectedRevision }, authorize, async (db, a) => {
      const r = await this.get<Run>(db, 'workflow_runs', c.tenantId, id);
      revision(r.revision, expectedRevision);
      if (!['running', 'needs_revision'].includes(r.status))
        throw new HttpError(409, 'WORKFLOW_RUN_CLOSED');
      await this.closePendingTasks(db, r);
      await db.query(
        "UPDATE workflow_runs SET status='cancelled',current_step=NULL,finished_at=now(),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [c.tenantId, id],
      );
      await this.audit(db, c, a, 'run.cancelled', r.org_unit_id, r.definition_id, id, {});
      return this.get<Run>(db, 'workflow_runs', c.tenantId, id);
    });
  }
  async reassign(
    c: WorkflowCommand,
    id: string,
    input: { expectedRevision: number; accountId: string; replaceAccountId?: string },
  ) {
    workflowUuid(input.accountId);
    if (input.replaceAccountId) workflowUuid(input.replaceAccountId);
    let priorAssignment: Task | undefined;
    let assignmentAuthority: Awaited<ReturnType<WorkflowsService['reassignAuthority']>> = null;
    const authorize = async (db: PoolClient, a: WorkflowActor) => {
      const t = await this.get<Task>(db, 'workflow_tasks', c.tenantId, id),
        r = await this.get<Run>(db, 'workflow_runs', c.tenantId, t.run_id);
      // The command rechecks live permissions before commit against the assignment it is replacing.
      const authority = await this.reassignAuthority(db, c, a, r, priorAssignment ?? t);
      if (!authority) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      if (!priorAssignment) assignmentAuthority = authority;
      if (t.assignment_group_id)
        await this.assignment.member(
          db,
          c.tenantId,
          r.org_unit_id,
          t.assignment_group_id,
          input.accountId,
        );
      const target = await this.directory.assignee(c.tenantId, r.org_unit_id, input.accountId);
      if (
        t.kind === 'approval' &&
        (input.accountId === r.owner_account_id ||
          target.personId === r.owner_person_id ||
          target.personId === r.source_context?.subjectPersonId)
      )
        throw new HttpError(403, 'WORKFLOW_SELF_APPROVAL');
    };
    const updated = this.command(c, 'task.reassign', { id, input }, authorize, async (db, a) => {
      const t = await this.get<Task>(db, 'workflow_tasks', c.tenantId, id),
        r = await this.get<Run>(db, 'workflow_runs', c.tenantId, t.run_id);
      revision(t.revision, input.expectedRevision);
      if (!(await this.isOpenTask(db, r, t))) throw new HttpError(409, 'WORKFLOW_TASK_CLOSED');
      if (assignmentAuthority !== 'manager' && t.assignee_account_id === input.accountId)
        throw new HttpError(400, 'WORKFLOW_REPLACEMENT_REQUIRED');
      priorAssignment = t;
      const target = await this.directory.assignee(c.tenantId, r.org_unit_id, input.accountId);
      if (t.approval_policy) {
        if (!input.replaceAccountId || input.replaceAccountId === input.accountId)
          throw new HttpError(400, 'WORKFLOW_REPLACEMENT_REQUIRED');
        const members = (
          await db.query(
            'SELECT * FROM workflow_approval_members WHERE tenant_id=$1 AND task_id=$2',
            [c.tenantId, id],
          )
        ).rows;
        if (
          !members.some((m) => m.account_id === input.replaceAccountId && m.active) ||
          members.some(
            (m) =>
              m.active &&
              m.account_id !== input.replaceAccountId &&
              (m.account_id === input.accountId || m.person_id === target.personId),
          )
        )
          throw new HttpError(409, 'WORKFLOW_POOL_DUPLICATE_PERSON');
        if (
          (
            await db.query(
              'SELECT 1 FROM workflow_approval_votes WHERE tenant_id=$1 AND task_id=$2 AND (account_id=ANY($3::uuid[]) OR person_id=$4)',
              [c.tenantId, id, [input.replaceAccountId, input.accountId], target.personId],
            )
          ).rowCount
        )
          throw new HttpError(409, 'WORKFLOW_ALREADY_VOTED');
        await db.query(
          'UPDATE workflow_approval_members SET active=false,revision=revision+1 WHERE tenant_id=$1 AND task_id=$2 AND account_id=$3',
          [c.tenantId, id, input.replaceAccountId],
        );
        const prior = members.find((m) => m.account_id === input.accountId);
        if (prior && prior.person_id !== target.personId)
          throw new HttpError(409, 'WORKFLOW_POOL_IDENTITY_CHANGED');
        if (prior)
          await db.query(
            'UPDATE workflow_approval_members SET active=true,revision=revision+1 WHERE tenant_id=$1 AND task_id=$2 AND account_id=$3',
            [c.tenantId, id, input.accountId],
          );
        else
          await db.query(
            'INSERT INTO workflow_approval_members(tenant_id,task_id,account_id,person_id,name) VALUES($1,$2,$3,$4,$5)',
            [c.tenantId, id, input.accountId, target.personId, target.name],
          );
        const next = (
          await db.query(
            'UPDATE workflow_tasks SET revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING *',
            [c.tenantId, id],
          )
        ).rows[0] as ExecutionTask;
        await this.audit(db, c, a, 'task.reassigned', r.org_unit_id, r.definition_id, r.id, {
          taskId: id,
          before: input.replaceAccountId,
          after: input.accountId,
          pooled: true,
          authority: assignmentAuthority,
        });
        return next;
      }
      if (input.replaceAccountId) throw new HttpError(400, 'WORKFLOW_ACTION_INVALID');
      const next = (
        await db.query(
          'UPDATE workflow_tasks SET assignee_account_id=$3,assignee_name=$4,organization_rule=NULL,revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING *',
          [c.tenantId, id, input.accountId, target.name],
        )
      ).rows[0] as ExecutionTask;
      await this.audit(db, c, a, 'task.reassigned', r.org_unit_id, r.definition_id, r.id, {
        taskId: id,
        before: t.assignee_account_id,
        after: input.accountId,
        organizationRuleOverride: t.organization_rule ?? null,
        authority: assignmentAuthority,
      });
      return next;
    });
    const { execution_order: _, ...assignment } = await updated;
    return assignment;
  }
  private reportScope(tenantId: string, actor: WorkflowActor): ReportScope {
    const scopes = actor.permissions
      .filter(
        (p) =>
          p.tenantId === tenantId &&
          ['workflows:report', 'workflows:manage'].includes(p.permission),
      )
      .map((p) => p.orgUnitId);
    if (!scopes.length) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const allUnits = scopes.includes(null);
    return {
      tenantId,
      allUnits,
      unitIds: allUnits
        ? []
        : [...new Set(scopes.filter((id): id is string => id !== null))].sort(),
    };
  }

  async performanceReportVersions(c: WorkflowContext) {
    return {
      items: await reportVersions(this.pool, this.reportScope(c.tenantId, await this.actor(c))),
    };
  }

  private async withReportSnapshot<T>(read: (db: PoolClient) => Promise<T>) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await read(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  private async projectReportFields(
    db: Db,
    actor: WorkflowActor,
    scope: ReportScope,
    query: ReportQuery,
    observedAt: string,
    facetSearch?: string,
  ) {
    const secret = this.reportFieldKey;
    if (!secret) throw new HttpError(503, 'WORKFLOW_REPORT_FIELDS_UNAVAILABLE');
    const tenantId = scope.tenantId;
    const spec = parseWorkflow(await reportFieldSpec(db, scope, query));
    const rows = await reportFieldRows(db, scope, query, observedAt);
    const roundKey = (run: string, round: number) => run + '/' + round;
    const grants = new Map<string, Map<string, Set<string>>>();
    const rounds = new Map(
      rows
        .filter(({ unit_id }) => workflowAllowed(actor, tenantId, 'workflows:act', unit_id))
        .map((row) => [roundKey(row.run_id, row.round), row]),
    );
    if (rounds.size && Object.keys(spec.fieldReaders ?? {}).length) {
      const candidates = await db.query<Task>(
        `SELECT t.* FROM workflow_tasks t
         JOIN jsonb_to_recordset($2::jsonb) AS r(run_id uuid,round integer)
           ON (r.run_id,r.round)=(t.run_id,t.round)
         WHERE t.tenant_id=$1 AND t.status<>'cancelled'
           AND NOT EXISTS (SELECT 1 FROM workflow_task_supersessions s
             WHERE (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id))
           AND ((t.approval_policy IS NULL AND t.assignee_account_id=$3)
             OR (t.approval_policy IS NOT NULL AND EXISTS (SELECT 1 FROM workflow_approval_members m
               WHERE (m.tenant_id,m.task_id,m.account_id)=(t.tenant_id,t.id,$3) AND m.active)))`,
        [
          tenantId,
          JSON.stringify([...rounds.values()].map(({ run_id, round }) => ({ run_id, round }))),
          actor.accountId,
        ],
      );
      for (const task of candidates.rows) {
        const key = roundKey(task.run_id, task.round);
        const unit = rounds.get(key)!.unit_id;
        if (!(await this.assignment.eligible(db, tenantId, unit, task, actor.accountId))) continue;
        const steps = grants.get(key) ?? new Map<string, Set<string>>();
        const attempts = steps.get(task.node_id) ?? new Set<string>();
        attempts.add(task.id);
        steps.set(task.node_id, attempts);
        grants.set(key, steps);
      }
    }
    return fieldReportProjection({
      spec,
      query,
      rows,
      tenantId,
      secret,
      ...(facetSearch !== undefined && { facetSearch }),
      audience: (row) => ({
        owner:
          row.owner_account_id === actor.accountId &&
          workflowAllowed(actor, tenantId, 'workflows:start', row.unit_id),
        manager: workflowAllowed(actor, tenantId, 'workflows:manage', row.unit_id),
        steps: new Set(
          [...(grants.get(roundKey(row.run_id, row.round)) ?? [])]
            .filter(
              ([node, attempts]) =>
                node !== row.node_id || (row.task_id !== null && attempts.has(row.task_id)),
            )
            .map(([node]) => node),
        ),
      }),
    });
  }

  async performanceReportFields(
    c: WorkflowContext,
    input: PerformanceReportQuery,
    search?: string,
  ) {
    const actor = await this.actor(c);
    const scope = this.reportScope(c.tenantId, actor);
    const query = parsePerformanceReport(input);
    if (!query.versionId) throw new HttpError(400, 'WORKFLOW_REPORT_INVALID');
    const { fields, values, more } = await this.withReportSnapshot((db) =>
      this.projectReportFields(db, actor, scope, query, new Date().toISOString(), search ?? ''),
    );
    return { fields, values, more };
  }

  async performanceReport(c: WorkflowContext, input: PerformanceReportQuery, page: number) {
    const actor = await this.actor(c);
    const scope = this.reportScope(c.tenantId, actor);
    const query = parsePerformanceReport(input);
    const observedAt = new Date().toISOString();
    if (!reportUsesFields(query)) return reportSummary(this.pool, scope, query, page, observedAt);
    return this.withReportSnapshot(async (db) => {
      const { projection } = await this.projectReportFields(db, actor, scope, query, observedAt);
      return reportSummary(db, scope, query, page, observedAt, undefined, projection);
    });
  }

  async performanceReportDetail(
    c: WorkflowContext,
    input: PerformanceReportQuery,
    group: string,
    page: number,
    observedAt: string,
  ) {
    const actor = await this.actor(c);
    const scope = this.reportScope(c.tenantId, actor);
    const clock = Date.parse(observedAt);
    if (!Number.isFinite(clock) || clock > Date.now() + 1000)
      throw new HttpError(400, 'WORKFLOW_REPORT_INVALID');
    const query = parsePerformanceReport(input);
    const at = new Date(clock).toISOString();
    if (!reportUsesFields(query)) return reportDetail(this.pool, scope, query, group, page, at);
    return this.withReportSnapshot(async (db) => {
      const { projection } = await this.projectReportFields(db, actor, scope, query, at);
      const detail = await reportDetail(db, scope, query, group, page, at, undefined, projection);
      return { ...detail, columns: projection.columns };
    });
  }

  async exportPerformanceReport(c: WorkflowCommand, input: PerformanceReportQuery, group?: string) {
    const actor = await this.actor(c);
    const scope = this.reportScope(c.tenantId, actor);
    const query = parsePerformanceReport(input);
    const scopeHash = formHash({ scope, personId: actor.personId });
    const custom = reportUsesFields(query);
    const fieldGrants = ({ permissions }: WorkflowActor) =>
      [
        ...new Set(
          permissions
            .filter(
              ({ tenantId, permission }) =>
                tenantId === c.tenantId &&
                ['workflows:start', 'workflows:act', 'workflows:manage'].includes(permission),
            )
            .map(({ permission, orgUnitId }) => permission + '/' + (orgUnitId ?? '*')),
        ),
      ]
        .sort()
        .join(',');
    const csv = async (db: Db, current: WorkflowActor, observedAt: string) => {
      const projected = custom
        ? (await this.projectReportFields(db, current, scope, query, observedAt)).projection
        : undefined;
      return reportCsv(db, scope, query, observedAt, group, projected);
    };
    let generatedAt: string | undefined;
    let download: Awaited<ReturnType<typeof reportCsv>> | undefined;
    const ensureScope = (current: WorkflowActor) => {
      if (
        current.accountId !== actor.accountId ||
        formHash({ scope: this.reportScope(c.tenantId, current), personId: current.personId }) !==
          scopeHash
      )
        throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    };
    const receipt = await this.command(
      c,
      'report.exported',
      { input, group, scopeHash },
      async (_db, current) => ensureScope(current),
      async (db, current) => {
        const observedAt = new Date().toISOString();
        generatedAt = observedAt;
        download = await csv(db, current, observedAt);
        const checksum = formHash(download.csv);
        await this.audit(db, c, current, 'report.exported', input.unitId ?? null, null, null, {
          filters: input,
          group,
          observedAt,
          rows: download.rows,
          checksum,
        });
        return { observedAt, checksum };
      },
      custom
        ? async (db, current) => {
            const checked = await csv(db, current, generatedAt!);
            if (formHash(checked.csv) !== formHash(download!.csv))
              throw new HttpError(409, 'WORKFLOW_REPORT_CHANGED');
          }
        : undefined,
    );
    if (!download) {
      const current = await this.actor(c);
      ensureScope(current);
      const priorGrants = custom ? fieldGrants(current) : undefined;
      download = custom
        ? await this.withReportSnapshot((db) => csv(db, current, receipt.observedAt))
        : await csv(this.pool, current, receipt.observedAt);
      const verified = await this.actor(c);
      ensureScope(verified);
      if (custom && fieldGrants(verified) !== priorGrants)
        throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
      if (formHash(download.csv) !== receipt.checksum)
        throw new HttpError(409, 'WORKFLOW_REPORT_CHANGED');
    }
    return download;
  }

  async report(c: WorkflowContext) {
    const scope = this.reportScope(c.tenantId, await this.actor(c));
    return {
      states: (
        await this.pool.query(
          'SELECT status,count(*)::integer AS count FROM workflow_runs WHERE tenant_id=$1 AND ($2::boolean OR org_unit_id=ANY($3::uuid[])) GROUP BY status',
          [c.tenantId, scope.allUnits, scope.unitIds],
        )
      ).rows,
      overdue: (
        await this.pool.query(
          "SELECT count(*)::integer AS count FROM workflow_tasks t JOIN workflow_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id WHERE t.tenant_id=$1 AND t.status='pending' AND t.due_at<now() AND ($2::boolean OR r.org_unit_id=ANY($3::uuid[]))",
          [c.tenantId, scope.allUnits, scope.unitIds],
        )
      ).rows[0].count,
    };
  }
}
