import type { Pool } from 'pg';
import { isDate } from '../forms/contracts.js';
import { HttpError } from '../security.js';
import { workflowUuid } from './contracts.js';
import { inAutomationTransaction } from './automation-jobs.js';

export const scheduleCadences = ['once', 'daily', 'weekly', 'monthly', 'yearly'] as const;
export type ScheduleTiming = {
  cadence: (typeof scheduleCadences)[number];
  every: number;
  startDate: string;
  endDate?: string | null;
  localTime: string;
};
export type WorkflowScheduleInput = ScheduleTiming & {
  title: string;
  definitionId: string;
  versionId: string;
  unitId: string;
  recipientAccountId: string;
};
export type WorkflowDraftSchedule = {
  id: string;
  tenant_id: string;
  org_unit_id: string;
  definition_id: string;
  version_id: string;
  title: string;
  recipient_account_id: string;
  recipient_person_id: string;
  cadence: ScheduleTiming['cadence'];
  every: number;
  start_date: string;
  end_date: string | null;
  local_time: string;
  time_zone: 'Asia/Ho_Chi_Minh';
  next_run_at: Date | null;
  enabled: boolean;
  revision: number;
};

export type WorkflowScheduleJob = {
  id: string;
  tenant_id: string;
  schedule_id: string;
  scheduled_for: Date;
  attempts: number;
  status: 'queued' | 'retry' | 'done' | 'blocked';
};

export function parseSchedule(input: WorkflowScheduleInput): WorkflowScheduleInput {
  for (const value of [input.definitionId, input.versionId, input.unitId, input.recipientAccountId])
    workflowUuid(value);
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.trim().length > 160 ||
    !scheduleCadences.includes(input.cadence) ||
    !Number.isInteger(input.every) ||
    input.every < 1 ||
    input.every > 365 ||
    (input.cadence === 'once' && input.every !== 1) ||
    !isDate(input.startDate) ||
    input.startDate < '2000-01-01' ||
    (input.endDate != null && (!isDate(input.endDate) || input.endDate < input.startDate)) ||
    typeof input.localTime !== 'string' ||
    !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.localTime)
  )
    throw new HttpError(400, 'WORKFLOW_SCHEDULE_INVALID');
  return {
    definitionId: input.definitionId.toLowerCase(),
    versionId: input.versionId.toLowerCase(),
    unitId: input.unitId.toLowerCase(),
    recipientAccountId: input.recipientAccountId.toLowerCase(),
    title: input.title.trim(),
    cadence: input.cadence,
    every: input.every,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    localTime: input.localTime,
  };
}

const vietnamOffset = 7 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

export function nextScheduleOccurrence(schedule: ScheduleTiming, earliest: Date): Date | null {
  // Scheduling uses Vietnamese civil dates. UTC arithmetic avoids the worker's host time zone.
  const anchor = new Date(schedule.startDate + 'T' + schedule.localTime + ':00Z');
  const minimum = earliest.getTime() + vietnamOffset;
  let occurrence = anchor.getTime();
  if (schedule.cadence === 'once') {
    if (occurrence < minimum) return null;
  } else if (schedule.cadence === 'daily' || schedule.cadence === 'weekly') {
    const stride = dayMs * schedule.every * (schedule.cadence === 'weekly' ? 7 : 1);
    occurrence += Math.max(0, Math.ceil((minimum - occurrence) / stride)) * stride;
  } else {
    const stride = schedule.every * (schedule.cadence === 'yearly' ? 12 : 1);
    const local = new Date(minimum);
    const span =
      (local.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      local.getUTCMonth() -
      anchor.getUTCMonth();
    const month = Math.max(0, Math.floor(span / stride)) * stride;
    const at = (offset: number) => {
      const y = anchor.getUTCFullYear(),
        m = anchor.getUTCMonth() + offset;
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return Date.UTC(
        y,
        m,
        Math.min(anchor.getUTCDate(), last),
        anchor.getUTCHours(),
        anchor.getUTCMinutes(),
      );
    };
    occurrence = at(month);
    if (occurrence < minimum) occurrence = at(month + stride);
  }
  const localDate = new Date(occurrence);
  if (
    localDate.getUTCFullYear() > 9999 ||
    (schedule.endDate && localDate.toISOString().slice(0, 10) > schedule.endDate)
  )
    return null;
  return new Date(occurrence - vietnamOffset);
}

export async function enqueueScheduledDrafts(pool: Pool) {
  const candidates = (
    await pool.query<{ id: string; tenant_id: string }>(
      `SELECT id,tenant_id FROM workflow_draft_schedules
     WHERE enabled AND next_run_at<=now() ORDER BY next_run_at,id LIMIT 20`,
    )
  ).rows;
  let enqueued = 0;
  for (const { id, tenant_id: tenant } of candidates) {
    enqueued += await inAutomationTransaction(pool, tenant, async (db) => {
      const schedule = (
        await db.query<WorkflowDraftSchedule & { now: Date }>(
          `SELECT *,start_date::text AS start_date,end_date::text AS end_date,now() AS now
         FROM workflow_draft_schedules WHERE (tenant_id,id)=($1,$2)
          AND enabled AND next_run_at<=now() FOR UPDATE`,
          [tenant, id],
        )
      ).rows[0];
      if (!schedule?.next_run_at) return 0;
      const timing = {
        cadence: schedule.cadence,
        every: schedule.every,
        startDate: schedule.start_date,
        endDate: schedule.end_date,
        localTime: schedule.local_time,
      };
      let next: Date | null = schedule.next_run_at;
      let inserted = 0;
      for (let count = 0; count < 8 && next && next <= schedule.now; count++) {
        const result = await db.query(
          `INSERT INTO workflow_scheduled_draft_jobs(id,tenant_id,schedule_id,scheduled_for)
           VALUES(gen_random_uuid(),$1,$2,$3) ON CONFLICT(tenant_id,schedule_id,scheduled_for) DO NOTHING`,
          [tenant, id, next],
        );
        inserted += result.rowCount ?? 0;
        next = nextScheduleOccurrence(timing, new Date(next.getTime() + 1));
      }
      await db.query(
        'UPDATE workflow_draft_schedules SET next_run_at=$3 WHERE (tenant_id,id)=($1,$2)',
        [tenant, id, next],
      );
      return inserted;
    });
  }
  return enqueued;
}

export function vietnamScheduleDate(occurrence: Date) {
  return new Date(occurrence.getTime() + vietnamOffset).toISOString().slice(0, 10);
}
