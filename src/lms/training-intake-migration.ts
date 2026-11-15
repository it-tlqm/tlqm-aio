/** 010: durable references from approved synthetic Workflow runs to LMS training drafts. */
export const trainingIntakeMigration = {
  version: '010',
  statements: [
    `CREATE TABLE lms_training_intakes(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, org_unit_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL, source_version_id TEXT NOT NULL, source_round INTEGER NOT NULL CHECK(source_round>0),
      recipient_account_id TEXT NOT NULL REFERENCES aio_account_links(account_id), recipient_person_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, batch_id TEXT UNIQUE, accepted_at INTEGER,
      UNIQUE(tenant_id,source_run_id,source_round), FOREIGN KEY(tenant_id,batch_id) REFERENCES lms_training_batches(tenant_id,id),
      CHECK((batch_id IS NULL)=(accepted_at IS NULL))
    )`,
    `CREATE INDEX lms_training_intake_inbox ON lms_training_intakes(tenant_id,recipient_account_id,created_at DESC,id) WHERE batch_id IS NULL`,
    `CREATE TRIGGER lms_training_intake_no_delete BEFORE DELETE ON lms_training_intakes BEGIN SELECT RAISE(ABORT,'LMS_TRAINING_INTAKE_IMMUTABLE'); END`,
    `CREATE TRIGGER lms_training_intake_guard BEFORE UPDATE ON lms_training_intakes
      WHEN OLD.batch_id IS NOT NULL OR NEW.batch_id IS NULL OR NEW.accepted_at IS NULL OR
      (NEW.id,NEW.tenant_id,NEW.org_unit_id,NEW.source_run_id,NEW.source_version_id,NEW.source_round,
        NEW.recipient_account_id,NEW.recipient_person_id,NEW.created_at) IS NOT
      (OLD.id,OLD.tenant_id,OLD.org_unit_id,OLD.source_run_id,OLD.source_version_id,OLD.source_round,
        OLD.recipient_account_id,OLD.recipient_person_id,OLD.created_at) OR
      NOT EXISTS(SELECT 1 FROM lms_training_batches b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.batch_id
        AND b.owner_unit_id=NEW.org_unit_id AND b.created_by=NEW.recipient_account_id)
      BEGIN SELECT RAISE(ABORT,'LMS_TRAINING_INTAKE_IMMUTABLE'); END`,
  ],
} as const;
