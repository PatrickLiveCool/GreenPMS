CREATE OR REPLACE FUNCTION qintopia_validate_new_collection_fact_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_currency char(3);
  referenced_fact_type text;
  referenced_order_id text;
  reversed_fact_type text;
  reversed_order_id text;
  reversed_currency char(3);
  reversed_amount_minor integer;
  reversed_net_effect_minor integer;
BEGIN
  SELECT property.currency
    INTO order_currency
    FROM orders AS booking
    JOIN properties AS property ON property.id = booking.property_id
    WHERE booking.id = NEW.order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'collection facts require an existing order'
      USING ERRCODE = '23503', CONSTRAINT = 'collection_facts_order_required';
  END IF;
  IF NEW.currency IS DISTINCT FROM order_currency THEN
    RAISE EXCEPTION 'collection fact currency must match the order property currency'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_order_currency_match';
  END IF;

  IF NEW.fact_type = 'COLLECTION' THEN
    IF NEW.net_effect_minor::bigint IS DISTINCT FROM NEW.amount_minor::bigint THEN
      RAISE EXCEPTION 'collection net effect must equal its amount'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_collection_net_effect';
    END IF;
    IF NEW.references_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'collection facts cannot reference another fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_collection_reference_null';
    END IF;
    IF NEW.reverses_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'collection facts cannot reverse another fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_collection_reversal_null';
    END IF;
  ELSIF NEW.fact_type = 'REFUND' THEN
    IF NEW.net_effect_minor::bigint IS DISTINCT FROM -(NEW.amount_minor::bigint) THEN
      RAISE EXCEPTION 'refund net effect must be the negative of its amount'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_net_effect';
    END IF;
    IF NEW.reverses_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'refund facts cannot reverse another fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reversal_null';
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
  ELSIF NEW.fact_type = 'REVERSAL' THEN
    IF NEW.references_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'reversal facts cannot use the refund reference field'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_reference_null';
    END IF;
    IF NEW.reverses_fact_id IS NULL THEN
      RAISE EXCEPTION 'reversal facts require the fact they reverse'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_target_required';
    END IF;

    SELECT fact_type, order_id, currency, amount_minor, net_effect_minor
      INTO reversed_fact_type, reversed_order_id, reversed_currency, reversed_amount_minor, reversed_net_effect_minor
      FROM collection_facts
      WHERE fact_id = NEW.reverses_fact_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reversal facts require an existing fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_target_required';
    END IF;
    IF reversed_fact_type = 'REVERSAL' THEN
      RAISE EXCEPTION 'reversal facts cannot reverse another reversal'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_target_not_reversal';
    END IF;
    IF reversed_order_id IS DISTINCT FROM NEW.order_id THEN
      RAISE EXCEPTION 'reversal facts must reverse a fact in the same order'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_same_order';
    END IF;
    IF reversed_currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'reversal facts must use the reversed fact currency'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_same_currency';
    END IF;
    IF NEW.amount_minor IS DISTINCT FROM reversed_amount_minor THEN
      RAISE EXCEPTION 'reversal amount must equal the reversed fact amount'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_amount';
    END IF;
    IF NEW.net_effect_minor::bigint IS DISTINCT FROM -(reversed_net_effect_minor::bigint) THEN
      RAISE EXCEPTION 'reversal net effect must negate the reversed fact net effect'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_net_effect';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Sort after migration 009's transaction-reference trigger so its established errors stay stable.
CREATE TRIGGER collection_facts_validate_new_write_shape
BEFORE INSERT ON collection_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_collection_fact_shape();

CREATE OR REPLACE FUNCTION qintopia_validate_order_current_revision_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_order_id text;
BEGIN
  IF NEW.current_revision_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT order_id
    INTO revision_order_id
    FROM pricing_revisions
    WHERE id = NEW.current_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current pricing revision must exist'
      USING ERRCODE = '23503', CONSTRAINT = 'orders_current_revision_required';
  END IF;
  IF revision_order_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'current pricing revision must belong to the same order'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_current_revision_same_order';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_validate_current_revision_owner
BEFORE INSERT OR UPDATE OF current_revision_id ON orders
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_order_current_revision_owner();

CREATE OR REPLACE FUNCTION qintopia_protect_member_contract_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    RAISE EXCEPTION 'member contract member and property are immutable after creation'
      USING ERRCODE = '55000', CONSTRAINT = 'member_contracts_owner_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER member_contracts_protect_owner
BEFORE UPDATE ON member_contracts
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_member_contract_owner();
