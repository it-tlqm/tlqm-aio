CREATE SCHEMA audit_projection;

CREATE TABLE audit_projection.environment_marker (
  singleton boolean PRIMARY KEY CHECK (singleton),
  instance_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'tlqm-aio-audit-staging')
);

CREATE TABLE audit_projection.events (
  source text NOT NULL CHECK (source IN ('foundation', 'forms', 'workflows', 'tasks', 'lms')),
  source_id bigint NOT NULL CHECK (source_id > 0),
  occurred_at timestamptz NOT NULL,
  app_code text NOT NULL CHECK (app_code ~ '^[a-z][a-z0-9-]{1,63}$'),
  tenant_id uuid,
  org_unit_id uuid,
  actor_account_id uuid,
  subject_account_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-zA-Z0-9_.:-]{1,100}$'),
  request_id uuid,
  PRIMARY KEY (source, source_id)
);

CREATE INDEX audit_projection_requests ON audit_projection.events (request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX audit_projection_retention ON audit_projection.events (occurred_at);

CREATE FUNCTION audit_projection.prune_expired() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  WITH expired AS (
    DELETE FROM audit_projection.events
      WHERE occurred_at < now() - interval '2160 hours'
      RETURNING 1
  )
  SELECT count(*) FROM expired;
$$;

REVOKE ALL ON FUNCTION audit_projection.prune_expired() FROM PUBLIC;
