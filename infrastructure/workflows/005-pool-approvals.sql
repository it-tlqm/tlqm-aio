ALTER TABLE workflow_tasks ADD COLUMN approval_policy jsonb CHECK(approval_policy IS NULL OR (jsonb_typeof(approval_policy)='object' AND approval_policy ?& ARRAY['mode','required','groupRevision'] AND approval_policy->>'mode' IN('all','any','quorum') AND jsonb_typeof(approval_policy->'required')='number' AND (approval_policy->>'required')::integer BETWEEN 1 AND 50 AND (approval_policy->>'groupRevision')::integer>0 AND kind='approval' AND assignment_group_id IS NOT NULL));
CREATE TABLE workflow_approval_members (
 tenant_id uuid NOT NULL,task_id uuid NOT NULL,account_id uuid NOT NULL,person_id uuid NOT NULL,name text NOT NULL,
 active boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,task_id,account_id),FOREIGN KEY(tenant_id,task_id) REFERENCES workflow_tasks(tenant_id,id)
);
CREATE UNIQUE INDEX workflow_pool_active_person ON workflow_approval_members(tenant_id,task_id,person_id) WHERE active;
CREATE TABLE workflow_approval_votes (
 tenant_id uuid NOT NULL,task_id uuid NOT NULL,account_id uuid NOT NULL,person_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('approve','reject','return')),answers jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,task_id,account_id),UNIQUE(tenant_id,task_id,person_id),FOREIGN KEY(tenant_id,task_id,account_id) REFERENCES workflow_approval_members(tenant_id,task_id,account_id)
);
CREATE TRIGGER workflow_pool_votes_immutable BEFORE UPDATE OR DELETE ON workflow_approval_votes FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE FUNCTION workflow_pool_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.approval_policy IS DISTINCT FROM OLD.approval_policy THEN RAISE EXCEPTION 'Approval policy snapshot immutable' USING ERRCODE='23514'; END IF;
 IF NEW.approval_policy IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
  IF (NEW.status='completed' AND (SELECT count(*) FROM workflow_approval_votes WHERE tenant_id=NEW.tenant_id AND task_id=NEW.id AND action='approve')<(NEW.approval_policy->>'required')::integer)
   OR (NEW.status IN('returned','rejected') AND NOT EXISTS(SELECT 1 FROM workflow_approval_votes WHERE tenant_id=NEW.tenant_id AND task_id=NEW.id AND action=CASE WHEN NEW.status='returned' THEN 'return' ELSE 'reject' END)) THEN
   RAISE EXCEPTION 'Pool decision required' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER workflow_pool_policy_immutable BEFORE UPDATE ON workflow_tasks FOR EACH ROW EXECUTE FUNCTION workflow_pool_policy_guard();
CREATE FUNCTION workflow_pool_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Approval member history retained' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM workflow_tasks t JOIN workflow_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id AND t.status='pending' AND t.approval_policy IS NOT NULL AND t.kind='approval' AND r.owner_person_id<>NEW.person_id) THEN RAISE EXCEPTION 'Invalid approval member' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ((NEW.tenant_id,NEW.task_id,NEW.account_id,NEW.person_id,NEW.name,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.task_id,OLD.account_id,OLD.person_id,OLD.name,OLD.created_at) OR NEW.revision<>OLD.revision+1 OR EXISTS(SELECT 1 FROM workflow_approval_votes WHERE tenant_id=OLD.tenant_id AND task_id=OLD.task_id AND account_id=OLD.account_id)) THEN RAISE EXCEPTION 'Approval member identity immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER workflow_pool_member_ownership BEFORE INSERT OR UPDATE OR DELETE ON workflow_approval_members FOR EACH ROW EXECUTE FUNCTION workflow_pool_member_guard();
CREATE FUNCTION workflow_pool_vote_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM workflow_approval_members m JOIN workflow_tasks t ON t.tenant_id=m.tenant_id AND t.id=m.task_id JOIN workflow_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id JOIN workflow_groups g ON g.tenant_id=t.tenant_id AND g.id=t.assignment_group_id JOIN workflow_group_members gm ON gm.tenant_id=g.tenant_id AND gm.group_id=g.id AND gm.account_id=m.account_id WHERE m.tenant_id=NEW.tenant_id AND m.task_id=NEW.task_id AND m.account_id=NEW.account_id AND m.person_id=NEW.person_id AND m.active AND g.active AND gm.active AND (g.org_unit_id IS NULL OR g.org_unit_id=r.org_unit_id) AND t.status='pending' AND r.status='running' AND r.current_step=t.node_id AND r.round=t.round AND r.owner_person_id<>NEW.person_id) THEN RAISE EXCEPTION 'Invalid approval vote' USING ERRCODE='23514'; END IF;RETURN NEW; END $$;
CREATE TRIGGER workflow_pool_vote_authority BEFORE INSERT ON workflow_approval_votes FOR EACH ROW EXECUTE FUNCTION workflow_pool_vote_guard();
CREATE OR REPLACE FUNCTION workflow_task_notification() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE owner_id uuid; BEGIN
 SELECT owner_account_id INTO owner_id FROM workflow_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;
 IF NEW.approval_policy IS NULL AND NEW.status='pending' AND (TG_OP='INSERT' OR NEW.assignee_account_id IS DISTINCT FROM OLD.assignee_account_id) THEN
 INSERT INTO workflow_notifications(tenant_id,recipient_account_id,event_key,run_id,task_id,kind) VALUES(NEW.tenant_id,NEW.assignee_account_id,'assignment:'||NEW.id||':'||NEW.revision,NEW.run_id,NEW.id,'assigned') ON CONFLICT DO NOTHING;
 ELSIF TG_OP='UPDATE' AND NEW.status='completed' AND OLD.status='pending' AND NEW.kind='approval' THEN
 INSERT INTO workflow_notifications(tenant_id,recipient_account_id,event_key,run_id,task_id,kind) VALUES(NEW.tenant_id,owner_id,'approval:'||NEW.id,NEW.run_id,NEW.id,'approved') ON CONFLICT DO NOTHING; END IF;RETURN NEW; END $$;
CREATE FUNCTION workflow_pool_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.active AND (TG_OP='INSERT' OR NOT OLD.active) THEN
 INSERT INTO workflow_notifications(tenant_id,recipient_account_id,event_key,run_id,task_id,kind) SELECT NEW.tenant_id,NEW.account_id,'pool-assignment:'||NEW.task_id||':'||NEW.account_id||':'||NEW.revision,t.run_id,NEW.task_id,'assigned' FROM workflow_tasks t WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id ON CONFLICT DO NOTHING; END IF;RETURN NEW; END $$;
CREATE TRIGGER workflow_pool_notifications AFTER INSERT OR UPDATE ON workflow_approval_members FOR EACH ROW EXECUTE FUNCTION workflow_pool_notification();
