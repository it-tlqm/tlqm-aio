CREATE TABLE workflow_document_folders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  org_unit_id uuid NOT NULL,
  parent_id uuid,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,org_unit_id,id),
  FOREIGN KEY(tenant_id,org_unit_id,parent_id)
    REFERENCES workflow_document_folders(tenant_id,org_unit_id,id),
  CHECK(parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX workflow_document_folder_sibling_name
  ON workflow_document_folders(tenant_id,org_unit_id,parent_id,lower(name)) NULLS NOT DISTINCT;

CREATE TABLE workflow_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  org_unit_id uuid NOT NULL,
  folder_id uuid,
  draft_version integer NOT NULL CHECK(draft_version > 0),
  issued_version integer CHECK(issued_version > 0),
  review_state text NOT NULL CHECK(review_state IN('draft','pending','approved','rejected')),
  published boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,org_unit_id,folder_id)
    REFERENCES workflow_document_folders(tenant_id,org_unit_id,id),
  CHECK(NOT published OR issued_version IS NOT NULL),
  CHECK(issued_version IS NULL OR issued_version <= draft_version)
);
CREATE INDEX workflow_document_library ON workflow_documents(tenant_id,updated_at DESC,id DESC);

CREATE TABLE workflow_document_versions (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160),
  content text NOT NULL CHECK(length(content) <= 20000),
  viewer_units uuid[] NOT NULL CHECK(cardinality(viewer_units) BETWEEN 1 AND 50 AND array_position(viewer_units,NULL) IS NULL),
  definition_id uuid,
  workflow_version_id uuid,
  file_count integer NOT NULL CHECK(file_count BETWEEN 0 AND 4),
  created_by uuid NOT NULL,
  created_person_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,document_id,version),
  FOREIGN KEY(tenant_id,document_id) REFERENCES workflow_documents(tenant_id,id),
  FOREIGN KEY(tenant_id,definition_id,workflow_version_id)
    REFERENCES workflow_versions(tenant_id,definition_id,id),
  CHECK((definition_id IS NULL) = (workflow_version_id IS NULL))
);
CREATE INDEX workflow_document_workflow_version
  ON workflow_document_versions(tenant_id,workflow_version_id,document_id)
  WHERE workflow_version_id IS NOT NULL;
ALTER TABLE workflow_documents
  ADD FOREIGN KEY(tenant_id,id,draft_version) REFERENCES workflow_document_versions(tenant_id,document_id,version)
  DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY(tenant_id,id,issued_version) REFERENCES workflow_document_versions(tenant_id,document_id,version);

CREATE TABLE workflow_document_files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 180),
  byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 10485760),
  format text NOT NULL CHECK(format IN('pdf','docx','xlsx','txt','png','jpeg','csv','unknown')),
  checksum text NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
  scan_status text NOT NULL CHECK(scan_status IN('ready','quarantined')),
  content bytea,
  UNIQUE(tenant_id,document_id,id),
  FOREIGN KEY(tenant_id,document_id) REFERENCES workflow_documents(tenant_id,id),
  CHECK((scan_status='ready' AND format<>'unknown' AND content IS NOT NULL AND octet_length(content)=byte_count)
     OR (scan_status='quarantined' AND content IS NULL))
);
CREATE TABLE workflow_document_version_files (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version integer NOT NULL,
  file_id uuid NOT NULL,
  position integer NOT NULL CHECK(position BETWEEN 1 AND 4),
  PRIMARY KEY(tenant_id,document_id,version,file_id),
  UNIQUE(tenant_id,document_id,version,position),
  FOREIGN KEY(tenant_id,document_id,version) REFERENCES workflow_document_versions(tenant_id,document_id,version),
  FOREIGN KEY(tenant_id,document_id,file_id) REFERENCES workflow_document_files(tenant_id,document_id,id)
);
CREATE FUNCTION workflow_document_version_files_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workflow_document_versions v
    WHERE (v.tenant_id,v.document_id,v.version)=(NEW.tenant_id,NEW.document_id,NEW.version)
      AND NEW.position<=v.file_count
  ) THEN
    RAISE EXCEPTION 'Invalid slot for a document snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_document_version_file_slot BEFORE INSERT ON workflow_document_version_files
  FOR EACH ROW EXECUTE FUNCTION workflow_document_version_files_guard();

CREATE FUNCTION workflow_document_version_files_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM workflow_document_version_files l
      WHERE (l.tenant_id,l.document_id,l.version)=(NEW.tenant_id,NEW.document_id,NEW.version))<>NEW.file_count THEN
    RAISE EXCEPTION 'Incomplete document snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER workflow_document_version_file_count AFTER INSERT ON workflow_document_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workflow_document_version_files_complete();

CREATE FUNCTION workflow_document_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.org_unit_id,NEW.folder_id,NEW.created_by,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.org_unit_id,OLD.folder_id,OLD.created_by,OLD.created_at)
     OR NEW.revision<>OLD.revision+1 OR NEW.draft_version NOT IN (OLD.draft_version,OLD.draft_version+1)
     OR (NEW.issued_version IS DISTINCT FROM OLD.issued_version AND
       (NEW.issued_version IS DISTINCT FROM NEW.draft_version OR NOT NEW.published)) THEN
    RAISE EXCEPTION 'Invalid document revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_document_revision BEFORE UPDATE ON workflow_documents
  FOR EACH ROW EXECUTE FUNCTION workflow_document_revision_guard();

CREATE TRIGGER workflow_document_versions_immutable BEFORE UPDATE OR DELETE ON workflow_document_versions
  FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE TRIGGER workflow_document_files_immutable BEFORE UPDATE OR DELETE ON workflow_document_files
  FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE TRIGGER workflow_document_version_files_immutable BEFORE UPDATE OR DELETE ON workflow_document_version_files
  FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE INDEX workflow_document_audit_history ON workflow_audit(tenant_id,(details->>'documentId'),id)
  WHERE action LIKE 'document.%';
