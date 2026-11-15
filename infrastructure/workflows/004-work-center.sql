-- Work and notification metadata stays with its source module; no business data in IAM.
CREATE TABLE workflow_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_account_id uuid NOT NULL,
 event_key text NOT NULL, run_id uuid NOT NULL, task_id uuid, kind text NOT NULL CHECK(kind IN('assigned','approved','returned','completed','rejected','cancelled','due_soon','overdue')),
 read_at timestamptz, revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,recipient_account_id,event_key),
 FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_runs(tenant_id,id), FOREIGN KEY(tenant_id,task_id) REFERENCES workflow_tasks(tenant_id,id)
);
CREATE INDEX workflow_notifications_recipient ON workflow_notifications(tenant_id,recipient_account_id,created_at DESC,id DESC);
CREATE FUNCTION workflow_notification_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Notification history retained' USING ERRCODE='23514'; END IF;
 IF (NEW.id,NEW.tenant_id,NEW.recipient_account_id,NEW.event_key,NEW.run_id,NEW.task_id,NEW.kind,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.recipient_account_id,OLD.event_key,OLD.run_id,OLD.task_id,OLD.kind,OLD.created_at) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Notification ownership immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER workflow_notifications_guard BEFORE UPDATE OR DELETE ON workflow_notifications FOR EACH ROW EXECUTE FUNCTION workflow_notification_immutable();
CREATE FUNCTION workflow_task_notification() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE owner_id uuid; BEGIN
 SELECT owner_account_id INTO owner_id FROM workflow_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;
 IF NEW.status='pending' AND (TG_OP='INSERT' OR NEW.assignee_account_id IS DISTINCT FROM OLD.assignee_account_id) THEN
 INSERT INTO workflow_notifications(tenant_id,recipient_account_id,event_key,run_id,task_id,kind) VALUES(NEW.tenant_id,NEW.assignee_account_id,'assignment:'||NEW.id||':'||NEW.revision,NEW.run_id,NEW.id,'assigned') ON CONFLICT DO NOTHING;
 ELSIF TG_OP='UPDATE' AND NEW.status='completed' AND OLD.status='pending' AND NEW.kind='approval' THEN
 INSERT INTO workflow_notifications(tenant_id,recipient_account_id,event_key,run_id,task_id,kind) VALUES(NEW.tenant_id,owner_id,'approval:'||NEW.id,NEW.run_id,NEW.id,'approved') ON CONFLICT DO NOTHING;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER workflow_task_notifications AFTER INSERT OR UPDATE ON workflow_tasks FOR EACH ROW EXECUTE FUNCTION workflow_task_notification();
CREATE FUNCTION workflow_run_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN('needs_revision','completed','rejected','cancelled') THEN
 INSERT INTO workflow_notifications(tenant_id,recipient_account_id,event_key,run_id,kind) VALUES(NEW.tenant_id,NEW.owner_account_id,'run:'||NEW.id||':'||NEW.revision,NEW.id,CASE WHEN NEW.status='needs_revision' THEN 'returned' ELSE NEW.status END) ON CONFLICT DO NOTHING;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER workflow_run_notifications AFTER UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION workflow_run_notification();
CREATE TABLE workflow_reminder_policies (
 tenant_id uuid NOT NULL, org_unit_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT false,
 before_minutes integer NOT NULL DEFAULT 60 CHECK(before_minutes BETWEEN 0 AND 10080),
 overdue_minutes integer NOT NULL DEFAULT 60 CHECK(overdue_minutes BETWEEN 1 AND 10080),
 revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,org_unit_id)
);
CREATE TABLE workflow_reminder_runs (
 tenant_id uuid PRIMARY KEY, last_started_at timestamptz NOT NULL, last_completed_at timestamptz,
 last_error_code text, delivered integer NOT NULL DEFAULT 0
);
