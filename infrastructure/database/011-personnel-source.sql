CREATE SCHEMA personnel_sync;
REVOKE ALL ON SCHEMA personnel_sync FROM PUBLIC;

CREATE TABLE personnel_sync.bindings (
  source_id text PRIMARY KEY CHECK (source_id ~ '^SYN-[A-Z0-9-]{1,60}$'),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  employment_id uuid NOT NULL UNIQUE REFERENCES public.employments(id),
  account_id uuid NOT NULL UNIQUE REFERENCES public.accounts(id),
  source_revision integer NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  employed boolean,
  last_request_id uuid,
  CHECK ((source_revision = 0) = (employed IS NULL)),
  CHECK ((source_revision = 0) = (last_request_id IS NULL))
);

CREATE FUNCTION personnel_sync.guard_activation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.active AND NOT OLD.active AND EXISTS (
    SELECT FROM personnel_sync.bindings WHERE account_id = NEW.id AND employed = false
  ) THEN
    RAISE EXCEPTION 'Personnel source has blocked activation' USING ERRCODE = '23514',
      CONSTRAINT = 'personnel_source_activation_blocked';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION personnel_sync.guard_activation() FROM PUBLIC;
CREATE TRIGGER personnel_sync_guard_activation BEFORE UPDATE OF active ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION personnel_sync.guard_activation();

CREATE FUNCTION personnel_sync.apply_snapshot(
  stage_instance uuid, worker_source_id text, incoming_revision integer, incoming_employed boolean
) RETURNS TABLE (outcome text, request_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  binding personnel_sync.bindings%ROWTYPE;
  event_id uuid;
BEGIN
  IF current_database() !~ '^aio_foundation_stage_[ab]$' OR NOT EXISTS (
    SELECT FROM public.environment_marker WHERE purpose = 'tlqm-aio-test'
  ) OR NOT EXISTS (
    SELECT FROM public.bootstrap_receipts WHERE name = 'enterprise-staging:' || stage_instance::text
  ) THEN
    RAISE EXCEPTION 'Personnel connector requires its isolated staging database' USING ERRCODE = '42501';
  END IF;
  IF worker_source_id IS NULL OR worker_source_id !~ '^SYN-[A-Z0-9-]{1,60}$'
      OR incoming_revision IS NULL OR incoming_revision <= 0 OR incoming_employed IS NULL THEN
    RAISE EXCEPTION 'Invalid personnel snapshot' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(71092027);
  SELECT b.* INTO binding FROM personnel_sync.bindings b
    JOIN public.accounts a ON a.id = b.account_id AND NOT a.is_protected
    JOIN public.persons p ON p.id = a.person_id AND p.home_tenant_id = b.tenant_id
    JOIN public.employments e ON e.id = b.employment_id AND e.person_id = p.id AND e.tenant_id = b.tenant_id
    WHERE b.source_id = worker_source_id FOR UPDATE OF b, a;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unlinked'::text, NULL::uuid;
  ELSIF incoming_revision < binding.source_revision THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid;
  ELSIF incoming_revision = binding.source_revision THEN
    IF incoming_employed = binding.employed THEN
      RETURN QUERY SELECT 'replay'::text, binding.last_request_id;
    ELSE
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid;
    END IF;
  ELSE
    event_id := gen_random_uuid();
    UPDATE personnel_sync.bindings
      SET source_revision = incoming_revision, employed = incoming_employed, last_request_id = event_id
      WHERE source_id = worker_source_id;
    IF NOT incoming_employed THEN
      UPDATE public.accounts SET active = false, revision = revision + 1
        WHERE id = binding.account_id AND active;
    END IF;
    INSERT INTO public.audit_events (subject_account_id, tenant_id, app_code, action, request_id, details)
      VALUES (binding.account_id, binding.tenant_id, 'aio-foundation',
        CASE WHEN incoming_employed THEN 'personnel-source.employed' ELSE 'personnel-source.departed' END,
        event_id::text, jsonb_build_object('source', 'synthetic-personnel', 'sourceRevision', incoming_revision));
    RETURN QUERY SELECT 'applied'::text, event_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION personnel_sync.apply_snapshot(uuid, text, integer, boolean) FROM PUBLIC;
