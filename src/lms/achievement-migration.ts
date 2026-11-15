/** 004: certificates preserve the exact assessed version and recipient at issuance. */
export const achievementMigration = {
  version: '004',
  statements: [
    `CREATE TABLE lms_certificates(id TEXT PRIMARY KEY REFERENCES lms_attempts(id),employee_id TEXT NOT NULL REFERENCES employees(id),tenant_id TEXT NOT NULL,code TEXT NOT NULL UNIQUE,snapshot_json TEXT NOT NULL,issued_at INTEGER NOT NULL)`,
    `CREATE INDEX lms_certificates_employee ON lms_certificates(tenant_id,employee_id,issued_at)`,
    `CREATE TRIGGER lms_certificate_valid BEFORE INSERT ON lms_certificates WHEN NOT EXISTS(SELECT 1 FROM lms_attempts a JOIN lms_course_versions v ON v.id=a.version_id JOIN lms_courses c ON c.id=v.course_id WHERE a.id=NEW.id AND a.employee_id=NEW.employee_id AND c.tenant_id=NEW.tenant_id AND a.score>=80) BEGIN SELECT RAISE(ABORT,'LMS_CERTIFICATE_NOT_ELIGIBLE'); END`,
    `CREATE TRIGGER lms_certificate_no_update BEFORE UPDATE ON lms_certificates BEGIN SELECT RAISE(ABORT,'LMS_CERTIFICATE_IMMUTABLE'); END`,
    `CREATE TRIGGER lms_certificate_no_delete BEFORE DELETE ON lms_certificates BEGIN SELECT RAISE(ABORT,'LMS_CERTIFICATE_IMMUTABLE'); END`,
  ],
} as const;
