-- Additive upgrade of the local Foundation schema. Migration 001 is unchanged.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE persons ADD COLUMN home_tenant_id uuid REFERENCES tenants(id);
UPDATE persons p SET home_tenant_id = (
  SELECT m.tenant_id FROM accounts a JOIN tenant_memberships m ON m.account_id=a.id
  WHERE a.person_id=p.id ORDER BY m.tenant_id LIMIT 1
);
ALTER TABLE persons ALTER COLUMN home_tenant_id SET NOT NULL;
ALTER TABLE persons ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN is_protected boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN mfa_required boolean NOT NULL DEFAULT false;
UPDATE accounts a SET is_protected=true WHERE EXISTS (
  SELECT 1 FROM role_bindings b WHERE b.account_id=a.id AND b.role_code='access-admin'
);
ALTER TABLE external_identities ADD COLUMN linked_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE external_identities ADD COLUMN linked_by uuid REFERENCES accounts(id);
ALTER TABLE external_identities ADD COLUMN verification_note text NOT NULL DEFAULT 'Local bootstrap fixture';

ALTER TABLE legal_entities ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE legal_entities ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE org_units ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE org_units ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE org_units ADD CONSTRAINT org_units_tenant_id_id_key UNIQUE(tenant_id,id);
ALTER TABLE job_titles ADD COLUMN tenant_id uuid REFERENCES tenants(id);
DO $$
BEGIN
  IF EXISTS (SELECT job_title_id FROM positions GROUP BY job_title_id HAVING count(DISTINCT tenant_id)>1)
  THEN RAISE EXCEPTION 'Shared job title requires explicit tenant mapping before upgrade'; END IF;
END $$;
UPDATE job_titles j SET tenant_id=COALESCE(
  (SELECT p.tenant_id FROM positions p WHERE p.job_title_id=j.id ORDER BY p.tenant_id LIMIT 1),
  (SELECT id FROM tenants ORDER BY id LIMIT 1)
);
ALTER TABLE job_titles ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE job_titles DROP CONSTRAINT job_titles_code_key;
ALTER TABLE job_titles ADD CONSTRAINT job_titles_tenant_code_key UNIQUE(tenant_id,code);
ALTER TABLE job_titles ADD CONSTRAINT job_titles_tenant_id_id_key UNIQUE(tenant_id,id);
ALTER TABLE job_titles ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE job_titles ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE positions ADD CONSTRAINT positions_scoped_title_fk FOREIGN KEY(tenant_id,job_title_id) REFERENCES job_titles(tenant_id,id);
ALTER TABLE positions ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE positions ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE employments ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE assignments ADD COLUMN revision integer NOT NULL DEFAULT 1;

-- Role definitions and their permission sets are tenant scoped. Preserve all bindings.
CREATE TEMP TABLE legacy_roles ON COMMIT DROP AS SELECT * FROM app_roles;
CREATE TEMP TABLE legacy_permissions ON COMMIT DROP AS SELECT * FROM role_permissions;
ALTER TABLE role_bindings DROP CONSTRAINT role_bindings_app_code_role_code_fkey;
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_app_code_role_code_fkey;
ALTER TABLE app_roles DROP CONSTRAINT app_roles_pkey;
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_pkey;
ALTER TABLE app_roles ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE role_permissions ADD COLUMN tenant_id uuid REFERENCES tenants(id);
UPDATE app_roles SET tenant_id=(SELECT id FROM tenants ORDER BY id LIMIT 1);
UPDATE role_permissions SET tenant_id=(SELECT id FROM tenants ORDER BY id LIMIT 1);
INSERT INTO app_roles(app_code,code,tenant_id)
  SELECT r.app_code,r.code,t.id FROM legacy_roles r CROSS JOIN tenants t
  WHERE t.id<>(SELECT id FROM tenants ORDER BY id LIMIT 1);
INSERT INTO role_permissions(app_code,role_code,permission,tenant_id)
  SELECT p.app_code,p.role_code,p.permission,t.id FROM legacy_permissions p CROSS JOIN tenants t
  WHERE t.id<>(SELECT id FROM tenants ORDER BY id LIMIT 1);
ALTER TABLE app_roles ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE role_permissions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app_roles ADD PRIMARY KEY(tenant_id,app_code,code);
ALTER TABLE role_permissions ADD PRIMARY KEY(tenant_id,app_code,role_code,permission);
ALTER TABLE app_roles ADD COLUMN name text NOT NULL DEFAULT '';
UPDATE app_roles SET name=code;
ALTER TABLE app_roles ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE app_roles ADD COLUMN protected boolean NOT NULL DEFAULT true;
ALTER TABLE app_roles ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE role_permissions ADD CONSTRAINT scoped_role_permissions_fk FOREIGN KEY(tenant_id,app_code,role_code) REFERENCES app_roles(tenant_id,app_code,code);
ALTER TABLE role_bindings ADD CONSTRAINT scoped_role_bindings_fk FOREIGN KEY(tenant_id,app_code,role_code) REFERENCES app_roles(tenant_id,app_code,code);
ALTER TABLE role_bindings ADD COLUMN org_unit_id uuid;
ALTER TABLE role_bindings ADD CONSTRAINT binding_unit_fk FOREIGN KEY(tenant_id,org_unit_id) REFERENCES org_units(tenant_id,id);
ALTER TABLE role_bindings ADD COLUMN valid_from timestamptz NOT NULL DEFAULT now();
ALTER TABLE role_bindings ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE role_bindings ADD CONSTRAINT binding_valid_period CHECK(valid_until IS NULL OR valid_until>valid_from);
ALTER TABLE application_grants ADD COLUMN revision integer NOT NULL DEFAULT 1;

ALTER TABLE applications ADD COLUMN owner_tenant_id uuid REFERENCES tenants(id);
UPDATE applications SET owner_tenant_id=(SELECT id FROM tenants ORDER BY id LIMIT 1);
ALTER TABLE applications ALTER COLUMN owner_tenant_id SET NOT NULL;
ALTER TABLE applications ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN protected boolean NOT NULL DEFAULT true;
ALTER TABLE applications ADD COLUMN revision integer NOT NULL DEFAULT 1;

CREATE TABLE permission_catalog (
  app_code text NOT NULL REFERENCES applications(code),
  code text NOT NULL,
  name text NOT NULL,
  protected boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(app_code,code),
  CHECK(code ~ '^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$')
);
INSERT INTO permission_catalog(app_code,code,name,protected)
  SELECT DISTINCT app_code,permission,permission,true FROM role_permissions;
ALTER TABLE role_permissions ADD CONSTRAINT catalog_permission_fk FOREIGN KEY(app_code,permission) REFERENCES permission_catalog(app_code,code);

CREATE TABLE bootstrap_receipts(name text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE mutation_receipts (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  app_code text NOT NULL REFERENCES applications(code),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_account_id,app_code,tenant_id,idempotency_key)
);
ALTER TABLE audit_events ADD COLUMN target_type text;
ALTER TABLE audit_events ADD COLUMN target_id text;
ALTER TABLE sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

-- A single employment cannot have overlapping primary assignments, including history.
ALTER TABLE assignments ADD CONSTRAINT primary_assignment_no_overlap
  EXCLUDE USING gist (employment_id WITH =,tstzrange(valid_from,valid_until,'[)') WITH &&)
  WHERE (is_primary) DEFERRABLE INITIALLY IMMEDIATE;

CREATE FUNCTION check_org_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(71092028);
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM org_units WHERE id=NEW.parent_id AND tenant_id=NEW.tenant_id
      UNION
      SELECT u.id,u.parent_id FROM org_units u JOIN ancestors a ON u.id=a.parent_id
      WHERE u.tenant_id=NEW.tenant_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  ) THEN
    RAISE EXCEPTION 'Organization hierarchy would contain a cycle'
      USING ERRCODE='23514', CONSTRAINT='organization_no_cycle';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER org_units_cycle_guard BEFORE INSERT OR UPDATE OF parent_id,tenant_id ON org_units
  FOR EACH ROW EXECUTE FUNCTION check_org_cycle();

CREATE FUNCTION check_assignment_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e employments%ROWTYPE;
BEGIN
  SELECT * INTO e FROM employments WHERE id=NEW.employment_id FOR UPDATE;
  IF FOUND AND (NEW.valid_from<e.valid_from OR
    (e.valid_until IS NOT NULL AND (NEW.valid_until IS NULL OR NEW.valid_until>e.valid_until))) THEN
    RAISE EXCEPTION 'Assignment must be within employment validity'
      USING ERRCODE='23514', CONSTRAINT='assignment_within_employment';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assignment_period_guard BEFORE INSERT OR UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION check_assignment_period();

CREATE FUNCTION check_employment_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_employment employments%ROWTYPE;
BEGIN
  SELECT * INTO current_employment FROM employments WHERE id=NEW.id;
  IF EXISTS (
    SELECT 1 FROM assignments a WHERE a.employment_id=NEW.id AND (
      a.valid_from<current_employment.valid_from OR
      (current_employment.valid_until IS NOT NULL AND (a.valid_until IS NULL OR a.valid_until>current_employment.valid_until))
    )
  ) THEN
    RAISE EXCEPTION 'Employment end must preserve assignment history'
      USING ERRCODE='23514', CONSTRAINT='employment_contains_assignments';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER employment_period_guard AFTER UPDATE ON employments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_employment_period();

CREATE FUNCTION protect_audit_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit history is append only' USING ERRCODE='42501';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION protect_audit_history();
