CREATE OR REPLACE FUNCTION qintopia_protect_command_execution_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'command execution identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.command_type IS DISTINCT FROM OLD.command_type
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'command execution identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'EXECUTING'
    AND NEW.state IN ('APPLIED', 'REJECTED')
    AND OLD.completed_at IS NULL
    AND NEW.completed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state
    AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'command execution state may only advance from EXECUTING to a completed state' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_protect_api_token_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'api token identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
    OR NEW.access_ceiling IS DISTINCT FROM OLD.access_ceiling
    OR NEW.property_scope IS DISTINCT FROM OLD.property_scope
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.rotated_from_id IS DISTINCT FROM OLD.rotated_from_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'api token identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.revoked_at IS NOT DISTINCT FROM OLD.revoked_at
    AND NEW.replaced_by_id IS NOT DISTINCT FROM OLD.replaced_by_id THEN
    RETURN NEW;
  END IF;

  IF OLD.revoked_at IS NULL
    AND OLD.replaced_by_id IS NULL
    AND NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'api token state may only advance once from active to revoked or rotated' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER command_executions_protect_identity
BEFORE UPDATE OR DELETE ON command_executions
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_command_execution_identity();

CREATE TRIGGER api_tokens_protect_identity
BEFORE UPDATE OR DELETE ON api_tokens
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_api_token_identity();
