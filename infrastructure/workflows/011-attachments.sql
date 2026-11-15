CREATE TABLE workflow_attachments (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 request_id uuid,
 run_id uuid,
 round integer,
 task_id uuid,
 field_id text NOT NULL CHECK (length(field_id) BETWEEN 1 AND 70),
 uploader_account_id uuid NOT NULL,
 uploader_person_id uuid NOT NULL,
 file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
 format text NOT NULL CHECK (format IN ('pdf','png','jpeg','txt','csv','docx','xlsx','unknown')),
 byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 10485760),
 checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
 scan_status text NOT NULL CHECK (scan_status IN ('ready','quarantined')),
 content bytea,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,id),
 FOREIGN KEY (tenant_id,request_id) REFERENCES workflow_requests(tenant_id,id),
 FOREIGN KEY (tenant_id,run_id) REFERENCES workflow_runs(tenant_id,id),
 FOREIGN KEY (tenant_id,run_id,round,task_id) REFERENCES workflow_tasks(tenant_id,run_id,round,id),
 CHECK (
  (request_id IS NOT NULL AND run_id IS NULL AND round IS NULL AND task_id IS NULL)
  OR (request_id IS NULL AND run_id IS NOT NULL AND round IS NOT NULL AND round>0)
 ),
 CHECK (
  (scan_status='ready' AND format<>'unknown' AND content IS NOT NULL AND octet_length(content)=byte_count)
  OR (scan_status='quarantined' AND content IS NULL)
 )
);
CREATE INDEX workflow_attachment_request ON workflow_attachments(tenant_id,request_id,field_id)
 WHERE request_id IS NOT NULL;
CREATE INDEX workflow_attachment_run ON workflow_attachments(tenant_id,run_id,round,task_id,field_id)
 WHERE run_id IS NOT NULL;
CREATE TRIGGER workflow_attachments_immutable BEFORE UPDATE OR DELETE ON workflow_attachments
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();

CREATE TABLE workflow_attachment_links (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 round integer NOT NULL,
 task_id uuid,
 field_id text NOT NULL,
 attachment_id uuid NOT NULL,
 UNIQUE NULLS NOT DISTINCT (tenant_id,run_id,round,task_id,field_id,attachment_id),
 FOREIGN KEY (tenant_id,run_id,round) REFERENCES workflow_run_inputs(tenant_id,run_id,round),
 FOREIGN KEY (tenant_id,run_id,round,task_id) REFERENCES workflow_tasks(tenant_id,run_id,round,id),
 FOREIGN KEY (tenant_id,attachment_id) REFERENCES workflow_attachments(tenant_id,id)
);
CREATE INDEX workflow_attachment_links_access ON workflow_attachment_links(tenant_id,attachment_id);
CREATE TRIGGER workflow_attachment_links_immutable BEFORE UPDATE OR DELETE ON workflow_attachment_links
 FOR EACH ROW EXECUTE FUNCTION workflows_append_only();
CREATE FUNCTION workflow_attachment_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM workflow_attachments a
  LEFT JOIN workflow_requests q ON (q.tenant_id,q.id)=(a.tenant_id,a.request_id)
  LEFT JOIN workflow_tasks original ON (original.tenant_id,original.id)=(a.tenant_id,a.task_id)
  LEFT JOIN workflow_tasks target ON (target.tenant_id,target.id)=(NEW.tenant_id,NEW.task_id)
  WHERE (a.tenant_id,a.id)=(NEW.tenant_id,NEW.attachment_id) AND a.scan_status='ready'
   AND (a.run_id=NEW.run_id OR q.run_id=NEW.run_id)
   AND (
    (a.task_id IS NULL AND COALESCE(a.round,1)<=NEW.round
      AND (a.field_id=NEW.field_id AND NEW.task_id IS NULL
       OR 'input.'||a.field_id=NEW.field_id AND NEW.task_id IS NOT NULL))
    OR (a.task_id IS NOT NULL AND a.round=NEW.round
      AND original.node_id=target.node_id AND a.field_id=NEW.field_id)
   )
 ) THEN
  RAISE EXCEPTION 'Invalid workflow attachment link' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_attachment_link_scope BEFORE INSERT ON workflow_attachment_links
 FOR EACH ROW EXECUTE FUNCTION workflow_attachment_link_guard();
