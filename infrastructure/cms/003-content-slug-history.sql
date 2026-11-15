ALTER TABLE cms_content_revisions
  DROP CONSTRAINT IF EXISTS cms_content_revisions_tenant_id_website_id_entry_id_locale__key;

CREATE UNIQUE INDEX cms_content_revisions_slug_history
  ON cms_content_revisions(tenant_id, website_id, entry_id, locale, slug, version);
