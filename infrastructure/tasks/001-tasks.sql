CREATE TABLE task_projects (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, org_unit_id uuid NOT NULL,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK(length(description)<=5000),
  owner_account_id uuid NOT NULL, owner_person_id uuid NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id)
);
CREATE INDEX task_project_listing ON task_projects(tenant_id,updated_at DESC,id DESC);
CREATE TABLE task_project_members (
  tenant_id uuid NOT NULL, project_id uuid NOT NULL, account_id uuid NOT NULL, person_id uuid NOT NULL,
  name text NOT NULL, role text NOT NULL CHECK(role IN('manager','member','viewer')),
  active boolean NOT NULL DEFAULT true, changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id,account_id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES task_projects(tenant_id,id)
);
CREATE UNIQUE INDEX task_project_active_person ON task_project_members(tenant_id,project_id,person_id) WHERE active;
CREATE INDEX task_members_for_account ON task_project_members(tenant_id,account_id,project_id) WHERE active;

CREATE TABLE task_items (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, parent_id uuid,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL CHECK(length(description)<=10000),
  creator_account_id uuid NOT NULL, creator_person_id uuid NOT NULL, creator_name text NOT NULL,
  assignee_account_id uuid, assignee_person_id uuid, assignee_name text,
  assignment_generation integer NOT NULL DEFAULT 1 CHECK(assignment_generation>0),
  status text NOT NULL DEFAULT 'todo' CHECK(status IN('todo','doing','done')),
  progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  due_on date, remind_days integer CHECK(remind_days IN(0,1,3,7)),
  completed_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,project_id,id), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES task_projects(tenant_id,id),
  FOREIGN KEY(tenant_id,project_id,parent_id) REFERENCES task_items(tenant_id,project_id,id),
  FOREIGN KEY(tenant_id,project_id,assignee_account_id) REFERENCES task_project_members(tenant_id,project_id,account_id),
  CHECK(parent_id IS DISTINCT FROM id),
  CHECK((assignee_account_id IS NULL)=(assignee_person_id IS NULL) AND
    (assignee_account_id IS NULL)=(assignee_name IS NULL)),
  CHECK((status='done')=(progress=100) AND (status='done')=(completed_at IS NOT NULL)),
  CHECK(status<>'todo' OR progress=0),
  CHECK(remind_days IS NULL OR due_on IS NOT NULL)
);
CREATE INDEX task_items_listing ON task_items(tenant_id,project_id,updated_at DESC,id DESC);
CREATE INDEX task_items_parent ON task_items(tenant_id,project_id,parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX task_items_reminders ON task_items(due_on,tenant_id,project_id,id)
  WHERE status<>'done' AND assignee_account_id IS NOT NULL AND remind_days IS NOT NULL;
CREATE TABLE task_participants (
  tenant_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
  account_id uuid NOT NULL, person_id uuid NOT NULL, name text NOT NULL, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(tenant_id,task_id,account_id),
  FOREIGN KEY(tenant_id,project_id,task_id) REFERENCES task_items(tenant_id,project_id,id),
  FOREIGN KEY(tenant_id,project_id,account_id) REFERENCES task_project_members(tenant_id,project_id,account_id)
);
CREATE INDEX task_participant_access ON task_participants(tenant_id,account_id,task_id) WHERE active;
CREATE TABLE task_comments (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
  author_account_id uuid NOT NULL, author_person_id uuid NOT NULL, author_name text NOT NULL,
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 3000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,project_id,task_id) REFERENCES task_items(tenant_id,project_id,id)
);
CREATE INDEX task_comments_history ON task_comments(tenant_id,task_id,created_at,id);
CREATE TABLE task_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid,
  actor_account_id uuid NOT NULL, actor_name text NOT NULL,
  action text NOT NULL, reason text NOT NULL, request_id text NOT NULL, details jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,project_id) REFERENCES task_projects(tenant_id,id),
  FOREIGN KEY(tenant_id,project_id,task_id) REFERENCES task_items(tenant_id,project_id,id)
);
CREATE INDEX task_audit_history ON task_audit(tenant_id,task_id,id DESC);
CREATE TABLE task_receipts (
  tenant_id uuid NOT NULL, actor_account_id uuid NOT NULL, idempotency_key text NOT NULL,
  request_hash text NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(tenant_id,actor_account_id,idempotency_key)
);
CREATE TABLE task_reminders (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
  due_on date NOT NULL, assignment_generation integer NOT NULL,
  account_id uuid NOT NULL, person_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN('due','overdue')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,task_id,assignment_generation,due_on,kind),
  FOREIGN KEY(tenant_id,project_id,task_id) REFERENCES task_items(tenant_id,project_id,id)
);
CREATE INDEX task_reminders_inbox ON task_reminders(tenant_id,account_id,created_at DESC,id DESC);

CREATE FUNCTION tasks_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Task history is append only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER task_comments_immutable BEFORE UPDATE OR DELETE ON task_comments
  FOR EACH ROW EXECUTE FUNCTION tasks_append_only();
CREATE TRIGGER task_audit_immutable BEFORE UPDATE OR DELETE ON task_audit
  FOR EACH ROW EXECUTE FUNCTION tasks_append_only();
CREATE TRIGGER task_receipts_immutable BEFORE UPDATE OR DELETE ON task_receipts
  FOR EACH ROW EXECUTE FUNCTION tasks_append_only();
CREATE TRIGGER task_reminders_immutable BEFORE UPDATE OR DELETE ON task_reminders
  FOR EACH ROW EXECUTE FUNCTION tasks_append_only();

CREATE FUNCTION task_item_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM task_items t WHERE (t.tenant_id,t.project_id,t.id)=(NEW.tenant_id,NEW.project_id,NEW.parent_id)
        AND t.parent_id IS NULL
    ) THEN
      RAISE EXCEPTION 'Invalid subtask parent' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.tenant_id,NEW.project_id,NEW.parent_id,NEW.creator_account_id,NEW.creator_person_id,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.project_id,OLD.parent_id,OLD.creator_account_id,OLD.creator_person_id,OLD.created_at)
     OR NEW.revision<>OLD.revision+1
     OR NEW.assignment_generation<>OLD.assignment_generation+
       (CASE WHEN (NEW.assignee_account_id,NEW.assignee_person_id) IS DISTINCT FROM (OLD.assignee_account_id,OLD.assignee_person_id) THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'Invalid task revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_item_revision BEFORE INSERT OR UPDATE ON task_items
  FOR EACH ROW EXECUTE FUNCTION task_item_revision_guard();

CREATE FUNCTION task_project_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.org_unit_id,NEW.owner_account_id,NEW.owner_person_id,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.org_unit_id,OLD.owner_account_id,OLD.owner_person_id,OLD.created_at)
     OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'Invalid project revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_project_revision BEFORE UPDATE ON task_projects
  FOR EACH ROW EXECUTE FUNCTION task_project_revision_guard();
