ALTER TABLE submissions DROP CONSTRAINT submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check CHECK (status IN ('draft','submitted','cancelled'));
CREATE OR REPLACE FUNCTION forms_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'draft' OR (OLD.id,OLD.tenant_id,OLD.form_id,OLD.version_id,OLD.account_id,OLD.person_id,OLD.org_unit_id,OLD.created_at)
      IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.form_id,NEW.version_id,NEW.account_id,NEW.person_id,NEW.org_unit_id,NEW.created_at) THEN
    RAISE EXCEPTION 'Submission history and ownership are immutable' USING ERRCODE='23514', CONSTRAINT='submission_immutable';
  END IF;
  RETURN NEW;
END;
$$;
