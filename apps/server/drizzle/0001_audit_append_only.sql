-- audit_events is append-only. Updates are always rejected.
-- Deletes are allowed only for a retention purge that sets: SET LOCAL tracera.allow_audit_purge = 'on'.
CREATE FUNCTION tracera_audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('tracera.allow_audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION tracera_audit_events_append_only();
