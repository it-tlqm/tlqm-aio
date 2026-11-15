CREATE TABLE forms (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{2,50}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  owner_account_id uuid NOT NULL,
  org_unit_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  draft_schema jsonb CHECK (draft_schema IS NULL OR jsonb_typeof(draft_schema)='object'),
  latest_version integer NOT NULL DEFAULT 0 CHECK (latest_version >= 0),
  max_submissions integer NOT NULL DEFAULT 1 CHECK (max_submissions BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,code)
);
CREATE TABLE form_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  schema jsonb NOT NULL CHECK (jsonb_typeof(schema)='object'),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,form_id) REFERENCES forms(tenant_id,id),
  UNIQUE (tenant_id,form_id,id),
  UNIQUE (tenant_id,form_id,version)
);
CREATE TABLE version_availability (
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  version_id uuid NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid NOT NULL,
  PRIMARY KEY(tenant_id,form_id,version_id),
  FOREIGN KEY(tenant_id,form_id,version_id) REFERENCES form_versions(tenant_id,form_id,id)
);
CREATE TABLE form_groups (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  org_unit_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id)
);
CREATE TABLE form_group_members (
  tenant_id uuid NOT NULL,
  group_id uuid NOT NULL,
  account_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(tenant_id,group_id,account_id),
  FOREIGN KEY(tenant_id,group_id) REFERENCES form_groups(tenant_id,id)
);
CREATE TABLE form_audiences (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('account','unit','group')),
  target_id uuid NOT NULL,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY(tenant_id,form_id) REFERENCES forms(tenant_id,id),
  CHECK (closes_at IS NULL OR closes_at > opens_at)
);
CREATE INDEX form_audiences_lookup ON form_audiences(tenant_id,form_id) WHERE active;
CREATE TABLE submissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  version_id uuid NOT NULL,
  account_id uuid NOT NULL,
  person_id uuid NOT NULL,
  org_unit_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  FOREIGN KEY(tenant_id,form_id,version_id) REFERENCES form_versions(tenant_id,form_id,id),
  CHECK ((status='submitted')=(submitted_at IS NOT NULL)),
  UNIQUE(tenant_id,form_id,id)
);
CREATE UNIQUE INDEX one_open_draft_per_form ON submissions(tenant_id,form_id,account_id) WHERE status='draft';
CREATE INDEX submissions_reporting ON submissions(tenant_id,form_id,org_unit_id,submitted_at);
CREATE TABLE form_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  form_id uuid,
  org_unit_id uuid,
  actor_account_id uuid NOT NULL,
  action text NOT NULL,
  target_id uuid,
  reason text NOT NULL,
  request_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_audit_scope ON form_audit(tenant_id,form_id,id DESC);
CREATE TABLE form_receipts (
  tenant_id uuid NOT NULL,
  actor_account_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,actor_account_id,idempotency_key)
);
CREATE FUNCTION forms_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Forms history is immutable' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER form_versions_immutable BEFORE UPDATE OR DELETE ON form_versions FOR EACH ROW EXECUTE FUNCTION forms_append_only();
CREATE TRIGGER form_audit_immutable BEFORE UPDATE OR DELETE ON form_audit FOR EACH ROW EXECUTE FUNCTION forms_append_only();
CREATE TRIGGER form_receipts_immutable BEFORE UPDATE OR DELETE ON form_receipts FOR EACH ROW EXECUTE FUNCTION forms_append_only();
CREATE TRIGGER version_closure_immutable BEFORE UPDATE OR DELETE ON version_availability FOR EACH ROW EXECUTE FUNCTION forms_append_only();
CREATE FUNCTION forms_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='submitted' OR (OLD.id,OLD.tenant_id,OLD.form_id,OLD.version_id,OLD.account_id,OLD.person_id,OLD.org_unit_id,OLD.created_at)
      IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.form_id,NEW.version_id,NEW.account_id,NEW.person_id,NEW.org_unit_id,NEW.created_at) THEN
    RAISE EXCEPTION 'Submission history and ownership are immutable' USING ERRCODE='23514', CONSTRAINT='submission_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER form_submission_immutable BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION forms_submission_guard();
