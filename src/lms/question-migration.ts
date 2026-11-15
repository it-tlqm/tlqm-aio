export const questionMigration = {
  version: '005',
  statements: [
    `CREATE TABLE lms_question_bank(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,category TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('quiz','checkpoint')),entry_json TEXT NOT NULL,search_text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),revision INTEGER NOT NULL DEFAULT 1,last_operation_id TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE INDEX lms_bank_tenant ON lms_question_bank(tenant_id,status,kind,updated_at,id)`,
    `CREATE TRIGGER lms_bank_owner_immutable BEFORE UPDATE ON lms_question_bank WHEN NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'LMS_BANK_OWNER_IMMUTABLE'); END`,
    `CREATE TABLE lms_question_versions(question_id TEXT NOT NULL REFERENCES lms_question_bank(id),revision INTEGER NOT NULL,category TEXT NOT NULL,entry_json TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(question_id,revision))`,
    `CREATE TRIGGER lms_bank_version_no_update BEFORE UPDATE ON lms_question_versions BEGIN SELECT RAISE(ABORT,'LMS_BANK_VERSION_IMMUTABLE'); END`,
    `CREATE TRIGGER lms_bank_version_no_delete BEFORE DELETE ON lms_question_versions BEGIN SELECT RAISE(ABORT,'LMS_BANK_VERSION_IMMUTABLE'); END`,
    `CREATE TABLE lms_question_imports(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,actor_account_id TEXT NOT NULL,kind TEXT NOT NULL,source_name TEXT NOT NULL,digest TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)`,
    `CREATE TRIGGER lms_question_import_no_update BEFORE UPDATE ON lms_question_imports BEGIN SELECT RAISE(ABORT,'LMS_IMPORT_IMMUTABLE'); END`,
  ],
} as const;
