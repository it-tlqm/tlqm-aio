ALTER TABLE task_projects ADD COLUMN workflow jsonb CHECK (workflow IS NULL OR jsonb_typeof(workflow)='object');
ALTER TABLE task_items ADD COLUMN stage_code text CHECK (stage_code ~ '^[a-z][a-z0-9-]{0,31}$');

CREATE FUNCTION task_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configured jsonb;
BEGIN
  SELECT workflow INTO configured FROM task_projects WHERE (tenant_id,id)=(NEW.tenant_id,NEW.project_id);
  IF configured IS NULL AND NEW.stage_code IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (NEW.status,NEW.stage_code) IS DISTINCT FROM (OLD.status,OLD.stage_code)
    AND current_setting('aio_tasks.workflow_write',true) IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'Configured project requires a workflow-aware writer' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(configured->'stages') AS s(stage)
    WHERE stage->>'code'=COALESCE(NEW.stage_code,NEW.status) AND stage->>'phase'=NEW.status
  ) THEN RAISE EXCEPTION 'Task stage and lifecycle disagree' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_stage_check BEFORE INSERT OR UPDATE OF stage_code,status ON task_items
  FOR EACH ROW EXECUTE FUNCTION task_stage_guard();
