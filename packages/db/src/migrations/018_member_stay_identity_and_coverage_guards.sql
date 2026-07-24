ALTER TABLE quotes
  ADD COLUMN member_id text REFERENCES members(id);

ALTER TABLE orders
  ADD COLUMN member_id text REFERENCES members(id);

UPDATE quotes AS quote
SET member_id = contract.member_id
FROM member_contracts AS contract
WHERE quote.member_contract_id = contract.id
  AND quote.member_id IS NULL;

UPDATE orders AS booking
SET member_id = contract.member_id
FROM member_contracts AS contract
WHERE booking.member_contract_id = contract.id
  AND booking.member_id IS NULL;

ALTER TABLE member_contracts
  ADD CONSTRAINT member_contracts_member_property_identity_unique
  UNIQUE (id, member_id, property_id);

ALTER TABLE quotes
  ADD CONSTRAINT quotes_member_property_fk
    FOREIGN KEY (member_id, property_id) REFERENCES member_property_links(member_id, property_id),
  ADD CONSTRAINT quotes_member_contract_identity_fk
    FOREIGN KEY (member_contract_id, member_id, property_id)
    REFERENCES member_contracts(id, member_id, property_id);

ALTER TABLE orders
  ADD CONSTRAINT orders_member_property_fk
    FOREIGN KEY (member_id, property_id) REFERENCES member_property_links(member_id, property_id),
  ADD CONSTRAINT orders_member_contract_identity_fk
    FOREIGN KEY (member_contract_id, member_id, property_id)
    REFERENCES member_contracts(id, member_id, property_id);

CREATE INDEX quotes_member_expiry_idx ON quotes (member_id, expires_at) WHERE member_id IS NOT NULL;
CREATE INDEX orders_member_created_idx ON orders (member_id, created_at DESC) WHERE member_id IS NOT NULL;

ALTER TABLE orders
  ADD CONSTRAINT orders_free_member_identity_null CHECK (
    stay_type <> 'FREE' OR (member_id IS NULL AND member_contract_id IS NULL)
  );

CREATE OR REPLACE FUNCTION qintopia_protect_order_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.primary_guest_snapshot IS DISTINCT FROM OLD.primary_guest_snapshot
    OR NEW.booking_channel_code IS DISTINCT FROM OLD.booking_channel_code
    OR NEW.channel_order_reference IS DISTINCT FROM OLD.channel_order_reference
    OR NEW.free_stay_reason IS DISTINCT FROM OLD.free_stay_reason
    OR NEW.pricing_policy_version_id IS DISTINCT FROM OLD.pricing_policy_version_id
    OR NEW.stay_type IS DISTINCT FROM OLD.stay_type
    OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.member_contract_id IS DISTINCT FROM OLD.member_contract_id THEN
    RAISE EXCEPTION 'order identity, guest snapshot, booking channel, free-stay reason, membership, stay type, and locked pricing policy are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_coverage_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_contract_id text;
  lot_unit_kind text;
  lot_expires_on date;
  contract_property_id text;
  contract_member_id text;
  contract_status text;
  contract_valid_from date;
  contract_valid_until date;
  order_property_id text;
  order_member_id text;
  order_contract_id text;
  inventory_property_id text;
  inventory_kind text;
  inventory_room_type_code text;
  held_revision_order_id text;
  held_revision_arrival_date date;
  held_revision_departure_date date;
  membership_order_id text;
  membership_status text;
  membership_room_type_code text;
  membership_inventory_kind text;
  membership_unit_kind text;
BEGIN
  SELECT lot.contract_id, lot.unit_kind, lot.expires_on,
         contract.property_id, contract.member_id, contract.status, contract.valid_from, contract.valid_until
    INTO lot_contract_id, lot_unit_kind, lot_expires_on,
         contract_property_id, contract_member_id, contract_status, contract_valid_from, contract_valid_until
    FROM entitlement_lots AS lot
    JOIN member_contracts AS contract ON contract.id = lot.contract_id
    WHERE lot.id = NEW.lot_id;
  SELECT property_id, member_id, member_contract_id
    INTO order_property_id, order_member_id, order_contract_id
    FROM orders WHERE id = NEW.order_id;
  SELECT property_id, kind, room_type_code
    INTO inventory_property_id, inventory_kind, inventory_room_type_code
    FROM inventory_units WHERE id = NEW.inventory_unit_id;
  SELECT order_id, arrival_date, departure_date
    INTO held_revision_order_id, held_revision_arrival_date, held_revision_departure_date
    FROM pricing_revisions WHERE id = NEW.held_by_revision_id;
  SELECT id, status, allowed_room_type_code, allowed_inventory_kind, entitlement_unit_kind
    INTO membership_order_id, membership_status, membership_room_type_code,
         membership_inventory_kind, membership_unit_kind
    FROM membership_orders
    WHERE entitlement_lot_id = NEW.lot_id
      AND contract_id = NEW.contract_id;

  IF lot_contract_id IS NULL OR order_property_id IS NULL OR inventory_property_id IS NULL OR held_revision_order_id IS NULL THEN
    RAISE EXCEPTION 'coverage requires existing lot, order, inventory, and pricing revision'
      USING ERRCODE = '23503', CONSTRAINT = 'coverage_items_owners_required';
  END IF;
  IF NEW.contract_id IS DISTINCT FROM lot_contract_id
    OR order_property_id IS DISTINCT FROM contract_property_id
    OR inventory_property_id IS DISTINCT FROM contract_property_id THEN
    RAISE EXCEPTION 'coverage lot, contract, order, and inventory must share ownership'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_owner_match';
  END IF;
  IF NEW.unit_kind IS DISTINCT FROM lot_unit_kind
    OR NEW.unit_kind IS DISTINCT FROM (CASE inventory_kind WHEN 'ROOM' THEN 'ROOM_NIGHT' ELSE 'BED_NIGHT' END) THEN
    RAISE EXCEPTION 'coverage entitlement kind must match its lot and inventory unit'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_unit_kind_match';
  END IF;
  IF held_revision_order_id IS DISTINCT FROM NEW.order_id
    OR NEW.service_date < held_revision_arrival_date
    OR NEW.service_date >= held_revision_departure_date THEN
    RAISE EXCEPTION 'coverage must belong to the holding pricing revision and its stay dates'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_revision_match';
  END IF;
  IF contract_status IS DISTINCT FROM 'ACTIVE'
    OR NEW.service_date < contract_valid_from
    OR NEW.service_date > contract_valid_until
    OR NEW.service_date > lot_expires_on THEN
    RAISE EXCEPTION 'coverage requires active entitlement valid for the service date'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_entitlement_valid';
  END IF;
  IF order_member_id IS NOT NULL AND contract_member_id IS DISTINCT FROM order_member_id THEN
    RAISE EXCEPTION 'coverage contract must belong to the order member'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_order_member_match';
  END IF;
  IF order_member_id IS NULL AND order_contract_id IS DISTINCT FROM NEW.contract_id THEN
    RAISE EXCEPTION 'legacy coverage contract must match the order contract'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_legacy_order_contract_match';
  END IF;
  IF order_member_id IS NOT NULL AND membership_order_id IS NOT NULL AND (
    membership_status IS DISTINCT FROM 'ACTIVE'
    OR membership_room_type_code IS DISTINCT FROM inventory_room_type_code
    OR membership_inventory_kind IS DISTINCT FROM inventory_kind
    OR membership_unit_kind IS DISTINCT FROM NEW.unit_kind
  ) THEN
    RAISE EXCEPTION 'coverage inventory must match the active membership product'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_membership_product_match';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM coverage_items AS coverage
    LEFT JOIN orders AS booking ON booking.id = coverage.order_id
    LEFT JOIN entitlement_lots AS lot ON lot.id = coverage.lot_id
    LEFT JOIN member_contracts AS contract ON contract.id = lot.contract_id
    LEFT JOIN inventory_units AS inventory ON inventory.id = coverage.inventory_unit_id
    LEFT JOIN pricing_revisions AS revision ON revision.id = coverage.held_by_revision_id
    LEFT JOIN membership_orders AS membership
      ON membership.entitlement_lot_id = coverage.lot_id
      AND membership.contract_id = coverage.contract_id
    WHERE booking.id IS NULL OR lot.id IS NULL OR contract.id IS NULL OR inventory.id IS NULL OR revision.id IS NULL
      OR coverage.contract_id IS DISTINCT FROM lot.contract_id
      OR booking.property_id IS DISTINCT FROM contract.property_id
      OR inventory.property_id IS DISTINCT FROM contract.property_id
      OR coverage.unit_kind IS DISTINCT FROM lot.unit_kind
      OR coverage.unit_kind IS DISTINCT FROM (CASE inventory.kind WHEN 'ROOM' THEN 'ROOM_NIGHT' ELSE 'BED_NIGHT' END)
      OR revision.order_id IS DISTINCT FROM coverage.order_id
      OR coverage.service_date < revision.arrival_date
      OR coverage.service_date >= revision.departure_date
      OR contract.status IS DISTINCT FROM 'ACTIVE'
      OR coverage.service_date < contract.valid_from
      OR coverage.service_date > contract.valid_until
      OR coverage.service_date > lot.expires_on
      OR (booking.member_id IS NOT NULL AND contract.member_id IS DISTINCT FROM booking.member_id)
      OR (booking.member_id IS NULL AND booking.member_contract_id IS DISTINCT FROM coverage.contract_id)
      OR (booking.member_id IS NOT NULL AND membership.id IS NOT NULL AND (
        membership.status IS DISTINCT FROM 'ACTIVE'
        OR membership.allowed_room_type_code IS DISTINCT FROM inventory.room_type_code
        OR membership.allowed_inventory_kind IS DISTINCT FROM inventory.kind
        OR membership.entitlement_unit_kind IS DISTINCT FROM coverage.unit_kind
      ))
  ) THEN
    RAISE EXCEPTION 'existing coverage violates member-stay ownership, product, validity, or revision invariants'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TRIGGER coverage_items_validate_ownership
BEFORE INSERT ON coverage_items
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_coverage_ownership();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM entitlement_ledger AS ledger
    LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
    WHERE ledger.entry_type IN ('HOLD', 'RELEASE', 'CONSUME')
      AND (
        coverage.id IS NULL
        OR ledger.lot_id IS DISTINCT FROM coverage.lot_id
        OR ledger.order_id IS DISTINCT FROM coverage.order_id
        OR ledger.service_date IS DISTINCT FROM coverage.service_date
        OR (ledger.entry_type = 'HOLD' AND ledger.quantity_delta <> -1)
        OR (ledger.entry_type = 'RELEASE' AND ledger.quantity_delta <> 1)
        OR (ledger.entry_type = 'CONSUME' AND ledger.quantity_delta <> 0)
      )
  ) OR EXISTS (
    SELECT 1
    FROM coverage_items AS coverage
    LEFT JOIN entitlement_ledger AS ledger
      ON ledger.coverage_id = coverage.id
      AND ledger.entry_type IN ('HOLD', 'RELEASE', 'CONSUME')
    GROUP BY coverage.id, coverage.status
    HAVING count(*) FILTER (WHERE ledger.entry_type = 'HOLD') <> 1
      OR count(*) FILTER (WHERE ledger.entry_type IN ('RELEASE', 'CONSUME')) <> CASE WHEN coverage.status = 'HELD' THEN 0 ELSE 1 END
      OR count(*) FILTER (WHERE ledger.entry_type = 'RELEASE') <> CASE WHEN coverage.status = 'RELEASED' THEN 1 ELSE 0 END
      OR count(*) FILTER (WHERE ledger.entry_type = 'CONSUME') <> CASE WHEN coverage.status = 'CONSUMED' THEN 1 ELSE 0 END
  ) THEN
    RAISE EXCEPTION 'existing entitlement lifecycle facts violate coverage conservation invariants'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE UNIQUE INDEX entitlement_ledger_one_hold_per_coverage_idx
  ON entitlement_ledger (coverage_id)
  WHERE entry_type = 'HOLD';

CREATE UNIQUE INDEX entitlement_ledger_one_terminal_per_coverage_idx
  ON entitlement_ledger (coverage_id)
  WHERE entry_type IN ('RELEASE', 'CONSUME');

CREATE OR REPLACE FUNCTION qintopia_validate_entitlement_lifecycle_fact() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  coverage_lot_id text;
  coverage_order_id text;
  coverage_service_date date;
  coverage_status text;
BEGIN
  IF NEW.entry_type NOT IN ('HOLD', 'RELEASE', 'CONSUME') THEN
    RETURN NEW;
  END IF;
  SELECT lot_id, order_id, service_date, status
    INTO coverage_lot_id, coverage_order_id, coverage_service_date, coverage_status
    FROM coverage_items WHERE id = NEW.coverage_id;
  IF coverage_lot_id IS NULL
    OR NEW.lot_id IS DISTINCT FROM coverage_lot_id
    OR NEW.order_id IS DISTINCT FROM coverage_order_id
    OR NEW.service_date IS DISTINCT FROM coverage_service_date THEN
    RAISE EXCEPTION 'entitlement lifecycle fact must match its coverage identity'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_coverage_match';
  END IF;
  IF (NEW.entry_type = 'HOLD' AND NEW.quantity_delta <> -1)
    OR (NEW.entry_type = 'RELEASE' AND NEW.quantity_delta <> 1)
    OR (NEW.entry_type = 'CONSUME' AND NEW.quantity_delta <> 0) THEN
    RAISE EXCEPTION 'entitlement lifecycle fact has an invalid quantity delta'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_lifecycle_delta';
  END IF;
  IF (NEW.entry_type = 'HOLD' AND coverage_status IS DISTINCT FROM 'HELD')
    OR (NEW.entry_type = 'RELEASE' AND coverage_status IS DISTINCT FROM 'RELEASED')
    OR (NEW.entry_type = 'CONSUME' AND coverage_status IS DISTINCT FROM 'CONSUMED') THEN
    RAISE EXCEPTION 'entitlement lifecycle fact must match the current coverage status'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_lifecycle_status';
  END IF;
  IF NEW.entry_type IN ('RELEASE', 'CONSUME') AND NOT EXISTS (
    SELECT 1 FROM entitlement_ledger
    WHERE coverage_id = NEW.coverage_id AND entry_type = 'HOLD'
  ) THEN
    RAISE EXCEPTION 'terminal entitlement lifecycle fact requires its original hold'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_terminal_requires_hold';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entitlement_ledger_validate_lifecycle_fact
BEFORE INSERT ON entitlement_ledger
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_entitlement_lifecycle_fact();

CREATE OR REPLACE FUNCTION qintopia_validate_coverage_lifecycle_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  hold_count integer;
  release_count integer;
  consume_count integer;
  current_status text;
BEGIN
  SELECT status INTO current_status
    FROM coverage_items
    WHERE id = NEW.id;
  SELECT
    count(*) FILTER (WHERE entry_type = 'HOLD'),
    count(*) FILTER (WHERE entry_type = 'RELEASE'),
    count(*) FILTER (WHERE entry_type = 'CONSUME')
    INTO hold_count, release_count, consume_count
    FROM entitlement_ledger
    WHERE coverage_id = NEW.id;

  IF hold_count <> 1
    OR release_count <> (CASE WHEN current_status = 'RELEASED' THEN 1 ELSE 0 END)
    OR consume_count <> (CASE WHEN current_status = 'CONSUMED' THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'coverage status and entitlement lifecycle facts must remain conserved'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_lifecycle_conserved';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER coverage_items_validate_lifecycle_state
AFTER INSERT OR UPDATE OF status ON coverage_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_coverage_lifecycle_state();
