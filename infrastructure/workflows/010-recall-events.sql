-- A recall records authority and supersession without changing a task result or vote.
CREATE TABLE workflow_recall_events (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 round integer NOT NULL,
 source_task_id uuid,
 actor_account_id uuid NOT NULL,
 actor_person_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,run_id,round,id),
 UNIQUE NULLS NOT DISTINCT (tenant_id,run_id,round,source_task_id),
 FOREIGN KEY (tenant_id,run_id,round) REFERENCES workflow_run_inputs(tenant_id,run_id,round),
 FOREIGN KEY (tenant_id,run_id,round,source_task_id)
  REFERENCES workflow_tasks(tenant_id,run_id,round,id)
);
CREATE TRIGGER workflow_recall_events_immutable BEFORE UPDATE OR DELETE ON workflow_recall_events
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

CREATE FUNCTION workflow_recall_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM workflow_runs r
  WHERE (r.tenant_id,r.id,r.round)=(NEW.tenant_id,NEW.run_id,NEW.round) AND r.status='running'
   AND (
    (NEW.source_task_id IS NULL AND (r.owner_account_id,r.owner_person_id)=(NEW.actor_account_id,NEW.actor_person_id))
    OR EXISTS (
     SELECT 1 FROM workflow_tasks t
     JOIN workflow_task_results d ON (d.tenant_id,d.task_id)=(t.tenant_id,t.id)
     WHERE (t.tenant_id,t.run_id,t.round,t.id)=(NEW.tenant_id,NEW.run_id,NEW.round,NEW.source_task_id)
      AND t.status IN ('completed','rejected')
      AND (d.actor_account_id,d.actor_person_id)=(NEW.actor_account_id,NEW.actor_person_id)
      AND NOT EXISTS (
       SELECT 1 FROM workflow_task_supersessions s
       WHERE (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id)
      )
    )
   )
 ) THEN
  RAISE EXCEPTION 'Invalid workflow recall source' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_recall_event_authority BEFORE INSERT ON workflow_recall_events
 FOR EACH ROW EXECUTE FUNCTION workflow_recall_event_guard();

ALTER TABLE workflow_task_supersessions ADD COLUMN recall_id uuid;
ALTER TABLE workflow_task_supersessions ADD CONSTRAINT workflow_supersession_recall_scope
 FOREIGN KEY (tenant_id,run_id,round,recall_id)
 REFERENCES workflow_recall_events(tenant_id,run_id,round,id);
CREATE OR REPLACE FUNCTION workflow_task_supersession_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM workflow_tasks previous
  JOIN workflow_tasks cause USING (tenant_id,run_id,round)
  WHERE (previous.tenant_id,previous.run_id,previous.round,previous.id,cause.id)
   =(NEW.tenant_id,NEW.run_id,NEW.round,NEW.task_id,NEW.caused_by_task_id)
   AND previous.status IN ('completed','rejected','returned','cancelled')
   AND (
    (NEW.recall_id IS NULL AND cause.status IN ('returned','rejected','cancelled')
     AND (NEW.target_task_id IS NOT NULL OR previous.execution_order<=cause.execution_order))
    OR (
     EXISTS (
      SELECT 1 FROM workflow_recall_events e
      WHERE (e.tenant_id,e.run_id,e.round,e.id,e.source_task_id)
       =(NEW.tenant_id,NEW.run_id,NEW.round,NEW.recall_id,cause.id)
     )
     AND cause.status IN ('completed','rejected')
     AND ((NEW.target_task_id IS NULL AND previous.execution_order>=cause.execution_order)
      OR NEW.target_task_id=cause.id)
     AND (previous.id=cause.id OR (
      previous.status='cancelled'
      AND NOT EXISTS (SELECT 1 FROM workflow_task_results d WHERE (d.tenant_id,d.task_id)=(previous.tenant_id,previous.id))
      AND NOT EXISTS (SELECT 1 FROM workflow_approval_votes v WHERE (v.tenant_id,v.task_id)=(previous.tenant_id,previous.id))
     ))
    )
   )
 ) THEN
  RAISE EXCEPTION 'Invalid workflow supersession' USING ERRCODE='23514';
 END IF;
 IF NEW.target_task_id IS NOT NULL AND NOT (
  WITH RECURSIVE dependent(id) AS (
   SELECT NEW.target_task_id
   UNION
   SELECT d.task_id FROM workflow_task_dependencies d JOIN dependent p ON d.prerequisite_task_id=p.id
   WHERE (d.tenant_id,d.run_id,d.round)=(NEW.tenant_id,NEW.run_id,NEW.round)
  )
  SELECT count(*) = (CASE WHEN NEW.task_id=NEW.caused_by_task_id THEN 1 ELSE 2 END)
  FROM dependent WHERE id IN (NEW.task_id,NEW.caused_by_task_id)
 ) THEN
  RAISE EXCEPTION 'Invalid workflow causal supersession' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
