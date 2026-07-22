CREATE OR REPLACE FUNCTION qintopia_validate_new_order_primary_guest_nickname() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  normalized_nickname text;
BEGIN
  IF jsonb_typeof(NEW.primary_guest_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'new orders require a primary guest snapshot object'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_primary_guest_snapshot_object';
  END IF;

  IF jsonb_typeof(NEW.primary_guest_snapshot -> 'nickname') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'new orders require a nonblank primary guest nickname'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_primary_guest_nickname_required';
  END IF;

  normalized_nickname := regexp_replace(
    btrim(NEW.primary_guest_snapshot ->> 'nickname'),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  );
  IF normalized_nickname = '' THEN
    RAISE EXCEPTION 'new orders require a nonblank primary guest nickname'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_primary_guest_nickname_required';
  END IF;
  IF char_length(normalized_nickname) > 200 THEN
    RAISE EXCEPTION 'new order primary guest nickname exceeds 200 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_primary_guest_nickname_length';
  END IF;

  NEW.primary_guest_snapshot := jsonb_set(
    NEW.primary_guest_snapshot,
    '{nickname}',
    to_jsonb(normalized_nickname),
    false
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_validate_new_primary_guest_nickname
BEFORE INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_order_primary_guest_nickname();
