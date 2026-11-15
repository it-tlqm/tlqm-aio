CREATE TABLE directory_configurations (
 tenant_id uuid NOT NULL REFERENCES tenants(id), resource text NOT NULL CHECK(resource IN('people','org-units','job-titles','positions')),
 draft jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, current_version integer NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,resource)
);
CREATE TABLE directory_schema_versions (
 tenant_id uuid NOT NULL, resource text NOT NULL, version integer NOT NULL CHECK(version>0),
 configuration jsonb NOT NULL, published_by uuid NOT NULL REFERENCES accounts(id), published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,resource,version), FOREIGN KEY(tenant_id,resource) REFERENCES directory_configurations(tenant_id,resource)
);
CREATE TRIGGER directory_schema_history BEFORE UPDATE OR DELETE ON directory_schema_versions FOR EACH ROW EXECUTE FUNCTION protect_audit_history();
CREATE TABLE directory_metadata (
 tenant_id uuid NOT NULL,resource text NOT NULL,target_id uuid NOT NULL,schema_version integer NOT NULL,answers jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,resource,target_id),FOREIGN KEY(tenant_id,resource,schema_version) REFERENCES directory_schema_versions(tenant_id,resource,version)
);
CREATE TABLE directory_metadata_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,resource text NOT NULL,target_id uuid NOT NULL,
 schema_version integer NOT NULL,answers jsonb NOT NULL,revision integer NOT NULL,actor_account_id uuid NOT NULL REFERENCES accounts(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,resource,target_id) REFERENCES directory_metadata(tenant_id,resource,target_id),
 FOREIGN KEY(tenant_id,resource,schema_version) REFERENCES directory_schema_versions(tenant_id,resource,version),UNIQUE(tenant_id,resource,target_id,revision)
);
CREATE TRIGGER directory_metadata_history_immutable BEFORE UPDATE OR DELETE ON directory_metadata_history FOR EACH ROW EXECUTE FUNCTION protect_audit_history();
CREATE FUNCTION directory_metadata_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE found_id uuid; BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Metadata history retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ((NEW.tenant_id,NEW.resource,NEW.target_id) IS DISTINCT FROM (OLD.tenant_id,OLD.resource,OLD.target_id) OR NEW.revision<>OLD.revision+1) THEN RAISE EXCEPTION 'Metadata ownership immutable' USING ERRCODE='23514'; END IF;
 IF NEW.resource='people' THEN SELECT id INTO found_id FROM persons WHERE id=NEW.target_id AND home_tenant_id=NEW.tenant_id;
 ELSIF NEW.resource='org-units' THEN SELECT id INTO found_id FROM org_units WHERE id=NEW.target_id AND tenant_id=NEW.tenant_id;
 ELSIF NEW.resource='job-titles' THEN SELECT id INTO found_id FROM job_titles WHERE id=NEW.target_id AND tenant_id=NEW.tenant_id;
 ELSIF NEW.resource='positions' THEN SELECT id INTO found_id FROM positions WHERE id=NEW.target_id AND tenant_id=NEW.tenant_id; END IF;
 IF found_id IS NULL THEN RAISE EXCEPTION 'Invalid metadata target' USING ERRCODE='23503'; END IF; RETURN NEW; END $$;
CREATE TRIGGER directory_metadata_ownership BEFORE INSERT OR UPDATE OR DELETE ON directory_metadata FOR EACH ROW EXECUTE FUNCTION directory_metadata_guard();
CREATE TABLE directory_profile_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),person_id uuid NOT NULL REFERENCES persons(id),actor_account_id uuid NOT NULL REFERENCES accounts(id),
 schema_version integer NOT NULL,base_revision integer NOT NULL,patch jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','withdrawn')),
 revision integer NOT NULL DEFAULT 1,reason text NOT NULL,review_reason text,reviewer_account_id uuid REFERENCES accounts(id),created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz
);
CREATE UNIQUE INDEX directory_one_profile_proposal ON directory_profile_proposals(tenant_id,person_id) WHERE status='pending';
CREATE FUNCTION directory_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' AND (NOT EXISTS(SELECT 1 FROM persons p JOIN accounts a ON a.person_id=p.id WHERE p.id=NEW.person_id AND p.home_tenant_id=NEW.tenant_id AND a.id=NEW.actor_account_id) OR NOT EXISTS(SELECT 1 FROM directory_schema_versions v WHERE v.tenant_id=NEW.tenant_id AND v.resource='people' AND v.version=NEW.schema_version)) THEN RAISE EXCEPTION 'Invalid proposal ownership or schema' USING ERRCODE='23503'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Profile proposal history retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (OLD.status<>'pending' OR NEW.status='pending' OR NEW.revision<>OLD.revision+1 OR (NEW.id,NEW.tenant_id,NEW.person_id,NEW.actor_account_id,NEW.schema_version,NEW.base_revision,NEW.patch,NEW.reason,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.person_id,OLD.actor_account_id,OLD.schema_version,OLD.base_revision,OLD.patch,OLD.reason,OLD.created_at)) THEN RAISE EXCEPTION 'Proposal immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER directory_proposal_ownership BEFORE INSERT OR UPDATE OR DELETE ON directory_profile_proposals FOR EACH ROW EXECUTE FUNCTION directory_proposal_guard();
