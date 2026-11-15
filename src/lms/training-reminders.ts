import type { D1Database, D1Statement } from './types.js';
import { LmsError } from './security.js';
export type ReminderAudience = (
  tenantId: string,
  accountIds: string[],
) => Promise<{ accountId: string; personId: string; unitIds: string[] }[]>;
type Row = Record<string, any>;
const eligibleSql = `a.active=1 AND e.is_active=1 AND EXISTS(SELECT 1 FROM aio_external_links x WHERE x.account_id=a.account_id AND x.active=1)
  AND a.person_id=n.person_id AND a.employee_id=n.employee_id AND a.tenant_id=b.tenant_id
  AND EXISTS(SELECT 1 FROM json_each(v.spec_json,'$.audienceUnits') audience WHERE audience.value=a.org_unit_id)
  AND EXISTS(SELECT 1 FROM json_each(v.spec_json,'$.courseVersionIds') step WHERE NOT EXISTS(SELECT 1 FROM lms_attempts result WHERE result.employee_id=e.id AND result.version_id=step.value AND json_extract(result.snapshot_json,'$.passed')=1))`;
/** No sends outside AIO. Persist only source-owned in-app metadata after live Foundation eligibility. */
export class TrainingReminders {
  constructor(
    readonly db: D1Database,
    readonly audience: ReminderAudience,
  ) {}
  async tick(now = Date.now()) {
    if (
      (
        await this.db
          .prepare('SELECT enabled FROM aio_adapter_control WHERE id=1')
          .first<{ enabled: number }>()
      )?.enabled !== 1
    )
      throw new LmsError(503, 'LMS_ADAPTER_DISABLED');
    const tenants = (
      await this.db
        .prepare(
          'SELECT DISTINCT tenant_id FROM lms_training_reminder_policies WHERE enabled=1 ORDER BY tenant_id LIMIT 101',
        )
        .all<{ tenant_id: string }>()
    ).results;
    if (tenants.length > 100) throw new LmsError(413, 'LMS_TRAINING_TOO_MANY');
    let delivered = 0,
      failedTenants = 0;
    for (const { tenant_id: tenant } of tenants) {
      try {
        const rows = (
          await this.db
            .prepare(
              `SELECT b.id AS batch_id,b.revision AS batch_revision,b.owner_unit_id,b.starts_at,b.due_at,
          n.account_id,n.person_id,n.employee_id,a.org_unit_id,p.before_minutes,p.overdue_minutes,p.revision AS policy_revision
          FROM lms_training_batches b JOIN lms_learning_path_versions v ON v.id=b.path_version_id
          JOIN lms_training_reminder_policies p ON p.tenant_id=b.tenant_id AND p.unit_id=b.owner_unit_id AND p.enabled=1
          JOIN lms_training_enrollments n ON n.batch_id=b.id JOIN aio_account_links a ON a.account_id=n.account_id
          JOIN employees e ON e.id=n.employee_id
          WHERE b.tenant_id=? AND b.status='active' AND b.starts_at<=? AND ${eligibleSql}
          AND ((p.before_minutes>0 AND ?>=b.due_at-p.before_minutes*60000 AND ?<b.due_at) OR ?>=b.due_at+p.overdue_minutes*60000)
          ORDER BY b.id,n.account_id LIMIT 1001`,
            )
            .bind(tenant, now, now, now, now)
            .all<Row>()
        ).results;
        if (rows.length > 1000) throw new LmsError(413, 'LMS_TRAINING_TOO_MANY');
        const ids = [...new Set(rows.map((r) => String(r.account_id)))],
          people = await this.audience(tenant, ids),
          fresh = await this.audience(tenant, ids),
          operation = crypto.randomUUID(),
          statements: D1Statement[] = [];
        statements.push(
          this.db
            .prepare(
              'INSERT INTO lms_write_guards(operation_id,valid) VALUES(?,CASE WHEN (SELECT enabled FROM aio_adapter_control WHERE id=1)=1 THEN 1 ELSE 0 END)',
            )
            .bind(operation),
        );
        for (const r of rows) {
          const matches = (list: typeof people) =>
            list.some(
              (p) =>
                p.accountId === r.account_id &&
                p.personId === r.person_id &&
                p.unitIds.includes(r.org_unit_id),
            );
          if (!matches(people) || !matches(fresh)) continue;
          const kind = now < r.due_at ? 'due_soon' : 'overdue',
            id = crypto.randomUUID().replaceAll('-', '');
          statements.push(
            this.db
              .prepare(
                `INSERT INTO lms_training_notifications(id,tenant_id,batch_id,account_id,person_id,employee_id,kind,batch_revision,due_at,created_at,delivery_operation_id)
            SELECT ?,b.tenant_id,b.id,n.account_id,n.person_id,n.employee_id,?,b.revision,b.due_at,?,?
            FROM lms_training_batches b JOIN lms_learning_path_versions v ON v.id=b.path_version_id JOIN lms_training_enrollments n ON n.batch_id=b.id
            JOIN aio_account_links a ON a.account_id=n.account_id JOIN employees e ON e.id=n.employee_id
            JOIN lms_training_reminder_policies p ON p.tenant_id=b.tenant_id AND p.unit_id=b.owner_unit_id
            WHERE b.tenant_id=? AND b.id=? AND b.revision=? AND b.status='active' AND b.starts_at<=? AND n.account_id=? AND a.org_unit_id=?
            AND p.enabled=1 AND p.revision=? AND ${eligibleSql}
            ON CONFLICT(batch_id,account_id,batch_revision,kind) DO NOTHING`,
              )
              .bind(
                id,
                kind,
                now,
                operation,
                tenant,
                r.batch_id,
                r.batch_revision,
                now,
                r.account_id,
                r.org_unit_id,
                r.policy_revision,
              ),
          );
        }
        statements.push(
          this.db
            .prepare(
              `INSERT INTO aio_audit(event_id,occurred_at,tenant_id,action,reason,request_id,details)
          SELECT ?,?,?,'training.reminders_delivered','Đối soát nhắc hạn đào tạo',?,json_object('delivered',count(*)) FROM lms_training_notifications WHERE delivery_operation_id=? HAVING count(*)>0`,
            )
            .bind(operation, now, tenant, operation, operation),
        );
        statements.push(
          this.db
            .prepare(
              `INSERT INTO lms_training_reminder_state(tenant_id,last_completed_at,last_error_code,delivered)
          SELECT ?,?,NULL,count(*) FROM lms_training_notifications WHERE delivery_operation_id=?
          ON CONFLICT(tenant_id) DO UPDATE SET last_completed_at=excluded.last_completed_at,last_error_code=NULL,delivered=excluded.delivered`,
            )
            .bind(tenant, now, operation),
        );
        statements.push(
          this.db.prepare('DELETE FROM lms_write_guards WHERE operation_id=?').bind(operation),
        );
        await this.db.batch(statements);
        delivered += (await this.db
          .prepare(
            'SELECT count(*) AS count FROM lms_training_notifications WHERE delivery_operation_id=?',
          )
          .bind(operation)
          .first<{ count: number }>())!.count;
      } catch {
        failedTenants++;
        await this.db
          .prepare(
            "INSERT INTO lms_training_reminder_state(tenant_id,last_error_code) VALUES(?,'REMINDER_FAILED') ON CONFLICT(tenant_id) DO UPDATE SET last_error_code='REMINDER_FAILED'",
          )
          .bind(tenant)
          .run();
      }
    }
    return { delivered, failedTenants };
  }
}
