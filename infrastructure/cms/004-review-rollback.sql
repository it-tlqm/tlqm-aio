ALTER TABLE cms_page_revisions DROP CONSTRAINT IF EXISTS cms_page_revisions_state_check;
ALTER TABLE cms_page_revisions ADD CONSTRAINT cms_page_revisions_state_check CHECK (state IN ('draft','review','published','archived'));

ALTER TABLE cms_content_revisions DROP CONSTRAINT IF EXISTS cms_content_revisions_state_check;
ALTER TABLE cms_content_revisions ADD CONSTRAINT cms_content_revisions_state_check CHECK (state IN ('draft','review','published','archived'));
