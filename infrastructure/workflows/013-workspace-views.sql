CREATE TABLE workflow_workspace_views (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 account_id uuid NOT NULL,
 person_id uuid NOT NULL,
 view text NOT NULL CHECK (view IN ('mine','inbox','all','followed','done')),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
 settings jsonb NOT NULL CHECK (jsonb_typeof(settings)='object' AND octet_length(settings::text)<=4096),
 revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workflow_workspace_views_name ON workflow_workspace_views
 (tenant_id,account_id,person_id,view,lower(name)) WHERE active;
CREATE INDEX workflow_work_done_results ON workflow_task_results(tenant_id,actor_account_id,actor_person_id,task_id);
CREATE INDEX workflow_work_done_votes ON workflow_approval_votes(tenant_id,account_id,person_id,task_id);
CREATE FUNCTION workflow_workspace_view_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Workflow workspace view history is retained' USING ERRCODE='42501';
 END IF;
 IF (NEW.id,NEW.tenant_id,NEW.account_id,NEW.person_id,NEW.view,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.account_id,OLD.person_id,OLD.view,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
  RAISE EXCEPTION 'Invalid workflow workspace view change' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_workspace_view_ownership BEFORE UPDATE OR DELETE ON workflow_workspace_views
 FOR EACH ROW EXECUTE FUNCTION workflow_workspace_view_guard();
