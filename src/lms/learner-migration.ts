/** 006: retain imported credentials verbatim; newly provisioned SSO profiles have none.
 * D1 always enforces foreign keys. Copy/swap and restoration of dependent triggers share
 * one batch transaction, with equality/FK guards before ending deferred checking.
 */
export const learnerMigration = {
  version: '006',
  statements: [
    `PRAGMA defer_foreign_keys=ON`,
    `DROP TRIGGER aio_session_guard`,
    `DROP TRIGGER aio_legacy_employee_revoke`,
    `CREATE TABLE employees_next(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,department TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('learner','admin','manager')),password_hash TEXT,must_change_password INTEGER NOT NULL DEFAULT 0,is_active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,credential_kind TEXT NOT NULL DEFAULT 'legacy-retained' CHECK(credential_kind IN ('legacy-retained','sso-only')),CHECK((credential_kind='legacy-retained' AND password_hash IS NOT NULL) OR (credential_kind='sso-only' AND password_hash IS NULL AND must_change_password=0)))`,
    `INSERT INTO employees_next(id,code,name,department,role,password_hash,must_change_password,is_active,created_at,updated_at) SELECT id,code,name,department,role,password_hash,must_change_password,is_active,created_at,updated_at FROM employees`,
    `INSERT INTO lms_write_guards(operation_id,valid) SELECT 'migration-006-preserve',CASE WHEN NOT EXISTS(SELECT id,code,name,department,role,password_hash,must_change_password,is_active,created_at,updated_at FROM employees EXCEPT SELECT id,code,name,department,role,password_hash,must_change_password,is_active,created_at,updated_at FROM employees_next) AND NOT EXISTS(SELECT id,code,name,department,role,password_hash,must_change_password,is_active,created_at,updated_at FROM employees_next EXCEPT SELECT id,code,name,department,role,password_hash,must_change_password,is_active,created_at,updated_at FROM employees) THEN 1 ELSE 0 END`,
    `DROP TABLE employees`,
    `ALTER TABLE employees_next RENAME TO employees`,
    `CREATE TRIGGER aio_session_guard BEFORE INSERT ON aio_sessions WHEN (SELECT enabled FROM aio_adapter_control WHERE id=1) IS NOT 1 OR NOT EXISTS(SELECT 1 FROM aio_account_links a JOIN aio_external_links i ON i.account_id=a.account_id JOIN employees e ON e.id=a.employee_id WHERE a.account_id=NEW.account_id AND a.employee_id=NEW.employee_id AND i.issuer=NEW.issuer AND i.subject=NEW.subject AND a.active=1 AND i.active=1 AND e.is_active=1 AND NEW.authenticated_at>a.auth_not_before) BEGIN SELECT RAISE(ABORT,'LMS_SESSION_REJECTED'); END`,
    `CREATE TRIGGER aio_legacy_employee_revoke AFTER UPDATE ON employees WHEN OLD.is_active=1 AND NEW.is_active=0 BEGIN UPDATE aio_account_links SET auth_not_before=max(auth_not_before,unixepoch()) WHERE employee_id=NEW.id; DELETE FROM aio_sessions WHERE employee_id=NEW.id; END`,
    `INSERT INTO lms_write_guards(operation_id,valid) SELECT 'migration-006-fk',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END`,
    `PRAGMA defer_foreign_keys=OFF`,
    `DELETE FROM lms_write_guards WHERE operation_id IN ('migration-006-preserve','migration-006-fk')`,
    `CREATE TRIGGER employee_credentials_retained BEFORE UPDATE ON employees WHEN NEW.credential_kind<>OLD.credential_kind OR NEW.password_hash IS NOT OLD.password_hash OR NEW.must_change_password<>OLD.must_change_password BEGIN SELECT RAISE(ABORT,'LMS_CREDENTIALS_IMMUTABLE'); END`,
  ],
} as const;
