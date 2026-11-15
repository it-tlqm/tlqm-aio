-- Each execution has a new task. Supersessions preserve prior decisions and identify the effective path.
ALTER TABLE workflow_tasks
 ADD COLUMN execution_order bigint GENERATED ALWAYS AS IDENTITY,
 ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0);
ALTER TABLE workflow_tasks DROP CONSTRAINT workflow_tasks_tenant_id_run_id_round_node_id_key;
ALTER TABLE workflow_tasks
 ADD CONSTRAINT workflow_task_attempt_unique UNIQUE (tenant_id,run_id,round,node_id,attempt),
 ADD CONSTRAINT workflow_task_execution_scope UNIQUE (tenant_id,run_id,round,id);
CREATE INDEX workflow_task_execution_path ON workflow_tasks(tenant_id,run_id,round,execution_order);

CREATE TRIGGER workflow_task_attempt_immutable
 BEFORE UPDATE OF attempt,execution_order ON workflow_tasks
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

CREATE TABLE workflow_task_supersessions (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 round integer NOT NULL,
 task_id uuid NOT NULL,
 caused_by_task_id uuid NOT NULL,
 PRIMARY KEY (tenant_id,run_id,round,task_id),
 FOREIGN KEY (tenant_id,run_id,round,task_id) REFERENCES workflow_tasks(tenant_id,run_id,round,id),
 FOREIGN KEY (tenant_id,run_id,round,caused_by_task_id) REFERENCES workflow_tasks(tenant_id,run_id,round,id)
);
CREATE TRIGGER workflow_task_supersessions_immutable BEFORE UPDATE OR DELETE ON workflow_task_supersessions
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

CREATE FUNCTION workflow_task_supersession_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM workflow_tasks previous
  JOIN workflow_tasks cause USING (tenant_id,run_id,round)
  WHERE previous.tenant_id=NEW.tenant_id AND previous.run_id=NEW.run_id AND previous.round=NEW.round
   AND previous.id=NEW.task_id AND cause.id=NEW.caused_by_task_id
   AND previous.status IN ('completed','rejected','returned','cancelled')
   AND cause.status IN ('returned','rejected','cancelled')
   AND previous.execution_order<=cause.execution_order
 ) THEN
  RAISE EXCEPTION 'Invalid workflow supersession' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_task_supersession_scope BEFORE INSERT ON workflow_task_supersessions
 FOR EACH ROW EXECUTE FUNCTION workflow_task_supersession_guard();

CREATE FUNCTION workflow_task_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_attempt integer; superseded uuid;
BEGIN
 SELECT previous.attempt,s.task_id INTO last_attempt,superseded
 FROM workflow_tasks previous
 LEFT JOIN workflow_task_supersessions s
  ON (s.tenant_id,s.run_id,s.round,s.task_id)=(previous.tenant_id,previous.run_id,previous.round,previous.id)
 WHERE (previous.tenant_id,previous.run_id,previous.round,previous.node_id)=(NEW.tenant_id,NEW.run_id,NEW.round,NEW.node_id)
 ORDER BY previous.attempt DESC LIMIT 1;
 IF NEW.attempt<>COALESCE(last_attempt,0)+1 OR (last_attempt IS NOT NULL AND superseded IS NULL) THEN
  RAISE EXCEPTION 'Invalid workflow task attempt' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_task_attempt_sequence BEFORE INSERT ON workflow_tasks
 FOR EACH ROW EXECUTE FUNCTION workflow_task_attempt_guard();
