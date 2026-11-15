ALTER TABLE audit_projection.infrastructure_events
  ADD CONSTRAINT workerd_source_role CHECK (
    source <> 'workerd' OR (app_code = 'aio-lms-sandbox' AND action <> 'edge.rejected')
  );

ALTER TABLE audit_projection.infrastructure_events
  DROP CONSTRAINT infrastructure_events_check;

ALTER TABLE audit_projection.infrastructure_events
  ADD CONSTRAINT staging_infrastructure_event_shape CHECK (
    (source IN ('ingress', 'workerd') AND action IN ('auth.callback', 'http.denied', 'http.error', 'edge.rejected')
      AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 599
      AND request_id IS NOT NULL AND subject_ref IS NULL)
    OR (source = 'keycloak-auth' AND action IN ('login', 'login.failed')
      AND http_status IS NULL AND request_id IS NULL)
    OR (source = 'keycloak-admin' AND action IN ('key.create', 'key.update', 'user.update', 'user.logout')
      AND http_status IS NULL AND request_id IS NULL)
  );

CREATE POLICY staging_workerd_ingest ON audit_projection.infrastructure_events
  FOR INSERT WITH CHECK (current_user = 'aio_audit_workerd' AND source = 'workerd');
