-- Explicit responsibilities never create an application grant or role.
CREATE TABLE reporting_lines (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  employment_id uuid NOT NULL, manager_employment_id uuid NOT NULL,
  valid_from timestamptz NOT NULL, valid_until timestamptz,
  active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
  FOREIGN KEY(tenant_id,legal_entity_id,employment_id) REFERENCES employments(tenant_id,legal_entity_id,id),
  FOREIGN KEY(tenant_id,legal_entity_id,manager_employment_id) REFERENCES employments(tenant_id,legal_entity_id,id),
  CHECK(employment_id<>manager_employment_id), CHECK(valid_until IS NULL OR valid_until>valid_from),
  CONSTRAINT reporting_lines_overlap EXCLUDE USING gist
    (employment_id WITH =,tstzrange(valid_from,valid_until,'[)') WITH &&) WHERE(active)
);
CREATE INDEX reporting_lines_tenant ON reporting_lines(tenant_id,id);

CREATE TABLE approval_substitutions (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  employment_id uuid NOT NULL, substitute_employment_id uuid NOT NULL,
  valid_from timestamptz NOT NULL, valid_until timestamptz,
  active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
  FOREIGN KEY(tenant_id,legal_entity_id,employment_id) REFERENCES employments(tenant_id,legal_entity_id,id),
  FOREIGN KEY(tenant_id,legal_entity_id,substitute_employment_id) REFERENCES employments(tenant_id,legal_entity_id,id),
  CHECK(employment_id<>substitute_employment_id), CHECK(valid_until IS NULL OR valid_until>valid_from),
  CONSTRAINT approval_substitutions_overlap EXCLUDE USING gist
    (employment_id WITH =,tstzrange(valid_from,valid_until,'[)') WITH &&) WHERE(active)
);
CREATE INDEX approval_substitutions_tenant ON approval_substitutions(tenant_id,id);

CREATE TABLE unit_leaders (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  org_unit_id uuid NOT NULL, employment_id uuid NOT NULL,
  valid_from timestamptz NOT NULL, valid_until timestamptz,
  active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
  FOREIGN KEY(tenant_id,legal_entity_id,org_unit_id) REFERENCES org_units(tenant_id,legal_entity_id,id),
  FOREIGN KEY(tenant_id,legal_entity_id,employment_id) REFERENCES employments(tenant_id,legal_entity_id,id),
  CHECK(valid_until IS NULL OR valid_until>valid_from),
  CONSTRAINT unit_leaders_overlap EXCLUDE USING gist
    (org_unit_id WITH =,tstzrange(valid_from,valid_until,'[)') WITH &&) WHERE(active)
);
CREATE INDEX unit_leaders_tenant ON unit_leaders(tenant_id,id);
