/** New functional LMS tables. The pre-existing legacy/history tables stay untouched. */
export const courseMigration = {
  version: '003',
  statements: [
    `CREATE TABLE lms_courses(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_unit_id TEXT NOT NULL,code TEXT NOT NULL,draft_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,published_version_id TEXT,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),last_operation_id TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(tenant_id,code))`,
    `CREATE INDEX lms_courses_tenant ON lms_courses(tenant_id,status)`,
    `CREATE TRIGGER lms_course_owner_immutable BEFORE UPDATE ON lms_courses WHEN NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.owner_unit_id<>OLD.owner_unit_id OR NEW.code<>OLD.code OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'LMS_COURSE_OWNER_IMMUTABLE'); END`,
    `CREATE TABLE lms_course_versions(id TEXT PRIMARY KEY,course_id TEXT NOT NULL REFERENCES lms_courses(id),version INTEGER NOT NULL,spec_json TEXT NOT NULL,checksum TEXT NOT NULL,published_by TEXT NOT NULL,published_at INTEGER NOT NULL,UNIQUE(course_id,version))`,
    `CREATE TRIGGER lms_version_no_update BEFORE UPDATE ON lms_course_versions BEGIN SELECT RAISE(ABORT,'LMS_VERSION_IMMUTABLE'); END`,
    `CREATE TRIGGER lms_version_no_delete BEFORE DELETE ON lms_course_versions BEGIN SELECT RAISE(ABORT,'LMS_VERSION_IMMUTABLE'); END`,
    `CREATE TABLE lms_media(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_unit_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('video','document','image')),object_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>0),sha256 TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)`,
    `CREATE TABLE lms_progress(id TEXT PRIMARY KEY,employee_id TEXT NOT NULL REFERENCES employees(id),version_id TEXT NOT NULL REFERENCES lms_course_versions(id),position REAL NOT NULL DEFAULT 0,watched REAL NOT NULL DEFAULT 0,answers_json TEXT NOT NULL DEFAULT '{}',finished INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,last_operation_id TEXT,updated_at INTEGER NOT NULL,UNIQUE(employee_id,version_id))`,
    `CREATE TABLE lms_attempts(id TEXT PRIMARY KEY,employee_id TEXT NOT NULL REFERENCES employees(id),version_id TEXT NOT NULL REFERENCES lms_course_versions(id),score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),answers_json TEXT NOT NULL,snapshot_json TEXT NOT NULL,tab_switch_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)`,
    `CREATE INDEX lms_attempts_employee ON lms_attempts(employee_id,version_id,created_at)`,
    `CREATE TRIGGER lms_attempt_no_update BEFORE UPDATE ON lms_attempts BEGIN SELECT RAISE(ABORT,'LMS_ATTEMPT_IMMUTABLE'); END`,
    `CREATE TRIGGER lms_attempt_no_delete BEFORE DELETE ON lms_attempts BEGIN SELECT RAISE(ABORT,'LMS_ATTEMPT_IMMUTABLE'); END`,
    `CREATE TABLE lms_notes(id TEXT PRIMARY KEY,employee_id TEXT NOT NULL REFERENCES employees(id),version_id TEXT NOT NULL REFERENCES lms_course_versions(id),time REAL NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL)`,
    `CREATE TABLE lms_course_receipts(actor_account_id TEXT NOT NULL,command_key TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(actor_account_id,command_key))`,
    `CREATE TRIGGER lms_receipt_no_update BEFORE UPDATE ON lms_course_receipts BEGIN SELECT RAISE(ABORT,'LMS_RECEIPT_IMMUTABLE'); END`,
    `CREATE TRIGGER lms_receipt_no_delete BEFORE DELETE ON lms_course_receipts BEGIN SELECT RAISE(ABORT,'LMS_RECEIPT_IMMUTABLE'); END`,
    `CREATE TABLE lms_write_guards(operation_id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1))`,
  ],
} as const;
