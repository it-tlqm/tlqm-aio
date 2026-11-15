ALTER TABLE accounts ADD COLUMN auth_not_before bigint NOT NULL DEFAULT 0 CHECK (auth_not_before>=0);
ALTER TABLE external_identities ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE external_identities ADD CONSTRAINT external_identity_id_unique UNIQUE(id);
ALTER TABLE external_identities ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE external_identities ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE external_identities ADD COLUMN verified_at timestamptz;
ALTER TABLE external_identities ADD COLUMN verified_by uuid REFERENCES accounts(id);
ALTER TABLE external_identities ADD COLUMN verification_method text NOT NULL DEFAULT 'bootstrap-local';
CREATE FUNCTION external_identity_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.issuer,NEW.subject,NEW.account_id) IS DISTINCT FROM (OLD.issuer,OLD.subject,OLD.account_id) THEN
    RAISE EXCEPTION 'Identity ownership is immutable' USING ERRCODE='23514', CONSTRAINT='external_identity_binding_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER external_identity_binding_immutable BEFORE UPDATE ON external_identities FOR EACH ROW EXECUTE FUNCTION external_identity_binding_immutable();

CREATE TABLE identity_proofs (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  app_code text NOT NULL REFERENCES applications(code),
  issuer text NOT NULL,
  subject text NOT NULL,
  authenticated_at bigint NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  encrypted_payload text,
  consumed_at timestamptz,
  linked_account_id uuid REFERENCES accounts(id),
  CHECK (expires_at>verified_at),
  CHECK ((consumed_at IS NULL AND encrypted_payload IS NOT NULL) OR (consumed_at IS NOT NULL AND encrypted_payload IS NULL))
);
CREATE INDEX identity_proofs_expiry ON identity_proofs(expires_at);

CREATE FUNCTION account_security_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    NEW.auth_not_before := GREATEST(OLD.auth_not_before, floor(extract(epoch FROM clock_timestamp()))::bigint);
  END IF;
  IF NEW.auth_not_before < OLD.auth_not_before THEN
    RAISE EXCEPTION 'Account authentication boundary must be monotonic' USING ERRCODE='23514', CONSTRAINT='account_auth_boundary_monotonic';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_security_boundary BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION account_security_boundary();
CREATE FUNCTION account_revoke_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.active AND NOT NEW.active) OR NEW.auth_not_before>OLD.auth_not_before THEN
    DELETE FROM sessions WHERE account_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_revoke_sessions AFTER UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION account_revoke_sessions();
CREATE FUNCTION person_revoke_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    UPDATE accounts SET auth_not_before=GREATEST(auth_not_before,floor(extract(epoch FROM clock_timestamp()))::bigint),revision=revision+1 WHERE person_id=NEW.id;
    DELETE FROM sessions WHERE account_id IN(SELECT id FROM accounts WHERE person_id=NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER person_revoke_sessions AFTER UPDATE ON persons FOR EACH ROW EXECUTE FUNCTION person_revoke_sessions();
