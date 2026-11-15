CREATE TABLE workflow_definitions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,code text NOT NULL CHECK(code ~ '^[a-z][a-z0-9-]{2,50}$'),name text NOT NULL,category text NOT NULL,org_unit_id uuid NOT NULL,owner_account_id uuid NOT NULL,
 draft jsonb NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','published','paused')),latest_version integer NOT NULL DEFAULT 0,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,code)
);
CREATE TABLE workflow_versions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,definition_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),spec jsonb NOT NULL,checksum text NOT NULL,published_by uuid NOT NULL,published_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,definition_id,id),UNIQUE(tenant_id,definition_id,version),FOREIGN KEY(tenant_id,definition_id) REFERENCES workflow_definitions(tenant_id,id)
);
CREATE TABLE workflow_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,definition_id uuid NOT NULL,version_id uuid NOT NULL,org_unit_id uuid NOT NULL,owner_account_id uuid NOT NULL,owner_person_id uuid NOT NULL,title text NOT NULL,
 status text NOT NULL CHECK(status IN('running','needs_revision','completed','rejected','cancelled')),round integer NOT NULL DEFAULT 1 CHECK(round>0),inputs jsonb NOT NULL,current_step text,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,definition_id,version_id) REFERENCES workflow_versions(tenant_id,definition_id,id)
);
CREATE TABLE workflow_run_inputs (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,round integer NOT NULL,inputs jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,run_id,round),FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_runs(tenant_id,id)
);
CREATE TABLE workflow_tasks (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,run_id uuid NOT NULL,round integer NOT NULL,node_id text NOT NULL,label text NOT NULL,kind text NOT NULL CHECK(kind IN('approval','task')),assignee_account_id uuid NOT NULL,assignee_name text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed','rejected','returned','cancelled')),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),due_at timestamptz NOT NULL,finished_at timestamptz,UNIQUE(tenant_id,id),UNIQUE(tenant_id,run_id,round,node_id),FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_runs(tenant_id,id),CHECK((status='pending')=(finished_at IS NULL))
);
CREATE UNIQUE INDEX workflow_one_pending ON workflow_tasks(tenant_id,run_id) WHERE status='pending';
CREATE INDEX workflow_inbox ON workflow_tasks(tenant_id,assignee_account_id,created_at DESC,id DESC) WHERE status='pending';
CREATE INDEX workflow_runs_owner ON workflow_runs(tenant_id,owner_account_id,created_at DESC,id DESC);
CREATE TABLE workflow_task_results (
 tenant_id uuid NOT NULL,task_id uuid NOT NULL,actor_account_id uuid NOT NULL,actor_person_id uuid NOT NULL,action text NOT NULL CHECK(action IN('approve','reject','complete','return')),answers jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,task_id),FOREIGN KEY(tenant_id,task_id) REFERENCES workflow_tasks(tenant_id,id)
);
CREATE TABLE workflow_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid NOT NULL,definition_id uuid,run_id uuid,org_unit_id uuid NOT NULL,actor_account_id uuid NOT NULL,action text NOT NULL,reason text NOT NULL,request_id text NOT NULL,details jsonb NOT NULL DEFAULT '{}',occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_audit_run ON workflow_audit(tenant_id,run_id,id);
CREATE TABLE workflow_receipts (
 tenant_id uuid NOT NULL,actor_account_id uuid NOT NULL,idempotency_key text NOT NULL,operation text NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,PRIMARY KEY(tenant_id,actor_account_id,idempotency_key)
);
CREATE FUNCTION workflows_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Workflow history is immutable' USING ERRCODE='42501'; END; $$;
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE OR DELETE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE TRIGGER workflow_inputs_immutable BEFORE UPDATE OR DELETE ON workflow_run_inputs FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE TRIGGER workflow_results_immutable BEFORE UPDATE OR DELETE ON workflow_task_results FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE TRIGGER workflow_audit_immutable BEFORE UPDATE OR DELETE ON workflow_audit FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE TRIGGER workflow_receipts_immutable BEFORE UPDATE OR DELETE ON workflow_receipts FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE FUNCTION workflows_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status IN('completed','rejected','cancelled') OR (OLD.id,OLD.tenant_id,OLD.definition_id,OLD.version_id,OLD.org_unit_id,OLD.owner_account_id,OLD.owner_person_id,OLD.created_at) IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.definition_id,NEW.version_id,NEW.org_unit_id,NEW.owner_account_id,NEW.owner_person_id,NEW.created_at) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Workflow run immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.inputs IS DISTINCT FROM OLD.inputs OR NEW.round<>OLD.round) AND NOT(OLD.status='needs_revision' AND NEW.status='running' AND NEW.round=OLD.round+1) THEN RAISE EXCEPTION 'Workflow input history immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END; $$;
CREATE TRIGGER workflow_run_ownership BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION workflows_run_guard();
CREATE FUNCTION workflows_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status<>'pending' OR (OLD.id,OLD.tenant_id,OLD.run_id,OLD.round,OLD.node_id,OLD.kind,OLD.created_at,OLD.due_at) IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.run_id,NEW.round,NEW.node_id,NEW.kind,NEW.created_at,NEW.due_at) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Workflow task immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER workflow_task_history BEFORE UPDATE ON workflow_tasks FOR EACH ROW EXECUTE FUNCTION workflows_task_guard();
CREATE FUNCTION workflows_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM workflow_tasks t JOIN workflow_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id AND t.kind='approval' AND (r.owner_account_id=NEW.actor_account_id OR r.owner_person_id=NEW.actor_person_id)) THEN RAISE EXCEPTION 'Self approval forbidden' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER workflow_no_self_approval BEFORE INSERT ON workflow_task_results FOR EACH ROW EXECUTE FUNCTION workflows_result_guard();
