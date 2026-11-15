-- A registered source snapshot is owned by its adapter. Browser commands cannot supply it.
ALTER TABLE workflow_runs ADD COLUMN source_context jsonb;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_source_shape CHECK(source_context IS NULL OR (jsonb_typeof(source_context)='object' AND source_context ?& ARRAY['kind','id','proposalId','subjectPersonId','subjectName','checksum','changes'] AND source_context->>'kind'='directory-profile' AND source_context->>'checksum' ~ '^[0-9a-f]{64}$'));
CREATE UNIQUE INDEX workflow_source_once ON workflow_runs(tenant_id,(source_context->>'kind'),(source_context->>'id')) WHERE source_context IS NOT NULL;
CREATE FUNCTION workflow_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source_context IS DISTINCT FROM OLD.source_context OR (OLD.source_context IS NOT NULL AND NEW.inputs IS DISTINCT FROM OLD.inputs) THEN RAISE EXCEPTION 'Source proposal snapshot immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_source_immutable BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION workflow_source_guard();
CREATE FUNCTION workflow_source_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE subject_id text; actor_id text; BEGIN
 SELECT r.source_context->>'subjectPersonId' INTO subject_id FROM workflow_tasks t JOIN workflow_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id AND t.kind='approval';
 IF TG_TABLE_NAME='workflow_approval_votes' THEN actor_id=NEW.person_id::text; ELSE actor_id=NEW.actor_person_id::text; END IF;
 IF subject_id IS NOT NULL AND subject_id=actor_id THEN RAISE EXCEPTION 'Source subject cannot approve own proposal' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_source_vote_guard BEFORE INSERT ON workflow_approval_votes FOR EACH ROW EXECUTE FUNCTION workflow_source_decision_guard();
CREATE TRIGGER workflow_source_result_guard BEFORE INSERT ON workflow_task_results FOR EACH ROW EXECUTE FUNCTION workflow_source_decision_guard();
