CREATE OR REPLACE FUNCTION qintopia_validate_new_order_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.channel_order_reference := NULLIF(
    regexp_replace(btrim(NEW.channel_order_reference), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );

  IF NEW.member_id IS NOT NULL OR NEW.member_contract_id IS NOT NULL THEN
    IF NEW.booking_channel_code IS NOT NULL OR NEW.channel_order_reference IS NOT NULL THEN
      RAISE EXCEPTION 'member stays cannot have a booking channel or channel order reference'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_member_booking_channel_null';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.booking_channel_code IS NULL
    OR NEW.booking_channel_code NOT IN ('YOUMUDAO', 'CTRIP', 'MEITUAN', 'WECOM') THEN
    RAISE EXCEPTION 'new non-member orders require a known booking channel code'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_booking_channel_required';
  END IF;
  IF NEW.booking_channel_code = 'WECOM' AND NEW.channel_order_reference IS NOT NULL THEN
    RAISE EXCEPTION 'WECOM orders cannot have a channel order reference'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_wecom_has_no_channel_order_reference';
  END IF;
  RETURN NEW;
END;
$$;
