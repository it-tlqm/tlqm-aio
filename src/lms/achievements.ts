import { allowed, requirePermission } from './access.js';
import type { D1Database } from './types.js';
import type { CourseActor, CourseAuthorization } from './courses.js';
import type { Certificate, Ranking } from './achievement-contracts.js';
import { LmsError } from './security.js';

export type CurrentSubjects = (accountIds: string[]) => Promise<
  {
    accountId: string;
    personId: string;
    tenantId: string;
    orgUnitId: string;
  }[]
>;
type Candidate = {
  account_id: string;
  person_id: string;
  employee_id: string;
  org_unit_id: string;
  name: string;
  code: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Peer results require current Foundation subjects, never legacy department strings. */
export class Achievements {
  constructor(
    private readonly db: D1Database,
    private readonly authorize: CourseAuthorization,
    private readonly subjects: CurrentSubjects,
  ) {}
  private canReview(actor: CourseActor, unitId: string) {
    return (['lms:admin', 'lms:review'] as const).some((permission) => {
      try {
        requirePermission(actor.principal, actor.link, permission);
        return allowed(actor.principal, permission, actor.link.tenant_id, unitId);
      } catch (error) {
        if (error instanceof LmsError && error.status === 403) return false;
        throw error;
      }
    });
  }
  private async eligible(actor: CourseActor, candidates: Candidate[]) {
    const subjects = await this.subjects(candidates.map((row) => row.account_id));
    return candidates.filter((row) =>
      subjects.some(
        (current) =>
          current.accountId === row.account_id &&
          current.personId === row.person_id &&
          current.tenantId === actor.link.tenant_id &&
          current.orgUnitId === row.org_unit_id,
      ),
    );
  }
  async certificate(code: string): Promise<Certificate> {
    if (!/^TLQM-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(code))
      throw new LmsError(400, 'INVALID_REQUEST');
    const actor = await this.authorize();
    const row = await this.db
      .prepare(
        'SELECT employee_id,snapshot_json FROM lms_certificates WHERE code=? AND tenant_id=?',
      )
      .bind(code, actor.link.tenant_id)
      .first<{ employee_id: string; snapshot_json: string }>();
    if (!row) throw new LmsError(404, 'LMS_CERTIFICATE_NOT_FOUND');
    if (row.employee_id === actor.link.employee_id) {
      requirePermission(actor.principal, actor.link, 'lms:learn');
    } else {
      const target = await this.db
        .prepare(
          `SELECT a.account_id,a.person_id,a.employee_id,a.org_unit_id,e.name,e.code FROM aio_account_links a JOIN employees e ON e.id=a.employee_id WHERE a.employee_id=? AND a.tenant_id=? AND a.active=1 AND e.is_active=1 AND EXISTS(SELECT 1 FROM aio_external_links x WHERE x.account_id=a.account_id AND x.active=1)`,
        )
        .bind(row.employee_id, actor.link.tenant_id)
        .first<Candidate>();
      if (
        !target ||
        !this.canReview(actor, target.org_unit_id) ||
        !(await this.eligible(actor, [target])).length
      )
        throw new LmsError(404, 'LMS_CERTIFICATE_NOT_FOUND');
    }
    return JSON.parse(row.snapshot_json) as Certificate;
  }
  async ranking(options: {
    orgUnitId?: string | undefined;
    page?: string | undefined;
    search?: string | undefined;
  }): Promise<Ranking> {
    const actor = await this.authorize();
    requirePermission(actor.principal, actor.link, 'lms:learn');
    const orgUnitId = options.orgUnitId ?? actor.link.org_unit_id,
      pageText = options.page ?? '1',
      search = options.search ?? '';
    if (!uuid.test(orgUnitId) || !/^[1-9][0-9]{0,5}$/.test(pageText) || search.length > 100)
      throw new LmsError(400, 'INVALID_REQUEST');
    if (orgUnitId !== actor.link.org_unit_id && !this.canReview(actor, orgUnitId))
      throw new LmsError(403, 'LMS_PERMISSION_DENIED');
    const page = Number(pageText),
      pageSize = 50;
    const scores: (Ranking['items'][number] & { employeeId: string })[] = [];
    let cursor = '';
    for (;;) {
      const candidates = (
        await this.db
          .prepare(
            `SELECT a.account_id,a.person_id,a.employee_id,a.org_unit_id,e.name,e.code FROM aio_account_links a JOIN employees e ON e.id=a.employee_id WHERE a.tenant_id=? AND a.org_unit_id=? AND a.active=1 AND e.is_active=1 AND a.employee_id>? AND EXISTS(SELECT 1 FROM aio_external_links x WHERE x.account_id=a.account_id AND x.active=1) ORDER BY a.employee_id LIMIT 100`,
          )
          .bind(actor.link.tenant_id, orgUnitId, cursor)
          .all<Candidate>()
      ).results;
      if (!candidates.length) break;
      for (const candidate of await this.eligible(actor, candidates)) {
        const stats = await this.db
          .prepare(
            `SELECT COUNT(*) AS attempted,COALESCE(SUM(passed),0) AS completed,COALESCE(ROUND(AVG(best)),0) AS average FROM (SELECT v.course_id,MAX(a.score) AS best,MAX(json_extract(a.snapshot_json,'$.passed')) AS passed FROM lms_attempts a JOIN lms_course_versions v ON v.id=a.version_id JOIN lms_courses c ON c.id=v.course_id WHERE a.employee_id=? AND c.tenant_id=? AND EXISTS(SELECT 1 FROM json_each(v.spec_json,'$.audienceUnits') WHERE value=?) GROUP BY v.course_id)`,
          )
          .bind(candidate.employee_id, actor.link.tenant_id, orgUnitId)
          .first<{ attempted: number; completed: number; average: number }>();
        if (stats?.attempted)
          scores.push({
            ...stats,
            employeeId: candidate.employee_id,
            rank: 0,
            name: candidate.name,
            code: candidate.code,
            isMe: candidate.employee_id === actor.link.employee_id,
          });
      }
      cursor = candidates.at(-1)!.employee_id;
    }
    scores.sort(
      (a, b) =>
        b.completed - a.completed ||
        b.average - a.average ||
        a.code.localeCompare(b.code) ||
        a.employeeId.localeCompare(b.employeeId),
    );
    scores.forEach((row, index) => {
      const previous = scores[index - 1];
      row.rank =
        previous && row.completed === previous.completed && row.average === previous.average
          ? previous.rank
          : index + 1;
    });
    const normalize = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd')
        .toLowerCase();
    const filtered = scores.filter((row) =>
      normalize(row.name + ' ' + row.code).includes(normalize(search.trim())),
    );
    return {
      scope: 'unit',
      orgUnitId,
      page,
      pageSize,
      total: filtered.length,
      myRank: scores.find((row) => row.isMe)?.rank ?? null,
      items: filtered
        .slice((page - 1) * pageSize, page * pageSize)
        .map(({ employeeId: _employeeId, ...row }) => row),
    };
  }
}
