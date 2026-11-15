CREATE INDEX audit_events_request_id
  ON audit_events (request_id)
  WHERE request_id IS NOT NULL;
