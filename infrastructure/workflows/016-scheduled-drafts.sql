CREATE TABLE workflow_draft_schedules (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, org_unit_id uuid NOT NULL,
 definition_id uuid NOT NULL, version_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 recipient_account_id uuid NOT NULL, recipient_person_id uuid NOT NULL,
 cadence text NOT NULL CHECK(cadence IN('once','daily','weekly','monthly','yearly')),
 every integer NOT NULL CHECK(every BETWEEN 1 AND 365 AND (cadence<>'once' OR every=1)),
 start_date date NOT NULL, end_date date CHECK(end_date>=start_date),
 local_time text NOT NULL CHECK(local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 time_zone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh' CHECK(time_zone='Asia/Ho_Chi_Minh'),
 next_run_at timestamptz,
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,definition_id,version_id) REFERENCES workflow_versions(tenant_id,definition_id,id),
 CHECK(enabled OR next_run_at IS NULL)
);
CREATE INDEX workflow_draft_schedules_due ON workflow_draft_schedules(next_run_at,id)
 WHERE enabled AND next_run_at IS NOT NULL;

CREATE FUNCTION workflows_draft_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Draft schedules must be retained' USING ERRCODE='42501'; END IF;
 IF NOT OLD.enabled OR
  (to_jsonb(OLD)-'enabled'-'revision'-'next_run_at') IS DISTINCT FROM
  (to_jsonb(NEW)-'enabled'-'revision'-'next_run_at') OR
  NOT (
   (NOT NEW.enabled AND NEW.revision=OLD.revision+1 AND NEW.next_run_at IS NULL)
   OR (NEW.enabled AND NEW.revision=OLD.revision AND OLD.next_run_at IS NOT NULL
    AND (NEW.next_run_at IS NULL OR NEW.next_run_at>OLD.next_run_at))
  ) THEN RAISE EXCEPTION 'Invalid draft schedule transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_draft_schedule_history BEFORE UPDATE OR DELETE ON workflow_draft_schedules
 FOR EACH ROW EXECUTE FUNCTION workflows_draft_schedule_guard();

CREATE TABLE workflow_scheduled_draft_jobs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, schedule_id uuid NOT NULL, scheduled_for timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','retry','done','blocked')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), error_code text,
 target_request_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,schedule_id,scheduled_for), UNIQUE(tenant_id,target_request_id),
 FOREIGN KEY(tenant_id,schedule_id) REFERENCES workflow_draft_schedules(tenant_id,id),
 FOREIGN KEY(tenant_id,target_request_id) REFERENCES workflow_requests(tenant_id,id),
 CHECK((status='done')=(target_request_id IS NOT NULL)),
 CHECK((status IN('retry','blocked'))=(error_code IS NOT NULL))
);
CREATE INDEX workflow_scheduled_draft_jobs_due ON workflow_scheduled_draft_jobs(next_attempt_at,id)
 WHERE status IN('queued','retry');

CREATE TABLE workflow_scheduled_draft_attempts (
 tenant_id uuid NOT NULL, job_id uuid NOT NULL, attempt integer NOT NULL CHECK(attempt>0),
 status text NOT NULL CHECK(status IN('retry','done','blocked')),
 error_code text, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,job_id,attempt),
 FOREIGN KEY(tenant_id,job_id) REFERENCES workflow_scheduled_draft_jobs(tenant_id,id)
);
CREATE TRIGGER workflow_scheduled_draft_attempt_history BEFORE UPDATE OR DELETE ON workflow_scheduled_draft_attempts
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

CREATE FUNCTION workflows_scheduled_draft_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Scheduled jobs must be retained' USING ERRCODE='42501'; END IF;
 IF (OLD.id,OLD.tenant_id,OLD.schedule_id,OLD.scheduled_for,OLD.created_at)
       IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.schedule_id,NEW.scheduled_for,NEW.created_at)
    OR NOT (
     (OLD.status IN('queued','retry') AND NEW.status IN('retry','done','blocked') AND NEW.attempts=OLD.attempts+1)
     OR (OLD.status='blocked' AND NEW.status='queued' AND NEW.attempts=OLD.attempts)
    ) THEN
  RAISE EXCEPTION 'Invalid scheduled job transition' USING ERRCODE='23514';
 END IF;
 IF NEW.status='done' AND NOT EXISTS (
    SELECT 1 FROM workflow_draft_schedules s JOIN workflow_requests q
      ON (q.tenant_id,q.id)=(NEW.tenant_id,NEW.target_request_id)
    WHERE (s.tenant_id,s.id)=(NEW.tenant_id,NEW.schedule_id) AND s.enabled AND q.status='draft'
      AND (q.definition_id,q.version_id,q.org_unit_id,q.owner_account_id,q.owner_person_id)=
          (s.definition_id,s.version_id,s.org_unit_id,s.recipient_account_id,s.recipient_person_id)
 ) THEN RAISE EXCEPTION 'Invalid scheduled draft scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_scheduled_draft_job_history BEFORE UPDATE OR DELETE ON workflow_scheduled_draft_jobs
 FOR EACH ROW EXECUTE FUNCTION workflows_scheduled_draft_job_guard();

GRANT SELECT,INSERT,UPDATE ON workflow_draft_schedules,workflow_scheduled_draft_jobs TO aio_workflows_runtime;
GRANT SELECT,INSERT ON workflow_scheduled_draft_attempts TO aio_workflows_runtime;
