import { Courses } from './courses.js';
import type { CourseActor, CourseCommand } from './courses.js';
import { allowed, requirePermission } from './access.js';
import { LmsError, hash } from './security.js';
import { reportSummary } from './report-contracts.js';
import type {
  ReportData,
  ReportFilters,
  ReportCourse,
  ReportLearner,
  ReportCell,
  GradebookPage,
} from './report-contracts.js';
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
type Mapping = {
  account_id: string;
  person_id: string;
  employee_id: string;
  org_unit_id: string;
  code: string;
};
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
function validate(filters: ReportFilters) {
  if (
    !filters ||
    typeof filters !== 'object' ||
    Array.isArray(filters) ||
    Object.keys(filters).some(
      (key) =>
        !['orgUnitId', 'courseId', 'search', 'status', 'mandatoryOnly', 'page'].includes(key),
    ) ||
    (filters.orgUnitId !== undefined && !uuid(filters.orgUnitId)) ||
    (filters.courseId !== undefined && !uuid(filters.courseId)) ||
    (filters.search !== undefined &&
      (typeof filters.search !== 'string' || filters.search.length > 160)) ||
    (filters.status !== undefined &&
      !['all', 'completed', 'pending', 'not-started', 'not-required'].includes(filters.status)) ||
    (filters.mandatoryOnly !== undefined && typeof filters.mandatoryOnly !== 'boolean') ||
    (filters.page !== undefined &&
      (!Number.isInteger(filters.page) || filters.page < 1 || filters.page > 1000000))
  )
    throw new LmsError(400, 'INVALID_REQUEST');
}
export class Reports extends Courses {
  private async context() {
    let actor: CourseActor;
    try {
      actor = await this.actor('lms:admin');
      return { actor, permission: 'lms:admin' as const };
    } catch (error) {
      if (!(error instanceof LmsError) || error.status !== 403) throw error;
    }
    actor = await this.actor('lms:review');
    return { actor, permission: 'lms:review' as const };
  }
  private async collect(filters: ReportFilters) {
    validate(filters);
    const { actor, permission } = await this.context(),
      directoryUnits = await this.directory.units(actor.link.tenant_id);
    const units = directoryUnits.filter((unit) =>
      allowed(actor.principal, permission, actor.link.tenant_id, unit.id),
    );
    if (filters.orgUnitId && !units.some((unit) => unit.id === filters.orgUnitId))
      throw new LmsError(403, 'LMS_PERMISSION_DENIED');
    const targetUnits = filters.orgUnitId
        ? units.filter((unit) => unit.id === filters.orgUnitId)
        : units,
      scope = JSON.stringify(targetUnits.map((unit) => unit.id));
    const mappings = (
      await this.db
        .prepare(
          `SELECT a.account_id,a.person_id,a.employee_id,a.org_unit_id,e.code FROM aio_account_links a JOIN employees e ON e.id=a.employee_id AND e.is_active=1 WHERE a.tenant_id=? AND a.active=1 AND a.org_unit_id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM aio_external_links x WHERE x.account_id=a.account_id AND x.active=1) ORDER BY a.employee_id`,
        )
        .bind(actor.link.tenant_id, scope)
        .all<Mapping>()
    ).results;
    const people = await this.directory.people(
      actor.link.tenant_id,
      mappings.map((row) => row.account_id),
    );
    const eligible = mappings.flatMap((mapping) => {
      const person = people.find(
        (person) =>
          person.accountId === mapping.account_id &&
          person.personId === mapping.person_id &&
          person.units.some((unit) => unit.id === mapping.org_unit_id),
      );
      return person
        ? [
            {
              ...mapping,
              name: person.displayName,
              unitName: person.units.find((unit) => unit.id === mapping.org_unit_id)!.name,
            },
          ]
        : [];
    });
    const courseRows = (
      await this.db
        .prepare(
          `SELECT c.id,v.id AS versionId,v.version,json_extract(v.spec_json,'$.title') AS title,json_extract(v.spec_json,'$.series') AS series,json_extract(v.spec_json,'$.duration') AS duration,json_extract(v.spec_json,'$.isMandatory') AS mandatory,json_extract(v.spec_json,'$.deadline') AS deadline,CASE WHEN json_extract(v.spec_json,'$.video.kind')='gdrive' THEN 'self-confirmed' ELSE 'player-reported' END AS tracking,json_extract(v.spec_json,'$.audienceUnits') AS audience FROM lms_courses c JOIN lms_course_versions v ON v.id=c.published_version_id WHERE c.tenant_id=? AND c.status='active' AND EXISTS(SELECT 1 FROM json_each(v.spec_json,'$.audienceUnits') WHERE value IN (SELECT value FROM json_each(?))) ORDER BY c.created_at,c.id`,
        )
        .bind(actor.link.tenant_id, scope)
        .all<
          Omit<ReportCourse, 'audienceUnits' | 'mandatory'> & {
            audience: string;
            mandatory: number;
          }
        >()
    ).results;
    if (filters.courseId && !courseRows.some((course) => course.id === filters.courseId))
      throw new LmsError(404, 'LMS_COURSE_NOT_FOUND');
    const courses: ReportCourse[] = courseRows
      .filter(
        (course) =>
          (!filters.courseId || course.id === filters.courseId) &&
          (!filters.mandatoryOnly || course.mandatory),
      )
      .map(({ audience, mandatory, ...course }) => ({
        ...course,
        mandatory: !!mandatory,
        audienceUnits: JSON.parse(audience) as string[],
      }));
    const attempts = (
      await this.db
        .prepare(
          `SELECT a.employee_id,a.version_id,MAX(a.score) AS best,MAX(json_extract(a.snapshot_json,'$.passed')) AS passed,COUNT(*) AS count,MAX(a.created_at) AS last FROM lms_attempts a JOIN lms_course_versions v ON v.id=a.version_id JOIN lms_courses c ON c.published_version_id=v.id AND c.status='active' JOIN aio_account_links m ON m.employee_id=a.employee_id AND m.tenant_id=c.tenant_id AND m.active=1 WHERE c.tenant_id=? AND m.org_unit_id IN (SELECT value FROM json_each(?)) GROUP BY a.employee_id,a.version_id`,
        )
        .bind(actor.link.tenant_id, scope)
        .all<{
          employee_id: string;
          version_id: string;
          best: number;
          passed: number;
          count: number;
          last: number;
        }>()
    ).results;
    const progress = (
      await this.db
        .prepare(
          `SELECT p.employee_id,p.version_id,p.watched,p.finished FROM lms_progress p JOIN lms_course_versions v ON v.id=p.version_id JOIN lms_courses c ON c.published_version_id=v.id AND c.status='active' JOIN aio_account_links m ON m.employee_id=p.employee_id AND m.tenant_id=c.tenant_id AND m.active=1 WHERE c.tenant_id=? AND m.org_unit_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(actor.link.tenant_id, scope)
        .all<{ employee_id: string; version_id: string; watched: number; finished: number }>()
    ).results;
    const attemptsById = new Map(
        attempts.map((row) => [row.employee_id + ':' + row.version_id, row]),
      ),
      progressById = new Map(progress.map((row) => [row.employee_id + ':' + row.version_id, row]));
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const today = ['year', 'month', 'day']
      .map((type) => dateParts.find((part) => part.type === type)!.value)
      .join('-');
    let rows: ReportLearner[] = eligible.map((person) => {
      const cells: ReportCell[] = courses.map((course) => {
        const assigned = course.audienceUnits.includes(person.org_unit_id),
          attempt = assigned
            ? attemptsById.get(person.employee_id + ':' + course.versionId)
            : undefined,
          p = assigned ? progressById.get(person.employee_id + ':' + course.versionId) : undefined;
        const state: ReportCell['state'] = !assigned
          ? 'unassigned'
          : attempt
            ? !!attempt.passed
              ? 'passed'
              : 'failed'
            : p && (p.watched > 0 || p.finished)
              ? 'learning'
              : 'not-started';
        return {
          courseId: course.id,
          versionId: course.versionId,
          assigned,
          state,
          bestScore: attempt?.best ?? null,
          attempts: attempt?.count ?? 0,
          watchedPct:
            assigned && p && course.duration > 0
              ? Math.min(100, Math.round((p.watched / course.duration) * 100))
              : 0,
          lastAttemptAt: attempt?.last ?? null,
          overdue:
            assigned &&
            course.mandatory &&
            !!course.deadline &&
            course.deadline < today &&
            state !== 'passed',
        };
      });
      const required = courses.filter(
          (course) => course.mandatory && course.audienceUnits.includes(person.org_unit_id),
        ),
        passedRequired = required.filter((course) =>
          cells.some((cell) => cell.courseId === course.id && cell.state === 'passed'),
        ).length;
      return {
        employeeId: person.employee_id,
        accountId: person.account_id,
        name: person.name,
        code: person.code,
        orgUnitId: person.org_unit_id,
        unitName: person.unitName,
        required: required.length,
        passedRequired,
        assigned: cells.filter((cell) => cell.assigned).length,
        passed: cells.filter((cell) => cell.state === 'passed').length,
        attempts: cells.reduce((sum, cell) => sum + cell.attempts, 0),
        status:
          required.length === 0
            ? 'not-required'
            : passedRequired === required.length
              ? 'completed'
              : 'pending',
        started: cells.some((cell) => cell.state !== 'unassigned' && cell.state !== 'not-started'),
        cells,
      };
    });
    if (filters.courseId) rows = rows.filter((row) => row.assigned > 0);
    const search = normalize(filters.search?.trim() ?? '');
    rows = rows.filter(
      (row) =>
        normalize(row.name + ' ' + row.code + ' ' + row.unitName).includes(search) &&
        (!filters.status ||
          filters.status === 'all' ||
          (filters.status === 'not-started'
            ? row.assigned > 0 && !row.started
            : row.status === filters.status)),
    );
    rows.sort((a, b) => a.code.localeCompare(b.code) || a.employeeId.localeCompare(b.employeeId));
    const data: ReportData = {
      scope: 'current-publication',
      filters: { ...filters, page: 1 },
      courses,
      courseOptions: courseRows
        .filter((course) => !filters.mandatoryOnly || course.mandatory)
        .map((course) => ({ id: course.id, title: course.title, version: course.version })),
      units: units.map((unit) => ({ id: unit.id, name: unit.name })),
      rows,
      summary: reportSummary(rows),
      byUnit: targetUnits.map((unit) => ({
        id: unit.id,
        name: unit.name,
        ...reportSummary(rows.filter((row) => row.orgUnitId === unit.id)),
      })),
    };
    return { actor, permission, data };
  }
  async gradebook(filters: ReportFilters): Promise<GradebookPage> {
    const { data } = await this.collect(filters),
      page = filters.page ?? 1,
      pageSize = 50,
      { rows, ...rest } = data;
    return {
      ...rest,
      items: rows.slice((page - 1) * pageSize, page * pageSize),
      total: rows.length,
      page,
      pageSize,
    };
  }
  async learnerDetail(employeeId: string, filters: ReportFilters) {
    if (typeof employeeId !== 'string' || !employeeId || employeeId.length > 100)
      throw new LmsError(400, 'INVALID_REQUEST');
    const { data } = await this.collect({ ...filters, page: 1, search: '', status: 'all' }),
      learner = data.rows.find((row) => row.employeeId === employeeId);
    if (!learner) throw new LmsError(404, 'LMS_LEARNER_NOT_FOUND');
    return { learner, courses: data.courses };
  }
  async exportReport(filters: ReportFilters, command: CourseCommand) {
    const { actor, permission, data } = await this.collect({ ...filters, page: 1 });
    if (data.rows.length > 5000 || data.rows.length * Math.max(1, data.courses.length) > 100000)
      throw new LmsError(413, 'LMS_EXPORT_LIMIT');
    const digest = await hash(JSON.stringify(data));
    const receipt = await this.commit(
      actor,
      permission,
      command,
      'report.exported',
      filters,
      () => ({
        statements: [],
        condition: '1=1',
        values: [],
        result: { digest, issuedAt: Date.now(), rows: data.rows.length },
        details: {
          digest,
          rows: data.rows.length,
          courses: data.courses.length,
          orgUnitId: filters.orgUnitId ?? null,
          courseId: filters.courseId ?? null,
        },
      }),
    );
    if (receipt.digest !== digest) throw new LmsError(409, 'LMS_REPORT_CHANGED');
    return { data, issuedAt: receipt.issuedAt };
  }
}
