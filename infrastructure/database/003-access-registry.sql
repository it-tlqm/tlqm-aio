-- Governance metadata and explicit management delegation for newly registered apps.
CREATE TABLE application_delegations (
  account_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  app_code text NOT NULL REFERENCES applications(code),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,tenant_id,app_code),
  FOREIGN KEY(account_id,tenant_id) REFERENCES tenant_memberships(account_id,tenant_id)
);
ALTER TABLE applications ADD COLUMN oidc_client_id text;
ALTER TABLE applications ADD COLUMN oidc_audience text;
ALTER TABLE applications ADD COLUMN provisioned_at timestamptz;
INSERT INTO permission_catalog(app_code,code,name,protected)
  SELECT code,'applications:create','Đăng ký ứng dụng mới',true FROM applications WHERE code='aio-foundation'
  ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(tenant_id,app_code,role_code,permission)
  SELECT tenant_id,app_code,code,'applications:create' FROM app_roles
  WHERE app_code='aio-foundation' AND code='access-admin' AND protected
  ON CONFLICT DO NOTHING;
CREATE INDEX role_bindings_scope_lookup ON role_bindings(tenant_id,app_code,account_id);
