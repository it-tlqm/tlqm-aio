CREATE TABLE workflow_output_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, definition_id uuid NOT NULL,
 version_id uuid NOT NULL, org_unit_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN('print','email')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 heading text NOT NULL CHECK(length(heading) BETWEEN 1 AND 240),
 body text NOT NULL CHECK(length(body)<=6000),
 fields jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(fields)='array'),
 event_kind text CHECK(event_kind IN('assigned','approved','returned','completed','rejected','cancelled','due_soon','overdue','mentioned')),
 step_id text CHECK(length(step_id) BETWEEN 1 AND 64),
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,definition_id,version_id) REFERENCES workflow_versions(tenant_id,definition_id,id),
 CHECK((kind='email')=(event_kind IS NOT NULL)),
 CHECK(kind='email' OR step_id IS NULL), CHECK(kind='print' OR fields='[]'::jsonb)
);
CREATE INDEX workflow_output_templates_live ON workflow_output_templates(tenant_id,version_id,org_unit_id,kind)
 WHERE enabled;
CREATE FUNCTION workflows_output_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Output templates retained' USING ERRCODE='42501'; END IF;
 IF NOT OLD.enabled OR NEW.enabled OR NEW.revision<>OLD.revision+1
   OR (to_jsonb(OLD)-'enabled'-'revision') IS DISTINCT FROM (to_jsonb(NEW)-'enabled'-'revision')
 THEN RAISE EXCEPTION 'Output template immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_output_template_guard BEFORE UPDATE OR DELETE ON workflow_output_templates
 FOR EACH ROW EXECUTE FUNCTION workflows_output_template_guard();

CREATE TABLE workflow_email_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, template_id uuid NOT NULL,
 notification_id uuid NOT NULL, source_round integer NOT NULL CHECK(source_round>0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','retry','done','blocked','skipped')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), error_code text, delivery_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,template_id,notification_id), UNIQUE(tenant_id,delivery_id),
 FOREIGN KEY(tenant_id,template_id) REFERENCES workflow_output_templates(tenant_id,id),
 FOREIGN KEY(tenant_id,notification_id) REFERENCES workflow_notifications(tenant_id,id),
 CHECK((status='done')=(delivery_id IS NOT NULL)),
 CHECK((status IN('retry','blocked'))=(error_code IS NOT NULL))
);
CREATE INDEX workflow_email_jobs_due ON workflow_email_jobs(next_attempt_at,id) WHERE status IN('queued','retry');

CREATE TABLE workflow_email_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, job_id uuid NOT NULL,
 recipient_account_id uuid NOT NULL, recipient_person_id uuid NOT NULL,
 subject text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,job_id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES workflow_email_jobs(tenant_id,id)
);
ALTER TABLE workflow_email_jobs ADD FOREIGN KEY(tenant_id,delivery_id) REFERENCES workflow_email_deliveries(tenant_id,id);
CREATE INDEX workflow_email_deliveries_recipient ON workflow_email_deliveries(tenant_id,recipient_account_id,created_at DESC,id DESC);
CREATE TRIGGER workflow_email_delivery_immutable BEFORE UPDATE OR DELETE ON workflow_email_deliveries
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE TABLE workflow_email_attempts (
 tenant_id uuid NOT NULL, job_id uuid NOT NULL, attempt integer NOT NULL CHECK(attempt>0),
 status text NOT NULL CHECK(status IN('retry','done','blocked','skipped')), error_code text,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,job_id,attempt),
 FOREIGN KEY(tenant_id,job_id) REFERENCES workflow_email_jobs(tenant_id,id)
);
CREATE TRIGGER workflow_email_attempt_immutable BEFORE UPDATE OR DELETE ON workflow_email_attempts
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE FUNCTION workflows_email_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Email history retained' USING ERRCODE='42501'; END IF;
 IF (OLD.id,OLD.tenant_id,OLD.template_id,OLD.notification_id,OLD.source_round,OLD.created_at)
    IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.template_id,NEW.notification_id,NEW.source_round,NEW.created_at)
    OR NOT (
     (OLD.status IN('queued','retry') AND NEW.status IN('retry','done','blocked','skipped') AND NEW.attempts=OLD.attempts+1)
     OR (OLD.status='blocked' AND NEW.status='queued' AND NEW.attempts=OLD.attempts)
    ) THEN RAISE EXCEPTION 'Invalid email job transition' USING ERRCODE='23514'; END IF;
 IF NEW.status='done' AND NOT EXISTS (
   SELECT 1 FROM workflow_email_deliveries d JOIN workflow_notifications n
      ON (n.tenant_id,n.id,n.recipient_account_id)=(NEW.tenant_id,NEW.notification_id,d.recipient_account_id)
   WHERE (d.tenant_id,d.id,d.job_id)=(NEW.tenant_id,NEW.delivery_id,NEW.id)
 ) THEN RAISE EXCEPTION 'Invalid email delivery scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_email_job_guard BEFORE UPDATE OR DELETE ON workflow_email_jobs
 FOR EACH ROW EXECUTE FUNCTION workflows_email_job_guard();

CREATE FUNCTION workflows_enqueue_email_output() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO workflow_email_jobs(tenant_id,template_id,notification_id,source_round)
 SELECT NEW.tenant_id,o.id,NEW.id,COALESCE(t.round,r.round)
 FROM workflow_runs r
 JOIN workflow_output_templates o ON (o.tenant_id,o.definition_id,o.version_id,o.org_unit_id)=
   (r.tenant_id,r.definition_id,r.version_id,r.org_unit_id)
 LEFT JOIN workflow_tasks t ON (t.tenant_id,t.id)=(NEW.tenant_id,NEW.task_id)
 WHERE (r.tenant_id,r.id)=(NEW.tenant_id,NEW.run_id)
   AND o.enabled AND o.kind='email' AND o.event_kind=NEW.kind AND (o.step_id IS NULL OR o.step_id=t.node_id)
 ON CONFLICT(tenant_id,template_id,notification_id) DO NOTHING;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_email_output AFTER INSERT ON workflow_notifications
 FOR EACH ROW EXECUTE FUNCTION workflows_enqueue_email_output();
GRANT SELECT,INSERT,UPDATE ON workflow_output_templates,workflow_email_jobs TO aio_workflows_runtime;
GRANT SELECT,INSERT ON workflow_email_deliveries,workflow_email_attempts TO aio_workflows_runtime;
