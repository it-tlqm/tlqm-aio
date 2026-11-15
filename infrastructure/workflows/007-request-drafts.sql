-- User-owned drafts are separate from submitted immutable workflow runs.
CREATE TABLE workflow_requests (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, definition_id uuid NOT NULL, version_id uuid NOT NULL,
 org_unit_id uuid NOT NULL, owner_account_id uuid NOT NULL, owner_person_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200), answers jsonb NOT NULL,
 selections jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','submitted')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), run_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,definition_id,version_id) REFERENCES workflow_versions(tenant_id,definition_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_runs(tenant_id,id), CHECK((status='submitted')=(run_id IS NOT NULL))
);
CREATE INDEX workflow_requests_owner ON workflow_requests(tenant_id,owner_account_id,updated_at DESC,id DESC) WHERE status='draft';
CREATE TABLE workflow_request_history (
 tenant_id uuid NOT NULL, request_id uuid NOT NULL, revision integer NOT NULL,
 title text NOT NULL, answers jsonb NOT NULL, selections jsonb NOT NULL, status text NOT NULL,run_id uuid,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,request_id,revision),
 FOREIGN KEY(tenant_id,request_id) REFERENCES workflow_requests(tenant_id,id)
);
CREATE FUNCTION workflows_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Request history must be retained' USING ERRCODE='42501'; END IF;
 IF OLD.status<>'draft' OR (OLD.id,OLD.tenant_id,OLD.definition_id,OLD.version_id,OLD.org_unit_id,OLD.owner_account_id,OLD.owner_person_id,OLD.created_at) IS DISTINCT FROM
 (NEW.id,NEW.tenant_id,NEW.definition_id,NEW.version_id,NEW.org_unit_id,NEW.owner_account_id,NEW.owner_person_id,NEW.created_at) OR NEW.revision<>OLD.revision+1 THEN
 RAISE EXCEPTION 'Invalid request revision or ownership' USING ERRCODE='23514'; END IF;
 RETURN NEW; END; $$;
CREATE TRIGGER workflow_request_guard BEFORE UPDATE OR DELETE ON workflow_requests FOR EACH ROW EXECUTE FUNCTION workflows_request_guard();
CREATE TRIGGER workflow_request_history_immutable BEFORE UPDATE OR DELETE ON workflow_request_history FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
GRANT SELECT,INSERT,UPDATE ON workflow_requests TO aio_workflows_runtime;
GRANT SELECT,INSERT ON workflow_request_history TO aio_workflows_runtime;
