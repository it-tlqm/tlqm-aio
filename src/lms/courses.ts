import { learningPolicy, completedCheckpoints, assessmentWindow } from './learning-policy.js';
import { LmsError, hash } from './security.js';
import type { D1Database, D1Statement, MediaRecord } from './types.js';
import { requirePermission } from './access.js';
import type { LmsPrincipal, LmsLink } from './access.js';
import {
  parseCourse,
  publicCourse,
  validAnswer,
  checkAnswer,
  gradeCourse,
} from './course-contracts.js';
import type { CourseSpec, Answer, AssessmentSnapshot } from './course-contracts.js';
import { certificateCode } from './achievement-contracts.js';
import type { Certificate } from './achievement-contracts.js';
import type { LmsDirectory } from './directory.js';
import { listCursor, encodeListCursor, LMS_PAGE_SIZE } from './list-cursor.js';

export type CourseActor = {
  principal: LmsPrincipal;
  link: LmsLink;
  sessionHash: string | null;
  requestId?: string;
};
export type CourseAuthorization = () => Promise<CourseActor>;
type CourseRow = {
  id: string;
  tenant_id: string;
  owner_unit_id: string;
  code: string;
  draft_json: string;
  revision: number;
  published_version_id: string | null;
  status: 'active' | 'archived';
  created_at: number;
  updated_at: number;
};
type VersionRow = {
  id: string;
  course_id: string;
  version: number;
  spec_json: string;
  checksum: string;
  published_at: number;
  tenant_id: string;
  owner_unit_id: string;
  status: string;
  published_version_id: string | null;
};
type ProgressRow = {
  id: string;
  position: number;
  watched: number;
  answers_json: string;
  finished: number;
  revision: number;
  updated_at: number;
};
export type CourseCommand = { key: string; reason: string };
const id = (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const revision = (value: unknown) => Number.isInteger(value) && Number(value) >= 0;
function request(condition: unknown, code = 'INVALID_REQUEST'): asserts condition {
  if (!condition) throw new LmsError(400, code);
}
/** SSO is checked for every read/write, then again immediately before each atomic D1 batch. */
export class Courses {
  constructor(
    protected readonly db: D1Database,
    private readonly authorize: CourseAuthorization,
    protected readonly directory: LmsDirectory,
  ) {}
  protected async actor(permission: 'lms:learn' | 'lms:admin' | 'lms:review') {
    const actor = await this.authorize();
    requirePermission(actor.principal, actor.link, permission);
    return actor;
  }
  private async validateUnits(actor: CourseActor, owner: string, audience: string[]) {
    const units = await this.directory.units(actor.link.tenant_id);
    if (![owner, ...audience].every((id) => units.some((unit) => unit.id === id)))
      throw new LmsError(400, 'LMS_UNIT_UNAVAILABLE');
  }
  protected async course(actor: CourseActor, courseId: string) {
    const row = await this.db
      .prepare('SELECT * FROM lms_courses WHERE id=? AND tenant_id=?')
      .bind(courseId, actor.link.tenant_id)
      .first<CourseRow>();
    if (!row) throw new LmsError(404, 'LMS_COURSE_NOT_FOUND');
    return row;
  }
  private async version(actor: CourseActor, versionId: string, admin = false) {
    const row = await this.db
      .prepare(
        'SELECT v.*,c.tenant_id,c.owner_unit_id,c.status,c.published_version_id FROM lms_course_versions v JOIN lms_courses c ON c.id=v.course_id WHERE v.id=? AND c.tenant_id=?',
      )
      .bind(versionId, actor.link.tenant_id)
      .first<VersionRow>();
    if (!row) throw new LmsError(404, 'LMS_COURSE_NOT_FOUND');
    const spec = parseCourse(JSON.parse(row.spec_json), true);
    if (!admin && (row.status !== 'active' || !spec.audienceUnits.includes(actor.link.org_unit_id)))
      throw new LmsError(403, 'LMS_COURSE_UNAVAILABLE');
    if (
      !admin &&
      spec.policy?.prerequisiteVersionIds.length &&
      (await this.unmetPrerequisites(actor, versionId))
    )
      throw new LmsError(409, 'LMS_PREREQUISITES_REQUIRED');
    return { row, spec };
  }
  private async unmetPrerequisites(actor: CourseActor, versionId: string) {
    const result = await this.db
      .prepare(
        "SELECT count(*) AS count FROM lms_course_versions v JOIN json_each(v.spec_json,'$.policy.prerequisiteVersionIds') p WHERE v.id=? AND NOT EXISTS(SELECT 1 FROM lms_attempts a WHERE a.employee_id=? AND a.version_id=p.value AND json_extract(a.snapshot_json,'$.passed')=1)",
      )
      .bind(versionId, actor.link.employee_id)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }
  private async progress(actor: CourseActor, versionId: string) {
    return this.db
      .prepare('SELECT * FROM lms_progress WHERE employee_id=? AND version_id=?')
      .bind(actor.link.employee_id, versionId)
      .first<ProgressRow>();
  }
  private async receipt(actor: CourseActor, command: CourseCommand, requestHash: string) {
    const old = await this.db
      .prepare(
        'SELECT request_hash,response_json FROM lms_course_receipts WHERE actor_account_id=? AND command_key=?',
      )
      .bind(actor.principal.accountId, command.key)
      .first<{ request_hash: string; response_json: string }>();
    if (!old) return null;
    if (old.request_hash !== requestHash) throw new LmsError(409, 'IDEMPOTENCY_KEY_REUSED');
    return JSON.parse(old.response_json) as Record<string, unknown>;
  }
  protected async replayCommand<T>(
    actor: CourseActor,
    command: CourseCommand,
    action: string,
    payload: unknown,
  ): Promise<T | null> {
    request(
      /^[A-Za-z0-9-]{16,80}$/.test(command.key) &&
        typeof command.reason === 'string' &&
        command.reason.trim().length >= 5 &&
        command.reason.length <= 300,
      'REASON_REQUIRED',
    );
    return (await this.receipt(
      actor,
      command,
      await hash(
        JSON.stringify({ action, payload, tenantId: actor.link.tenant_id, reason: command.reason }),
      ),
    )) as T | null;
  }
  protected async commit<T extends Record<string, unknown>>(
    actor: CourseActor,
    permission: 'lms:learn' | 'lms:admin' | 'lms:review',
    command: CourseCommand,
    action: string,
    payload: unknown,
    build: (operation: string) => {
      statements: D1Statement[];
      condition: string;
      values: (string | number | null)[];
      result: T;
      details: Record<string, unknown>;
    },
    beforeWrite?: () => Promise<void>,
  ): Promise<T> {
    // Delegated Portal actors are read-only and never create or borrow an LMS session.
    if (!actor.sessionHash) throw new LmsError(403, 'LMS_PORTAL_READ_ONLY');
    request(
      /^[A-Za-z0-9-]{16,80}$/.test(command.key) &&
        typeof command.reason === 'string' &&
        command.reason.trim().length >= 5 &&
        command.reason.length <= 300,
      'REASON_REQUIRED',
    );
    const requestHash = await hash(
      JSON.stringify({ action, payload, tenantId: actor.link.tenant_id, reason: command.reason }),
    );
    const fresh = await this.actor(permission);
    if (
      fresh.principal.accountId !== actor.principal.accountId ||
      fresh.link.tenant_id !== actor.link.tenant_id ||
      fresh.link.org_unit_id !== actor.link.org_unit_id ||
      fresh.sessionHash !== actor.sessionHash ||
      (action === 'report.exported' &&
        JSON.stringify(fresh.principal.permissions.map((value) => JSON.stringify(value)).sort()) !==
          JSON.stringify(actor.principal.permissions.map((value) => JSON.stringify(value)).sort()))
    )
      throw new LmsError(401, 'SESSION_IDENTITY_CHANGED');
    const existing = await this.receipt(actor, command, requestHash);
    if (existing) return existing as T;
    await beforeWrite?.();
    const operation = crypto.randomUUID(),
      change = build(operation),
      now = Date.now();
    const guard = this.db
      .prepare(
        `INSERT INTO lms_write_guards(operation_id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM aio_sessions s JOIN aio_account_links a ON a.account_id=s.account_id JOIN employees e ON e.id=a.employee_id JOIN aio_external_links x ON x.account_id=a.account_id AND x.issuer=s.issuer AND x.subject=s.subject WHERE s.hash=? AND s.account_id=? AND a.employee_id=? AND a.tenant_id=? AND a.org_unit_id=? AND a.active=1 AND x.active=1 AND e.is_active=1 AND (e.credential_kind='sso-only' OR ?='lms:learn' OR e.role='admin' OR (?='lms:review' AND e.role='manager')) AND s.authenticated_at>a.auth_not_before AND s.absolute_expires_at>? AND s.idle_expires_at>? AND (SELECT enabled FROM aio_adapter_control WHERE id=1)=1) THEN 1 ELSE 0 END)`,
      )
      .bind(
        operation,
        actor.sessionHash,
        actor.principal.accountId,
        actor.link.employee_id,
        actor.link.tenant_id,
        actor.link.org_unit_id,
        permission,
        permission,
        now,
        now,
      );
    const versionId =
      permission === 'lms:learn' && payload && typeof payload === 'object'
        ? (payload as { versionId?: string }).versionId
        : undefined;
    const courseGuard = versionId
      ? [
          this.db
            .prepare(
              `INSERT INTO lms_write_guards(operation_id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM lms_course_versions v JOIN lms_courses c ON c.id=v.course_id WHERE v.id=? AND c.tenant_id=? AND c.status='active' AND EXISTS(SELECT 1 FROM json_each(v.spec_json,'$.audienceUnits') WHERE value=?) AND NOT EXISTS(SELECT 1 FROM json_each(v.spec_json,'$.policy.prerequisiteVersionIds') prereq WHERE NOT EXISTS(SELECT 1 FROM lms_attempts a WHERE a.version_id=prereq.value AND a.employee_id=? AND json_extract(a.snapshot_json,'$.passed')=1))) THEN 1 ELSE 0 END)`,
            )
            .bind(
              operation + ':course',
              versionId,
              actor.link.tenant_id,
              actor.link.org_unit_id,
              actor.link.employee_id,
            ),
        ]
      : [];
    try {
      await this.db.batch([
        guard,
        ...courseGuard,
        ...change.statements,
        this.db
          .prepare(
            'INSERT INTO lms_write_guards(operation_id,valid) VALUES (?,CASE WHEN (' +
              change.condition +
              ') THEN 1 ELSE 0 END)',
          )
          .bind(operation + ':changed', ...change.values),
        this.db
          .prepare(
            'INSERT INTO aio_audit(event_id,occurred_at,actor_account_id,subject_account_id,employee_id,tenant_id,action,reason,request_id,details) VALUES (?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            operation,
            now,
            actor.principal.accountId,
            actor.principal.accountId,
            actor.link.employee_id,
            actor.link.tenant_id,
            action,
            command.reason,
            actor.requestId ?? operation,
            JSON.stringify(change.details),
          ),
        this.db
          .prepare(
            'INSERT INTO lms_course_receipts(actor_account_id,command_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?)',
          )
          .bind(
            actor.principal.accountId,
            command.key,
            requestHash,
            JSON.stringify(change.result),
            now,
          ),
        this.db
          .prepare('DELETE FROM lms_write_guards WHERE operation_id IN (?,?,?)')
          .bind(operation, operation + ':changed', operation + ':course'),
      ]);
      return change.result;
    } catch (error) {
      const message = String((error as Error).message);
      if (message.includes('LMS_ATTEMPT_LIMIT') || message.includes('LMS_ATTEMPT_COOLDOWN')) {
        const replay = await this.receipt(actor, command, requestHash);
        if (replay) return replay as T;
      }
      for (const code of [
        'LMS_TRAINING_IMMUTABLE',
        'LMS_TRAINING_COURSE_UNAVAILABLE',
        'LMS_TRAINING_PARTICIPANT_CHANGED',
        'LMS_ATTEMPT_LIMIT',
        'LMS_ATTEMPT_COOLDOWN',
        'LMS_PREREQUISITES_REQUIRED',
        'LMS_PREREQUISITE_UNAVAILABLE',
        'LMS_PREREQUISITE_CYCLE',
        'LMS_ASSESSMENT_POLICY_MISMATCH',
      ])
        if (message.includes(code)) throw new LmsError(409, code);
      if (message.includes('UNIQUE constraint failed: lms_course_receipts')) {
        const again = await this.receipt(actor, command, requestHash);
        if (again) return again as T;
      }
      if (message.includes('CHECK constraint failed: valid=1')) {
        if (beforeWrite) {
          const again = await this.receipt(actor, command, requestHash);
          if (again) return again as T;
        }
        throw new LmsError(409, 'REVISION_CONFLICT');
      }
      if (message.includes('UNIQUE constraint failed: lms_courses.tenant_id'))
        throw new LmsError(409, 'DUPLICATE_RECORD');
      if (message.includes('UNIQUE constraint failed: lms_media.id')) {
        const again = await this.receipt(actor, command, requestHash);
        if (again) return again as T;
        throw new LmsError(409, 'DUPLICATE_RECORD');
      }
      throw error;
    }
  }
  async mediaUploadActor() {
    return this.actor('lms:admin');
  }
  async registerMedia(
    input: {
      id: string;
      ownerUnitId: string;
      name: string;
      kind: MediaRecord['kind'];
      mimeType: string;
      size: number;
      sha256: string;
    },
    objectKey: string,
    command: CourseCommand,
  ) {
    const actor = await this.actor('lms:admin');
    request(
      id(input.id) &&
        id(input.ownerUnitId) &&
        typeof input.name === 'string' &&
        input.name.length > 0 &&
        input.name.length <= 180 &&
        Number.isInteger(input.size) &&
        input.size > 0 &&
        input.size <= 100 * 1024 * 1024 &&
        /^[0-9a-f]{64}$/.test(input.sha256) &&
        objectKey.startsWith('media/' + actor.link.tenant_id + '/' + input.id + '/'),
    );
    await this.validateUnits(actor, input.ownerUnitId, []);
    const createdAt = Date.now();
    return this.commit(actor, 'lms:admin', command, 'media.uploaded', input, () => ({
      statements: [
        this.db
          .prepare(
            'INSERT INTO lms_media(id,tenant_id,owner_unit_id,kind,object_key,name,mime_type,size,sha256,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            input.id,
            actor.link.tenant_id,
            input.ownerUnitId,
            input.kind,
            objectKey,
            input.name,
            input.mimeType,
            input.size,
            input.sha256,
            actor.principal.accountId,
            createdAt,
          ),
      ],
      condition: 'EXISTS(SELECT 1 FROM lms_media WHERE id=? AND tenant_id=? AND object_key=?)',
      values: [input.id, actor.link.tenant_id, objectKey],
      result: {
        id: input.id,
        name: input.name,
        kind: input.kind,
        mimeType: input.mimeType,
        size: input.size,
        createdAt,
      },
      details: { mediaId: input.id, kind: input.kind, size: input.size, sha256: input.sha256 },
    }));
  }
  async media(mediaId: string, versionId?: string): Promise<MediaRecord> {
    request(id(mediaId));
    const actor = await this.actor(versionId ? 'lms:learn' : 'lms:admin');
    const row = await this.db
      .prepare('SELECT * FROM lms_media WHERE id=? AND tenant_id=?')
      .bind(mediaId, actor.link.tenant_id)
      .first<MediaRecord>();
    if (!row) throw new LmsError(404, 'LMS_MEDIA_NOT_FOUND');
    if (versionId) {
      request(id(versionId));
      const { spec } = await this.version(actor, versionId);
      if (
        !(spec.video?.kind === 'file' && spec.video.id === mediaId) &&
        !spec.attachments.some((item) => item.mediaId === mediaId)
      )
        throw new LmsError(404, 'LMS_MEDIA_NOT_FOUND');
    }
    return row;
  }
  async mediaList(cursor?: string) {
    const actor = await this.actor('lms:admin');
    const after = listCursor(cursor, 'media');
    const rows = (
      await this.db
        .prepare(
          'SELECT id,name,kind,mime_type AS mimeType,size,created_at AS createdAt FROM lms_media WHERE tenant_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id>?)) ORDER BY created_at DESC,id LIMIT ?',
        )
        .bind(
          actor.link.tenant_id,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[1] ?? null,
          LMS_PAGE_SIZE + 1,
        )
        .all<{
          id: string;
          name: string;
          kind: string;
          mimeType: string;
          size: number;
          createdAt: number;
        }>()
    ).results;
    return {
      items: rows.slice(0, LMS_PAGE_SIZE),
      nextCursor:
        rows.length > LMS_PAGE_SIZE
          ? encodeListCursor('media', [
              rows[LMS_PAGE_SIZE - 1]!.createdAt,
              rows[LMS_PAGE_SIZE - 1]!.id,
            ])
          : null,
    };
  }
  async lookups() {
    const actor = await this.actor('lms:admin');
    const units = await this.directory.units(actor.link.tenant_id);
    return { ownUnitId: actor.link.org_unit_id, units };
  }
  async list(admin = false, cursor?: string) {
    const actor = await this.actor(admin ? 'lms:admin' : 'lms:learn');
    const after = listCursor(cursor, 'courses');
    const rows = (
      await this.db
        .prepare(
          "SELECT c.*,v.spec_json,v.version,p.position,p.watched,p.finished,EXISTS(SELECT 1 FROM lms_attempts a WHERE a.employee_id=? AND a.version_id=v.id AND json_extract(a.snapshot_json,'$.passed')=1) AS passed,(SELECT count(*) FROM json_each(v.spec_json,'$.policy.prerequisiteVersionIds') req WHERE NOT EXISTS(SELECT 1 FROM lms_attempts a WHERE a.employee_id=? AND a.version_id=req.value AND json_extract(a.snapshot_json,'$.passed')=1)) AS prerequisites_remaining FROM lms_courses c LEFT JOIN lms_course_versions v ON v.id=c.published_version_id LEFT JOIN lms_progress p ON p.version_id=v.id AND p.employee_id=? WHERE c.tenant_id=? AND (?=1 OR (c.status='active' AND v.id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(v.spec_json,'$.audienceUnits') WHERE value=?))) AND (? IS NULL OR c.updated_at<? OR (c.updated_at=? AND c.id>?)) ORDER BY c.updated_at DESC,c.id LIMIT ?",
        )
        .bind(
          actor.link.employee_id,
          actor.link.employee_id,
          actor.link.employee_id,
          actor.link.tenant_id,
          Number(admin),
          actor.link.org_unit_id,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[1] ?? null,
          LMS_PAGE_SIZE + 1,
        )
        .all<
          CourseRow & {
            spec_json: string | null;
            version: number | null;
            position: number | null;
            watched: number | null;
            finished: number | null;
            passed: number;
            prerequisites_remaining: number;
          }
        >()
    ).results;
    return {
      nextCursor:
        rows.length > LMS_PAGE_SIZE
          ? encodeListCursor('courses', [
              rows[LMS_PAGE_SIZE - 1]!.updated_at,
              rows[LMS_PAGE_SIZE - 1]!.id,
            ])
          : null,
      items: rows.slice(0, LMS_PAGE_SIZE).flatMap((row) => {
        const published = row.spec_json ? parseCourse(JSON.parse(row.spec_json), true) : null;
        if (
          !admin &&
          (!published ||
            row.status !== 'active' ||
            !published.audienceUnits.includes(actor.link.org_unit_id))
        )
          return [];
        return [
          {
            id: row.id,
            code: row.code,
            status: row.status,
            revision: row.revision,
            ownerUnitId: row.owner_unit_id,
            versionId: row.published_version_id,
            version: row.version,
            spec: admin ? parseCourse(JSON.parse(row.draft_json)) : publicCourse(published!),
            updatedAt: row.updated_at,
            prerequisitesRemaining: !admin ? row.prerequisites_remaining : 0,
            publishedTitle: published?.title ?? null,
            progress: {
              position: row.position ?? 0,
              watched: row.watched ?? 0,
              finished: !!row.finished,
              passed: !!row.passed,
            },
          },
        ];
      }),
    };
  }
  async detail(versionId: string) {
    request(id(versionId));
    const actor = await this.actor('lms:learn');
    const { row, spec } = await this.version(actor, versionId);
    const progress = await this.progress(actor, versionId);
    const attempts = await this.db
      .prepare(
        'SELECT count(*) AS count,max(created_at) AS last FROM lms_attempts WHERE employee_id=? AND version_id=?',
      )
      .bind(actor.link.employee_id, versionId)
      .first<{ count: number; last: number | null }>();
    const notes = (
      await this.db
        .prepare(
          'SELECT id,time,content,created_at FROM lms_notes WHERE employee_id=? AND version_id=? ORDER BY time,created_at',
        )
        .bind(actor.link.employee_id, versionId)
        .all()
    ).results;
    return {
      versionId,
      courseId: row.course_id,
      version: row.version,
      spec: publicCourse(spec),
      assessment: assessmentWindow(
        learningPolicy(spec),
        attempts?.count ?? 0,
        attempts?.last ?? null,
      ),
      progress: progress
        ? {
            position: progress.position,
            watched: progress.watched,
            finished: !!progress.finished,
            revision: progress.revision,
            answeredCheckpoints: completedCheckpoints(
              spec,
              JSON.parse(progress.answers_json) as Record<string, Answer>,
            ),
          }
        : {
            position: 0,
            watched: 0,
            finished: false,
            revision: 0,
            answeredCheckpoints: completedCheckpoints(spec, {}),
          },
      notes,
    };
  }
  async save(
    input: {
      courseId?: string;
      code: string;
      ownerUnitId: string;
      expectedRevision: number;
      spec: unknown;
    },
    command: CourseCommand,
  ) {
    const actor = await this.actor('lms:admin');
    request(
      /^[a-z0-9][a-z0-9-]{2,49}$/.test(input.code) &&
        id(input.ownerUnitId) &&
        revision(input.expectedRevision),
    );
    const spec = parseCourse(input.spec),
      courseId = input.courseId ?? crypto.randomUUID();
    await this.validateUnits(actor, input.ownerUnitId, spec.audienceUnits);
    if (input.courseId) {
      request(id(input.courseId));
      const current = await this.course(actor, input.courseId);
      if (current.code !== input.code || current.owner_unit_id !== input.ownerUnitId)
        throw new LmsError(400, 'LMS_COURSE_OWNER_IMMUTABLE');
    } else request(input.expectedRevision === 0);
    return this.commit(actor, 'lms:admin', command, 'course.draft_saved', input, (operation) => ({
      statements: [
        input.courseId
          ? this.db
              .prepare(
                'UPDATE lms_courses SET draft_json=?,revision=revision+1,updated_at=?,last_operation_id=? WHERE id=? AND tenant_id=? AND revision=?',
              )
              .bind(
                JSON.stringify(spec),
                Date.now(),
                operation,
                courseId,
                actor.link.tenant_id,
                input.expectedRevision,
              )
          : this.db
              .prepare(
                'INSERT INTO lms_courses(id,tenant_id,owner_unit_id,code,draft_json,last_operation_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
              )
              .bind(
                courseId,
                actor.link.tenant_id,
                input.ownerUnitId,
                input.code,
                JSON.stringify(spec),
                operation,
                actor.principal.accountId,
                Date.now(),
                Date.now(),
              ),
      ],
      condition: 'EXISTS(SELECT 1 FROM lms_courses WHERE id=? AND last_operation_id=?)',
      values: [courseId, operation],
      result: { id: courseId, revision: input.expectedRevision + 1 },
      details: { courseId, revision: input.expectedRevision + 1 },
    }));
  }
  async publish(courseId: string, expectedRevision: number, command: CourseCommand) {
    request(id(courseId) && revision(expectedRevision));
    const actor = await this.actor('lms:admin'),
      course = await this.course(actor, courseId);
    const spec = parseCourse(JSON.parse(course.draft_json), true);
    await this.validateUnits(actor, course.owner_unit_id, spec.audienceUnits);
    const mediaIds = [
      ...(spec.video?.kind === 'file' ? [spec.video.id] : []),
      ...spec.attachments.map((a) => a.mediaId),
    ];
    for (const mediaId of mediaIds) {
      const media = await this.db
        .prepare('SELECT kind FROM lms_media WHERE id=? AND tenant_id=?')
        .bind(mediaId, actor.link.tenant_id)
        .first<{ kind: string }>();
      if (
        !media ||
        (spec.video?.kind === 'file' && mediaId === spec.video.id && media.kind !== 'video')
      )
        throw new LmsError(400, 'LMS_MEDIA_NOT_FOUND');
    }
    const sequence = (await this.db
      .prepare(
        'SELECT COALESCE(MAX(version),0)+1 AS next FROM lms_course_versions WHERE course_id=?',
      )
      .bind(courseId)
      .first<{ next: number }>())!.next;
    const versionId = crypto.randomUUID(),
      checksum = await hash(JSON.stringify(spec));
    return this.commit(
      actor,
      'lms:admin',
      command,
      'course.published',
      { courseId, expectedRevision },
      (operation) => ({
        statements: [
          this.db
            .prepare(
              "UPDATE lms_courses SET published_version_id=?,status='active',revision=revision+1,updated_at=?,last_operation_id=? WHERE id=? AND tenant_id=? AND revision=?",
            )
            .bind(
              versionId,
              Date.now(),
              operation,
              courseId,
              actor.link.tenant_id,
              expectedRevision,
            ),
          this.db
            .prepare(
              'INSERT INTO lms_course_versions(id,course_id,version,spec_json,checksum,published_by,published_at) SELECT ?,id,?,?,?,?,? FROM lms_courses WHERE id=? AND last_operation_id=?',
            )
            .bind(
              versionId,
              sequence,
              JSON.stringify(spec),
              checksum,
              actor.principal.accountId,
              Date.now(),
              courseId,
              operation,
            ),
        ],
        condition: 'EXISTS(SELECT 1 FROM lms_courses WHERE id=? AND last_operation_id=?)',
        values: [courseId, operation],
        result: { id: courseId, revision: expectedRevision + 1, versionId, version: sequence },
        details: { courseId, versionId, version: sequence, checksum },
      }),
    );
  }
  async setStatus(
    courseId: string,
    expectedRevision: number,
    status: 'active' | 'archived',
    command: CourseCommand,
  ) {
    request(id(courseId) && revision(expectedRevision) && ['active', 'archived'].includes(status));
    const actor = await this.actor('lms:admin');
    await this.course(actor, courseId);
    return this.commit(
      actor,
      'lms:admin',
      command,
      'course.status_changed',
      { courseId, expectedRevision, status },
      (operation) => ({
        statements: [
          this.db
            .prepare(
              'UPDATE lms_courses SET status=?,revision=revision+1,updated_at=?,last_operation_id=? WHERE id=? AND tenant_id=? AND revision=?',
            )
            .bind(status, Date.now(), operation, courseId, actor.link.tenant_id, expectedRevision),
        ],
        condition: 'EXISTS(SELECT 1 FROM lms_courses WHERE id=? AND last_operation_id=?)',
        values: [courseId, operation],
        result: { id: courseId, revision: expectedRevision + 1, status },
        details: { courseId, status },
      }),
    );
  }
  async saveProgress(
    input: {
      versionId: string;
      expectedRevision: number;
      position: number;
      acknowledged?: boolean;
    },
    command: CourseCommand,
  ) {
    request(
      id(input.versionId) &&
        revision(input.expectedRevision) &&
        Number.isFinite(input.position) &&
        input.position >= 0 &&
        (input.acknowledged === undefined || typeof input.acknowledged === 'boolean'),
    );
    const actor = await this.actor('lms:learn'),
      { spec } = await this.version(actor, input.versionId),
      old = await this.progress(actor, input.versionId);
    if (spec.video?.kind === 'gdrive' && input.acknowledged !== true)
      throw new LmsError(400, 'LMS_MANUAL_CONFIRMATION_REQUIRED');
    const answers = JSON.parse(old?.answers_json ?? '{}') as Record<string, Answer>,
      completed = completedCheckpoints(spec, answers),
      next = spec.checkpoints.find((q) => !completed.includes(q.id));
    const position = Math.min(input.position, next?.time ?? spec.duration, spec.duration),
      watched = Math.max(old?.watched ?? 0, position),
      finished = !next && watched >= spec.duration - 0.5;
    return this.writeProgress(
      actor,
      input,
      command,
      'learning.progress_saved',
      {
        position,
        watched,
        answers,
        finished,
      },
      {},
      spec.video?.kind === 'gdrive' ? 'self-confirmed' : 'player-reported',
    );
  }
  async checkpoint(
    input: { versionId: string; expectedRevision: number; questionId: string; answer: unknown },
    command: CourseCommand,
  ) {
    request(id(input.versionId) && revision(input.expectedRevision));
    const actor = await this.actor('lms:learn'),
      { spec } = await this.version(actor, input.versionId),
      old = await this.progress(actor, input.versionId);
    const index = spec.checkpoints.findIndex((q) => q.id === input.questionId),
      question = spec.checkpoints[index];
    request(question && validAnswer(question, input.answer), 'LMS_ANSWER_INVALID');
    const answers = JSON.parse(old?.answers_json ?? '{}') as Record<string, Answer>;
    if (
      spec.checkpoints
        .slice(0, index)
        .some((q) => !completedCheckpoints(spec, answers).includes(q.id)) ||
      (old?.watched ?? 0) + 0.5 < question.time
    )
      throw new LmsError(409, 'LMS_CHECKPOINT_NOT_REACHED');
    const feedback = checkAnswer(question, spec.answerKey[question.id]!, input.answer);
    return this.writeProgress(
      actor,
      input,
      command,
      'learning.checkpoint_answered',
      {
        position: old?.position ?? 0,
        watched: old?.watched ?? 0,
        answers: { ...answers, [question.id]: input.answer },
        finished: !!old?.finished,
      },
      {
        ...feedback,
        completed: learningPolicy(spec).checkpointPolicy !== 'correct' || feedback.correct,
      },
    );
  }
  private async writeProgress<TExtra extends Record<string, unknown> = Record<string, never>>(
    actor: CourseActor,
    input: { versionId: string; expectedRevision: number },
    command: CourseCommand,
    action: string,
    values: {
      position: number;
      watched: number;
      answers: Record<string, Answer>;
      finished: boolean;
    },
    extra: TExtra = {} as TExtra,
    tracking?: 'self-confirmed' | 'player-reported',
  ) {
    const progressId = actor.link.employee_id + ':' + input.versionId;
    return this.commit(actor, 'lms:learn', command, action, input, (operation) => ({
      statements: [
        this.db
          .prepare(
            'INSERT INTO lms_progress(id,employee_id,version_id,position,watched,answers_json,finished,last_operation_id,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ?=0 ON CONFLICT(employee_id,version_id) DO NOTHING',
          )
          .bind(
            progressId,
            actor.link.employee_id,
            input.versionId,
            values.position,
            values.watched,
            JSON.stringify(values.answers),
            Number(values.finished),
            operation,
            Date.now(),
            input.expectedRevision,
          ),
        this.db
          .prepare(
            'UPDATE lms_progress SET position=?,watched=?,answers_json=?,finished=?,revision=revision+1,last_operation_id=?,updated_at=? WHERE employee_id=? AND version_id=? AND revision=? AND ?>0',
          )
          .bind(
            values.position,
            values.watched,
            JSON.stringify(values.answers),
            Number(values.finished),
            operation,
            Date.now(),
            actor.link.employee_id,
            input.versionId,
            input.expectedRevision,
            input.expectedRevision,
          ),
      ],
      condition:
        'EXISTS(SELECT 1 FROM lms_progress WHERE employee_id=? AND version_id=? AND last_operation_id=?)',
      values: [actor.link.employee_id, input.versionId, operation],
      result: {
        revision: input.expectedRevision + 1,
        position: values.position,
        watched: values.watched,
        finished: values.finished,
        ...extra,
      },
      details: {
        versionId: input.versionId,
        revision: input.expectedRevision + 1,
        ...(tracking ? { tracking } : {}),
      },
    }));
  }
  async submit(
    input: { versionId: string; answers: unknown; tabSwitchCount: number },
    command: CourseCommand,
  ) {
    request(
      id(input.versionId) &&
        Number.isInteger(input.tabSwitchCount) &&
        input.tabSwitchCount >= 0 &&
        input.tabSwitchCount <= 100000,
    );
    const actor = await this.actor('lms:learn'),
      { spec, row } = await this.version(actor, input.versionId);
    const replay = await this.replayCommand<
      AssessmentSnapshot & { id: string; versionId: string; createdAt: number }
    >(actor, command, 'learning.quiz_submitted', input);
    if (replay) return replay;
    const progress = await this.progress(actor, input.versionId),
      policy = learningPolicy(spec),
      answers = JSON.parse(progress?.answers_json ?? '{}') as Record<string, Answer>;
    if (
      (policy.requireVideoCompletion && !progress?.finished) ||
      completedCheckpoints(spec, answers).length !== spec.checkpoints.length
    )
      throw new LmsError(409, 'LMS_LEARNING_INCOMPLETE');
    const graded = gradeCourse(spec, input.answers),
      attemptId = crypto.randomUUID(),
      createdAt = Date.now();
    const snapshot: AssessmentSnapshot = {
      schemaVersion: 1,
      lessonTitle: spec.title,
      series: spec.series,
      version: row.version,
      checksum: row.checksum,
      policy,
      ...graded,
      tabSwitchCount: input.tabSwitchCount,
      tracking: spec.video?.kind === 'gdrive' ? 'self-confirmed' : 'player-reported',
    };
    return this.commit(
      actor,
      'lms:learn',
      command,
      'learning.quiz_submitted',
      input,
      (operation) => ({
        statements: [
          this.db
            .prepare(
              'INSERT INTO lms_write_guards(operation_id,valid) VALUES (?,CASE WHEN COALESCE((SELECT revision FROM lms_progress WHERE employee_id=? AND version_id=?),0)=? THEN 1 ELSE 0 END)',
            )
            .bind(
              operation + ':progress',
              actor.link.employee_id,
              input.versionId,
              progress?.revision ?? 0,
            ),
          this.db
            .prepare(
              'INSERT INTO lms_attempts(id,employee_id,version_id,score,answers_json,snapshot_json,tab_switch_count,created_at) VALUES (?,?,?,?,?,?,?,?)',
            )
            .bind(
              attemptId,
              actor.link.employee_id,
              input.versionId,
              graded.score,
              JSON.stringify(input.answers),
              JSON.stringify(snapshot),
              input.tabSwitchCount,
              createdAt,
            ),
          this.db
            .prepare('DELETE FROM lms_write_guards WHERE operation_id=?')
            .bind(operation + ':progress'),
        ],
        condition: 'EXISTS(SELECT 1 FROM lms_attempts WHERE id=? AND employee_id=?)',
        values: [attemptId, actor.link.employee_id],
        result: { id: attemptId, versionId: input.versionId, createdAt, ...snapshot },
        details: { attemptId, versionId: input.versionId, score: graded.score },
      }),
    );
  }
  async history(cursor?: string) {
    const actor = await this.actor('lms:learn');
    const after = listCursor(cursor, 'history');
    const rows = (
      await this.db
        .prepare(
          'SELECT a.id,a.version_id,a.score,a.created_at,a.snapshot_json FROM lms_attempts a JOIN lms_course_versions v ON v.id=a.version_id JOIN lms_courses c ON c.id=v.course_id WHERE a.employee_id=? AND c.tenant_id=? AND (? IS NULL OR a.created_at<? OR (a.created_at=? AND a.id<?)) ORDER BY a.created_at DESC,a.id DESC LIMIT ?',
        )
        .bind(
          actor.link.employee_id,
          actor.link.tenant_id,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[1] ?? null,
          LMS_PAGE_SIZE + 1,
        )
        .all<{
          id: string;
          version_id: string;
          score: number;
          created_at: number;
          snapshot_json: string;
        }>()
    ).results;
    return {
      nextCursor:
        rows.length > LMS_PAGE_SIZE
          ? encodeListCursor('history', [
              rows[LMS_PAGE_SIZE - 1]!.created_at,
              rows[LMS_PAGE_SIZE - 1]!.id,
            ])
          : null,
      items: rows.slice(0, LMS_PAGE_SIZE).map((row) => {
        const snapshot = JSON.parse(row.snapshot_json) as {
          lessonTitle: string;
          series: string;
          version: number;
          passed: boolean;
          policy?: import('./learning-policy.js').LearningPolicy;
        };
        return {
          id: row.id,
          versionId: row.version_id,
          score: row.score,
          passed: snapshot.passed,
          passScore: snapshot.policy?.passScore ?? 80,
          createdAt: row.created_at,
          lessonTitle: snapshot.lessonTitle,
          series: snapshot.series,
          version: snapshot.version,
        };
      }),
    };
  }
  async issueCertificate(attemptId: string, command: CourseCommand) {
    request(id(attemptId));
    const actor = await this.actor('lms:learn');
    const row = await this.db
      .prepare(
        'SELECT a.score,a.created_at,a.snapshot_json FROM lms_attempts a JOIN lms_course_versions v ON v.id=a.version_id JOIN lms_courses c ON c.id=v.course_id WHERE a.id=? AND a.employee_id=? AND c.tenant_id=?',
      )
      .bind(attemptId, actor.link.employee_id, actor.link.tenant_id)
      .first<{ score: number; created_at: number; snapshot_json: string }>();
    if (!row) throw new LmsError(404, 'LMS_ATTEMPT_NOT_FOUND');
    const attempt = JSON.parse(row.snapshot_json) as AssessmentSnapshot;
    if (row.score < (attempt.policy?.passScore ?? 80) || !attempt.passed)
      throw new LmsError(409, 'LMS_CERTIFICATE_NOT_ELIGIBLE');
    const code = certificateCode(attemptId),
      issuedAt = Date.now();
    const snapshot: Certificate = {
      schemaVersion: 1,
      id: attemptId,
      code,
      recipientName: actor.principal.displayName,
      employeeCode: actor.link.code,
      courseTitle: attempt.lessonTitle,
      series: attempt.series,
      version: attempt.version,
      checksum: attempt.checksum,
      score: row.score,
      completedAt: row.created_at,
      issuedAt,
      tracking: attempt.tracking ?? 'player-reported',
    };
    return this.commit(
      actor,
      'lms:learn',
      command,
      'learning.certificate_issued',
      { attemptId },
      () => ({
        statements: [
          this.db
            .prepare(
              'INSERT INTO lms_certificates(id,employee_id,tenant_id,code,snapshot_json,issued_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
            )
            .bind(
              attemptId,
              actor.link.employee_id,
              actor.link.tenant_id,
              code,
              JSON.stringify(snapshot),
              issuedAt,
            ),
        ],
        condition:
          'EXISTS(SELECT 1 FROM lms_certificates WHERE id=? AND employee_id=? AND tenant_id=?)',
        values: [attemptId, actor.link.employee_id, actor.link.tenant_id],
        // This stable receipt is valid even if a concurrent request issued the certificate.
        // Read the immutable snapshot through the authorized certificate endpoint.
        result: { id: attemptId, code },
        details: { attemptId, code },
      }),
    );
  }
  async attempt(attemptId: string) {
    request(id(attemptId));
    const actor = await this.actor('lms:learn');
    const row = await this.db
      .prepare(
        'SELECT a.* FROM lms_attempts a JOIN lms_course_versions v ON v.id=a.version_id JOIN lms_courses c ON c.id=v.course_id WHERE a.id=? AND a.employee_id=? AND c.tenant_id=?',
      )
      .bind(attemptId, actor.link.employee_id, actor.link.tenant_id)
      .first<{ id: string; version_id: string; created_at: number; snapshot_json: string }>();
    if (!row) throw new LmsError(404, 'LMS_ATTEMPT_NOT_FOUND');
    return {
      id: row.id,
      versionId: row.version_id,
      createdAt: row.created_at,
      ...(JSON.parse(row.snapshot_json) as AssessmentSnapshot),
    };
  }
  async addNote(
    input: { versionId: string; time: number; content: string },
    command: CourseCommand,
  ) {
    request(
      id(input.versionId) &&
        Number.isFinite(input.time) &&
        input.time >= 0 &&
        typeof input.content === 'string' &&
        input.content.trim().length > 0 &&
        input.content.length <= 500,
    );
    const actor = await this.actor('lms:learn'),
      { spec } = await this.version(actor, input.versionId);
    request(input.time <= spec.duration);
    const noteId = crypto.randomUUID(),
      createdAt = Date.now();
    return this.commit(actor, 'lms:learn', command, 'learning.note_created', input, () => ({
      statements: [
        this.db
          .prepare(
            'INSERT INTO lms_notes(id,employee_id,version_id,time,content,created_at) VALUES (?,?,?,?,?,?)',
          )
          .bind(
            noteId,
            actor.link.employee_id,
            input.versionId,
            input.time,
            input.content.trim(),
            createdAt,
          ),
      ],
      condition: 'EXISTS(SELECT 1 FROM lms_notes WHERE id=? AND employee_id=?)',
      values: [noteId, actor.link.employee_id],
      result: { id: noteId, time: input.time, content: input.content.trim(), createdAt },
      details: { noteId, versionId: input.versionId },
    }));
  }
  async deleteNote(noteId: string, command: CourseCommand) {
    request(id(noteId));
    const actor = await this.actor('lms:learn');
    const row = await this.db
      .prepare('SELECT version_id FROM lms_notes WHERE id=? AND employee_id=?')
      .bind(noteId, actor.link.employee_id)
      .first<{ version_id: string }>();
    // Retry receipts are checked by commit; an absent row never permits deleting another owner's note.
    if (row) await this.version(actor, row.version_id);
    return this.commit(actor, 'lms:learn', command, 'learning.note_deleted', { noteId }, () => ({
      statements: [
        this.db
          .prepare(
            'INSERT INTO lms_write_guards(operation_id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM lms_notes WHERE id=? AND employee_id=?) THEN 1 ELSE 0 END)',
          )
          .bind('note:' + command.key, noteId, actor.link.employee_id),
        this.db
          .prepare('DELETE FROM lms_notes WHERE id=? AND employee_id=?')
          .bind(noteId, actor.link.employee_id),
        this.db
          .prepare('DELETE FROM lms_write_guards WHERE operation_id=?')
          .bind('note:' + command.key),
      ],
      condition: 'NOT EXISTS(SELECT 1 FROM lms_notes WHERE id=? AND employee_id=?)',
      values: [noteId, actor.link.employee_id],
      result: { deleted: true },
      details: { noteId },
    }));
  }
}
