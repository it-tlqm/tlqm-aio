CREATE TABLE cms_websites (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{2,50}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','disabled')),
  default_locale text NOT NULL DEFAULT 'vi' CHECK (default_locale ~ '^[a-z]{2,8}(?:-[A-Z]{2})?$'),
  locales text[] NOT NULL DEFAULT ARRAY['vi']::text[],
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (cardinality(locales) BETWEEN 1 AND 12),
  CHECK (default_locale = ANY(locales))
);

CREATE TABLE cms_domains (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid NOT NULL,
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  environment text NOT NULL DEFAULT 'local' CHECK (environment IN ('local','preview','production')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, host),
  FOREIGN KEY (tenant_id, website_id) REFERENCES cms_websites(tenant_id, id)
);

CREATE TABLE cms_pages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{2,80}$'),
  path text NOT NULL CHECK (path LIKE '/%' AND length(path) <= 240),
  kind text NOT NULL DEFAULT 'landing' CHECK (kind IN ('landing','collection','system')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  draft_revision_id uuid,
  published_revision_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, website_id, id),
  UNIQUE (tenant_id, website_id, code),
  UNIQUE (tenant_id, website_id, path),
  FOREIGN KEY (tenant_id, website_id) REFERENCES cms_websites(tenant_id, id)
);

CREATE TABLE cms_page_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid NOT NULL,
  page_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,8}(?:-[A-Z]{2})?$'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','archived')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  seo jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(seo) = 'object'),
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocks) = 'array'),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (tenant_id, page_id, locale, version),
  UNIQUE (tenant_id, page_id, id),
  UNIQUE (tenant_id, website_id, id),
  FOREIGN KEY (tenant_id, website_id) REFERENCES cms_websites(tenant_id, id),
  FOREIGN KEY (tenant_id, website_id, page_id) REFERENCES cms_pages(tenant_id, website_id, id),
  CHECK ((state = 'published') = (published_at IS NOT NULL AND published_by IS NOT NULL))
);

ALTER TABLE cms_pages
  ADD CONSTRAINT cms_pages_draft_revision_fk
  FOREIGN KEY (tenant_id, website_id, draft_revision_id)
  REFERENCES cms_page_revisions(tenant_id, website_id, id);

ALTER TABLE cms_pages
  ADD CONSTRAINT cms_pages_published_revision_fk
  FOREIGN KEY (tenant_id, website_id, published_revision_id)
  REFERENCES cms_page_revisions(tenant_id, website_id, id);

CREATE TABLE cms_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid,
  page_id uuid,
  actor_account_id uuid NOT NULL,
  action text NOT NULL,
  target_id uuid,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 5 AND 240),
  request_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cms_receipts (
  tenant_id uuid NOT NULL,
  actor_account_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_account_id, idempotency_key)
);

CREATE INDEX cms_domains_host_lookup ON cms_domains(host) WHERE active;
CREATE INDEX cms_pages_website_lookup ON cms_pages(tenant_id, website_id, status);
CREATE INDEX cms_revisions_public_lookup ON cms_page_revisions(tenant_id, website_id, page_id, locale, state);
CREATE INDEX cms_audit_scope ON cms_audit(tenant_id, website_id, page_id, id DESC);

CREATE FUNCTION cms_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CMS history is immutable' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER cms_page_revisions_immutable
  BEFORE UPDATE OR DELETE ON cms_page_revisions
  FOR EACH ROW EXECUTE FUNCTION cms_history_immutable();

CREATE TRIGGER cms_audit_immutable
  BEFORE UPDATE OR DELETE ON cms_audit
  FOR EACH ROW EXECUTE FUNCTION cms_history_immutable();
