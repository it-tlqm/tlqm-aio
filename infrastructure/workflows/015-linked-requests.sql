-- Rules pin both published schemas. A completed run and its jobs commit together.
CREATE TABLE workflow_link_rules (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, org_unit_id uuid NOT NULL,
 source_definition_id uuid NOT NULL, source_version_id uuid NOT NULL,
 target_definition_id uuid NOT NULL, target_version_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='array'),
 predicate jsonb CHECK(jsonb_typeof(predicate)='object'),
 recipient_account_id uuid, recipient_person_id uuid,
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,source_definition_id,source_version_id) REFERENCES workflow_versions(tenant_id,definition_id,id),
 FOREIGN KEY(tenant_id,target_definition_id,target_version_id) REFERENCES workflow_versions(tenant_id,definition_id,id),
 CHECK(source_definition_id<>target_definition_id),
 CHECK((recipient_account_id IS NULL)=(recipient_person_id IS NULL))
);
CREATE INDEX workflow_link_rules_active ON workflow_link_rules(tenant_id,source_version_id,org_unit_id) WHERE enabled;

CREATE FUNCTION workflows_link_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Link rules must be retained' USING ERRCODE='42501'; END IF;
 IF NOT OLD.enabled OR NEW.enabled OR NEW.revision<>OLD.revision+1
    OR (to_jsonb(OLD)-'enabled'-'revision') IS DISTINCT FROM (to_jsonb(NEW)-'enabled'-'revision') THEN
  RAISE EXCEPTION 'Link rule is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_link_rule_history BEFORE UPDATE OR DELETE ON workflow_link_rules
 FOR EACH ROW EXECUTE FUNCTION workflows_link_rule_guard();

CREATE TABLE workflow_link_jobs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, rule_id uuid NOT NULL,
 source_run_id uuid NOT NULL, source_round integer NOT NULL CHECK(source_round>0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','retry','done','blocked','skipped')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), error_code text,
 target_request_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,rule_id,source_run_id,source_round),
 UNIQUE(tenant_id,target_request_id),
 FOREIGN KEY(tenant_id,rule_id) REFERENCES workflow_link_rules(tenant_id,id),
 FOREIGN KEY(tenant_id,source_run_id,source_round) REFERENCES workflow_run_inputs(tenant_id,run_id,round),
 FOREIGN KEY(tenant_id,target_request_id) REFERENCES workflow_requests(tenant_id,id),
 CHECK((status='done')=(target_request_id IS NOT NULL)),
 CHECK((status IN('retry','blocked'))=(error_code IS NOT NULL))
);
CREATE INDEX workflow_link_jobs_due ON workflow_link_jobs(next_attempt_at,id) WHERE status IN('queued','retry');
CREATE INDEX workflow_link_jobs_source ON workflow_link_jobs(tenant_id,source_run_id,created_at,id);
CREATE INDEX workflow_link_submitted_request ON workflow_requests(tenant_id,run_id) WHERE run_id IS NOT NULL;

CREATE TABLE workflow_link_attempts (
 tenant_id uuid NOT NULL, job_id uuid NOT NULL, attempt integer NOT NULL CHECK(attempt>0),
 status text NOT NULL CHECK(status IN('retry','done','blocked','skipped')),
 error_code text, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,job_id,attempt),
 FOREIGN KEY(tenant_id,job_id) REFERENCES workflow_link_jobs(tenant_id,id)
);
CREATE TRIGGER workflow_link_attempt_history BEFORE UPDATE OR DELETE ON workflow_link_attempts
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

CREATE FUNCTION workflows_link_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Link jobs must be retained' USING ERRCODE='42501'; END IF;
 IF OLD.status IN('done','skipped')
    OR (OLD.id,OLD.tenant_id,OLD.rule_id,OLD.source_run_id,OLD.source_round,OLD.created_at)
       IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.rule_id,NEW.source_run_id,NEW.source_round,NEW.created_at)
    OR NOT (
     (OLD.status IN('queued','retry') AND NEW.status IN('retry','done','blocked','skipped') AND NEW.attempts=OLD.attempts+1)
     OR (OLD.status='blocked' AND NEW.status='queued' AND NEW.attempts=OLD.attempts)
    ) THEN
  RAISE EXCEPTION 'Invalid link job transition' USING ERRCODE='23514';
 END IF;
 IF NEW.status='done' AND NOT EXISTS (
    SELECT 1 FROM workflow_link_rules r
    JOIN workflow_runs s ON (s.tenant_id,s.id)=(NEW.tenant_id,NEW.source_run_id)
    JOIN workflow_requests q ON (q.tenant_id,q.id)=(NEW.tenant_id,NEW.target_request_id)
    WHERE (r.tenant_id,r.id)=(NEW.tenant_id,NEW.rule_id)
      AND (q.definition_id,q.version_id,q.org_unit_id)=(r.target_definition_id,r.target_version_id,r.org_unit_id)
      AND (q.owner_account_id,q.owner_person_id)=(
        COALESCE(r.recipient_account_id,s.owner_account_id),COALESCE(r.recipient_person_id,s.owner_person_id))
 ) THEN RAISE EXCEPTION 'Invalid link draft scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_link_job_history BEFORE UPDATE OR DELETE ON workflow_link_jobs
 FOR EACH ROW EXECUTE FUNCTION workflows_link_job_guard();

CREATE FUNCTION workflows_enqueue_completed_links() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO workflow_link_jobs(id,tenant_id,rule_id,source_run_id,source_round)
 SELECT gen_random_uuid(),NEW.tenant_id,r.id,NEW.id,NEW.round
 FROM workflow_link_rules r
 WHERE r.enabled AND (r.tenant_id,r.org_unit_id,r.source_definition_id,r.source_version_id)=
  (NEW.tenant_id,NEW.org_unit_id,NEW.definition_id,NEW.version_id)
 ON CONFLICT(tenant_id,rule_id,source_run_id,source_round) DO NOTHING;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_link_completion AFTER UPDATE OF status ON workflow_runs
 FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status='completed')
 EXECUTE FUNCTION workflows_enqueue_completed_links();

GRANT SELECT,INSERT,UPDATE ON workflow_link_rules,workflow_link_jobs TO aio_workflows_runtime;
GRANT SELECT,INSERT ON workflow_link_attempts TO aio_workflows_runtime;
