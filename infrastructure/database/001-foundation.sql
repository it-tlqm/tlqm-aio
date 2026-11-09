CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE environment_marker (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  purpose text NOT NULL CHECK (purpose IN ('tlqm-aio-local', 'tlqm-aio-test'))
);
CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE persons (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES persons(id),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE external_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  PRIMARY KEY (issuer, subject)
);
CREATE TABLE tenant_memberships (
  account_id uuid NOT NULL REFERENCES accounts(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (account_id, tenant_id)
);
CREATE TABLE legal_entities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE TABLE org_units (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  parent_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  UNIQUE (tenant_id, legal_entity_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id, parent_id) REFERENCES org_units(tenant_id, legal_entity_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE TABLE job_titles (id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL);
CREATE TABLE positions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  org_unit_id uuid NOT NULL,
  job_title_id uuid NOT NULL REFERENCES job_titles(id),
  name text NOT NULL,
  UNIQUE (tenant_id, legal_entity_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id, org_unit_id) REFERENCES org_units(tenant_id, legal_entity_id, id)
);
CREATE TABLE employments (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES persons(id),
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  employee_code text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  UNIQUE (tenant_id, legal_entity_id, id),
  UNIQUE (legal_entity_id, employee_code),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities(tenant_id, id),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE TABLE assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  employment_id uuid NOT NULL,
  position_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  FOREIGN KEY (tenant_id, legal_entity_id, employment_id) REFERENCES employments(tenant_id, legal_entity_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id, position_id) REFERENCES positions(tenant_id, legal_entity_id, id),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE TABLE applications (
  code text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','planned','disabled')),
  launch_url text
);
CREATE TABLE application_grants (
  account_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  app_code text NOT NULL REFERENCES applications(code),
  active boolean NOT NULL DEFAULT true,
  valid_until timestamptz,
  PRIMARY KEY (account_id, tenant_id, app_code),
  FOREIGN KEY (account_id, tenant_id) REFERENCES tenant_memberships(account_id, tenant_id)
);
CREATE TABLE app_roles (
  app_code text NOT NULL REFERENCES applications(code),
  code text NOT NULL,
  PRIMARY KEY (app_code, code)
);
CREATE TABLE role_permissions (
  app_code text NOT NULL,
  role_code text NOT NULL,
  permission text NOT NULL,
  PRIMARY KEY (app_code, role_code, permission),
  FOREIGN KEY (app_code, role_code) REFERENCES app_roles(app_code, code)
);
CREATE TABLE role_bindings (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  app_code text NOT NULL,
  role_code text NOT NULL,
  managed_app_code text REFERENCES applications(code),
  active boolean NOT NULL DEFAULT true,
  valid_until timestamptz,
  FOREIGN KEY (account_id, tenant_id) REFERENCES tenant_memberships(account_id, tenant_id),
  FOREIGN KEY (app_code, role_code) REFERENCES app_roles(app_code, code)
);
CREATE TABLE login_transactions (
  hash text PRIMARY KEY,
  app_code text NOT NULL REFERENCES applications(code),
  encrypted_payload text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE sessions (
  hash text PRIMARY KEY,
  app_code text NOT NULL REFERENCES applications(code),
  account_id uuid NOT NULL REFERENCES accounts(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  sid text,
  encrypted_payload text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_account_app ON sessions(account_id, app_code);
CREATE INDEX sessions_idp_session ON sessions(issuer, sid);
CREATE TABLE logout_receipts (
  app_code text NOT NULL,
  jti text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (app_code, jti)
);
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_account_id uuid REFERENCES accounts(id),
  subject_account_id uuid REFERENCES accounts(id),
  tenant_id uuid REFERENCES tenants(id),
  app_code text NOT NULL REFERENCES applications(code),
  action text NOT NULL,
  reason text,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_scope ON audit_events(tenant_id, id DESC);
