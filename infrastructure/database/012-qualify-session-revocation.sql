CREATE OR REPLACE FUNCTION public.account_revoke_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.active AND NOT NEW.active) OR NEW.auth_not_before>OLD.auth_not_before THEN
    DELETE FROM public.sessions WHERE account_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
