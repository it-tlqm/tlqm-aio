-- Pin step-triggered jobs to one successful execution attempt.
ALTER TABLE workflow_link_rules
 ADD COLUMN source_step_id text CHECK(length(source_step_id) BETWEEN 1 AND 64),
 ADD COLUMN recipient_is_step_actor boolean NOT NULL DEFAULT false,
 ADD CHECK(NOT recipient_is_step_actor OR (source_step_id IS NOT NULL AND recipient_account_id IS NULL));

ALTER TABLE workflow_link_jobs
 ADD COLUMN source_task_id uuid,
 ADD FOREIGN KEY(tenant_id,source_run_id,source_round,source_task_id)
   REFERENCES workflow_tasks(tenant_id,run_id,round,id);
DO $$ DECLARE old_unique name;
BEGIN
 SELECT conname INTO STRICT old_unique FROM pg_constraint
 WHERE conrelid='workflow_link_jobs'::regclass AND contype='u'
   AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, rule_id, source_run_id, source_round)';
 EXECUTE format('ALTER TABLE workflow_link_jobs DROP CONSTRAINT %I',old_unique);
END; $$;
CREATE UNIQUE INDEX workflow_link_jobs_run_once
 ON workflow_link_jobs(tenant_id,rule_id,source_run_id,source_round) WHERE source_task_id IS NULL;
CREATE UNIQUE INDEX workflow_link_jobs_step_once
 ON workflow_link_jobs(tenant_id,rule_id,source_task_id) WHERE source_task_id IS NOT NULL;
CREATE INDEX workflow_link_rules_step_active
 ON workflow_link_rules(tenant_id,source_version_id,org_unit_id,source_step_id)
 WHERE enabled AND source_step_id IS NOT NULL;

CREATE OR REPLACE FUNCTION workflows_enqueue_completed_links() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO workflow_link_jobs(id,tenant_id,rule_id,source_run_id,source_round)
 SELECT gen_random_uuid(),NEW.tenant_id,r.id,NEW.id,NEW.round
 FROM workflow_link_rules r
 WHERE r.enabled AND r.source_step_id IS NULL
   AND (r.tenant_id,r.org_unit_id,r.source_definition_id,r.source_version_id)=
       (NEW.tenant_id,NEW.org_unit_id,NEW.definition_id,NEW.version_id)
 ON CONFLICT(tenant_id,rule_id,source_run_id,source_round) WHERE source_task_id IS NULL DO NOTHING;
 RETURN NEW;
END; $$;

CREATE FUNCTION workflows_enqueue_step_links() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO workflow_link_jobs(id,tenant_id,rule_id,source_run_id,source_round,source_task_id)
 SELECT gen_random_uuid(),t.tenant_id,r.id,t.run_id,t.round,t.id
 FROM workflow_tasks t
 JOIN workflow_runs s ON (s.tenant_id,s.id,s.round)=(t.tenant_id,t.run_id,t.round)
 JOIN workflow_link_rules r ON (r.tenant_id,r.org_unit_id,r.source_definition_id,r.source_version_id,r.source_step_id)=
  (s.tenant_id,s.org_unit_id,s.definition_id,s.version_id,t.node_id)
 WHERE (t.tenant_id,t.id)=(NEW.tenant_id,NEW.task_id) AND t.status='completed'
   AND s.status='running' AND r.enabled
 ON CONFLICT(tenant_id,rule_id,source_task_id) WHERE source_task_id IS NOT NULL DO NOTHING;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_link_step_completion AFTER INSERT ON workflow_task_results
 FOR EACH ROW WHEN (NEW.action IN('approve','complete')) EXECUTE FUNCTION workflows_enqueue_step_links();

CREATE OR REPLACE FUNCTION workflows_link_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Link jobs must be retained' USING ERRCODE='42501'; END IF;
 IF OLD.status IN('done','skipped')
    OR (OLD.id,OLD.tenant_id,OLD.rule_id,OLD.source_run_id,OLD.source_round,OLD.source_task_id,OLD.created_at)
       IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.rule_id,NEW.source_run_id,NEW.source_round,NEW.source_task_id,NEW.created_at)
    OR NOT (
     (OLD.status IN('queued','retry') AND NEW.status IN('retry','done','blocked','skipped') AND NEW.attempts=OLD.attempts+1)
     OR (OLD.status='blocked' AND NEW.status='queued' AND NEW.attempts=OLD.attempts)
    ) THEN
  RAISE EXCEPTION 'Invalid link job transition' USING ERRCODE='23514';
 END IF;
 IF NEW.status='done' AND NOT EXISTS (
    SELECT 1 FROM workflow_link_rules r
    JOIN workflow_runs s ON (s.tenant_id,s.id,s.round)=(NEW.tenant_id,NEW.source_run_id,NEW.source_round)
    JOIN workflow_requests q ON (q.tenant_id,q.id)=(NEW.tenant_id,NEW.target_request_id)
    LEFT JOIN workflow_tasks t ON (t.tenant_id,t.run_id,t.round,t.id)=
      (NEW.tenant_id,NEW.source_run_id,NEW.source_round,NEW.source_task_id)
    LEFT JOIN workflow_task_results result ON (result.tenant_id,result.task_id)=(t.tenant_id,t.id)
    WHERE (r.tenant_id,r.id)=(NEW.tenant_id,NEW.rule_id)
      AND (s.definition_id,s.version_id,s.org_unit_id)=(r.source_definition_id,r.source_version_id,r.org_unit_id)
      AND (q.definition_id,q.version_id,q.org_unit_id)=(r.target_definition_id,r.target_version_id,r.org_unit_id)
      AND ((NEW.source_task_id IS NULL AND r.source_step_id IS NULL AND s.status='completed')
        OR (t.node_id=r.source_step_id AND t.status='completed' AND result.action IN('approve','complete')
          AND s.status IN('running','completed') AND NOT EXISTS(
            SELECT 1 FROM workflow_task_supersessions x
            WHERE (x.tenant_id,x.run_id,x.round,x.task_id)=(t.tenant_id,t.run_id,t.round,t.id)
          )))
      AND (q.owner_account_id,q.owner_person_id)=(
        CASE WHEN r.recipient_is_step_actor THEN result.actor_account_id ELSE COALESCE(r.recipient_account_id,s.owner_account_id) END,
        CASE WHEN r.recipient_is_step_actor THEN result.actor_person_id ELSE COALESCE(r.recipient_person_id,s.owner_person_id) END
      )
 ) THEN RAISE EXCEPTION 'Invalid link draft scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
