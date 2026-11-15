ALTER TABLE workflow_tasks ADD CONSTRAINT workflow_task_run_identity UNIQUE (tenant_id,run_id,id);
ALTER TABLE workflow_run_followers
 ADD COLUMN task_id uuid,
 DROP CONSTRAINT workflow_run_followers_tenant_id_run_id_person_id_key,
 ADD CONSTRAINT workflow_follower_scope_unique UNIQUE NULLS NOT DISTINCT (tenant_id,run_id,person_id,task_id),
 ADD CONSTRAINT workflow_follower_task_scope FOREIGN KEY (tenant_id,run_id,task_id)
  REFERENCES workflow_tasks(tenant_id,run_id,id);
ALTER TABLE workflow_run_comments
 ADD COLUMN task_id uuid,
 ADD CONSTRAINT workflow_comment_task_scope FOREIGN KEY (tenant_id,run_id,task_id)
  REFERENCES workflow_tasks(tenant_id,run_id,id);
CREATE INDEX workflow_run_comments_scope ON workflow_run_comments(tenant_id,run_id,task_id,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION workflow_run_follower_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Workflow follower history is retained' USING ERRCODE='42501';
 END IF;
 IF (NEW.id,NEW.tenant_id,NEW.run_id,NEW.account_id,NEW.person_id,NEW.display_name,NEW.created_at,NEW.task_id)
    IS DISTINCT FROM
    (OLD.id,OLD.tenant_id,OLD.run_id,OLD.account_id,OLD.person_id,OLD.display_name,OLD.created_at,OLD.task_id)
    OR NEW.revision<>OLD.revision+1 OR NEW.active=OLD.active THEN
  RAISE EXCEPTION 'Invalid workflow follower change' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION workflow_comment_mention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM workflow_run_followers f
  JOIN workflow_notifications n ON (n.tenant_id,n.run_id,n.recipient_account_id)=(f.tenant_id,f.run_id,f.account_id)
  JOIN workflow_run_comments c ON (c.tenant_id,c.run_id,c.id)=(f.tenant_id,f.run_id,NEW.comment_id)
  WHERE (f.tenant_id,f.run_id,f.id,f.revision)=(NEW.tenant_id,NEW.run_id,NEW.follower_id,NEW.follower_revision)
   AND f.active AND n.id=NEW.notification_id AND n.kind='mentioned'
   AND n.event_key='mention:'||NEW.comment_id::text
   AND n.task_id IS NOT DISTINCT FROM f.task_id AND c.task_id IS NOT DISTINCT FROM f.task_id
 ) THEN
  RAISE EXCEPTION 'Invalid workflow comment mention' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
