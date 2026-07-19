ALTER TABLE orders
  ADD COLUMN booking_channel_code text,
  ADD COLUMN channel_order_reference text,
  ADD CONSTRAINT orders_booking_channel_code_known CHECK (
    booking_channel_code IS NULL
    OR booking_channel_code IN ('YOUMUDAO', 'CTRIP', 'MEITUAN', 'WECOM')
  ),
  ADD CONSTRAINT orders_channel_order_reference_nonblank CHECK (
    channel_order_reference IS NULL OR channel_order_reference !~ '^[[:space:]]*$'
  ),
  ADD CONSTRAINT orders_wecom_has_no_channel_order_reference CHECK (
    booking_channel_code IS DISTINCT FROM 'WECOM' OR channel_order_reference IS NULL
  );

ALTER TABLE collection_facts
  ADD COLUMN transaction_reference text,
  ADD CONSTRAINT collection_facts_transaction_reference_nonblank CHECK (
    transaction_reference IS NULL OR transaction_reference !~ '^[[:space:]]*$'
  );

CREATE OR REPLACE FUNCTION qintopia_validate_new_order_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.channel_order_reference := NULLIF(
    regexp_replace(btrim(NEW.channel_order_reference), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  IF NEW.booking_channel_code IS NULL
    OR NEW.booking_channel_code NOT IN ('YOUMUDAO', 'CTRIP', 'MEITUAN', 'WECOM') THEN
    RAISE EXCEPTION 'new orders require a known booking channel code'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_booking_channel_required';
  END IF;
  IF NEW.booking_channel_code = 'WECOM' AND NEW.channel_order_reference IS NOT NULL THEN
    RAISE EXCEPTION 'WECOM orders cannot have a channel order reference'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_wecom_has_no_channel_order_reference';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_validate_new_channel
BEFORE INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_order_channel();

CREATE OR REPLACE FUNCTION qintopia_validate_new_collection_fact_transaction_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  referenced_fact_type text;
  referenced_order_id text;
BEGIN
  NEW.transaction_reference := NULLIF(
    regexp_replace(btrim(NEW.transaction_reference), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  IF NEW.fact_type IN ('COLLECTION', 'REFUND') AND NEW.transaction_reference IS NULL THEN
    RAISE EXCEPTION 'new collection and refund facts require a transaction reference'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_new_transaction_reference_required';
  END IF;
  IF NEW.fact_type = 'REVERSAL' AND NEW.transaction_reference IS NOT NULL THEN
    RAISE EXCEPTION 'reversal facts cannot have a transaction reference'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_transaction_reference_null';
  END IF;
  IF NEW.fact_type = 'REFUND' THEN
    IF NEW.references_fact_id IS NULL THEN
      RAISE EXCEPTION 'refund facts require a referenced collection fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_required';
    END IF;
    SELECT fact_type, order_id
      INTO referenced_fact_type, referenced_order_id
      FROM collection_facts
      WHERE fact_id = NEW.references_fact_id;
    IF NOT FOUND OR referenced_fact_type IS DISTINCT FROM 'COLLECTION' THEN
      RAISE EXCEPTION 'refund facts must reference a collection fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_collection';
    END IF;
    IF referenced_order_id IS DISTINCT FROM NEW.order_id THEN
      RAISE EXCEPTION 'refund facts must reference a collection in the same order'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_same_order';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_facts_validate_new_transaction_reference
BEFORE INSERT ON collection_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_collection_fact_transaction_reference();

CREATE OR REPLACE FUNCTION qintopia_protect_order_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.primary_guest_snapshot IS DISTINCT FROM OLD.primary_guest_snapshot
    OR NEW.booking_channel_code IS DISTINCT FROM OLD.booking_channel_code
    OR NEW.channel_order_reference IS DISTINCT FROM OLD.channel_order_reference
    OR NEW.pricing_policy_version_id IS DISTINCT FROM OLD.pricing_policy_version_id
    OR NEW.stay_type IS DISTINCT FROM OLD.stay_type
    OR NEW.member_contract_id IS DISTINCT FROM OLD.member_contract_id THEN
    RAISE EXCEPTION 'order identity, guest snapshot, booking channel, membership, stay type, and locked pricing policy are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
