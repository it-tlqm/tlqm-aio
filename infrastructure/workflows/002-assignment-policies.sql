CREATE TABLE workflow_groups (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,org_unit_id uuid,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 active boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
ALTER TABLE workflow_audit ALTER COLUMN org_unit_id DROP NOT NULL;
CREATE TABLE workflow_group_members (
 tenant_id uuid NOT NULL,group_id uuid NOT NULL,account_id uuid NOT NULL,active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,group_id,account_id),FOREIGN KEY(tenant_id,group_id) REFERENCES workflow_groups(tenant_id,id)
);
CREATE TABLE workflow_run_assignments (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,round integer NOT NULL,choices jsonb NOT NULL CHECK(jsonb_typeof(choices)='object'),group_revisions jsonb NOT NULL CHECK(jsonb_typeof(group_revisions)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,run_id,round),FOREIGN KEY(tenant_id,run_id,round) REFERENCES workflow_run_inputs(tenant_id,run_id,round)
);
CREATE TRIGGER workflow_assignments_immutable BEFORE UPDATE OR DELETE ON workflow_run_assignments FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
ALTER TABLE workflow_tasks ADD COLUMN assignment_group_id uuid;
ALTER TABLE workflow_tasks ADD CONSTRAINT workflow_task_group_tenant FOREIGN KEY(tenant_id,assignment_group_id) REFERENCES workflow_groups(tenant_id,id);
CREATE FUNCTION workflows_group_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workflow group history retained' USING ERRCODE='23514'; END IF;
 IF (NEW.id,NEW.tenant_id,NEW.org_unit_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.org_unit_id,OLD.created_at) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Workflow group ownership immutable' USING ERRCODE='23514'; END IF;RETURN NEW;END;$$;
CREATE TRIGGER workflow_group_ownership BEFORE UPDATE OR DELETE ON workflow_groups FOR EACH ROW EXECUTE FUNCTION workflows_group_guard();
CREATE FUNCTION workflows_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workflow group membership retained' USING ERRCODE='23514'; END IF;
 IF (NEW.tenant_id,NEW.group_id,NEW.account_id) IS DISTINCT FROM (OLD.tenant_id,OLD.group_id,OLD.account_id) THEN RAISE EXCEPTION 'Workflow group member ownership immutable' USING ERRCODE='23514'; END IF;RETURN NEW;END;$$;
CREATE TRIGGER workflow_member_ownership BEFORE UPDATE OR DELETE ON workflow_group_members FOR EACH ROW EXECUTE FUNCTION workflows_member_guard();
CREATE FUNCTION workflows_task_group_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.assignment_group_id IS DISTINCT FROM OLD.assignment_group_id THEN RAISE EXCEPTION 'Workflow assignment policy immutable' USING ERRCODE='23514'; END IF;RETURN NEW;END;$$;
CREATE TRIGGER workflow_task_group_immutable BEFORE UPDATE ON workflow_tasks FOR EACH ROW EXECUTE FUNCTION workflows_task_group_guard();
CREATE FUNCTION workflows_group_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM workflow_tasks t JOIN workflow_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id AND t.assignment_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_groups g JOIN workflow_group_members m ON m.tenant_id=g.tenant_id AND m.group_id=g.id WHERE g.tenant_id=t.tenant_id AND g.id=t.assignment_group_id AND g.active AND m.active AND m.account_id=NEW.actor_account_id AND (g.org_unit_id IS NULL OR g.org_unit_id=r.org_unit_id))) THEN RAISE EXCEPTION 'Workflow group eligibility revoked' USING ERRCODE='23514'; END IF;RETURN NEW;END;$$;
CREATE TRIGGER workflow_group_result_authority BEFORE INSERT ON workflow_task_results FOR EACH ROW EXECUTE FUNCTION workflows_group_result_guard();
