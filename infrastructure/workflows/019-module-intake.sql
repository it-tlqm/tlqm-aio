CREATE TABLE workflow_intake_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 definition_id uuid NOT NULL, version_id uuid NOT NULL, org_unit_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('hr-onboarding','lms-training')),
 recipient_account_id uuid NOT NULL, recipient_person_id uuid NOT NULL,
 mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,definition_id,version_id) REFERENCES workflow_versions(tenant_id,definition_id,id)
);
CREATE UNIQUE INDEX workflow_intake_rule_active ON workflow_intake_rules(tenant_id,version_id,org_unit_id,kind) WHERE enabled;
CREATE TRIGGER workflow_intake_rule_guard BEFORE UPDATE OR DELETE ON workflow_intake_rules
 FOR EACH ROW EXECUTE FUNCTION workflows_output_template_guard();

CREATE TABLE workflow_intake_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, rule_id uuid NOT NULL,
 source_run_id uuid NOT NULL, source_round integer NOT NULL CHECK(source_round>0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','retry','done','blocked','skipped')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), error_code text, target_draft_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,rule_id,source_run_id,source_round),
 FOREIGN KEY(tenant_id,rule_id) REFERENCES workflow_intake_rules(tenant_id,id),
 FOREIGN KEY(tenant_id,source_run_id,source_round) REFERENCES workflow_run_inputs(tenant_id,run_id,round),
 CHECK((status='done')=(target_draft_id IS NOT NULL)), CHECK(target_draft_id IS NULL OR target_draft_id=id),
 CHECK((status IN('retry','blocked'))=(error_code IS NOT NULL))
);
CREATE INDEX workflow_intake_due ON workflow_intake_jobs(next_attempt_at,id) WHERE status IN('queued','retry');
CREATE INDEX workflow_intake_rule_jobs ON workflow_intake_jobs(tenant_id,rule_id,created_at DESC,id);

CREATE TABLE workflow_intake_attempts (
 tenant_id uuid NOT NULL, job_id uuid NOT NULL, attempt integer NOT NULL CHECK(attempt>0),
 status text NOT NULL CHECK(status IN('retry','done','blocked','skipped')), error_code text,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,job_id,attempt),
 FOREIGN KEY(tenant_id,job_id) REFERENCES workflow_intake_jobs(tenant_id,id)
);
CREATE TRIGGER workflow_intake_attempt_immutable BEFORE UPDATE OR DELETE ON workflow_intake_attempts
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

CREATE FUNCTION workflows_intake_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Intake jobs retained' USING ERRCODE='42501'; END IF;
 IF (OLD.id,OLD.tenant_id,OLD.rule_id,OLD.source_run_id,OLD.source_round,OLD.created_at)
    IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.rule_id,NEW.source_run_id,NEW.source_round,NEW.created_at)
    OR NOT (
     (OLD.status IN('queued','retry') AND NEW.status IN('retry','done','blocked','skipped') AND NEW.attempts=OLD.attempts+1)
     OR (OLD.status='blocked' AND NEW.status='queued' AND NEW.attempts=OLD.attempts)
    ) THEN RAISE EXCEPTION 'Invalid intake job transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_intake_job_guard BEFORE UPDATE OR DELETE ON workflow_intake_jobs
 FOR EACH ROW EXECUTE FUNCTION workflows_intake_job_guard();

CREATE FUNCTION workflows_enqueue_module_intakes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO workflow_intake_jobs(tenant_id,rule_id,source_run_id,source_round)
 SELECT NEW.tenant_id,r.id,NEW.id,NEW.round
 FROM workflow_intake_rules r
 WHERE r.enabled AND (r.tenant_id,r.org_unit_id,r.definition_id,r.version_id)=
   (NEW.tenant_id,NEW.org_unit_id,NEW.definition_id,NEW.version_id)
 ON CONFLICT(tenant_id,rule_id,source_run_id,source_round) DO NOTHING;
 RETURN NEW;
END; $$;
CREATE TRIGGER workflow_intake_on_completion AFTER UPDATE OF status ON workflow_runs
 FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status='completed' AND NEW.source_context IS NULL)
 EXECUTE FUNCTION workflows_enqueue_module_intakes();

GRANT SELECT,INSERT,UPDATE ON workflow_intake_rules,workflow_intake_jobs TO aio_workflows_runtime;
GRANT SELECT,INSERT ON workflow_intake_attempts TO aio_workflows_runtime;
