import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../security.js';
import type { WorkflowsService, Run, Task } from './service.js';
import { processDraftJobs } from './automation-jobs.js';
import { renderOutput } from './output-templates.js';
import type { OutputEvent, OutputJob, OutputTemplate } from './output-templates.js';
import { workflowAllowed, workflowRequire } from './access.js';
import type { WorkflowContext, WorkflowCommand, WorkflowActor } from './access.js';
import { formHash } from '../forms/service.js';
type Row = Record<string, any>;
export type WorkQuery = {
  view: 'assigned' | 'requested' | 'returned' | 'overdue' | 'managed';
  page: number;
  search?: string;
  unitId?: string;
  assigneeId?: string;
};
export class WorkflowWorkCenter {
  constructor(readonly workflows: WorkflowsService) {}
  private async actor(c: WorkflowContext) {
    const actor = await c.actor();
    if (actor.appCode !== 'aio-workflows' || !actor.tenantIds.includes(c.tenantId))
      throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    return actor;
  }
  private async rows(c: WorkflowContext, actor: WorkflowActor) {
    const permitted = (permission: string) =>
      actor.permissions
        .filter((p) => p.tenantId === c.tenantId && p.permission === permission)
        .map((p) => p.orgUnitId);
    const owner = permitted('workflows:start'),
      assigned = permitted('workflows:act'),
      managed = [...permitted('workflows:manage'), ...permitted('workflows:report')];
    const rows = (
      await this.workflows.pool.query(
        `SELECT r.*,v.spec->>'name' AS workflow_name,t.id AS task_id,t.execution_branch_id,t.label AS task_label,t.kind AS task_kind,t.assignee_account_id,t.assignee_name,t.created_at AS task_created_at,t.due_at,t.assignment_group_id,t.organization_rule,t.approval_policy,COALESCE((SELECT json_agg(json_build_object('id',m.account_id,'name',m.name)) FROM workflow_approval_members m WHERE m.tenant_id=t.tenant_id AND m.task_id=t.id AND m.active AND NOT EXISTS(SELECT 1 FROM workflow_approval_votes v WHERE v.tenant_id=m.tenant_id AND v.task_id=m.task_id AND v.account_id=m.account_id)),'[]'::json) AS pool_members FROM workflow_runs r JOIN workflow_versions v ON v.id=r.version_id AND v.tenant_id=r.tenant_id LEFT JOIN workflow_tasks t ON t.tenant_id=r.tenant_id AND t.run_id=r.id AND t.round=r.round AND t.status='pending' WHERE r.tenant_id=$1 AND ((r.owner_account_id=$2 AND ($3 OR r.org_unit_id=ANY($4::uuid[]))) OR (((t.approval_policy IS NULL AND t.assignee_account_id=$2) OR EXISTS(SELECT 1 FROM workflow_approval_members m WHERE m.tenant_id=t.tenant_id AND m.task_id=t.id AND m.account_id=$2 AND m.active)) AND ($5 OR r.org_unit_id=ANY($6::uuid[]))) OR ($7 OR r.org_unit_id=ANY($8::uuid[]))) ORDER BY COALESCE(t.due_at,r.created_at),r.id,t.id LIMIT 10001`,
        [
          c.tenantId,
          actor.accountId,
          owner.includes(null),
          owner.filter(Boolean),
          assigned.includes(null),
          assigned.filter(Boolean),
          managed.includes(null),
          managed.filter(Boolean),
        ],
      )
    ).rows as Row[];
    if (rows.length > 10000) throw new HttpError(413, 'WORK_CENTER_TOO_MANY_ITEMS');
    const result: Row[] = [];
    for (const row of rows) {
      row.participants = row.approval_policy
        ? row.pool_members
        : row.assignee_account_id
          ? [{ id: row.assignee_account_id, name: row.assignee_name }]
          : [];
      const isOwner =
        row.owner_account_id === actor.accountId &&
        workflowAllowed(actor, c.tenantId, 'workflows:start', row.org_unit_id);
      const isManager =
        workflowAllowed(actor, c.tenantId, 'workflows:manage', row.org_unit_id) ||
        workflowAllowed(actor, c.tenantId, 'workflows:report', row.org_unit_id);
      const isAssignee =
        row.status === 'running' &&
        workflowAllowed(actor, c.tenantId, 'workflows:act', row.org_unit_id) &&
        (await this.workflows.canActTask(
          this.workflows.pool,
          c.tenantId,
          row.org_unit_id,
          { ...row, id: row.task_id } as Task,
          actor.accountId,
        ));
      if (isOwner || isManager || isAssignee)
        result.push({ ...row, isOwner, isManager, isAssignee });
    }
    return result;
  }
  async work(c: WorkflowContext, q: WorkQuery) {
    const actor = await this.actor(c),
      rows = await this.rows(c, actor),
      now = Date.now();
    const manager = actor.permissions.some(
      (p) =>
        p.tenantId === c.tenantId &&
        ['workflows:manage', 'workflows:report'].includes(p.permission),
    );
    if (q.view === 'managed' && !manager) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    const matched = rows.filter(
      (r) =>
        (q.view === 'assigned'
          ? r.isAssignee
          : q.view === 'requested'
            ? r.isOwner
            : q.view === 'returned'
              ? r.isOwner && r.status === 'needs_revision'
              : q.view === 'overdue'
                ? r.isAssignee && new Date(r.due_at).getTime() < now
                : r.isManager && ['running', 'needs_revision'].includes(r.status)) &&
        (!q.unitId || r.org_unit_id === q.unitId) &&
        (!q.assigneeId || r.participants.some((p: Row) => p.id === q.assigneeId)) &&
        (!q.search ||
          (r.title + ' ' + r.workflow_name + ' ' + (r.task_label ?? ''))
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/gi, 'd')
            .toLowerCase()
            .includes(
              q.search
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/đ/gi, 'd')
                .toLowerCase(),
            )),
    );
    const listed = new Set<string>();
    const selected =
      q.view === 'requested' || q.view === 'returned'
        ? matched.filter((row) => {
            if (listed.has(row.id)) return false;
            listed.add(row.id);
            return true;
          })
        : matched;
    const page = Math.min(q.page, Math.max(0, Math.ceil(selected.length / 25) - 1));
    const aggregate = (key: string) =>
      [
        ...new Set(
          selected
            .flatMap((r) =>
              key === 'assignee_account_id' ? r.participants.map((p: Row) => p.id) : [r[key]],
            )
            .filter(Boolean),
        ),
      ].map((id) => {
        const records = selected.filter((r) =>
          key === 'assignee_account_id'
            ? r.participants.some((p: Row) => p.id === id)
            : r[key] === id,
        );
        return {
          id,
          name:
            key === 'assignee_account_id'
              ? records[0]?.participants.find((p: Row) => p.id === id)?.name
              : null,
          count: records.length,
          overdue: records.filter((r) => r.due_at && new Date(r.due_at).getTime() < now).length,
          oldestWaitingAt: records
            .map((r) => r.task_created_at ?? r.updated_at)
            .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0],
        };
      });
    return {
      groups:
        q.view === 'managed'
          ? { units: aggregate('org_unit_id'), assignees: aggregate('assignee_account_id') }
          : null,
      items: selected.slice(page * 25, page * 25 + 25).map((r) => ({
        id: r.id,
        taskId: r.task_id ?? null,
        source: 'aio-workflows',
        title: r.title,
        workflowName: r.workflow_name,
        status: r.status,
        unitId: r.org_unit_id,
        task: r.task_label ?? null,
        kind: r.task_kind ?? null,
        assigneeId: r.approval_policy ? null : (r.assignee_account_id ?? null),
        assigneeName: r.participants.map((p: Row) => p.name).join(', ') || null,
        dueAt: r.due_at ?? null,
        waitingSince: r.task_created_at ?? r.updated_at,
        overdue: !!r.due_at && new Date(r.due_at).getTime() < now,
        canAct: !!r.isAssignee,
        route: '/\u0023workflow-run/' + r.id + (r.execution_branch_id ? '/' + r.task_id : ''),
      })),
      page,
      total: selected.length,
      canManage: manager,
      summary: {
        assigned: rows.filter((r) => r.isAssignee).length,
        requested: new Set(rows.filter((r) => r.isOwner).map((r) => r.id)).size,
        returned: new Set(
          rows.filter((r) => r.isOwner && r.status === 'needs_revision').map((r) => r.id),
        ).size,
        overdue: rows.filter((r) => r.isAssignee && new Date(r.due_at).getTime() < now).length,
      },
      units: [
        ...new Set(
          rows.filter((r) => q.view !== 'managed' || r.isManager).map((r) => r.org_unit_id),
        ),
      ],
      assignees: [
        ...new Map(
          rows
            .filter((r) => r.isManager)
            .flatMap((r) =>
              r.participants.map((p: Row) => [p.id, { id: p.id, name: p.name }] as const),
            ),
        ).values(),
      ],
    };
  }
  private async assignmentEvent(
    db: Pool | PoolClient,
    tenant: string,
    task: Task,
    accountId: string,
  ) {
    if (task.approval_policy) {
      const member = (
        await db.query(
          'SELECT revision FROM workflow_approval_members WHERE tenant_id=$1 AND task_id=$2 AND account_id=$3 AND active',
          [tenant, task.id, accountId],
        )
      ).rows[0];
      return member ? `pool-assignment:${task.id}:${accountId}:${member.revision}` : null;
    }
    // Highest assignment revision prevents A → B → A from reviving an old notification.
    return (
      await db.query(
        "SELECT event_key FROM workflow_notifications WHERE tenant_id=$1 AND task_id=$2 AND kind='assigned' AND event_key LIKE 'assignment:%' ORDER BY split_part(event_key,':',3)::integer DESC LIMIT 1",
        [tenant, task.id],
      )
    ).rows[0]?.event_key as string | undefined;
  }
  private async visibleNotification(
    actor: WorkflowActor,
    tenant: string,
    n: Row,
    db: Pool | PoolClient = this.workflows.pool,
  ) {
    if (
      actor.appCode !== 'aio-workflows' ||
      !actor.tenantIds.includes(tenant) ||
      n.recipient_account_id !== actor.accountId ||
      n.tenant_id !== tenant
    )
      return false;
    const run = (
      await db.query('SELECT * FROM workflow_runs WHERE tenant_id=$1 AND id=$2', [tenant, n.run_id])
    ).rows[0] as Run | undefined;
    if (!run) return false;
    if (n.kind === 'mentioned') {
      if (!(await this.workflows.canReadMention(db, actor, run, n.id, n.task_id ?? undefined)))
        return false;
      return { run, branchTaskId: n.task_id as string | null };
    }
    let branchTaskId: string | null = null;
    if (['assigned', 'due_soon', 'overdue'].includes(n.kind)) {
      const task = (
        await db.query('SELECT * FROM workflow_tasks WHERE tenant_id=$1 AND id=$2', [
          tenant,
          n.task_id,
        ])
      ).rows[0] as Task | undefined;
      if (
        !task ||
        task.run_id !== run.id ||
        task.status !== 'pending' ||
        run.status !== 'running' ||
        !workflowAllowed(actor, tenant, 'workflows:act', run.org_unit_id) ||
        !(await this.workflows.canActTask(db, tenant, run.org_unit_id, task, actor.accountId))
      )
        return false;
      const event = await this.assignmentEvent(db, tenant, task, actor.accountId);
      if (
        !event ||
        (n.kind === 'assigned'
          ? n.event_key !== event
          : n.event_key !== 'reminder:' + event + ':' + n.kind)
      )
        return false;
      if (task.execution_branch_id) branchTaskId = task.id;
    } else if (!(await this.workflows.canReadRun(actor, tenant, run, db))) return false;
    return { run, branchTaskId };
  }
  private async outputMail(
    db: Pool | PoolClient,
    c: WorkflowContext,
    actor: WorkflowActor,
    job: OutputJob,
    n: Row,
    template: OutputTemplate,
  ) {
    const source = await this.visibleNotification(actor, c.tenantId, n, db);
    if (!source) throw new HttpError(403, 'WORKFLOW_OUTPUT_RECIPIENT_DENIED');
    const { run } = source;
    if (
      run.version_id !== template.version_id ||
      run.org_unit_id !== template.org_unit_id ||
      run.round !== job.source_round
    )
      throw new HttpError(409, 'WORKFLOW_OUTPUT_EVENT_STALE');
    if (
      n.task_id &&
      (
        await db.query(
          'SELECT 1 FROM workflow_task_supersessions WHERE (tenant_id,run_id,round,task_id)=($1,$2,$3,$4)',
          [c.tenantId, run.id, job.source_round, n.task_id],
        )
      ).rowCount
    )
      throw new HttpError(409, 'WORKFLOW_OUTPUT_EVENT_STALE');
    const data = await this.workflows.outputSource(
      db,
      c,
      run,
      job.source_round,
      n.task_id ?? undefined,
    );
    return {
      ...renderOutput(template, data, {
        round: job.source_round,
        taskId: n.task_id ?? null,
        event: n.kind as OutputEvent,
        occurredAt: new Date(n.created_at),
      }),
      taskId: source.branchTaskId,
    };
  }

  async deliverOutputNotifications() {
    return processDraftJobs<OutputJob>(this.workflows.pool, 'email', async (db, job) => {
      const template = await this.workflows.getOutputTemplate(db, job.tenant_id, job.template_id);
      if (!template.enabled) throw new HttpError(409, 'WORKFLOW_OUTPUT_DISABLED');
      const n = (
        await db.query('SELECT * FROM workflow_notifications WHERE (tenant_id,id)=($1,$2)', [
          job.tenant_id,
          job.notification_id,
        ])
      ).rows[0];
      if (!n) throw new HttpError(409, 'WORKFLOW_OUTPUT_EVENT_STALE');
      const directory = this.workflows.directory;
      if (!directory.linkRecipient) throw new HttpError(503, 'WORKFLOW_DIRECTORY_UNAVAILABLE');
      const resolve = async () => {
        const actor = await directory.linkRecipient!(job.tenant_id, n.recipient_account_id);
        if (!actor) throw new HttpError(403, 'WORKFLOW_OUTPUT_RECIPIENT_DENIED');
        return actor;
      };
      const actor = await resolve();
      const context = { tenantId: job.tenant_id, actor: async () => actor };
      const result = await this.outputMail(db, context, actor, job, n, template);
      const current = await resolve();
      if (current.personId !== actor.personId || formHash(current) !== formHash(actor)) {
        const verified = await this.outputMail(
          db,
          { ...context, actor: async () => current },
          current,
          job,
          n,
          template,
        );
        if (
          current.personId !== actor.personId ||
          verified.heading !== result.heading ||
          verified.body !== result.body
        )
          throw new HttpError(403, 'WORKFLOW_OUTPUT_RECIPIENT_DENIED');
      }
      return (
        await db.query<{ id: string }>(
          `INSERT INTO workflow_email_deliveries(tenant_id,job_id,recipient_account_id,recipient_person_id,subject,body)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [job.tenant_id, job.id, actor.accountId, actor.personId, result.heading, result.body],
        )
      ).rows[0]!.id;
    });
  }

  async outputMailbox(c: WorkflowContext) {
    const actor = await this.actor(c);
    const db = this.workflows.pool;
    const rows = (
      await db.query(
        `SELECT d.id AS delivery_id,d.subject,d.body,d.created_at AS delivered_at,j.id AS job_id,j.source_round,j.template_id,n.*
       FROM workflow_email_deliveries d JOIN workflow_email_jobs j ON (j.tenant_id,j.id)=(d.tenant_id,d.job_id)
       JOIN workflow_notifications n ON (n.tenant_id,n.id)=(j.tenant_id,j.notification_id)
       WHERE (d.tenant_id,d.recipient_account_id,d.recipient_person_id)=($1,$2,$3)
       ORDER BY d.created_at DESC,d.id DESC LIMIT 50`,
        [c.tenantId, actor.accountId, actor.personId],
      )
    ).rows;
    const items = [];
    for (const row of rows) {
      const template = await this.workflows.getOutputTemplate(db, c.tenantId, row.template_id);
      try {
        const job = {
          ...row,
          id: row.job_id,
          notification_id: row.id,
          attempts: 0,
          status: 'done' as const,
        } as OutputJob;
        const current = await this.outputMail(
          db,
          { ...c, actor: async () => actor },
          actor,
          job,
          row,
          template,
        );
        if (row.subject === current.heading && row.body === current.body)
          items.push({
            id: row.delivery_id,
            subject: row.subject,
            body: row.body,
            runId: row.run_id,
            taskId: current.taskId,
            createdAt: row.delivered_at,
          });
      } catch (error) {
        if (!(error instanceof HttpError) || ![403, 404, 409].includes(error.statusCode))
          throw error;
      }
    }
    return { items };
  }

  async notifications(c: WorkflowContext, page: number, unreadOnly: boolean) {
    const actor = await this.actor(c),
      rows = (
        await this.workflows.pool.query(
          `WITH inbox AS (
             SELECT * FROM workflow_notifications WHERE tenant_id=$1 AND recipient_account_id=$2
             ORDER BY created_at DESC,id DESC LIMIT 10001
           )
           SELECT n.*,r.id IS NOT NULL AND (
             n.kind NOT IN ('assigned','due_soon','overdue') OR (
               r.status='running' AND t.status='pending' AND (
                 (t.approval_policy IS NULL AND t.assignee_account_id=$2)
                 OR (t.approval_policy IS NOT NULL AND EXISTS (
                   SELECT 1 FROM workflow_approval_members m
                   WHERE (m.tenant_id,m.task_id,m.account_id)=(t.tenant_id,t.id,$2) AND m.active
                 ))
               )
             )
           ) AS candidate
           FROM inbox n LEFT JOIN workflow_runs r ON (r.tenant_id,r.id)=(n.tenant_id,n.run_id)
           LEFT JOIN workflow_tasks t ON (t.tenant_id,t.run_id,t.id)=(n.tenant_id,n.run_id,n.task_id)
           ORDER BY n.created_at DESC,n.id DESC`,
          [c.tenantId, actor.accountId],
        )
      ).rows;
    if (rows.length > 10000) throw new HttpError(413, 'WORK_CENTER_TOO_MANY_ITEMS');
    const visible: Row[] = [];
    for (const row of rows) {
      if (!row.candidate) continue;
      const visibleRun = await this.visibleNotification(actor, c.tenantId, row);
      if (visibleRun)
        visible.push({
          id: row.id,
          source: 'aio-workflows',
          kind: row.kind,
          title: visibleRun.run.title,
          readAt: row.read_at,
          revision: row.revision,
          createdAt: row.created_at,
          route:
            '/\u0023workflow-run/' +
            visibleRun.run.id +
            (visibleRun.branchTaskId ? '/' + visibleRun.branchTaskId : ''),
        });
    }
    const filtered = visible.filter((r) => !unreadOnly || !r.readAt),
      current = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
    return {
      items: filtered.slice(current * 25, current * 25 + 25),
      unreadCount: visible.filter((r) => !r.readAt).length,
      total: filtered.length,
      page: current,
    };
  }
  private async command<T>(
    c: WorkflowCommand,
    operation: string,
    input: unknown,
    authorize: (db: PoolClient, a: WorkflowActor) => Promise<void>,
    action: (db: PoolClient, a: WorkflowActor) => Promise<T>,
  ) {
    if (
      !/^[A-Za-z0-9_-]{16,80}$/.test(c.idempotencyKey) ||
      c.reason.trim().length < 5 ||
      c.reason.length > 240
    )
      throw new HttpError(400, 'INVALID_REQUEST');
    const db = await this.workflows.pool.connect(),
      hash = formHash({ operation, input, reason: c.reason });
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'aio-workflows:' + c.tenantId,
      ]);
      const actor = await this.actor(c);
      await authorize(db, actor);
      const receipt = (
        await db.query(
          'SELECT * FROM workflow_receipts WHERE tenant_id=$1 AND actor_account_id=$2 AND idempotency_key=$3',
          [c.tenantId, actor.accountId, c.idempotencyKey],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.request_hash !== hash || receipt.operation !== operation)
          throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
        await db.query('COMMIT');
        return receipt.response as T;
      }
      const result = JSON.parse(JSON.stringify(await action(db, actor))) as T;
      await authorize(db, await this.actor(c));
      await db.query('INSERT INTO workflow_receipts VALUES($1,$2,$3,$4,$5,$6)', [
        c.tenantId,
        actor.accountId,
        c.idempotencyKey,
        operation,
        hash,
        JSON.stringify(result),
      ]);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  async mark(c: WorkflowCommand, id: string, read: boolean, revision: number) {
    const authorize = async (db: PoolClient, actor: WorkflowActor) => {
      const row = (
        await db.query(
          'SELECT * FROM workflow_notifications WHERE tenant_id=$1 AND id=$2 AND recipient_account_id=$3',
          [c.tenantId, id, actor.accountId],
        )
      ).rows[0];
      if (!row || !(await this.visibleNotification(actor, c.tenantId, row, db)))
        throw new HttpError(404, 'WORK_CENTER_NOTIFICATION_UNAVAILABLE');
    };
    return this.command(
      c,
      'notification.read',
      { id, read, revision },
      authorize,
      async (db, actor) => {
        const row = (
          await db.query(
            'UPDATE workflow_notifications SET read_at=CASE WHEN $4 THEN now() ELSE NULL END,revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND recipient_account_id=$3 AND revision=$5 RETURNING id,read_at,revision',
            [c.tenantId, id, actor.accountId, read, revision],
          )
        ).rows[0];
        if (!row) throw new HttpError(409, 'REVISION_CONFLICT');
        await db.query(
          'INSERT INTO workflow_audit(tenant_id,definition_id,run_id,org_unit_id,actor_account_id,action,reason,request_id,details) SELECT r.tenant_id,r.definition_id,r.id,r.org_unit_id,$3,$4,$5,$6,$7 FROM workflow_notifications n JOIN workflow_runs r ON r.tenant_id=n.tenant_id AND r.id=n.run_id WHERE n.tenant_id=$1 AND n.id=$2',
          [
            c.tenantId,
            id,
            actor.accountId,
            'notification.read.changed',
            c.reason,
            c.requestId,
            JSON.stringify({ notificationId: id, read, revision: row.revision }),
          ],
        );
        return row;
      },
    );
  }
  async policies(c: WorkflowContext) {
    const actor = await this.actor(c),
      scope = actor.permissions
        .filter((p) => p.tenantId === c.tenantId && p.permission === 'workflows:manage')
        .map((p) => p.orgUnitId);
    if (!scope.length) throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
    return {
      items: (
        await this.workflows.pool.query(
          'SELECT * FROM workflow_reminder_policies WHERE tenant_id=$1 AND ($2 OR org_unit_id=ANY($3::uuid[])) ORDER BY org_unit_id',
          [c.tenantId, scope.includes(null), scope.filter(Boolean)],
        )
      ).rows,
      worker:
        (
          await this.workflows.pool.query(
            'SELECT last_started_at,last_completed_at,last_error_code FROM workflow_reminder_runs WHERE tenant_id=$1',
            [c.tenantId],
          )
        ).rows[0] ?? null,
    };
  }
  async savePolicy(
    c: WorkflowCommand,
    input: {
      unitId: string;
      enabled: boolean;
      beforeMinutes: number;
      overdueMinutes: number;
      expectedRevision: number;
    },
  ) {
    return this.command(
      c,
      'reminder.policy',
      input,
      async (_db, a) => {
        workflowRequire(a, c.tenantId, 'workflows:manage', input.unitId);
        await this.workflows.directory.validateUnit(c.tenantId, input.unitId);
      },
      async (db, a) => {
        if (
          !Number.isInteger(input.beforeMinutes) ||
          input.beforeMinutes < 0 ||
          input.beforeMinutes > 10080 ||
          !Number.isInteger(input.overdueMinutes) ||
          input.overdueMinutes < 1 ||
          input.overdueMinutes > 10080
        )
          throw new HttpError(400, 'INVALID_REQUEST');
        const before =
          (
            await db.query(
              'SELECT * FROM workflow_reminder_policies WHERE tenant_id=$1 AND org_unit_id=$2',
              [c.tenantId, input.unitId],
            )
          ).rows[0] ?? null;
        if ((before?.revision ?? 0) !== input.expectedRevision)
          throw new HttpError(409, 'REVISION_CONFLICT');
        const row = (
          await db.query(
            'INSERT INTO workflow_reminder_policies(tenant_id,org_unit_id,enabled,before_minutes,overdue_minutes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,org_unit_id) DO UPDATE SET enabled=EXCLUDED.enabled,before_minutes=EXCLUDED.before_minutes,overdue_minutes=EXCLUDED.overdue_minutes,revision=workflow_reminder_policies.revision+1,updated_at=now() RETURNING *',
            [c.tenantId, input.unitId, input.enabled, input.beforeMinutes, input.overdueMinutes],
          )
        ).rows[0];
        await db.query(
          'INSERT INTO workflow_audit(tenant_id,org_unit_id,actor_account_id,action,reason,request_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            c.tenantId,
            input.unitId,
            a.accountId,
            'reminder.policy.changed',
            c.reason,
            c.requestId,
            JSON.stringify({ before, after: row }),
          ],
        );
        return row;
      },
    );
  }
  async remind() {
    const tenants = (
      await this.workflows.pool.query(
        'SELECT DISTINCT tenant_id FROM workflow_reminder_policies WHERE enabled ORDER BY tenant_id',
      )
    ).rows;
    let delivered = 0,
      failedTenants = 0;
    for (const { tenant_id: tenant } of tenants) {
      const db = await this.workflows.pool.connect();
      try {
        await db.query('BEGIN');
        const lock = (
          await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [
            'aio-workflows:' + tenant,
          ])
        ).rows[0].locked;
        if (!lock) {
          await db.query('ROLLBACK');
          continue;
        }
        await db.query(
          'INSERT INTO workflow_reminder_runs(tenant_id,last_started_at) VALUES($1,now()) ON CONFLICT(tenant_id) DO UPDATE SET last_started_at=now(),last_error_code=NULL',
          [tenant],
        );
        const rows = (
          await db.query(
            `SELECT t.*,r.org_unit_id,CASE WHEN t.due_at<=now()-p.overdue_minutes*interval '1 minute' THEN 'overdue' ELSE 'due_soon' END AS reminder_kind FROM workflow_tasks t JOIN workflow_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id JOIN workflow_reminder_policies p ON p.tenant_id=r.tenant_id AND p.org_unit_id=r.org_unit_id AND p.enabled WHERE t.tenant_id=$1 AND r.status='running' AND t.status='pending' AND ((p.before_minutes>0 AND t.due_at>now() AND t.due_at<=now()+p.before_minutes*interval '1 minute') OR t.due_at<=now()-p.overdue_minutes*interval '1 minute') ORDER BY t.due_at,t.id LIMIT 10001`,
            [tenant],
          )
        ).rows;
        if (rows.length > 10000) throw new HttpError(413, 'WORK_CENTER_TOO_MANY_ITEMS');
        let count = 0;
        for (const row of rows) {
          const recipients = row.approval_policy
            ? (
                await db.query(
                  'SELECT account_id FROM workflow_approval_members WHERE tenant_id=$1 AND task_id=$2 AND active',
                  [tenant, row.id],
                )
              ).rows.map((m) => m.account_id as string)
            : [row.assignee_account_id as string];
          for (const account of recipients) {
            if (!(await this.workflows.canActTask(db, tenant, row.org_unit_id, row, account)))
              continue;
            const event = await this.assignmentEvent(db, tenant, row, account);
            if (!event) continue;
            const result = await db.query(
              'INSERT INTO workflow_notifications(tenant_id,recipient_account_id,event_key,run_id,task_id,kind) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
              [
                tenant,
                account,
                'reminder:' + event + ':' + row.reminder_kind,
                row.run_id,
                row.id,
                row.reminder_kind,
              ],
            );
            count += result.rowCount ?? 0;
          }
        }
        await db.query(
          'UPDATE workflow_reminder_runs SET last_completed_at=now(),delivered=delivered+$2,last_error_code=NULL WHERE tenant_id=$1',
          [tenant, count],
        );
        await db.query('COMMIT');
        delivered += count;
      } catch (error) {
        await db.query('ROLLBACK');
        await db.query(
          "INSERT INTO workflow_reminder_runs(tenant_id,last_started_at,last_error_code) VALUES($1,now(),'REMINDER_FAILED') ON CONFLICT(tenant_id) DO UPDATE SET last_started_at=now(),last_error_code='REMINDER_FAILED'",
          [tenant],
        );
        failedTenants++;
      } finally {
        db.release();
      }
    }
    return { delivered, failedTenants };
  }
}
