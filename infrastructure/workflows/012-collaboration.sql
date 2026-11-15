CREATE TABLE workflow_run_followers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 account_id uuid NOT NULL,
 person_id uuid NOT NULL,
 display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
 active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,run_id,id),
 UNIQUE (tenant_id,run_id,person_id),
 FOREIGN KEY (tenant_id,run_id) REFERENCES workflow_runs(tenant_id,id)
);
CREATE INDEX workflow_run_followers_active ON workflow_run_followers(tenant_id,account_id,person_id,run_id)
 WHERE active;
CREATE FUNCTION workflow_run_follower_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Workflow follower history is retained' USING ERRCODE='42501';
 END IF;
 IF (NEW.id,NEW.tenant_id,NEW.run_id,NEW.account_id,NEW.person_id,NEW.display_name,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.tenant_id,OLD.run_id,OLD.account_id,OLD.person_id,OLD.display_name,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR NEW.active=OLD.active THEN
  RAISE EXCEPTION 'Invalid workflow follower change' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_run_followers_guard BEFORE UPDATE OR DELETE ON workflow_run_followers
 FOR EACH ROW EXECUTE FUNCTION workflow_run_follower_guard();

CREATE TABLE workflow_run_comments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 author_account_id uuid NOT NULL,
 author_person_id uuid NOT NULL,
 author_name text NOT NULL CHECK (length(author_name) BETWEEN 1 AND 200),
 body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,run_id,id),
 FOREIGN KEY (tenant_id,run_id) REFERENCES workflow_runs(tenant_id,id)
);
CREATE INDEX workflow_run_comments_page ON workflow_run_comments(tenant_id,run_id,created_at DESC,id DESC);
CREATE TRIGGER workflow_run_comments_immutable BEFORE UPDATE OR DELETE ON workflow_run_comments
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

ALTER TABLE workflow_notifications DROP CONSTRAINT workflow_notifications_kind_check;
ALTER TABLE workflow_notifications ADD CONSTRAINT workflow_notifications_kind_check
 CHECK (kind IN ('assigned','approved','returned','completed','rejected','cancelled','due_soon','overdue','mentioned'));

CREATE TABLE workflow_comment_mentions (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 comment_id uuid NOT NULL,
 follower_id uuid NOT NULL,
 follower_revision integer NOT NULL CHECK (follower_revision > 0),
 notification_id uuid NOT NULL,
 PRIMARY KEY (tenant_id,run_id,comment_id,follower_id),
 UNIQUE (tenant_id,notification_id),
 FOREIGN KEY (tenant_id,run_id,comment_id) REFERENCES workflow_run_comments(tenant_id,run_id,id),
 FOREIGN KEY (tenant_id,run_id,follower_id) REFERENCES workflow_run_followers(tenant_id,run_id,id),
 FOREIGN KEY (tenant_id,notification_id) REFERENCES workflow_notifications(tenant_id,id)
);
CREATE TRIGGER workflow_comment_mentions_immutable BEFORE UPDATE OR DELETE ON workflow_comment_mentions
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE FUNCTION workflow_comment_mention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM workflow_run_followers f
  JOIN workflow_notifications n ON (n.tenant_id,n.run_id,n.recipient_account_id)=(f.tenant_id,f.run_id,f.account_id)
  WHERE (f.tenant_id,f.run_id,f.id,f.revision)=(NEW.tenant_id,NEW.run_id,NEW.follower_id,NEW.follower_revision)
   AND f.active AND n.id=NEW.notification_id AND n.kind='mentioned'
   AND n.event_key='mention:'||NEW.comment_id::text
 ) THEN
  RAISE EXCEPTION 'Invalid workflow comment mention' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_comment_mentions_scope BEFORE INSERT ON workflow_comment_mentions
 FOR EACH ROW EXECUTE FUNCTION workflow_comment_mention_guard();
