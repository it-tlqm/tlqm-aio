import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isDate } from '../forms/contracts.js';
import { formHash } from '../forms/service.js';
import { HttpError } from '../security.js';
import { taskAllowed, taskDenied, taskUnitMember, taskUuid } from './access.js';
import type { TaskActor, TaskCommand, TaskContext, TaskDirectory } from './access.js';
import { projectRoles, reminderOffsets, taskStatuses } from './options.js';
import { allowedTaskStages, validateTaskWorkflow, validStageCode } from './workflow.js';
import type {
  ProjectItem,
  ProjectMember,
  ProjectRole,
  TaskDetail,
  TaskFilters,
  TaskInput,
  TaskItem,
  TaskPerson,
  TaskReport,
  TaskStatus,
  TaskWorkPage,
  TaskWorkReminder,
  TaskWorkflow,
} from './options.js';

type Db = Pool | PoolClient;
type Project = {
  id: string;
  tenant_id: string;
  org_unit_id: string;
  name: string;
  description: string;
  owner_account_id: string;
  owner_person_id: string;
  archived: boolean;
  revision: number;
  workflow: TaskWorkflow | null;
};
type Task = {
  id: string;
  tenant_id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  creator_account_id: string;
  creator_person_id: string;
  creator_name: string;
  assignee_account_id: string | null;
  assignee_person_id: string | null;
  assignee_name: string | null;
  assignment_generation: number;
  status: TaskStatus;
  stage_code: string | null;
  progress: number;
  due_on: string | null;
  remind_days: number | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};
type ProjectAccess = {
  project: Project;
  role: ProjectRole;
  wide: boolean;
  report: boolean;
  work: boolean;
};
type TaskAccess = ProjectAccess & {
  task: Task;
  edit: boolean;
  progress: boolean;
  handoff: boolean;
};
type Member = {
  account_id: string;
  person_id: string;
  name: string;
  role: ProjectRole;
  active: boolean;
};
const notFound = () => new HttpError(404, 'TASKS_NOT_FOUND');
const invalid = () => new HttpError(400, 'TASKS_INVALID');
const text = (value: unknown, limit: number, required = false) => {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()))
    throw invalid();
  return value.trim();
};
const expected = (actual: number, supplied: number | undefined) => {
  if (actual !== supplied) throw new HttpError(409, 'REVISION_CONFLICT');
};
const date = (at = new Date()) => new Date(at.getTime() + 7 * 3600000).toISOString().slice(0, 10);
const person = (accountId: string, personId: string, name: string): TaskPerson => ({
  accountId,
  personId,
  name,
});
const taskColumns =
  't.id,t.tenant_id,t.project_id,t.parent_id,t.title,t.description,t.creator_account_id,t.creator_person_id,t.creator_name,t.assignee_account_id,t.assignee_person_id,t.assignee_name,t.assignment_generation,t.status,t.stage_code,t.progress,t.due_on::text,t.remind_days,t.revision,t.created_at,t.updated_at,t.completed_at';
const owner = (actor: TaskActor, task: Task) =>
  actor.accountId === task.creator_account_id && actor.personId === task.creator_person_id;
const assigned = (actor: TaskActor, task: Task) =>
  actor.accountId === task.assignee_account_id && actor.personId === task.assignee_person_id;
const visibleTask = `t.tenant_id=$1 AND t.project_id=$2 AND ($3::boolean
  OR (t.creator_account_id,t.creator_person_id)=($4::uuid,$5::uuid)
  OR (t.assignee_account_id,t.assignee_person_id)=($4::uuid,$5::uuid)
  OR EXISTS(SELECT 1 FROM task_participants p WHERE (p.tenant_id,p.task_id,p.account_id,p.person_id)=(t.tenant_id,t.id,$4::uuid,$5::uuid) AND p.active))`;
const baseScope = (access: ProjectAccess, actor: TaskActor) => [
  access.project.tenant_id,
  access.project.id,
  access.wide,
  actor.accountId,
  actor.personId,
];

const memberDto = (row: Member): ProjectMember => ({
  ...person(row.account_id, row.person_id, row.name),
  role: row.role,
  active: row.active,
});
const projectDto = ({ project: p, role, work, report }: ProjectAccess): ProjectItem => ({
  id: p.id,
  unitId: p.org_unit_id,
  name: p.name,
  description: p.description,
  archived: p.archived,
  revision: p.revision,
  ownerAccountId: p.owner_account_id,
  canManage: role === 'manager',
  canCreateTask: !p.archived && work,
  canReport: report,
  ...(p.workflow && { workflow: p.workflow }),
});
const taskControls = (access: ProjectAccess, actor: TaskActor, task: Task) => {
  const edit =
    access.work && !access.project.archived && (access.role === 'manager' || owner(actor, task));
  const progress = edit || (access.work && !access.project.archived && assigned(actor, task));
  return { edit, progress, handoff: progress && task.status !== 'done' };
};
const taskDto = (access: ProjectAccess, actor: TaskActor, task: Task): TaskItem => {
  const control = taskControls(access, actor, task);
  const workflow = access.project.workflow;
  const stage = workflow?.stages.find(({ code }) => code === (task.stage_code ?? task.status));
  return {
    id: task.id,
    projectId: task.project_id,
    parentId: task.parent_id,
    title: task.title,
    description: task.description,
    creator: person(task.creator_account_id, task.creator_person_id, task.creator_name),
    assignee: task.assignee_account_id
      ? person(task.assignee_account_id, task.assignee_person_id!, task.assignee_name!)
      : null,
    status: task.status,
    ...(workflow &&
      stage && {
        stageCode: stage.code,
        stageName: stage.name,
        allowedStages: control.progress ? allowedTaskStages(workflow, stage.code, access.role) : [],
      }),
    progress: task.progress,
    dueOn: task.due_on,
    remindDays: task.remind_days,
    revision: task.revision,
    createdAt: task.created_at.toISOString(),
    updatedAt: task.updated_at.toISOString(),
    completedAt: task.completed_at?.toISOString() ?? null,
    overdue: task.status !== 'done' && task.due_on !== null && task.due_on < date(),
    canEdit: control.edit,
    canProgress: control.progress,
    canHandoff: control.handoff,
    canComment: access.work && !access.project.archived,
  };
};

export class TasksService {
  constructor(
    readonly pool: Pool,
    readonly directory: TaskDirectory,
  ) {}

  private async actor(c: TaskContext) {
    taskUuid(c.tenantId);
    const actor = await c.actor();
    if (actor.appCode !== 'aio-tasks' || !actor.tenantIds.includes(c.tenantId)) throw taskDenied();
    return actor;
  }

  private async command<S, T>(
    c: TaskCommand,
    operation: string,
    input: unknown,
    authorize: (db: PoolClient, actor: TaskActor, prior?: S) => Promise<S>,
    run: (db: PoolClient, actor: TaskActor, state: S) => Promise<T>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(c.idempotencyKey))
      throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    if (typeof c.reason !== 'string' || c.reason.trim().length < 5 || c.reason.length > 240)
      throw new HttpError(400, 'REASON_REQUIRED');
    const key = formHash({ operation, input, reason: c.reason.trim() });
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'aio-tasks:' + c.tenantId,
      ]);
      const actor = await this.actor(c);
      const state = await authorize(db, actor);
      const { rows } = await db.query<{ request_hash: string; result: T }>(
        'SELECT request_hash,result FROM task_receipts WHERE (tenant_id,actor_account_id,idempotency_key)=($1,$2,$3)',
        [c.tenantId, actor.accountId, c.idempotencyKey],
      );
      const receipt = rows[0];
      if (receipt) {
        if (receipt.request_hash !== key) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
        await db.query('COMMIT');
        return receipt.result;
      }
      const result = await run(db, actor, state);
      const current = await this.actor(c);
      if (actor.accountId !== current.accountId || actor.personId !== current.personId)
        throw taskDenied();
      await authorize(db, current, state);
      await db.query('INSERT INTO task_receipts VALUES($1,$2,$3,$4,$5)', [
        c.tenantId,
        actor.accountId,
        c.idempotencyKey,
        key,
        JSON.stringify(result),
      ]);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505')
        throw new HttpError(409, 'TASKS_DUPLICATE');
      if (['23503', '23514'].includes((error as { code?: string }).code ?? '')) throw invalid();
      throw error;
    } finally {
      db.release();
    }
  }

  private audit(
    db: Db,
    c: TaskCommand,
    actor: TaskActor,
    project: string,
    task: string | null,
    action: string,
    details: unknown = {},
  ) {
    return db.query(
      `INSERT INTO task_audit(tenant_id,project_id,task_id,actor_account_id,actor_name,action,reason,request_id,details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        c.tenantId,
        project,
        task,
        actor.accountId,
        actor.name,
        action,
        c.reason.trim(),
        c.requestId,
        JSON.stringify(details),
      ],
    );
  }

  private async project(db: Db, tenant: string, id: string) {
    taskUuid(id);
    const { rows } = await db.query<Project>(
      'SELECT * FROM task_projects WHERE (tenant_id,id)=($1,$2)',
      [tenant, id],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  private role(actor: TaskActor, project: Project, membership?: ProjectRole): ProjectAccess | null {
    const tenant = project.tenant_id,
      unit = project.org_unit_id;
    const global = taskAllowed(actor, tenant, unit, 'tasks:manage');
    const work = taskAllowed(actor, tenant, unit, 'tasks:work');
    const read = taskAllowed(actor, tenant, unit, 'tasks:view') || work;
    const role = global
      ? 'manager'
      : taskUnitMember(actor, tenant, unit) && read
        ? membership === 'manager' && !work
          ? 'viewer'
          : membership
        : undefined;
    if (!role) return null;
    return {
      project,
      role,
      wide: role === 'manager' || role === 'viewer',
      work: global || (role !== 'viewer' && work),
      report: taskAllowed(actor, tenant, unit, 'tasks:report'),
    };
  }

  private async projectAccess(
    db: Db,
    tenant: string,
    id: string,
    actor: TaskActor,
    manage = false,
  ) {
    const project = await this.project(db, tenant, id);
    const { rows } = await db.query<{ role: ProjectRole }>(
      `SELECT role FROM task_project_members WHERE (tenant_id,project_id,account_id,person_id)=($1,$2,$3,$4) AND active`,
      [tenant, id, actor.accountId, actor.personId],
    );
    const access = this.role(actor, project, rows[0]?.role);
    if (!access || (manage && access.role !== 'manager')) throw taskDenied();
    return access;
  }

  private async currentMember(db: Db, project: Project, id: string, requireWork = false) {
    taskUuid(id);
    const [row, target] = await Promise.all([
      db
        .query<Member>(
          'SELECT * FROM task_project_members WHERE (tenant_id,project_id,account_id)=($1,$2,$3) AND active',
          [project.tenant_id, project.id, id],
        )
        .then(({ rows }) => rows[0]),
      this.directory.actor(project.tenant_id, id),
    ]);
    if (
      !row ||
      !target ||
      row.person_id !== target.personId ||
      !taskUnitMember(target, project.tenant_id, project.org_unit_id) ||
      (requireWork
        ? row.role === 'viewer' ||
          !taskAllowed(target, project.tenant_id, project.org_unit_id, 'tasks:work')
        : !taskAllowed(target, project.tenant_id, project.org_unit_id, 'tasks:view') &&
          !taskAllowed(target, project.tenant_id, project.org_unit_id, 'tasks:work'))
    )
      throw new HttpError(400, 'TASKS_MEMBER_UNAVAILABLE');
    return target;
  }

  async projects(c: TaskContext) {
    const actor = await this.actor(c);
    const units = actor.units
      .filter(
        ({ tenantId, orgUnitId }) =>
          tenantId === c.tenantId &&
          (taskAllowed(actor, c.tenantId, orgUnitId, 'tasks:view') ||
            taskAllowed(actor, c.tenantId, orgUnitId, 'tasks:work')),
      )
      .map(({ orgUnitId }) => orgUnitId);
    const admin = actor.permissions
      .filter(
        ({ tenantId, permission }) => tenantId === c.tenantId && permission === 'tasks:manage',
      )
      .map(({ orgUnitId }) => orgUnitId);
    const { rows } = await this.pool.query<Project & { member_role?: ProjectRole }>(
      `SELECT p.*,m.role AS member_role FROM task_projects p LEFT JOIN task_project_members m
       ON (m.tenant_id,m.project_id,m.account_id,m.person_id)=(p.tenant_id,p.id,$2,$3) AND m.active
       WHERE p.tenant_id=$1 AND ($4::boolean OR p.org_unit_id=ANY($5::uuid[]) OR
         (m.account_id IS NOT NULL AND p.org_unit_id=ANY($6::uuid[])))
       ORDER BY p.archived,p.updated_at DESC,p.id LIMIT 300`,
      [
        c.tenantId,
        actor.accountId,
        actor.personId,
        admin.includes(null),
        admin.filter(Boolean),
        units,
      ],
    );
    return { items: rows.map((row) => projectDto(this.role(actor, row, row.member_role)!)) };
  }

  async projectDetails(c: TaskContext, id: string) {
    const actor = await this.actor(c);
    const access = await this.projectAccess(this.pool, c.tenantId, id, actor);
    const { rows } = await this.pool.query<Member>(
      'SELECT * FROM task_project_members WHERE (tenant_id,project_id)=($1,$2) AND active ORDER BY name,account_id LIMIT 200',
      [c.tenantId, id],
    );
    return { project: projectDto(access), members: rows.map(memberDto) };
  }

  async candidates(c: TaskContext, id: string, search: string) {
    const actor = await this.actor(c);
    const { project } = await this.projectAccess(this.pool, c.tenantId, id, actor, true);
    return {
      items: await this.directory.search(c.tenantId, project.org_unit_id, text(search, 120)),
    };
  }

  async saveProject(
    c: TaskCommand,
    input: { unitId: string; name: string; description: string; archived?: boolean },
    id?: string,
    revision?: number,
  ) {
    taskUuid(input.unitId);
    const name = text(input.name, 160, true),
      description = text(input.description, 5000);
    return this.command(
      c,
      'project.save',
      { input, id, revision },
      async (db, actor) => {
        await this.directory.validateUnit(c.tenantId, input.unitId);
        if (!id) {
          if (!taskAllowed(actor, c.tenantId, input.unitId, 'tasks:manage')) throw taskDenied();
          return null;
        }
        const access = await this.projectAccess(db, c.tenantId, id, actor, true);
        if (access.project.org_unit_id !== input.unitId) throw invalid();
        return access;
      },
      async (db, actor, access) => {
        const projectId = access?.project.id ?? randomUUID();
        let next: number;
        if (access) {
          expected(access.project.revision, revision);
          const { rows } = await db.query<{ revision: number }>(
            `UPDATE task_projects SET name=$3,description=$4,archived=$5,revision=revision+1,updated_at=now()
             WHERE (tenant_id,id)=($1,$2) RETURNING revision`,
            [c.tenantId, projectId, name, description, input.archived ?? access.project.archived],
          );
          next = rows[0]!.revision;
        } else {
          await db.query(
            `INSERT INTO task_projects(id,tenant_id,org_unit_id,name,description,owner_account_id,owner_person_id)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              projectId,
              c.tenantId,
              input.unitId,
              name,
              description,
              actor.accountId,
              actor.personId,
            ],
          );
          await db.query(
            `INSERT INTO task_project_members(tenant_id,project_id,account_id,person_id,name,role) VALUES($1,$2,$3,$4,$5,'manager')`,
            [c.tenantId, projectId, actor.accountId, actor.personId, actor.name],
          );
          next = 1;
        }
        await this.audit(
          db,
          c,
          actor,
          projectId,
          null,
          access ? 'project.updated' : 'project.created',
          { revision: next, archived: input.archived },
        );
        return { id: projectId, revision: next };
      },
    );
  }

  async saveWorkflow(c: TaskCommand, id: string, supplied: TaskWorkflow, revision: number) {
    const workflow = validateTaskWorkflow(supplied);
    return this.command(
      c,
      'project.workflow',
      { id, workflow, revision },
      async (db, actor) => {
        const access = await this.projectAccess(db, c.tenantId, id, actor, true);
        if (access.project.archived) throw taskDenied();
        return access.project;
      },
      async (db, actor, project) => {
        expected(project.revision, revision);
        const { rows } = await db.query<{ code: string; phase: TaskStatus }>(
          `SELECT DISTINCT COALESCE(stage_code,status) AS code,status AS phase FROM task_items WHERE (tenant_id,project_id)=($1,$2)`,
          [c.tenantId, id],
        );
        if (
          rows.some(
            (row) =>
              !workflow.stages.some(({ code, phase }) => code === row.code && phase === row.phase),
          )
        )
          throw new HttpError(409, 'TASKS_STAGE_IN_USE');
        await db.query(
          'UPDATE task_projects SET workflow=$3,revision=revision+1,updated_at=now() WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id, JSON.stringify(workflow)],
        );
        await this.audit(db, c, actor, id, null, 'project.workflow_changed', {
          before: project.workflow,
          after: workflow,
        });
        return { id, revision: revision + 1 };
      },
    );
  }

  async setMember(
    c: TaskCommand,
    id: string,
    input: { accountId: string; role: ProjectRole; active: boolean; expectedRevision: number },
  ) {
    taskUuid(input.accountId);
    if (!projectRoles.includes(input.role) || typeof input.active !== 'boolean') throw invalid();
    return this.command(
      c,
      'project.member',
      { id, input },
      async (db, actor) => {
        const access = await this.projectAccess(db, c.tenantId, id, actor, true);
        const { project } = access;
        if (project.archived || input.accountId === project.owner_account_id) throw invalid();
        let target: TaskActor | null = null;
        if (input.active) {
          target = await this.directory.actor(c.tenantId, input.accountId);
          const permission = input.role === 'viewer' ? 'tasks:view' : 'tasks:work';
          if (
            !target ||
            !taskUnitMember(target, c.tenantId, project.org_unit_id) ||
            !taskAllowed(target, c.tenantId, project.org_unit_id, permission)
          )
            throw new HttpError(400, 'TASKS_MEMBER_UNAVAILABLE');
        }
        return { access, target };
      },
      async (db, actor, { access, target }) => {
        expected(access.project.revision, input.expectedRevision);
        if (target)
          await db.query(
            `INSERT INTO task_project_members(tenant_id,project_id,account_id,person_id,name,role)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,project_id,account_id) DO UPDATE
           SET person_id=excluded.person_id,name=excluded.name,role=excluded.role,active=true,changed_at=now()`,
            [c.tenantId, id, target.accountId, target.personId, target.name, input.role],
          );
        else if (
          !(
            await db.query(
              'UPDATE task_project_members SET active=false,changed_at=now() WHERE (tenant_id,project_id,account_id)=($1,$2,$3) AND active',
              [c.tenantId, id, input.accountId],
            )
          ).rowCount
        )
          throw notFound();
        await db.query(
          'UPDATE task_projects SET revision=revision+1,updated_at=now() WHERE (tenant_id,id)=($1,$2)',
          [c.tenantId, id],
        );
        await this.audit(db, c, actor, id, null, 'project.member_changed', {
          accountId: input.accountId,
          role: input.role,
          active: input.active,
        });
        return { id, revision: access.project.revision + 1 };
      },
    );
  }
  private async getTask(db: Db, tenant: string, id: string) {
    taskUuid(id);
    const { rows } = await db.query<Task>(
      `SELECT ${taskColumns} FROM task_items t WHERE (t.tenant_id,t.id)=($1,$2)`,
      [tenant, id],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  private async taskAccess(
    db: Db,
    tenant: string,
    id: string,
    actor: TaskActor,
    snapshot?: Task,
  ): Promise<TaskAccess> {
    const task = snapshot ?? (await this.getTask(db, tenant, id));
    const access = await this.projectAccess(db, tenant, task.project_id, actor);
    if (!access.wide && !owner(actor, task) && !assigned(actor, task)) {
      const participant = await db.query(
        'SELECT 1 FROM task_participants WHERE (tenant_id,task_id,account_id,person_id)=($1,$2,$3,$4) AND active',
        [tenant, id, actor.accountId, actor.personId],
      );
      if (!participant.rowCount) throw taskDenied();
    }
    return { ...access, task, ...taskControls(access, actor, task) };
  }

  async tasks(c: TaskContext, projectId: string, filters: TaskFilters = {}) {
    const actor = await this.actor(c);
    const access = await this.projectAccess(this.pool, c.tenantId, projectId, actor);
    if (filters.status !== undefined && !taskStatuses.includes(filters.status)) throw invalid();
    if (filters.stageCode !== undefined && !validStageCode(filters.stageCode)) throw invalid();
    if (filters.assigneeId !== undefined) taskUuid(filters.assigneeId);
    if (filters.after !== undefined) taskUuid(filters.after);
    const search = text(filters.search ?? '', 120);
    const { rows } = await this.pool.query<Task>(
      `WITH eligible AS (
        SELECT ${taskColumns} FROM task_items t WHERE ${visibleTask}
          AND ($6::text='' OR position(lower($6) in lower(t.title))>0)
          AND ($7::text IS NULL OR t.status=$7)
          AND ($8::uuid IS NULL OR t.assignee_account_id=$8)
          AND (NOT $9::boolean OR (t.due_on<$11::date AND t.status<>'done'))
          AND (NOT $10::boolean OR (t.assignee_account_id,t.assignee_person_id)=($4::uuid,$5::uuid))
          AND ($13::text IS NULL OR COALESCE(t.stage_code,t.status)=$13)
      )
      SELECT * FROM eligible WHERE ($12::uuid IS NULL OR (updated_at,id)<(SELECT updated_at,id FROM eligible WHERE id=$12))
      ORDER BY updated_at DESC,id DESC LIMIT 101`,
      [
        ...baseScope(access, actor),
        search,
        filters.status ?? null,
        filters.assigneeId ?? null,
        filters.overdue === true,
        filters.mine === true,
        date(),
        filters.after ?? null,
        filters.stageCode ?? null,
      ],
    );
    const page = rows.slice(0, 100);
    return {
      items: page.map((row) => taskDto(access, actor, row)),
      nextAfter: rows.length > 100 ? page.at(-1)!.id : null,
    };
  }

  async taskDetails(c: TaskContext, id: string): Promise<TaskDetail> {
    const actor = await this.actor(c);
    const access = await this.taskAccess(this.pool, c.tenantId, id, actor);
    const [participants, children, comments, history] = await Promise.all([
      this.pool.query<{ accountId: string; personId: string; name: string }>(
        `SELECT p.account_id AS "accountId",p.person_id AS "personId",p.name FROM task_participants p
         JOIN task_project_members m ON (m.tenant_id,m.project_id,m.account_id,m.person_id)=(p.tenant_id,p.project_id,p.account_id,p.person_id)
         WHERE (p.tenant_id,p.task_id)=($1,$2) AND p.active AND m.active ORDER BY p.name,p.account_id`,
        [c.tenantId, id],
      ),
      this.pool.query<Task>(
        `SELECT ${taskColumns} FROM task_items t WHERE ${visibleTask} AND t.parent_id=$6 ORDER BY t.created_at,t.id LIMIT 100`,
        [...baseScope(access, actor), id],
      ),
      this.pool.query<{ id: string; author: string; body: string; createdAt: Date }>(
        `SELECT id,author_name AS author,body,created_at AS "createdAt" FROM (
           SELECT * FROM task_comments WHERE (tenant_id,task_id)=($1,$2) ORDER BY created_at DESC,id DESC LIMIT 100
         ) latest ORDER BY created_at,id`,
        [c.tenantId, id],
      ),
      this.pool.query<{
        id: string;
        actor: string;
        action: string;
        reason: string;
        occurredAt: Date;
        details: Record<string, unknown>;
      }>(
        `SELECT id::text,actor_name AS actor,action,reason,occurred_at AS "occurredAt",details FROM task_audit
         WHERE (tenant_id,task_id)=($1,$2) ORDER BY task_audit.id DESC LIMIT 100`,
        [c.tenantId, id],
      ),
    ]);
    return {
      item: taskDto(access, actor, access.task),
      participants: participants.rows,
      children: children.rows.map((row) => taskDto(access, actor, row)),
      comments: comments.rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      history: history.rows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
    };
  }

  async saveTask(
    c: TaskCommand,
    projectId: string,
    input: TaskInput,
    options: { id?: string; parentId?: string; revision?: number } = {},
  ) {
    const title = text(input.title, 200, true),
      description = text(input.description, 10000);
    if (
      (input.dueOn !== null && !isDate(input.dueOn)) ||
      (input.remindDays !== null &&
        (input.dueOn === null ||
          !(reminderOffsets as readonly number[]).includes(input.remindDays))) ||
      !Array.isArray(input.participantIds) ||
      input.participantIds.length > 30 ||
      new Set(input.participantIds).size !== input.participantIds.length ||
      (options.id && options.parentId)
    )
      throw invalid();
    type State = {
      access: ProjectAccess;
      task: Task | null;
      assignee: TaskActor | null;
      participants: TaskActor[];
    };
    return this.command<State, { id: string; projectId: string; revision: number }>(
      c,
      'task.save',
      { projectId, input, options },
      async (db, actor, prior) => {
        const access = await this.projectAccess(db, c.tenantId, projectId, actor);
        if (!access.work || access.project.archived) throw taskDenied();
        const task = options.id
          ? (await this.taskAccess(db, c.tenantId, options.id, actor, prior?.task ?? undefined))
              .task
          : null;
        if (task && (task.project_id !== projectId || !taskControls(access, actor, task).edit))
          throw taskDenied();
        if (task?.status === 'done' && task.assignee_account_id !== input.assigneeId)
          throw new HttpError(409, 'TASKS_DONE');
        if (options.parentId) {
          const parent = await this.taskAccess(db, c.tenantId, options.parentId, actor);
          if (parent.task.project_id !== projectId || parent.task.parent_id || !parent.progress)
            throw taskDenied();
        }
        const assignee =
          input.assigneeId === null
            ? null
            : await this.currentMember(db, access.project, input.assigneeId, true);
        const participants = await Promise.all(
          input.participantIds.map((id) => this.currentMember(db, access.project, id)),
        );
        return { access, task, assignee, participants };
      },
      async (db, actor, { task, assignee, participants }) => {
        const id = task?.id ?? randomUUID();
        const assigneeValues = [
          assignee?.accountId ?? null,
          assignee?.personId ?? null,
          assignee?.name ?? null,
        ];
        if (task) {
          expected(task.revision, options.revision);
          await db.query(
            `UPDATE task_items SET title=$3,description=$4,due_on=$5,remind_days=$6,
             assignee_account_id=$7,assignee_person_id=$8,assignee_name=$9,revision=revision+1,updated_at=now(),
             assignment_generation=assignment_generation+CASE WHEN (assignee_account_id,assignee_person_id)
                 IS DISTINCT FROM ($7::uuid,$8::uuid) THEN 1 ELSE 0 END
             WHERE (tenant_id,id)=($1,$2)`,
            [c.tenantId, id, title, description, input.dueOn, input.remindDays, ...assigneeValues],
          );
        } else
          await db.query(
            `INSERT INTO task_items(id,tenant_id,project_id,parent_id,title,description,due_on,remind_days,
             creator_account_id,creator_person_id,creator_name,assignee_account_id,assignee_person_id,assignee_name)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              id,
              c.tenantId,
              projectId,
              options.parentId ?? null,
              title,
              description,
              input.dueOn,
              input.remindDays,
              actor.accountId,
              actor.personId,
              actor.name,
              ...assigneeValues,
            ],
          );
        await db.query(
          'UPDATE task_participants SET active=false WHERE (tenant_id,task_id)=($1,$2) AND active AND NOT(account_id=ANY($3::uuid[]))',
          [c.tenantId, id, input.participantIds],
        );
        for (const member of participants)
          await db.query(
            `INSERT INTO task_participants(tenant_id,project_id,task_id,account_id,person_id,name)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,task_id,account_id) DO UPDATE
           SET person_id=excluded.person_id,name=excluded.name,active=true`,
            [c.tenantId, projectId, id, member.accountId, member.personId, member.name],
          );
        await this.audit(db, c, actor, projectId, id, task ? 'task.updated' : 'task.created', {
          dueOn: input.dueOn,
          assignee: assignee?.name ?? null,
          previousAssignee: task?.assignee_name ?? null,
          participants: participants.length,
          parentId: task?.parent_id ?? options.parentId ?? null,
        });
        return { id, projectId, revision: (task?.revision ?? 0) + 1 };
      },
    );
  }

  async progress(
    c: TaskCommand,
    id: string,
    input: { status: TaskStatus; progress: number; expectedRevision: number; stageCode?: string },
  ) {
    if (
      !taskStatuses.includes(input.status) ||
      (input.stageCode !== undefined && !validStageCode(input.stageCode)) ||
      !Number.isInteger(input.progress) ||
      input.progress < 0 ||
      input.progress > 100 ||
      (input.status === 'todo' && input.progress !== 0) ||
      (input.status === 'done') !== (input.progress === 100)
    )
      throw invalid();
    return this.command<
      TaskAccess & { stage: string | null },
      { id: string; projectId: string; revision: number }
    >(
      c,
      'task.progress',
      { id, input },
      async (db, actor, prior) => {
        const access = await this.taskAccess(db, c.tenantId, id, actor, prior?.task);
        if (!access.progress) throw taskDenied();
        const workflow = access.project.workflow;
        const from = access.task.stage_code ?? access.task.status;
        const to = input.stageCode ?? (input.status === access.task.status ? from : input.status);
        if (workflow) {
          if (!workflow.stages.some(({ code, phase }) => code === to && phase === input.status))
            throw invalid();
          if (from !== to && !allowedTaskStages(workflow, from, access.role).includes(to))
            throw new HttpError(403, 'TASKS_TRANSITION_DENIED');
        } else if (to !== input.status) throw invalid();
        return { ...access, stage: workflow && to !== input.status ? to : null };
      },
      async (db, actor, { task, stage }) => {
        expected(task.revision, input.expectedRevision);
        if (task.status !== input.status || task.stage_code !== stage)
          await db.query("SELECT set_config('aio_tasks.workflow_write','v2',true)");
        await db.query(
          `UPDATE task_items SET status=$3,progress=$4,stage_code=$5,revision=revision+1,updated_at=now(),
           completed_at=CASE WHEN $3='done' THEN COALESCE(completed_at,now()) END WHERE (tenant_id,id)=($1,$2)`,
          [c.tenantId, id, input.status, input.progress, stage],
        );
        await this.audit(db, c, actor, task.project_id, id, 'task.progress', {
          before: {
            status: task.status,
            progress: task.progress,
            ...(task.stage_code && { stageCode: task.stage_code }),
          },
          after: {
            status: input.status,
            progress: input.progress,
            ...(stage && { stageCode: stage }),
          },
        });
        return { id, projectId: task.project_id, revision: task.revision + 1 };
      },
    );
  }

  async handoff(c: TaskCommand, id: string, assigneeId: string | null, revision: number) {
    type State = TaskAccess & { target: TaskActor | null };
    return this.command<State, { id: string; projectId: string; revision: number }>(
      c,
      'task.handoff',
      { id, assigneeId, revision },
      async (db, actor, prior) => {
        const access = await this.taskAccess(db, c.tenantId, id, actor, prior?.task);
        if (access.progress && access.task.status === 'done')
          throw new HttpError(409, 'TASKS_DONE');
        if (!access.handoff) throw taskDenied();
        const target =
          assigneeId === null
            ? null
            : await this.currentMember(db, access.project, assigneeId, true);
        return { ...access, target };
      },
      async (db, actor, { task, target }) => {
        expected(task.revision, revision);
        if (
          (target?.accountId ?? null) === task.assignee_account_id &&
          (target?.personId ?? null) === task.assignee_person_id
        )
          throw new HttpError(409, 'TASKS_ALREADY_ASSIGNED');
        await db.query(
          `UPDATE task_items SET assignee_account_id=$3,assignee_person_id=$4,assignee_name=$5,
           assignment_generation=assignment_generation+1,revision=revision+1,updated_at=now() WHERE (tenant_id,id)=($1,$2)`,
          [
            c.tenantId,
            id,
            target?.accountId ?? null,
            target?.personId ?? null,
            target?.name ?? null,
          ],
        );
        await this.audit(db, c, actor, task.project_id, id, 'task.handoff', {
          from: task.assignee_name,
          to: target?.name ?? null,
        });
        return { id, projectId: task.project_id, revision: task.revision + 1 };
      },
    );
  }

  async comment(c: TaskCommand, id: string, body: string) {
    const content = text(body, 3000, true);
    return this.command<TaskAccess, { id: string; taskId: string }>(
      c,
      'task.comment',
      { id, content },
      async (db, actor, prior) => {
        const access = await this.taskAccess(db, c.tenantId, id, actor, prior?.task);
        if (!access.work || access.project.archived) throw taskDenied();
        return access;
      },
      async (db, actor, { task }) => {
        const comment = randomUUID();
        await db.query(
          `INSERT INTO task_comments(id,tenant_id,project_id,task_id,author_account_id,author_person_id,author_name,body)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            comment,
            c.tenantId,
            task.project_id,
            id,
            actor.accountId,
            actor.personId,
            actor.name,
            content,
          ],
        );
        await this.audit(db, c, actor, task.project_id, id, 'task.comment', { commentId: comment });
        return { id: comment, taskId: id };
      },
    );
  }

  async report(c: TaskContext, id: string): Promise<TaskReport> {
    const actor = await this.actor(c);
    const access = await this.projectAccess(this.pool, c.tenantId, id, actor);
    if (!access.report) throw taskDenied();
    const { rows } = await this.pool.query<{
      total: number;
      overdue: number;
      done: number;
      todo: number;
      doing: number;
      on_time: number;
      is_total: boolean;
      accountId: string | null;
      name: string;
    }>(
      `SELECT count(*)::integer AS total,count(*) FILTER(WHERE t.status='done')::integer AS done,
       count(*) FILTER(WHERE t.status='todo')::integer AS todo,count(*) FILTER(WHERE t.status='doing')::integer AS doing,
       count(*) FILTER(WHERE t.due_on<$6::date AND t.status<>'done')::integer AS overdue,
       count(*) FILTER(WHERE t.status='done' AND t.due_on IS NOT NULL AND
         (t.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date<=t.due_on)::integer AS on_time,
       GROUPING(t.assignee_account_id)=1 AS is_total,t.assignee_account_id AS "accountId",
       COALESCE(max(t.assignee_name),'Chưa giao') AS name
       FROM task_items t WHERE ${visibleTask}
       GROUP BY GROUPING SETS((),(t.assignee_account_id)) ORDER BY is_total DESC,total DESC,name,"accountId"`,
      [...baseScope(access, actor), date()],
    );
    const total = rows[0]!;
    return {
      total: total.total,
      overdue: total.overdue,
      completedOnTime: total.on_time,
      percentDone: total.total ? Math.round((total.done * 100) / total.total) : 0,
      statuses: { todo: total.todo, doing: total.doing, done: total.done },
      people: rows.slice(1).map(({ accountId, name, total, done, overdue }) => ({
        accountId,
        name,
        total,
        done,
        overdue,
      })),
    };
  }

  async runReminders(at = new Date()) {
    const today = date(at);
    let created = 0;
    let cursor: { due_on: string; id: string } | null = null;
    const db = await this.pool.connect();
    try {
      for (;;) {
        await db.query('BEGIN');
        type Candidate = {
          id: string;
          tenant_id: string;
          project_id: string;
          org_unit_id: string;
          due_on: string;
          assignee_account_id: string;
          assignee_person_id: string;
          assignment_generation: number;
          kind: 'due' | 'overdue';
        };
        const batch: Candidate[] = (
          await db.query<Candidate>(
            `SELECT t.id,t.tenant_id,t.project_id,p.org_unit_id,t.due_on::text,t.assignee_account_id,t.assignee_person_id,
            t.assignment_generation,CASE WHEN t.due_on<$1::date THEN 'overdue' ELSE 'due' END AS kind
           FROM task_items t JOIN task_projects p ON (p.tenant_id,p.id)=(t.tenant_id,t.project_id)
           JOIN task_project_members m ON (m.tenant_id,m.project_id,m.account_id,m.person_id)=
             (t.tenant_id,t.project_id,t.assignee_account_id,t.assignee_person_id) AND m.active AND m.role<>'viewer'
           WHERE NOT p.archived AND t.status<>'done' AND t.remind_days IS NOT NULL AND t.due_on-t.remind_days<=$1::date
             AND ($2::date IS NULL OR (t.due_on,t.id)>($2,$3::uuid))
             AND NOT EXISTS(SELECT 1 FROM task_reminders r WHERE
               (r.tenant_id,r.task_id,r.assignment_generation,r.due_on,r.kind)=
               (t.tenant_id,t.id,t.assignment_generation,t.due_on,CASE WHEN t.due_on<$1::date THEN 'overdue' ELSE 'due' END))
           ORDER BY t.due_on,t.id LIMIT 50 FOR UPDATE OF t SKIP LOCKED`,
            [today, cursor?.due_on ?? null, cursor?.id ?? null],
          )
        ).rows;
        const actors = new Map<string, TaskActor | null>();
        for (const task of batch) {
          const key = task.tenant_id + '/' + task.assignee_account_id;
          if (!actors.has(key))
            actors.set(key, await this.directory.actor(task.tenant_id, task.assignee_account_id));
          const target = actors.get(key);
          if (
            !target ||
            target.personId !== task.assignee_person_id ||
            !taskUnitMember(target, task.tenant_id, task.org_unit_id) ||
            !taskAllowed(target, task.tenant_id, task.org_unit_id, 'tasks:work')
          )
            continue;
          created +=
            (
              await db.query(
                `INSERT INTO task_reminders(id,tenant_id,project_id,task_id,due_on,assignment_generation,account_id,person_id,kind)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
                [
                  randomUUID(),
                  task.tenant_id,
                  task.project_id,
                  task.id,
                  task.due_on,
                  task.assignment_generation,
                  task.assignee_account_id,
                  task.assignee_person_id,
                  task.kind,
                ],
              )
            ).rowCount ?? 0;
        }
        await db.query('COMMIT');
        if (batch.length < 50) break;
        cursor = batch.at(-1)!;
      }
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
    return { created };
  }

  async reminders(c: TaskContext) {
    const actor = await this.actor(c);
    const { rows } = await this.pool.query<
      Omit<TaskWorkReminder, 'createdAt'> & { createdAt: Date }
    >(
      `SELECT r.id,r.task_id AS "taskId",r.project_id AS "projectId",t.title,r.due_on::text AS "dueOn",
         r.kind,r.created_at AS "createdAt" FROM task_reminders r
       JOIN task_items t ON (t.tenant_id,t.project_id,t.id,t.due_on,t.assignment_generation,t.assignee_account_id,t.assignee_person_id)=
         (r.tenant_id,r.project_id,r.task_id,r.due_on,r.assignment_generation,r.account_id,r.person_id)
       JOIN task_projects p ON (p.tenant_id,p.id)=(t.tenant_id,t.project_id)
       JOIN task_project_members m ON (m.tenant_id,m.project_id,m.account_id,m.person_id)=
         (r.tenant_id,r.project_id,r.account_id,r.person_id) AND m.active AND m.role<>'viewer'
       WHERE (r.tenant_id,r.account_id,r.person_id)=($1,$2,$3) AND p.org_unit_id=ANY($4::uuid[]) AND NOT p.archived
         AND t.status<>'done' AND t.remind_days IS NOT NULL AND t.due_on-t.remind_days<=$5::date
         AND r.kind=CASE WHEN t.due_on<$5::date THEN 'overdue' ELSE 'due' END
       ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
      [c.tenantId, actor.accountId, actor.personId, this.workUnits(actor, c.tenantId), date()],
    );
    return { items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  }

  private workUnits(actor: TaskActor, tenant: string) {
    return actor.units.flatMap(({ tenantId, orgUnitId }) =>
      tenantId === tenant && taskAllowed(actor, tenant, orgUnitId, 'tasks:work') ? [orgUnitId] : [],
    );
  }

  async assignedWork(
    c: TaskContext,
    filters: { after?: string; search?: string } = {},
  ): Promise<TaskWorkPage> {
    const actor = await this.actor(c);
    if (filters.after !== undefined) taskUuid(filters.after);
    const search = text(filters.search ?? '', 120);
    const { rows } = await this.pool.query<
      Omit<TaskWorkPage['items'][number], 'stageName'> & { stageName: string | null }
    >(
      `WITH eligible AS (
        SELECT t.id,t.project_id AS "projectId",p.name AS "projectName",t.title,t.status,
          t.due_on,COALESCE(t.due_on<$5::date,false) AS overdue,
          (SELECT stage->>'name' FROM jsonb_array_elements(p.workflow->'stages') AS s(stage)
            WHERE stage->>'code'=COALESCE(t.stage_code,t.status)) AS "stageName"
        FROM task_items t JOIN task_projects p ON (p.tenant_id,p.id)=(t.tenant_id,t.project_id)
        JOIN task_project_members m ON (m.tenant_id,m.project_id,m.account_id,m.person_id)=
          (t.tenant_id,t.project_id,t.assignee_account_id,t.assignee_person_id) AND m.active AND m.role<>'viewer'
        WHERE (t.tenant_id,t.assignee_account_id,t.assignee_person_id)=($1,$2,$3)
          AND NOT p.archived AND p.org_unit_id=ANY($4::uuid[]) AND t.status<>'done'
          AND ($6::text='' OR position(lower($6) in lower(t.title))>0 OR position(lower($6) in lower(p.name))>0)
      ) SELECT id,"projectId","projectName",title,status,due_on::text AS "dueOn",overdue,"stageName"
      FROM eligible WHERE ($7::uuid IS NULL OR
        (COALESCE(due_on,'infinity'::date),id)>(SELECT COALESCE(due_on,'infinity'::date),id FROM eligible WHERE id=$7))
      ORDER BY due_on NULLS LAST,id LIMIT 26`,
      [
        c.tenantId,
        actor.accountId,
        actor.personId,
        this.workUnits(actor, c.tenantId),
        date(),
        search,
        filters.after ?? null,
      ],
    );
    const items = rows
      .slice(0, 25)
      .map(({ stageName, ...item }) => ({ ...item, ...(stageName && { stageName }) }));
    return { items, nextAfter: rows.length > items.length ? items.at(-1)!.id : null };
  }
}
