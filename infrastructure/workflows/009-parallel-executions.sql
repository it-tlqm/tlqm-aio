-- A split has a distinct invocation per run and round, including nested splits.
CREATE TABLE workflow_parallel_executions (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 round integer NOT NULL,
 split_node_id text NOT NULL,
 join_node_id text NOT NULL,
 parent_branch_id uuid,
 opening_task_ids uuid[] NOT NULL,
 branch_count integer NOT NULL CHECK (branch_count BETWEEN 2 AND 28),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','joined','cancelled')),
 UNIQUE (tenant_id,run_id,round,id),
 FOREIGN KEY (tenant_id,run_id,round) REFERENCES workflow_run_inputs(tenant_id,run_id,round)
);
CREATE UNIQUE INDEX workflow_one_open_split_per_branch
 ON workflow_parallel_executions(tenant_id,run_id,round,parent_branch_id) NULLS NOT DISTINCT
 WHERE status='open';

CREATE TABLE workflow_parallel_branches (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 round integer NOT NULL,
 execution_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 27),
 start_node_id text NOT NULL,
 arrival_task_ids uuid[],
 UNIQUE (tenant_id,run_id,round,id),
 UNIQUE (execution_id,ordinal),
 FOREIGN KEY (tenant_id,run_id,round,execution_id)
  REFERENCES workflow_parallel_executions(tenant_id,run_id,round,id)
);
ALTER TABLE workflow_parallel_executions ADD CONSTRAINT workflow_parallel_parent_scope
 FOREIGN KEY (tenant_id,run_id,round,parent_branch_id)
 REFERENCES workflow_parallel_branches(tenant_id,run_id,round,id);
CREATE TRIGGER workflow_parallel_execution_structure
 BEFORE UPDATE OF id,tenant_id,run_id,round,split_node_id,join_node_id,parent_branch_id,branch_count,opening_task_ids
 OR DELETE ON workflow_parallel_executions
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE TRIGGER workflow_parallel_branch_structure
 BEFORE UPDATE OF id,tenant_id,run_id,round,execution_id,ordinal,start_node_id OR DELETE ON workflow_parallel_branches
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

CREATE FUNCTION workflow_parallel_valid_tasks(scope_tenant uuid,scope_run uuid,scope_round integer,ids uuid[])
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT count(DISTINCT t.id)=cardinality(ids)
 FROM workflow_tasks t
 WHERE (t.tenant_id,t.run_id,t.round)=(scope_tenant,scope_run,scope_round)
  AND t.id=ANY(ids) AND t.status IN ('completed','rejected')
  AND NOT EXISTS (
   SELECT 1 FROM workflow_task_supersessions s
   WHERE (s.tenant_id,s.run_id,s.round,s.task_id)=(t.tenant_id,t.run_id,t.round,t.id)
  )
$$;
CREATE FUNCTION workflow_parallel_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'open' OR NOT workflow_parallel_valid_tasks(NEW.tenant_id,NEW.run_id,NEW.round,NEW.opening_task_ids) THEN
   RAISE EXCEPTION 'Invalid workflow split' USING ERRCODE='23514';
  END IF;
 ELSIF OLD.status='cancelled' OR OLD.status=NEW.status
  OR (NEW.status='joined' AND (OLD.status<>'open' OR NEW.branch_count<>(
   SELECT count(*) FROM workflow_parallel_branches b
   WHERE (b.tenant_id,b.run_id,b.round,b.execution_id)=(NEW.tenant_id,NEW.run_id,NEW.round,NEW.id)
    AND b.arrival_task_ids IS NOT NULL
  ))) OR (NEW.status='open' AND NOT EXISTS (
   SELECT 1 FROM workflow_parallel_branches b
   WHERE (b.tenant_id,b.run_id,b.round,b.execution_id)=(NEW.tenant_id,NEW.run_id,NEW.round,NEW.id)
    AND b.arrival_task_ids IS NULL
  )) THEN
  RAISE EXCEPTION 'Invalid workflow join transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_parallel_execution_state BEFORE INSERT OR UPDATE OF status ON workflow_parallel_executions
 FOR EACH ROW EXECUTE FUNCTION workflow_parallel_execution_guard();
CREATE FUNCTION workflow_parallel_branch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE group_status text; total integer;
BEGIN
 SELECT status,branch_count INTO group_status,total FROM workflow_parallel_executions e
 WHERE (e.tenant_id,e.run_id,e.round,e.id)=(NEW.tenant_id,NEW.run_id,NEW.round,NEW.execution_id);
 IF group_status IS NULL OR group_status='cancelled' OR NEW.ordinal>=total THEN
  RAISE EXCEPTION 'Invalid workflow branch scope' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.arrival_task_ids IS NOT NULL OR group_status<>'open' THEN
   RAISE EXCEPTION 'Invalid initial workflow branch' USING ERRCODE='23514';
  END IF;
 ELSIF OLD.arrival_task_ids IS NOT DISTINCT FROM NEW.arrival_task_ids OR (
  NEW.arrival_task_ids IS NOT NULL AND (
   OLD.arrival_task_ids IS NOT NULL OR group_status<>'open'
   OR NOT workflow_parallel_valid_tasks(NEW.tenant_id,NEW.run_id,NEW.round,NEW.arrival_task_ids)
  )
 ) THEN
  RAISE EXCEPTION 'Invalid workflow branch arrival' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_parallel_branch_state BEFORE INSERT OR UPDATE OF arrival_task_ids ON workflow_parallel_branches
 FOR EACH ROW EXECUTE FUNCTION workflow_parallel_branch_guard();

ALTER TABLE workflow_tasks ADD COLUMN execution_branch_id uuid;
ALTER TABLE workflow_tasks ADD CONSTRAINT workflow_task_branch_scope
 FOREIGN KEY (tenant_id,run_id,round,execution_branch_id)
 REFERENCES workflow_parallel_branches(tenant_id,run_id,round,id);
CREATE TRIGGER workflow_task_branch_immutable BEFORE UPDATE OF execution_branch_id ON workflow_tasks
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

DROP INDEX workflow_one_pending;
CREATE UNIQUE INDEX workflow_one_pending_root ON workflow_tasks(tenant_id,run_id)
 WHERE status='pending' AND execution_branch_id IS NULL;
CREATE UNIQUE INDEX workflow_one_pending_branch ON workflow_tasks(tenant_id,run_id,execution_branch_id)
 WHERE status='pending' AND execution_branch_id IS NOT NULL;

CREATE TABLE workflow_task_dependencies (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 round integer NOT NULL,
 task_id uuid NOT NULL,
 prerequisite_task_id uuid NOT NULL,
 PRIMARY KEY (tenant_id,run_id,round,task_id,prerequisite_task_id),
 FOREIGN KEY (tenant_id,run_id,round,task_id)
  REFERENCES workflow_tasks(tenant_id,run_id,round,id),
 FOREIGN KEY (tenant_id,run_id,round,prerequisite_task_id)
  REFERENCES workflow_tasks(tenant_id,run_id,round,id),
 CHECK (task_id<>prerequisite_task_id)
);
CREATE INDEX workflow_task_dependents
 ON workflow_task_dependencies(tenant_id,run_id,round,prerequisite_task_id,task_id);
CREATE TRIGGER workflow_task_dependencies_immutable
 BEFORE UPDATE OR DELETE ON workflow_task_dependencies
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE FUNCTION workflow_task_dependency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM workflow_tasks task JOIN workflow_tasks prerequisite USING (tenant_id,run_id,round)
  WHERE (task.tenant_id,task.run_id,task.round,task.id,prerequisite.id)
   =(NEW.tenant_id,NEW.run_id,NEW.round,NEW.task_id,NEW.prerequisite_task_id)
   AND task.status='pending' AND prerequisite.status IN ('completed','rejected')
   AND prerequisite.execution_order<task.execution_order
   AND NOT EXISTS (
    SELECT 1 FROM workflow_task_supersessions s
    WHERE (s.tenant_id,s.run_id,s.round,s.task_id)=(prerequisite.tenant_id,prerequisite.run_id,prerequisite.round,prerequisite.id)
   )
 ) THEN
  RAISE EXCEPTION 'Invalid workflow dependency' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_task_dependency_scope BEFORE INSERT ON workflow_task_dependencies
 FOR EACH ROW EXECUTE FUNCTION workflow_task_dependency_guard();

ALTER TABLE workflow_task_supersessions ADD COLUMN target_task_id uuid;
ALTER TABLE workflow_task_supersessions ADD CONSTRAINT workflow_supersession_target_scope
 FOREIGN KEY (tenant_id,run_id,round,target_task_id)
 REFERENCES workflow_tasks(tenant_id,run_id,round,id);
CREATE OR REPLACE FUNCTION workflow_task_supersession_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM workflow_tasks previous
  JOIN workflow_tasks cause USING (tenant_id,run_id,round)
  WHERE (previous.tenant_id,previous.run_id,previous.round,previous.id,cause.id)
   =(NEW.tenant_id,NEW.run_id,NEW.round,NEW.task_id,NEW.caused_by_task_id)
   AND previous.status IN ('completed','rejected','returned','cancelled')
   AND cause.status IN ('returned','rejected','cancelled')
   AND (NEW.target_task_id IS NOT NULL OR previous.execution_order<=cause.execution_order)
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

-- A pooled decision must come from the open task's own execution branch.
CREATE OR REPLACE FUNCTION workflow_pool_vote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM workflow_approval_members m
  JOIN workflow_tasks t ON t.tenant_id=m.tenant_id AND t.id=m.task_id
  JOIN workflow_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id
  JOIN workflow_groups g ON g.tenant_id=t.tenant_id AND g.id=t.assignment_group_id
  JOIN workflow_group_members gm ON gm.tenant_id=g.tenant_id AND gm.group_id=g.id AND gm.account_id=m.account_id
  WHERE m.tenant_id=NEW.tenant_id AND m.task_id=NEW.task_id AND m.account_id=NEW.account_id
   AND m.person_id=NEW.person_id AND m.active AND g.active AND gm.active
   AND (g.org_unit_id IS NULL OR g.org_unit_id=r.org_unit_id)
   AND t.status='pending' AND r.status='running' AND r.round=t.round AND r.owner_person_id<>NEW.person_id
   AND (
    (t.execution_branch_id IS NULL AND r.current_step=t.node_id)
    OR EXISTS (
     SELECT 1 FROM workflow_parallel_branches b
     JOIN workflow_parallel_executions e ON (e.tenant_id,e.run_id,e.round,e.id)=(b.tenant_id,b.run_id,b.round,b.execution_id)
     WHERE (b.tenant_id,b.run_id,b.round,b.id)=(t.tenant_id,t.run_id,t.round,t.execution_branch_id)
      AND b.arrival_task_ids IS NULL AND e.status='open'
    )
   )
 ) THEN
  RAISE EXCEPTION 'Invalid approval vote' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
