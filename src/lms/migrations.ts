import { trainingMigration } from './training-migration.js';
import { trainingReminderMigration } from './training-reminder-migration.js';
import { trainingIntakeMigration } from './training-intake-migration.js';
import { learningPolicyMigration } from './learning-policy-migration.js';
import { courseMigration } from './course-migrations.js';
import { achievementMigration } from './achievement-migration.js';
import { questionMigration } from './question-migration.js';
import { learnerMigration } from './learner-migration.js';
/** Trusted, ordered SQL for the new synthetic D1 database. Applied versions are immutable. */
export const lmsMigrations = [
  {
    version: '001',
    statements: [
      `CREATE TABLE employees(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,department TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('learner','admin','manager')),password_hash TEXT NOT NULL,must_change_password INTEGER NOT NULL DEFAULT 0,is_active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
      `CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `CREATE TABLE lessons(id TEXT PRIMARY KEY,title TEXT NOT NULL,subtitle TEXT NOT NULL,series TEXT NOT NULL,target_dept TEXT NOT NULL,deadline TEXT NOT NULL,is_mandatory INTEGER NOT NULL,duration REAL NOT NULL,video_url TEXT NOT NULL,poster_url TEXT NOT NULL,checkpoints_json TEXT NOT NULL,questions_json TEXT NOT NULL,answer_key_json TEXT NOT NULL,status TEXT NOT NULL,order_index INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
      `CREATE TABLE learning_progress(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,lesson_id TEXT NOT NULL,position REAL NOT NULL,watched REAL NOT NULL,answers TEXT NOT NULL,finished INTEGER NOT NULL,updated_at TEXT NOT NULL)`,
      `CREATE TABLE learning_attempts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,lesson_id TEXT NOT NULL,answers TEXT NOT NULL,score INTEGER NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `CREATE TABLE learning_notes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,lesson_id TEXT NOT NULL,time REAL NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `CREATE TABLE aio_account_links(account_id TEXT PRIMARY KEY,person_id TEXT NOT NULL,employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id),tenant_id TEXT NOT NULL,org_unit_id TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),revision INTEGER NOT NULL DEFAULT 1,auth_not_before INTEGER NOT NULL DEFAULT 0,verified_at INTEGER NOT NULL,verified_by TEXT NOT NULL)`,
      `CREATE TABLE aio_external_links(issuer TEXT NOT NULL,subject TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES aio_account_links(account_id),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),revision INTEGER NOT NULL DEFAULT 1,verified_at INTEGER NOT NULL,verified_by TEXT NOT NULL,PRIMARY KEY(issuer,subject))`,
      `CREATE TABLE aio_login_transactions(hash TEXT PRIMARY KEY,encrypted_payload TEXT NOT NULL,expires_at INTEGER NOT NULL)`,
      `CREATE TABLE aio_sessions(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES aio_account_links(account_id),employee_id TEXT NOT NULL REFERENCES employees(id),issuer TEXT NOT NULL,subject TEXT NOT NULL,sid TEXT NOT NULL,authenticated_at INTEGER NOT NULL,encrypted_payload TEXT NOT NULL,created_at INTEGER NOT NULL,idle_expires_at INTEGER NOT NULL,absolute_expires_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,refresh_lock TEXT,lock_until INTEGER,last_operation_id TEXT,CHECK(idle_expires_at<=absolute_expires_at))`,
      `CREATE INDEX aio_session_idp ON aio_sessions(issuer,sid)`,
      `CREATE TABLE aio_logout_receipts(jti TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)`,
      `CREATE TABLE aio_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,occurred_at INTEGER NOT NULL,actor_account_id TEXT,subject_account_id TEXT,employee_id TEXT,tenant_id TEXT,action TEXT NOT NULL,reason TEXT NOT NULL,request_id TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}')`,
      `CREATE TABLE aio_receipts(actor_account_id TEXT NOT NULL,command_key TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(actor_account_id,command_key))`,
      `CREATE TABLE aio_bootstrap_receipts(name TEXT PRIMARY KEY,created_at INTEGER NOT NULL)`,
      `CREATE TABLE aio_adapter_control(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),revision INTEGER NOT NULL DEFAULT 1,last_operation_id TEXT)`,
      `INSERT INTO aio_adapter_control(id,enabled) VALUES (1,1)`,
      `CREATE TRIGGER aio_session_guard BEFORE INSERT ON aio_sessions WHEN (SELECT enabled FROM aio_adapter_control WHERE id=1) IS NOT 1 OR NOT EXISTS(SELECT 1 FROM aio_account_links a JOIN aio_external_links i ON i.account_id=a.account_id JOIN employees e ON e.id=a.employee_id WHERE a.account_id=NEW.account_id AND a.employee_id=NEW.employee_id AND i.issuer=NEW.issuer AND i.subject=NEW.subject AND a.active=1 AND i.active=1 AND e.is_active=1 AND NEW.authenticated_at>a.auth_not_before) BEGIN SELECT RAISE(ABORT,'LMS_SESSION_REJECTED'); END`,
      `CREATE TRIGGER aio_session_owner_immutable BEFORE UPDATE ON aio_sessions WHEN NEW.hash<>OLD.hash OR NEW.account_id<>OLD.account_id OR NEW.employee_id<>OLD.employee_id OR NEW.issuer<>OLD.issuer OR NEW.subject<>OLD.subject OR NEW.sid<>OLD.sid OR NEW.authenticated_at<>OLD.authenticated_at OR NEW.created_at<>OLD.created_at OR NEW.absolute_expires_at<>OLD.absolute_expires_at BEGIN SELECT RAISE(ABORT,'LMS_SESSION_OWNER_IMMUTABLE'); END`,
      `CREATE TRIGGER aio_audit_no_update BEFORE UPDATE ON aio_audit BEGIN SELECT RAISE(ABORT,'LMS_AUDIT_IMMUTABLE'); END`,
      `CREATE TRIGGER aio_audit_no_delete BEFORE DELETE ON aio_audit BEGIN SELECT RAISE(ABORT,'LMS_AUDIT_IMMUTABLE'); END`,
      `CREATE TRIGGER aio_receipt_no_update BEFORE UPDATE ON aio_receipts BEGIN SELECT RAISE(ABORT,'LMS_RECEIPT_IMMUTABLE'); END`,
      `CREATE TRIGGER aio_receipt_no_delete BEFORE DELETE ON aio_receipts BEGIN SELECT RAISE(ABORT,'LMS_RECEIPT_IMMUTABLE'); END`,
      `CREATE TRIGGER aio_account_owner_immutable BEFORE UPDATE ON aio_account_links WHEN NEW.account_id<>OLD.account_id OR NEW.person_id<>OLD.person_id OR NEW.employee_id<>OLD.employee_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.auth_not_before<OLD.auth_not_before BEGIN SELECT RAISE(ABORT,'LMS_IDENTITY_OWNERSHIP_IMMUTABLE'); END`,
      `CREATE TRIGGER aio_external_owner_immutable BEFORE UPDATE ON aio_external_links WHEN NEW.issuer<>OLD.issuer OR NEW.subject<>OLD.subject OR NEW.account_id<>OLD.account_id BEGIN SELECT RAISE(ABORT,'LMS_IDENTITY_OWNERSHIP_IMMUTABLE'); END`,
      `CREATE TRIGGER aio_external_revoke AFTER UPDATE ON aio_external_links WHEN OLD.active=1 AND NEW.active=0 BEGIN UPDATE aio_account_links SET auth_not_before=max(auth_not_before,unixepoch()) WHERE account_id=NEW.account_id; DELETE FROM aio_sessions WHERE account_id=NEW.account_id; END`,
      `CREATE TRIGGER aio_account_revoke AFTER UPDATE ON aio_account_links WHEN (OLD.active=1 AND NEW.active=0) OR NEW.auth_not_before>OLD.auth_not_before BEGIN UPDATE aio_account_links SET auth_not_before=max(auth_not_before,unixepoch()) WHERE account_id=NEW.account_id AND OLD.active=1 AND NEW.active=0; DELETE FROM aio_sessions WHERE account_id=NEW.account_id; END`,
      `CREATE TRIGGER aio_account_no_delete BEFORE DELETE ON aio_account_links BEGIN SELECT RAISE(ABORT,'LMS_IDENTITY_OWNERSHIP_IMMUTABLE'); END`,
      `CREATE TRIGGER aio_external_no_delete BEFORE DELETE ON aio_external_links BEGIN SELECT RAISE(ABORT,'LMS_IDENTITY_OWNERSHIP_IMMUTABLE'); END`,
      `CREATE TRIGGER aio_legacy_employee_revoke AFTER UPDATE ON employees WHEN OLD.is_active=1 AND NEW.is_active=0 BEGIN UPDATE aio_account_links SET auth_not_before=max(auth_not_before,unixepoch()) WHERE employee_id=NEW.id; DELETE FROM aio_sessions WHERE employee_id=NEW.id; END`,
      `CREATE TRIGGER aio_adapter_disable AFTER UPDATE ON aio_adapter_control WHEN OLD.enabled=1 AND NEW.enabled=0 BEGIN UPDATE aio_account_links SET auth_not_before=max(auth_not_before,unixepoch()); DELETE FROM aio_sessions; DELETE FROM aio_login_transactions; END`,
    ],
  },
  {
    version: '002',
    statements: [
      `ALTER TABLE aio_account_links ADD COLUMN last_operation_id TEXT`,
      `CREATE TRIGGER aio_account_unit_change AFTER UPDATE ON aio_account_links WHEN NEW.org_unit_id<>OLD.org_unit_id BEGIN UPDATE aio_account_links SET auth_not_before=max(auth_not_before,unixepoch()) WHERE account_id=NEW.account_id; DELETE FROM aio_sessions WHERE account_id=NEW.account_id; END`,
    ],
  },
  courseMigration,
  achievementMigration,
  questionMigration,
  learnerMigration,
  learningPolicyMigration,
  trainingMigration,
  trainingReminderMigration,
  trainingIntakeMigration,
] as const;
