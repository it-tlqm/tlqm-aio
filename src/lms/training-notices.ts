import { Training } from './training.js';
import { LmsError } from './security.js';
import type { CourseCommand } from './courses.js';
type Row = Record<string, any>;
/** Same source rules for native LMS and the read-only Portal feed. */
export class TrainingNotices extends Training {
  async work() {
    const a = await this.actor('lms:learn');
    const batches: Awaited<ReturnType<Training['batch']>>[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const result = await this.batches(false, cursor);
      batches.push(...result.items);
      if (batches.length > 1000) throw new LmsError(413, 'LMS_TRAINING_TOO_MANY');
      if (!result.nextCursor) break;
      if (seen.has(result.nextCursor)) throw new LmsError(503, 'LMS_TRAINING_FEED_INVALID');
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    const items = batches
      .flatMap((b) => {
        const member = b.members.find((m) => m.accountId === a.principal.accountId);
        return !member || member.completed
          ? []
          : [
              {
                id: b.id,
                title: b.title,
                pathTitle: b.pathTitle,
                startsAt: b.startsAt,
                dueAt: b.dueAt,
                progress: member.progress,
                overdue: member.overdue,
                remainingCourses: member.courses.filter((c) => !c.passed).length,
                needsReview: member.courses.some((c) => !c.passed && !c.available),
              },
            ];
      })
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
    const now = Date.now(),
      rows = (
        await this.db
          .prepare(
            `SELECT n.* FROM lms_training_notifications n JOIN lms_training_batches b ON b.id=n.batch_id
      LEFT JOIN lms_training_reminder_policies p ON p.tenant_id=b.tenant_id AND p.unit_id=b.owner_unit_id
      WHERE n.tenant_id=? AND n.account_id=? AND n.person_id=? AND n.employee_id=? AND b.status='active' AND n.batch_revision=b.revision
      AND (n.kind IN('assigned','rescheduled') OR (p.enabled=1 AND b.starts_at<=? AND ((n.kind='due_soon' AND p.before_minutes>0 AND ?>=b.due_at-p.before_minutes*60000 AND ?<b.due_at) OR (n.kind='overdue' AND ?>=b.due_at+p.overdue_minutes*60000)))) ORDER BY n.created_at DESC,n.id LIMIT 10001`,
          )
          .bind(
            a.link.tenant_id,
            a.principal.accountId,
            a.principal.personId,
            a.link.employee_id,
            now,
            now,
            now,
            now,
          )
          .all<Row>()
      ).results;
    if (rows.length > 10000) throw new LmsError(413, 'LMS_TRAINING_TOO_MANY');
    const notices = rows.flatMap((n) => {
      const item = items.find((i) => i.id === n.batch_id);
      return item
        ? [
            {
              id: String(n.id),
              batchId: item.id,
              title: item.title,
              kind: String(n.kind),
              createdAt: Number(n.created_at),
              readAt: n.read_at as number | null,
              revision: Number(n.revision),
            },
          ]
        : [];
    });
    return {
      version: 1,
      accountId: a.principal.accountId,
      personId: a.principal.personId,
      tenantId: a.link.tenant_id,
      items,
      notices,
      summary: {
        assigned: items.length,
        overdue: items.filter((i) => i.overdue).length,
        upcoming: items.filter((i) => i.startsAt > now).length,
        unread: notices.filter((n) => n.readAt === null).length,
      },
    };
  }
  async mark(id: string, read: boolean, expectedRevision: number, command: CourseCommand) {
    const a = await this.actor('lms:learn');
    if (
      !/^[0-9a-f]{32}$/.test(id) ||
      typeof read !== 'boolean' ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 1
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    const notice = (await this.work()).notices.find((n) => n.id === id);
    if (!notice) throw new LmsError(404, 'LMS_TRAINING_NOTICE_UNAVAILABLE');
    return this.commit(
      a,
      'lms:learn',
      command,
      'training.notice_read',
      { id, read, expectedRevision },
      (operation) => ({
        statements: [
          this.db
            .prepare(
              "UPDATE lms_training_notifications SET read_at=?,revision=revision+1,last_operation_id=? WHERE id=? AND tenant_id=? AND account_id=? AND revision=? AND EXISTS(SELECT 1 FROM lms_training_batches b WHERE b.id=batch_id AND b.status='active' AND b.revision=batch_revision)",
            )
            .bind(
              read ? Date.now() : null,
              operation,
              id,
              a.link.tenant_id,
              a.principal.accountId,
              expectedRevision,
            ),
        ],
        condition:
          'EXISTS(SELECT 1 FROM lms_training_notifications WHERE id=? AND last_operation_id=?)',
        values: [id, operation],
        result: { id, revision: expectedRevision + 1, read },
        details: { id, batchId: notice.batchId, read },
      }),
    );
  }
  async policies() {
    const a = await this.actor('lms:admin'),
      units = await this.directory.units(a.link.tenant_id),
      items = (
        await this.db
          .prepare(
            'SELECT * FROM lms_training_reminder_policies WHERE tenant_id=? ORDER BY unit_id LIMIT 1001',
          )
          .bind(a.link.tenant_id)
          .all<Row>()
      ).results;
    if (items.length > 1000) throw new LmsError(413, 'LMS_TRAINING_TOO_MANY');
    return {
      items: items.filter((p) => units.some((u) => u.id === p.unit_id)),
      units,
      worker: await this.db
        .prepare(
          'SELECT last_completed_at,last_error_code,delivered FROM lms_training_reminder_state WHERE tenant_id=?',
        )
        .bind(a.link.tenant_id)
        .first<Row>(),
    };
  }
  async savePolicy(
    input: {
      unitId: string;
      enabled: boolean;
      beforeMinutes: number;
      overdueMinutes: number;
      expectedRevision: number;
    },
    command: CourseCommand,
  ) {
    const a = await this.actor('lms:admin');
    if (
      typeof input.unitId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(input.unitId) ||
      typeof input.enabled !== 'boolean' ||
      !Number.isInteger(input.beforeMinutes) ||
      input.beforeMinutes < 0 ||
      input.beforeMinutes > 10080 ||
      !Number.isInteger(input.overdueMinutes) ||
      input.overdueMinutes < 1 ||
      input.overdueMinutes > 10080 ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    if (!(await this.directory.units(a.link.tenant_id)).some((u) => u.id === input.unitId))
      throw new LmsError(400, 'LMS_UNIT_UNAVAILABLE');
    const old = await this.db
      .prepare(
        'SELECT revision FROM lms_training_reminder_policies WHERE tenant_id=? AND unit_id=?',
      )
      .bind(a.link.tenant_id, input.unitId)
      .first<{ revision: number }>();
    // Receipt retries use the same expectedRevision in commit; CAS itself remains in the statement.
    if (!old && input.expectedRevision !== 0) throw new LmsError(409, 'REVISION_CONFLICT');
    return this.commit(
      a,
      'lms:admin',
      command,
      'training.reminders_configured',
      input,
      (operation) => ({
        statements: [
          this.db
            .prepare(
              `INSERT INTO lms_training_reminder_policies(tenant_id,unit_id,enabled,before_minutes,overdue_minutes,last_operation_id) VALUES(?,?,?,?,?,?)
        ON CONFLICT(tenant_id,unit_id) DO UPDATE SET enabled=excluded.enabled,before_minutes=excluded.before_minutes,overdue_minutes=excluded.overdue_minutes,last_operation_id=excluded.last_operation_id,revision=revision+1 WHERE revision=?`,
            )
            .bind(
              a.link.tenant_id,
              input.unitId,
              Number(input.enabled),
              input.beforeMinutes,
              input.overdueMinutes,
              operation,
              input.expectedRevision,
            ),
        ],
        condition:
          'EXISTS(SELECT 1 FROM lms_training_reminder_policies WHERE tenant_id=? AND unit_id=? AND last_operation_id=?)',
        values: [a.link.tenant_id, input.unitId, operation],
        result: { unitId: input.unitId, revision: input.expectedRevision + 1 },
        details: { ...input },
      }),
    );
  }
}
