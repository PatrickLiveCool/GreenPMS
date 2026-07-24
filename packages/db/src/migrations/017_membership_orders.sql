CREATE TABLE membership_products (
  id text PRIMARY KEY,
  code text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  list_price_minor integer NOT NULL CHECK (list_price_minor >= 0 AND list_price_minor % 100 = 0),
  currency char(3) NOT NULL,
  entitlement_unit_kind text NOT NULL CHECK (entitlement_unit_kind IN ('ROOM_NIGHT', 'BED_NIGHT')),
  entitlement_units integer NOT NULL CHECK (entitlement_units > 0),
  validity_period text NOT NULL CHECK (validity_period = 'P1Y'),
  allowed_room_type_code text NOT NULL,
  allowed_inventory_kind text NOT NULL CHECK (allowed_inventory_kind IN ('ROOM', 'BED')),
  status text NOT NULL CHECK (status = 'PUBLISHED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

INSERT INTO membership_products (
  id, code, version, name, list_price_minor, currency,
  entitlement_unit_kind, entitlement_units, validity_period,
  allowed_room_type_code, allowed_inventory_kind, status
) VALUES
  ('membership_product_shared_bath_single_v1', 'SHARED_BATH_SINGLE_30', 1, '公卫单人间会员', 162000, 'CNY', 'ROOM_NIGHT', 30, 'P1Y', 'shared_bath_single', 'ROOM', 'PUBLISHED'),
  ('membership_product_private_bath_single_v1', 'PRIVATE_BATH_SINGLE_30', 1, '独卫单人间会员', 216000, 'CNY', 'ROOM_NIGHT', 30, 'P1Y', 'private_bath_single', 'ROOM', 'PUBLISHED'),
  ('membership_product_shared_bath_quad_v1', 'SHARED_BATH_QUAD_30', 1, '公卫四人间会员', 93600, 'CNY', 'BED_NIGHT', 30, 'P1Y', 'shared_bath_quad', 'BED', 'PUBLISHED')
ON CONFLICT (id) DO NOTHING;

CREATE TRIGGER membership_products_append_only
BEFORE UPDATE OR DELETE ON membership_products
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE TABLE membership_orders (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  member_id text NOT NULL REFERENCES members(id),
  product_id text NOT NULL REFERENCES membership_products(id),
  product_code text NOT NULL,
  product_version integer NOT NULL CHECK (product_version > 0),
  product_name text NOT NULL,
  listed_price_minor integer NOT NULL CHECK (listed_price_minor >= 0 AND listed_price_minor % 100 = 0),
  agreed_price_minor integer NOT NULL CHECK (agreed_price_minor >= 0 AND agreed_price_minor % 100 = 0),
  price_adjustment_minor integer NOT NULL,
  price_adjustment_reason text,
  currency char(3) NOT NULL,
  entitlement_unit_kind text NOT NULL CHECK (entitlement_unit_kind IN ('ROOM_NIGHT', 'BED_NIGHT')),
  entitlement_units integer NOT NULL CHECK (entitlement_units > 0),
  allowed_room_type_code text NOT NULL,
  allowed_inventory_kind text NOT NULL CHECK (allowed_inventory_kind IN ('ROOM', 'BED')),
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE')),
  activated_at timestamptz,
  valid_from date,
  valid_until date,
  contract_id text UNIQUE,
  entitlement_lot_id text UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_command_id text NOT NULL,
  activated_by_command_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (member_id, property_id) REFERENCES member_property_links(member_id, property_id),
  CHECK (price_adjustment_minor = agreed_price_minor - listed_price_minor),
  CHECK (
    (agreed_price_minor = listed_price_minor AND price_adjustment_reason IS NULL)
    OR
    (agreed_price_minor <> listed_price_minor AND NULLIF(BTRIM(price_adjustment_reason), '') IS NOT NULL)
  ),
  CHECK (
    (status = 'DRAFT' AND activated_at IS NULL AND valid_from IS NULL AND valid_until IS NULL AND contract_id IS NULL AND entitlement_lot_id IS NULL AND activated_by_command_id IS NULL)
    OR
    (status = 'ACTIVE' AND activated_at IS NOT NULL AND valid_from IS NOT NULL AND valid_until IS NOT NULL AND contract_id IS NOT NULL AND entitlement_lot_id IS NOT NULL AND activated_by_command_id IS NOT NULL)
  ),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

CREATE INDEX membership_orders_member_property_idx
  ON membership_orders (member_id, property_id, created_at DESC);

CREATE OR REPLACE FUNCTION qintopia_protect_membership_order_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.product_code IS DISTINCT FROM OLD.product_code
    OR NEW.product_version IS DISTINCT FROM OLD.product_version
    OR NEW.product_name IS DISTINCT FROM OLD.product_name
    OR NEW.listed_price_minor IS DISTINCT FROM OLD.listed_price_minor
    OR NEW.agreed_price_minor IS DISTINCT FROM OLD.agreed_price_minor
    OR NEW.price_adjustment_minor IS DISTINCT FROM OLD.price_adjustment_minor
    OR NEW.price_adjustment_reason IS DISTINCT FROM OLD.price_adjustment_reason
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.entitlement_unit_kind IS DISTINCT FROM OLD.entitlement_unit_kind
    OR NEW.entitlement_units IS DISTINCT FROM OLD.entitlement_units
    OR NEW.allowed_room_type_code IS DISTINCT FROM OLD.allowed_room_type_code
    OR NEW.allowed_inventory_kind IS DISTINCT FROM OLD.allowed_inventory_kind
    OR NEW.created_by_command_id IS DISTINCT FROM OLD.created_by_command_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'membership order ownership, product, and price snapshot are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'membership_orders_identity_immutable';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'active membership orders are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'membership_orders_active_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER membership_orders_protect_identity
BEFORE UPDATE ON membership_orders
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_membership_order_identity();

CREATE TABLE membership_payment_facts (
  fact_id text PRIMARY KEY,
  membership_order_id text NOT NULL REFERENCES membership_orders(id),
  fact_type text NOT NULL CHECK (fact_type IN ('COLLECTION', 'REVERSAL')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  net_effect_minor integer NOT NULL,
  currency char(3) NOT NULL,
  transaction_reference text,
  corrects_fact_id text REFERENCES membership_payment_facts(fact_id),
  reverses_fact_id text REFERENCES membership_payment_facts(fact_id),
  note text NOT NULL DEFAULT '',
  command_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX membership_payment_one_reversal_idx
  ON membership_payment_facts (reverses_fact_id)
  WHERE reverses_fact_id IS NOT NULL;

CREATE INDEX membership_payment_order_created_idx
  ON membership_payment_facts (membership_order_id, created_at, fact_id);

CREATE OR REPLACE FUNCTION qintopia_validate_membership_payment_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_currency char(3);
  corrected membership_payment_facts%ROWTYPE;
  reversed membership_payment_facts%ROWTYPE;
BEGIN
  SELECT currency INTO order_currency FROM membership_orders WHERE id = NEW.membership_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership payment requires an existing membership order'
      USING ERRCODE = '23503', CONSTRAINT = 'membership_payment_order_required';
  END IF;
  IF NEW.currency IS DISTINCT FROM order_currency THEN
    RAISE EXCEPTION 'membership payment currency must match its membership order'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_currency_match';
  END IF;

  IF NEW.fact_type = 'COLLECTION' THEN
    IF NEW.net_effect_minor IS DISTINCT FROM NEW.amount_minor
      OR NULLIF(BTRIM(NEW.transaction_reference), '') IS NULL
      OR NEW.reverses_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'membership collection has an invalid shape'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_collection_shape';
    END IF;
    IF NEW.corrects_fact_id IS NOT NULL THEN
      SELECT * INTO corrected FROM membership_payment_facts WHERE fact_id = NEW.corrects_fact_id;
      IF NOT FOUND OR corrected.fact_type <> 'COLLECTION' OR corrected.membership_order_id <> NEW.membership_order_id THEN
        RAISE EXCEPTION 'replacement collection must correct a collection in the same membership order'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_correction_target';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM membership_payment_facts WHERE reverses_fact_id = NEW.corrects_fact_id) THEN
        RAISE EXCEPTION 'replacement collection requires a reversal of the corrected fact'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_correction_reversal_required';
      END IF;
    END IF;
  ELSE
    IF NEW.corrects_fact_id IS NOT NULL OR NEW.reverses_fact_id IS NULL OR NEW.transaction_reference IS NOT NULL THEN
      RAISE EXCEPTION 'membership reversal has an invalid shape'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_reversal_shape';
    END IF;
    SELECT * INTO reversed FROM membership_payment_facts WHERE fact_id = NEW.reverses_fact_id;
    IF NOT FOUND OR reversed.fact_type <> 'COLLECTION' OR reversed.membership_order_id <> NEW.membership_order_id THEN
      RAISE EXCEPTION 'membership reversal must reverse a collection in the same membership order'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_reversal_target';
    END IF;
    IF NEW.amount_minor IS DISTINCT FROM reversed.amount_minor
      OR NEW.net_effect_minor IS DISTINCT FROM -reversed.net_effect_minor
      OR NEW.currency IS DISTINCT FROM reversed.currency THEN
      RAISE EXCEPTION 'membership reversal must negate the original collection'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_reversal_amount';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER membership_payment_validate_insert
BEFORE INSERT ON membership_payment_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_payment_fact();

CREATE TRIGGER membership_payment_facts_append_only
BEFORE UPDATE OR DELETE ON membership_payment_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

ALTER TABLE member_contracts
  ADD COLUMN membership_order_id text UNIQUE REFERENCES membership_orders(id);

ALTER TABLE membership_orders
  ADD CONSTRAINT membership_orders_contract_fk FOREIGN KEY (contract_id) REFERENCES member_contracts(id),
  ADD CONSTRAINT membership_orders_lot_fk FOREIGN KEY (entitlement_lot_id) REFERENCES entitlement_lots(id);
