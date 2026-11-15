-- Foundation owns proposal/application state; no foreign connection to the Workflow database.
ALTER TABLE directory_profile_proposals ADD CONSTRAINT directory_proposal_tenant_key UNIQUE(tenant_id,id);
CREATE TABLE directory_profile_workflows (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,proposal_id uuid NOT NULL,
 initiated_by uuid NOT NULL REFERENCES accounts(id),source jsonb NOT NULL,dispatch jsonb NOT NULL,
 run_id uuid,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,
 CHECK(jsonb_typeof(source)='object' AND source ?& ARRAY['kind','id','proposalId','subjectPersonId','subjectName','checksum','changes'] AND source->>'kind'='directory-profile' AND source->>'checksum' ~ '^[0-9a-f]{64}$'),
 CHECK(jsonb_typeof(dispatch)='object'),
 UNIQUE(tenant_id,proposal_id),UNIQUE(tenant_id,run_id),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES directory_profile_proposals(tenant_id,id)
);
CREATE FUNCTION directory_profile_workflow_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Profile workflow history retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (NEW.source->>'id'<>NEW.id::text OR NEW.source->>'proposalId'<>NEW.proposal_id::text OR NEW.source->>'kind'<>'directory-profile' OR NOT EXISTS(SELECT 1 FROM directory_profile_proposals p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.proposal_id AND p.status='pending' AND p.person_id::text=NEW.source->>'subjectPersonId')) THEN RAISE EXCEPTION 'Invalid profile workflow source' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ((NEW.id,NEW.tenant_id,NEW.proposal_id,NEW.initiated_by,NEW.source,NEW.dispatch,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.proposal_id,OLD.initiated_by,OLD.source,OLD.dispatch,OLD.created_at) OR NEW.revision<>OLD.revision+1 OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id) OR OLD.applied_at IS NOT NULL) THEN RAISE EXCEPTION 'Profile workflow snapshot immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER directory_profile_workflow_ownership BEFORE INSERT OR UPDATE OR DELETE ON directory_profile_workflows FOR EACH ROW EXECUTE FUNCTION directory_profile_workflow_guard();
