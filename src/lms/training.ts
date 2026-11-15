import { Courses } from './courses.js';
import type { CourseActor, CourseCommand } from './courses.js';
import { allowed } from './access.js';
import { LmsError, hash } from './security.js';
import { parseTrainingPath, trainingIds, trainingSchedule } from './training-contracts.js';
import type { TrainingPathSpec } from './training-contracts.js';
import type { TrainingIntakeInbox } from './training-intakes.js';
type Row = Record<string, any>;
type Participant = {
  accountId: string;
  personId: string;
  employeeId: string;
  name: string;
  unitId: string;
  unitName: string;
};
const uuid = (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
const revision = (n: unknown) => Number.isInteger(n) && Number(n) >= 0;
export class Training extends Courses {
  constructor(
    db: ConstructorParameters<typeof Courses>[0],
    authorize: ConstructorParameters<typeof Courses>[1],
    directory: ConstructorParameters<typeof Courses>[2],
    private readonly intakes?: TrainingIntakeInbox,
  ) {
    super(db, authorize, directory);
  }

  async intakeDrafts() {
    const actor = await this.actor('lms:admin');
    if (!this.intakes) throw new LmsError(503, 'LMS_TRAINING_INTAKE_SOURCE_UNAVAILABLE');
    return this.intakes.list(actor);
  }
  private async viewActor(manage: boolean) {
    if (!manage) return { actor: await this.actor('lms:learn'), permission: 'lms:learn' as const };
    try {
      return { actor: await this.actor('lms:admin'), permission: 'lms:admin' as const };
    } catch (e) {
      if (!(e instanceof LmsError && e.status === 403)) throw e;
    }
    return { actor: await this.actor('lms:review'), permission: 'lms:review' as const };
  }
  private async path(a: CourseActor, id: string) {
    if (!uuid(id)) throw new LmsError(400, 'LMS_TRAINING_INVALID');
    const row = await this.db
      .prepare('SELECT * FROM lms_learning_paths WHERE id=? AND tenant_id=?')
      .bind(id, a.link.tenant_id)
      .first<Row>();
    if (!row) throw new LmsError(404, 'LMS_TRAINING_NOT_FOUND');
    return row;
  }
  async paths(cursor?: string) {
    const a = await this.actor('lms:admin');
    if (cursor && !uuid(cursor)) throw new LmsError(400, 'LMS_TRAINING_INVALID');
    const rows = (
      await this.db
        .prepare(
          'SELECT p.*,v.version,v.spec_json FROM lms_learning_paths p LEFT JOIN lms_learning_path_versions v ON v.id=p.published_version_id WHERE p.tenant_id=? AND p.id>? ORDER BY p.id LIMIT 101',
        )
        .bind(a.link.tenant_id, cursor ?? '')
        .all<Row>()
    ).results;
    return {
      items: rows.slice(0, 100).map((r) => ({
        id: r.id,
        title: r.title,
        revision: r.revision,
        spec: parseTrainingPath(JSON.parse(r.draft_json)),
        versionId: r.published_version_id,
        version: r.version ?? 0,
        published: r.spec_json ? parseTrainingPath(JSON.parse(r.spec_json), true) : null,
      })),
      nextCursor: rows.length > 100 ? (rows[99]!.id as string) : null,
    };
  }
  async savePath(
    input: { id?: string; expectedRevision: number; spec: unknown },
    command: CourseCommand,
  ) {
    const a = await this.actor('lms:admin'),
      spec = parseTrainingPath(input.spec),
      id = input.id ?? crypto.randomUUID();
    if (
      !uuid(id) ||
      !revision(input.expectedRevision) ||
      (!input.id && input.expectedRevision !== 0)
    )
      throw new LmsError(400, 'LMS_TRAINING_INVALID');
    if (input.id) await this.path(a, id);
    const units = await this.directory.units(a.link.tenant_id);
    if (spec.audienceUnits.some((id) => !units.some((u) => u.id === id)))
      throw new LmsError(400, 'LMS_UNIT_UNAVAILABLE');
    return this.commit(a, 'lms:admin', command, 'training.path_saved', input, (operation) => ({
      statements: [
        input.id
          ? this.db
              .prepare(
                'UPDATE lms_learning_paths SET title=?,draft_json=?,revision=revision+1,last_operation_id=?,updated_at=? WHERE id=? AND tenant_id=? AND revision=?',
              )
              .bind(
                spec.title,
                JSON.stringify(spec),
                operation,
                Date.now(),
                id,
                a.link.tenant_id,
                input.expectedRevision,
              )
          : this.db
              .prepare(
                'INSERT INTO lms_learning_paths(id,tenant_id,title,draft_json,last_operation_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
              )
              .bind(
                id,
                a.link.tenant_id,
                spec.title,
                JSON.stringify(spec),
                operation,
                a.principal.accountId,
                Date.now(),
                Date.now(),
              ),
      ],
      condition:
        'EXISTS(SELECT 1 FROM lms_learning_paths WHERE id=? AND tenant_id=? AND last_operation_id=?)',
      values: [id, a.link.tenant_id, operation],
      result: { id, revision: input.expectedRevision + 1 },
      details: { id, revision: input.expectedRevision + 1 },
    }));
  }
  async publishPath(id: string, expectedRevision: number, command: CourseCommand) {
    const a = await this.actor('lms:admin'),
      path = await this.path(a, id),
      spec = parseTrainingPath(JSON.parse(path.draft_json), true);
    if (!revision(expectedRevision)) throw new LmsError(400, 'LMS_TRAINING_INVALID');
    const units = await this.directory.units(a.link.tenant_id);
    if (spec.audienceUnits.some((id) => !units.some((u) => u.id === id)))
      throw new LmsError(400, 'LMS_UNIT_UNAVAILABLE');
    const version = (await this.db
        .prepare(
          'SELECT COALESCE(max(version),0)+1 AS next FROM lms_learning_path_versions WHERE path_id=?',
        )
        .bind(id)
        .first<{ next: number }>())!.next,
      versionId = crypto.randomUUID(),
      checksum = await hash(JSON.stringify(spec));
    return this.commit(
      a,
      'lms:admin',
      command,
      'training.path_published',
      { id, expectedRevision },
      (operation) => ({
        statements: [
          this.db
            .prepare(
              'UPDATE lms_learning_paths SET published_version_id=?,revision=revision+1,last_operation_id=?,updated_at=? WHERE id=? AND tenant_id=? AND revision=?',
            )
            .bind(versionId, operation, Date.now(), id, a.link.tenant_id, expectedRevision),
          this.db
            .prepare(
              'INSERT INTO lms_learning_path_versions(id,tenant_id,path_id,version,spec_json,checksum,published_by,published_at) SELECT ?,tenant_id,id,?,?,?,?,? FROM lms_learning_paths WHERE id=? AND last_operation_id=?',
            )
            .bind(
              versionId,
              version,
              JSON.stringify(spec),
              checksum,
              a.principal.accountId,
              Date.now(),
              id,
              operation,
            ),
        ],
        condition: 'EXISTS(SELECT 1 FROM lms_learning_paths WHERE id=? AND last_operation_id=?)',
        values: [id, operation],
        result: { id, revision: expectedRevision + 1, versionId, version },
        details: { id, version, versionId, checksum },
      }),
    );
  }
  private async participants(a: CourseActor, unitId?: string): Promise<Participant[]> {
    const rows = (
      await this.db
        .prepare(
          'SELECT a.* FROM aio_account_links a JOIN employees e ON e.id=a.employee_id WHERE a.tenant_id=? AND a.active=1 AND e.is_active=1 AND (? IS NULL OR a.org_unit_id=?) AND EXISTS(SELECT 1 FROM aio_external_links x WHERE x.account_id=a.account_id AND x.active=1) ORDER BY a.account_id LIMIT 10001',
        )
        .bind(a.link.tenant_id, unitId ?? null, unitId ?? null)
        .all<Row>()
    ).results;
    if (rows.length > 10000) throw new LmsError(413, 'LMS_TRAINING_TOO_MANY');
    const scope = rows.filter(
      (r) =>
        allowed(a.principal, 'lms:admin', a.link.tenant_id) ||
        allowed(a.principal, 'lms:review', a.link.tenant_id, r.org_unit_id),
    );
    const people = await this.directory.people(
      a.link.tenant_id,
      scope.map((r) => r.account_id),
    );
    return scope.flatMap((r) => {
      const p = people.find((p) => p.accountId === r.account_id && p.personId === r.person_id),
        unit = p?.units.find((u) => u.id === r.org_unit_id);
      return p && unit
        ? [
            {
              accountId: r.account_id,
              personId: r.person_id,
              employeeId: r.employee_id,
              name: p.displayName,
              unitId: unit.id,
              unitName: unit.name,
            },
          ]
        : [];
    });
  }
  async candidates(unitId?: string) {
    const a = await this.actor('lms:admin');
    if (unitId && !uuid(unitId)) throw new LmsError(400, 'LMS_TRAINING_INVALID');
    return {
      items: (await this.participants(a, unitId)).map(({ employeeId: _, personId: __, ...p }) => p),
    };
  }
  async createBatch(
    input: {
      pathVersionId: string;
      ownerUnitId: string;
      title: string;
      startsAt: number;
      dueAt: number;
      accountIds: unknown;
      workflowIntakeId?: string;
    },
    command: CourseCommand,
  ) {
    const a = await this.actor('lms:admin'),
      schedule = trainingSchedule(input),
      ids = trainingIds(input.accountIds, 500);
    if (!uuid(input.pathVersionId) || !uuid(input.ownerUnitId))
      throw new LmsError(400, 'LMS_TRAINING_INVALID');
    let intake: Awaited<ReturnType<TrainingIntakeInbox['reference']>> | undefined;
    if (input.workflowIntakeId !== undefined) {
      if (!uuid(input.workflowIntakeId) || !this.intakes)
        throw new LmsError(400, 'LMS_TRAINING_INTAKE_INVALID');
      intake = await this.intakes.reference(a, input.workflowIntakeId);
      if (intake.unitId !== input.ownerUnitId)
        throw new LmsError(403, 'LMS_TRAINING_INTAKE_UNIT_DENIED');
    }
    const path = await this.db
      .prepare(
        'SELECT v.* FROM lms_learning_path_versions v JOIN lms_learning_paths p ON p.published_version_id=v.id WHERE v.id=? AND v.tenant_id=?',
      )
      .bind(input.pathVersionId, a.link.tenant_id)
      .first<Row>();
    if (!path) throw new LmsError(409, 'LMS_TRAINING_VERSION_STALE');
    const spec = parseTrainingPath(JSON.parse(path.spec_json), true),
      units = await this.directory.units(a.link.tenant_id);
    if (!units.some((u) => u.id === input.ownerUnitId))
      throw new LmsError(400, 'LMS_UNIT_UNAVAILABLE');
    const participants = (await this.participants(a)).filter((p) => ids.includes(p.accountId));
    if (
      participants.length !== ids.length ||
      participants.some((p) => !spec.audienceUnits.includes(p.unitId)) ||
      new Set(participants.map((p) => p.personId)).size !== participants.length
    )
      throw new LmsError(409, 'LMS_TRAINING_PARTICIPANT_CHANGED');
    const id = crypto.randomUUID(),
      createdAt = Date.now();
    return this.commit(
      a,
      'lms:admin',
      command,
      'training.batch_created',
      input,
      (operation) => ({
        statements: [
          this.db
            .prepare(
              'INSERT INTO lms_training_batches(id,tenant_id,path_version_id,owner_unit_id,title,starts_at,due_at,last_operation_id,created_by,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM lms_learning_paths WHERE tenant_id=? AND published_version_id=?)',
            )
            .bind(
              id,
              a.link.tenant_id,
              input.pathVersionId,
              input.ownerUnitId,
              schedule.title,
              schedule.startsAt,
              schedule.dueAt,
              operation,
              a.principal.accountId,
              createdAt,
              createdAt,
              a.link.tenant_id,
              input.pathVersionId,
            ),
          this.db
            .prepare(
              "INSERT INTO lms_training_enrollments(batch_id,tenant_id,account_id,person_id,employee_id,unit_id,created_at) SELECT ?,?,json_extract(value,'$.accountId'),json_extract(value,'$.personId'),json_extract(value,'$.employeeId'),json_extract(value,'$.unitId'),? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM lms_training_batches WHERE id=? AND last_operation_id=?)",
            )
            .bind(id, a.link.tenant_id, createdAt, JSON.stringify(participants), id, operation),
          ...(intake
            ? [
                this.db
                  .prepare(
                    `UPDATE lms_training_intakes SET batch_id=?,accepted_at=?
          WHERE id=? AND tenant_id=? AND recipient_account_id=? AND recipient_person_id=? AND batch_id IS NULL
            AND EXISTS(SELECT 1 FROM lms_training_batches WHERE id=? AND last_operation_id=?)`,
                  )
                  .bind(
                    id,
                    createdAt,
                    intake.id,
                    a.link.tenant_id,
                    a.principal.accountId,
                    a.principal.personId,
                    id,
                    operation,
                  ),
              ]
            : []),
        ],
        condition:
          'EXISTS(SELECT 1 FROM lms_training_batches WHERE id=? AND last_operation_id=?) AND (SELECT count(*) FROM lms_training_enrollments WHERE batch_id=?)=?' +
          (intake
            ? ' AND EXISTS(SELECT 1 FROM lms_training_intakes WHERE id=? AND tenant_id=? AND batch_id=?)'
            : ''),
        values: [
          id,
          operation,
          id,
          participants.length,
          ...(intake ? [intake.id, a.link.tenant_id, id] : []),
        ],
        result: { id, revision: 1, participants: participants.length },
        details: {
          id,
          pathVersionId: input.pathVersionId,
          startsAt: schedule.startsAt,
          dueAt: schedule.dueAt,
          participants: participants.length,
          ...(intake && {
            workflowIntakeId: intake.id,
            sourceRunId: intake.runId,
            sourceVersionId: intake.versionId,
            sourceRound: intake.round,
          }),
        },
      }),
      intake ? () => this.intakes!.verifyPending(intake!) : undefined,
    );
  }
  async updateBatch(
    input: {
      id: string;
      expectedRevision: number;
      title: string;
      startsAt: number;
      dueAt: number;
      status: 'active' | 'cancelled';
    },
    command: CourseCommand,
  ) {
    const a = await this.actor('lms:admin'),
      schedule = trainingSchedule(input);
    if (
      !uuid(input.id) ||
      !revision(input.expectedRevision) ||
      !['active', 'cancelled'].includes(input.status)
    )
      throw new LmsError(400, 'LMS_TRAINING_INVALID');
    const before = await this.db
      .prepare(
        'SELECT title,starts_at,due_at,status FROM lms_training_batches WHERE id=? AND tenant_id=?',
      )
      .bind(input.id, a.link.tenant_id)
      .first();
    if (!before) throw new LmsError(404, 'LMS_TRAINING_NOT_FOUND');
    return this.commit(a, 'lms:admin', command, 'training.batch_updated', input, (operation) => ({
      statements: [
        this.db
          .prepare(
            "UPDATE lms_training_batches SET title=?,starts_at=?,due_at=?,status=?,revision=revision+1,last_operation_id=?,updated_at=? WHERE id=? AND tenant_id=? AND revision=? AND status='active'",
          )
          .bind(
            schedule.title,
            schedule.startsAt,
            schedule.dueAt,
            input.status,
            operation,
            Date.now(),
            input.id,
            a.link.tenant_id,
            input.expectedRevision,
          ),
      ],
      condition: 'EXISTS(SELECT 1 FROM lms_training_batches WHERE id=? AND last_operation_id=?)',
      values: [input.id, operation],
      result: { id: input.id, revision: input.expectedRevision + 1, status: input.status },
      details: { id: input.id, before, after: { ...schedule, status: input.status } },
    }));
  }
  private async batchDetail(a: CourseActor, id: string, manage: boolean) {
    if (!uuid(id)) throw new LmsError(400, 'LMS_TRAINING_INVALID');
    const batch = await this.db
      .prepare(
        'SELECT b.*,v.version,v.spec_json FROM lms_training_batches b JOIN lms_learning_path_versions v ON v.id=b.path_version_id WHERE b.id=? AND b.tenant_id=?',
      )
      .bind(id, a.link.tenant_id)
      .first<Row>();
    if (!batch) throw new LmsError(404, 'LMS_TRAINING_NOT_FOUND');
    const enrolled = (
      await this.db
        .prepare('SELECT * FROM lms_training_enrollments WHERE batch_id=? AND tenant_id=?')
        .bind(id, a.link.tenant_id)
        .all<Row>()
    ).results;
    const candidates = manage
      ? await this.participants(a)
      : [
          {
            accountId: a.principal.accountId,
            personId: a.principal.personId,
            employeeId: a.link.employee_id,
            name: a.principal.displayName,
            unitId: a.link.org_unit_id,
            unitName:
              a.principal.units.find((u) => u.orgUnitId === a.link.org_unit_id)?.name ??
              a.link.department,
          },
        ];
    const spec = parseTrainingPath(JSON.parse(batch.spec_json), true);
    const visible = candidates.filter(
      (p) =>
        spec.audienceUnits.includes(p.unitId) &&
        enrolled.some(
          (e) =>
            e.account_id === p.accountId &&
            e.person_id === p.personId &&
            e.employee_id === p.employeeId,
        ),
    );
    if (
      (!manage && (batch.status !== 'active' || !visible.length)) ||
      (manage &&
        !visible.length &&
        !allowed(a.principal, 'lms:admin', a.link.tenant_id) &&
        !allowed(a.principal, 'lms:review', a.link.tenant_id, batch.owner_unit_id))
    )
      throw new LmsError(404, 'LMS_TRAINING_NOT_FOUND');
    const rows = (
      await this.db
        .prepare(
          "SELECT e.employee_id,step.value AS version_id,step.key AS ordinal,v.version,json_extract(v.spec_json,'$.title') AS title,c.status,json_extract(v.spec_json,'$.audienceUnits') AS audience,EXISTS(SELECT 1 FROM lms_attempts a WHERE a.employee_id=e.employee_id AND a.version_id=v.id AND json_extract(a.snapshot_json,'$.passed')=1) AS passed FROM lms_training_enrollments e JOIN lms_training_batches b ON b.id=e.batch_id JOIN lms_learning_path_versions pv ON pv.id=b.path_version_id JOIN json_each(pv.spec_json,'$.courseVersionIds') step JOIN lms_course_versions v ON v.id=step.value JOIN lms_courses c ON c.id=v.course_id WHERE e.batch_id=? AND e.employee_id IN(SELECT value FROM json_each(?)) ORDER BY e.employee_id,CAST(step.key AS INTEGER)",
        )
        .bind(id, JSON.stringify(visible.map((p) => p.employeeId)))
        .all<Row>()
    ).results;
    const members = visible.map((p) => {
      const courses = rows
        .filter((r) => r.employee_id === p.employeeId)
        .map((r) => ({
          versionId: r.version_id as string,
          title: r.title as string,
          version: r.version as number,
          passed: !!r.passed,
          available:
            r.status === 'active' && (JSON.parse(r.audience) as string[]).includes(p.unitId),
        }));
      const completed = courses.length > 0 && courses.every((c) => c.passed);
      return {
        accountId: p.accountId,
        name: p.name,
        unitId: p.unitId,
        unitName: p.unitName,
        courses,
        completed,
        progress: Math.round((courses.filter((c) => c.passed).length / courses.length) * 100),
        overdue: batch.status === 'active' && !completed && Date.now() > batch.due_at,
      };
    });
    return {
      id: batch.id as string,
      title: batch.title as string,
      revision: batch.revision as number,
      status: batch.status as 'active' | 'cancelled',
      startsAt: batch.starts_at as number,
      dueAt: batch.due_at as number,
      pathVersionId: batch.path_version_id as string,
      pathTitle: spec.title,
      pathVersion: batch.version as number,
      members,
      summary: {
        participants: members.length,
        completed: members.filter((m) => m.completed).length,
        overdue: members.filter((m) => m.overdue).length,
      },
      canManage: allowed(a.principal, 'lms:admin', a.link.tenant_id),
    };
  }
  async batch(id: string, manage = false) {
    const { actor } = await this.viewActor(manage);
    return this.batchDetail(actor, id, manage);
  }
  async batches(manage = false, cursor?: string) {
    const { actor: a } = await this.viewActor(manage);
    if (cursor && !uuid(cursor)) throw new LmsError(400, 'LMS_TRAINING_INVALID');
    const scope = a.principal.permissions
        .filter((p) => p.tenantId === a.link.tenant_id && p.permission === 'lms:review')
        .map((p) => p.orgUnitId),
      all = allowed(a.principal, 'lms:admin', a.link.tenant_id) || scope.includes(null);
    const rows = (
      await this.db
        .prepare(
          "SELECT b.id FROM lms_training_batches b WHERE b.tenant_id=? AND b.id>? AND ((?=0 AND b.status='active' AND EXISTS(SELECT 1 FROM lms_training_enrollments e WHERE e.batch_id=b.id AND e.employee_id=? AND e.account_id=? AND e.person_id=?)) OR (?=1 AND (?=1 OR b.owner_unit_id IN(SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM lms_training_enrollments e JOIN aio_account_links a ON a.employee_id=e.employee_id WHERE e.batch_id=b.id AND a.tenant_id=b.tenant_id AND a.active=1 AND a.org_unit_id IN(SELECT value FROM json_each(?)))))) ORDER BY b.id LIMIT 26",
        )
        .bind(
          a.link.tenant_id,
          cursor ?? '',
          Number(manage),
          a.link.employee_id,
          a.principal.accountId,
          a.principal.personId,
          Number(manage),
          Number(all),
          JSON.stringify(scope),
          JSON.stringify(scope),
        )
        .all<{ id: string }>()
    ).results;
    const items = [];
    for (const row of rows.slice(0, 25)) {
      try {
        items.push(await this.batchDetail(a, row.id, manage));
      } catch (e) {
        if (!(e instanceof LmsError && e.status === 404)) throw e;
      }
    }
    return { items, nextCursor: rows.length > 25 ? rows[24]!.id : null };
  }
}
