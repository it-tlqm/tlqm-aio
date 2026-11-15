CREATE TABLE cms_content_types (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{2,60}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  schema jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(schema) = 'object'),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, website_id, id),
  UNIQUE (tenant_id, website_id, code),
  FOREIGN KEY (tenant_id, website_id) REFERENCES cms_websites(tenant_id, id)
);

CREATE TABLE cms_content_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid NOT NULL,
  content_type_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{2,80}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  draft_revision_id uuid,
  published_revision_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, website_id, id),
  UNIQUE (tenant_id, website_id, content_type_id, code),
  FOREIGN KEY (tenant_id, website_id, content_type_id) REFERENCES cms_content_types(tenant_id, website_id, id)
);

CREATE TABLE cms_content_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid NOT NULL,
  content_type_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,8}(?:-[A-Z]{2})?$'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','archived')),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9/_-]{0,200}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  seo jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(seo) = 'object'),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (tenant_id, entry_id, locale, version),
  UNIQUE (tenant_id, website_id, id),
  UNIQUE (tenant_id, website_id, entry_id, locale, slug),
  FOREIGN KEY (tenant_id, website_id, content_type_id) REFERENCES cms_content_types(tenant_id, website_id, id),
  FOREIGN KEY (tenant_id, website_id, entry_id) REFERENCES cms_content_entries(tenant_id, website_id, id),
  CHECK ((state = 'published') = (published_at IS NOT NULL AND published_by IS NOT NULL))
);

ALTER TABLE cms_content_entries
  ADD CONSTRAINT cms_content_entries_draft_fk
  FOREIGN KEY (tenant_id, website_id, draft_revision_id)
  REFERENCES cms_content_revisions(tenant_id, website_id, id);

ALTER TABLE cms_content_entries
  ADD CONSTRAINT cms_content_entries_published_fk
  FOREIGN KEY (tenant_id, website_id, published_revision_id)
  REFERENCES cms_content_revisions(tenant_id, website_id, id);

CREATE TABLE cms_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid,
  storage_provider text NOT NULL CHECK (storage_provider IN ('local','s3','cloudinary','external')),
  storage_key text NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 500),
  public_url text NOT NULL CHECK (length(public_url) BETWEEN 1 AND 2000),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  mime_type text NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 120),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  checksum text CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
  alt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(alt) = 'object'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','quarantined')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, website_id, storage_provider, storage_key),
  FOREIGN KEY (tenant_id, website_id) REFERENCES cms_websites(tenant_id, id)
);

CREATE TABLE cms_menus (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{2,60}$'),
  name text NOT NULL,
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,8}(?:-[A-Z]{2})?$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  draft jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(draft) = 'array'),
  published jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(published) = 'array'),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, website_id, code, locale),
  FOREIGN KEY (tenant_id, website_id) REFERENCES cms_websites(tenant_id, id)
);

CREATE TABLE cms_channel_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('website','facebook','tiktok','zalo-oa')),
  external_account_id text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 240),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 240),
  capability jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capability) = 'object'),
  token_ref text,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('pending','connected','expired','disabled','error')),
  last_error text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, website_id, id),
  UNIQUE (tenant_id, website_id, provider, external_account_id),
  FOREIGN KEY (tenant_id, website_id) REFERENCES cms_websites(tenant_id, id)
);

CREATE TABLE cms_publications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  website_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('page','content')),
  target_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','scheduled','publishing','published','failed','cancelled')),
  scheduled_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  external_id text,
  last_error text,
  request_key text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, connection_id, request_key),
  FOREIGN KEY (tenant_id, website_id, connection_id) REFERENCES cms_channel_connections(tenant_id, website_id, id)
);

CREATE INDEX cms_content_types_lookup ON cms_content_types(tenant_id, website_id, active);
CREATE INDEX cms_content_entries_lookup ON cms_content_entries(tenant_id, website_id, content_type_id, status);
CREATE INDEX cms_content_revisions_public_lookup ON cms_content_revisions(tenant_id, website_id, content_type_id, locale, state);
CREATE INDEX cms_assets_lookup ON cms_assets(tenant_id, website_id, status, created_at DESC);
CREATE INDEX cms_menus_lookup ON cms_menus(tenant_id, website_id, code, locale);
CREATE INDEX cms_publications_queue ON cms_publications(state, scheduled_at, created_at);

CREATE TRIGGER cms_content_revisions_immutable
  BEFORE UPDATE OR DELETE ON cms_content_revisions
  FOR EACH ROW EXECUTE FUNCTION cms_history_immutable();
