CREATE TABLE personnel_workflow_intakes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), org_unit_id uuid NOT NULL REFERENCES org_units(id),
 source_run_id uuid NOT NULL, source_version_id uuid NOT NULL, source_round integer NOT NULL CHECK(source_round>0),
 recipient_account_id uuid NOT NULL REFERENCES accounts(id), recipient_person_id uuid NOT NULL REFERENCES persons(id),
 created_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz, employment_id uuid REFERENCES employments(id),
 UNIQUE(tenant_id,source_run_id,source_round), UNIQUE(employment_id),
 CHECK((accepted_at IS NULL)=(employment_id IS NULL))
);
CREATE INDEX personnel_workflow_intake_inbox ON personnel_workflow_intakes(tenant_id,recipient_account_id,created_at DESC,id)
 WHERE employment_id IS NULL;

CREATE FUNCTION personnel_workflow_intake_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Personnel intake history retained' USING ERRCODE='42501'; END IF;
 IF OLD.employment_id IS NOT NULL OR NEW.employment_id IS NULL OR NEW.accepted_at IS NULL
    OR (to_jsonb(NEW)-'accepted_at'-'employment_id') IS DISTINCT FROM (to_jsonb(OLD)-'accepted_at'-'employment_id')
    OR NOT EXISTS (SELECT 1 FROM employments e WHERE (e.tenant_id,e.id)=(NEW.tenant_id,NEW.employment_id))
 THEN RAISE EXCEPTION 'Invalid personnel intake transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER personnel_workflow_intake_history BEFORE UPDATE OR DELETE ON personnel_workflow_intakes
 FOR EACH ROW EXECUTE FUNCTION personnel_workflow_intake_guard();

GRANT SELECT,INSERT,UPDATE ON personnel_workflow_intakes TO aio_runtime;
