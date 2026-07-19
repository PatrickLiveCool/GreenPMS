ALTER TABLE inventory_units
  ADD COLUMN catalog_version text,
  ADD COLUMN building_code text,
  ADD COLUMN room_type_code text,
  ADD COLUMN pricing_product_code text,
  ADD COLUMN inventory_basis text,
  ADD COLUMN code_provenance text,
  ADD COLUMN physical_bed_count integer,
  ADD CONSTRAINT inventory_units_inventory_basis_known CHECK (
    inventory_basis IS NULL OR inventory_basis IN ('INDEPENDENT', 'WHOLE_ROOM_COMBINATION')
  ),
  ADD CONSTRAINT inventory_units_code_provenance_known CHECK (
    code_provenance IS NULL OR code_provenance IN ('SOURCE_EXPLICIT', 'USER_CONFIRMED_RENAMED', 'PMS_GENERATED')
  ),
  ADD CONSTRAINT inventory_units_physical_bed_count_shape CHECK (
    (kind = 'ROOM' AND (physical_bed_count IS NULL OR physical_bed_count IN (1, 2, 4)))
    OR (kind = 'BED' AND physical_bed_count IS NULL)
  );

CREATE OR REPLACE FUNCTION qintopia_protect_inventory_unit_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory unit identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.parent_room_id IS DISTINCT FROM OLD.parent_room_id
    OR NEW.catalog_version IS DISTINCT FROM OLD.catalog_version
    OR NEW.building_code IS DISTINCT FROM OLD.building_code
    OR NEW.room_type_code IS DISTINCT FROM OLD.room_type_code
    OR NEW.pricing_product_code IS DISTINCT FROM OLD.pricing_product_code
    OR NEW.inventory_basis IS DISTINCT FROM OLD.inventory_basis
    OR NEW.code_provenance IS DISTINCT FROM OLD.code_provenance
    OR NEW.physical_bed_count IS DISTINCT FROM OLD.physical_bed_count
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'inventory unit property, hierarchy, catalog identity, and pricing product are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE pricing_policy_versions
  DROP CONSTRAINT pricing_policy_versions_calculation_kind_check,
  DROP CONSTRAINT pricing_policy_versions_nightly_rate_minor_check,
  DROP CONSTRAINT pricing_policy_versions_check,
  ALTER COLUMN stay_type DROP NOT NULL,
  ALTER COLUMN nightly_rate_minor DROP NOT NULL,
  ADD COLUMN product_anchor_rates_minor jsonb,
  ADD COLUMN effective_from date,
  ADD COLUMN effective_until date,
  ADD COLUMN rounding_rule text,
  ADD CONSTRAINT pricing_policy_versions_calculation_kind_check CHECK (
    calculation_kind IN ('FLAT_NIGHTLY', 'DURATION_BAND_TOTAL', 'FREE')
  ),
  ADD CONSTRAINT pricing_policy_versions_effective_interval_check CHECK (
    effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from
  ),
  ADD CONSTRAINT pricing_policy_versions_shape_check CHECK (
    (
      calculation_kind = 'FREE'
      AND stay_type = 'FREE'
      AND nightly_rate_minor = 0
      AND product_anchor_rates_minor IS NULL
      AND rounding_rule IS NULL
    )
    OR
    (
      calculation_kind = 'FLAT_NIGHTLY'
      AND stay_type IS NOT NULL
      AND nightly_rate_minor >= 0
      AND product_anchor_rates_minor IS NULL
      AND rounding_rule IS NULL
    )
    OR
    (
      calculation_kind = 'DURATION_BAND_TOTAL'
      AND stay_type IS NULL
      AND nightly_rate_minor IS NULL
      AND jsonb_typeof(product_anchor_rates_minor) = 'object'
      AND product_anchor_rates_minor <> '{}'::jsonb
      AND effective_from IS NOT NULL
      AND rounding_rule = 'FINAL_TOTAL_WHOLE_YUAN_HALF_UP'
    )
  );

CREATE TABLE members (
  id text PRIMARY KEY,
  identity_card_number text NOT NULL UNIQUE,
  full_name text NOT NULL,
  phone text NOT NULL,
  wechat text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT members_identity_card_number_nonblank CHECK (identity_card_number !~ '^[[:space:]]*$'),
  CONSTRAINT members_full_name_nonblank CHECK (full_name !~ '^[[:space:]]*$'),
  CONSTRAINT members_phone_nonblank CHECK (phone !~ '^[[:space:]]*$'),
  CONSTRAINT members_wechat_nonblank CHECK (wechat !~ '^[[:space:]]*$')
);

CREATE OR REPLACE FUNCTION qintopia_normalize_new_member_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.identity_card_number := upper(btrim(NEW.identity_card_number));
  RETURN NEW;
END;
$$;

CREATE TRIGGER members_normalize_new_identity
BEFORE INSERT ON members
FOR EACH ROW EXECUTE FUNCTION qintopia_normalize_new_member_identity();

CREATE OR REPLACE FUNCTION qintopia_protect_member_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'member identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.identity_card_number IS DISTINCT FROM OLD.identity_card_number
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'member identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER members_protect_identity
BEFORE UPDATE OR DELETE ON members
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_member_identity();

CREATE TABLE member_external_references (
  id text PRIMARY KEY,
  member_id text NOT NULL REFERENCES members(id),
  property_id text NOT NULL REFERENCES properties(id),
  provider text NOT NULL CHECK (provider = 'FEISHU_BASE'),
  source_container_id text NOT NULL,
  source_table_id text NOT NULL,
  external_record_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_external_references_source_container_nonblank CHECK (source_container_id !~ '^[[:space:]]*$'),
  CONSTRAINT member_external_references_source_table_nonblank CHECK (source_table_id !~ '^[[:space:]]*$'),
  CONSTRAINT member_external_references_record_nonblank CHECK (external_record_id !~ '^[[:space:]]*$'),
  CONSTRAINT member_external_references_source_key UNIQUE (provider, source_container_id, source_table_id, external_record_id)
);

CREATE TRIGGER member_external_references_append_only
BEFORE UPDATE OR DELETE ON member_external_references
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

ALTER TABLE member_contracts
  ADD COLUMN member_id text REFERENCES members(id);

CREATE INDEX member_contracts_member_id_idx ON member_contracts (member_id);

CREATE OR REPLACE FUNCTION qintopia_validate_new_member_contract() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id IS NULL THEN
    RAISE EXCEPTION 'new member contracts require a member profile'
      USING ERRCODE = '23514', CONSTRAINT = 'member_contracts_new_member_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER member_contracts_validate_new_member
BEFORE INSERT ON member_contracts
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_member_contract();

ALTER TABLE orders
  ADD COLUMN free_stay_reason text,
  ADD CONSTRAINT orders_free_stay_reason_nonblank CHECK (
    free_stay_reason IS NULL OR free_stay_reason !~ '^[[:space:]]*$'
  );

CREATE OR REPLACE FUNCTION qintopia_validate_new_order_free_reason() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.free_stay_reason := NULLIF(
    regexp_replace(btrim(NEW.free_stay_reason), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  IF NEW.stay_type = 'FREE' AND NEW.free_stay_reason IS NULL THEN
    RAISE EXCEPTION 'new free stays require a reason'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_free_stay_reason_required';
  END IF;
  IF NEW.stay_type <> 'FREE' AND NEW.free_stay_reason IS NOT NULL THEN
    RAISE EXCEPTION 'only free stays may store a free stay reason'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_nonfree_stay_reason_null';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_validate_new_free_reason
BEFORE INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_order_free_reason();

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
    OR NEW.member_contract_id IS DISTINCT FROM OLD.member_contract_id THEN
    RAISE EXCEPTION 'order identity, guest snapshot, booking channel, free-stay reason, membership, stay type, and locked pricing policy are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
