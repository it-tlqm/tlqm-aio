CREATE TABLE audit_projection.infrastructure_events (
  source text NOT NULL,
  source_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  app_code text NOT NULL CHECK (app_code ~ '^aio-[a-z0-9-]{1,59}$'),
  action text NOT NULL,
  http_status integer,
  request_id uuid,
  subject_ref uuid,
  PRIMARY KEY (source, source_id),
  CHECK (
    (source = 'ingress' AND action IN ('auth.callback', 'http.denied', 'http.error', 'edge.rejected')
      AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 599
      AND request_id IS NOT NULL AND subject_ref IS NULL)
    OR (source = 'keycloak-auth' AND action IN ('login', 'login.failed')
      AND http_status IS NULL AND request_id IS NULL)
    OR (source = 'keycloak-admin' AND action IN ('key.create', 'key.update', 'user.update', 'user.logout')
      AND http_status IS NULL AND request_id IS NULL)
  )
);

CREATE INDEX audit_infrastructure_requests ON audit_projection.infrastructure_events(request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX audit_infrastructure_retention ON audit_projection.infrastructure_events(occurred_at);

ALTER TABLE audit_projection.infrastructure_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY staging_infrastructure_ingest ON audit_projection.infrastructure_events
  FOR INSERT WITH CHECK (
    (current_user = 'aio_audit_ingress' AND source = 'ingress')
    OR (current_user = 'aio_audit_collect' AND source IN ('keycloak-auth', 'keycloak-admin'))
  );
CREATE POLICY staging_infrastructure_read ON audit_projection.infrastructure_events
  FOR SELECT USING (current_user = 'aio_audit_read');

CREATE FUNCTION audit_projection.prune_infrastructure_expired() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  WITH expired AS (
    DELETE FROM audit_projection.infrastructure_events
      WHERE occurred_at < now() - interval '2160 hours'
      RETURNING 1
  )
  SELECT count(*) FROM expired;
$$;
REVOKE ALL ON FUNCTION audit_projection.prune_infrastructure_expired() FROM PUBLIC;
