CREATE TABLE catalog_import_batches (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  source_document_token text NOT NULL CHECK (btrim(source_document_token) <> ''),
  source_revision integer NOT NULL CHECK (source_revision >= 0),
  source_version_date date,
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  execution_state text NOT NULL DEFAULT 'REFERENCE_ONLY' CHECK (execution_state = 'REFERENCE_ONLY'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, source_document_token, content_hash)
);

CREATE TABLE inventory_catalog_entries (
  id text PRIMARY KEY,
  import_batch_id text NOT NULL REFERENCES catalog_import_batches(id),
  type_code text NOT NULL CHECK (btrim(type_code) <> ''),
  type_name text NOT NULL CHECK (btrim(type_name) <> ''),
  bathroom_type text NOT NULL CHECK (bathroom_type IN ('SHARED', 'ENSUITE')),
  sell_unit_kind text NOT NULL CHECK (sell_unit_kind IN ('ROOM', 'BED')),
  physical_room_count integer NOT NULL CHECK (physical_room_count > 0),
  units_per_room integer,
  sellable_unit_count integer NOT NULL CHECK (sellable_unit_count > 0),
  electricity_included boolean NOT NULL,
  execution_state text NOT NULL DEFAULT 'REFERENCE_ONLY' CHECK (execution_state = 'REFERENCE_ONLY'),
  source_sheet text NOT NULL CHECK (btrim(source_sheet) <> ''),
  source_range text NOT NULL CHECK (btrim(source_range) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_batch_id, type_code),
  UNIQUE (id, import_batch_id),
  CHECK (
    (sell_unit_kind = 'ROOM' AND units_per_room IS NULL AND sellable_unit_count = physical_room_count)
    OR
    (sell_unit_kind = 'BED' AND units_per_room > 0 AND sellable_unit_count = physical_room_count * units_per_room)
  )
);

CREATE TABLE reference_rate_entries (
  id text PRIMARY KEY,
  import_batch_id text NOT NULL REFERENCES catalog_import_batches(id),
  inventory_catalog_entry_id text NOT NULL,
  package_nights integer NOT NULL CHECK (package_nights IN (1, 7, 14, 30)),
  package_amount_minor integer NOT NULL CHECK (package_amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  execution_state text NOT NULL DEFAULT 'REFERENCE_ONLY' CHECK (execution_state = 'REFERENCE_ONLY'),
  source_sheet text NOT NULL CHECK (btrim(source_sheet) <> ''),
  source_range text NOT NULL CHECK (btrim(source_range) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_batch_id, inventory_catalog_entry_id, package_nights),
  FOREIGN KEY (inventory_catalog_entry_id, import_batch_id)
    REFERENCES inventory_catalog_entries(id, import_batch_id)
);

CREATE TABLE reference_membership_products (
  id text PRIMARY KEY,
  import_batch_id text NOT NULL REFERENCES catalog_import_batches(id),
  inventory_catalog_entry_id text NOT NULL,
  product_code text NOT NULL CHECK (btrim(product_code) <> ''),
  product_name text NOT NULL CHECK (btrim(product_name) <> ''),
  price_minor integer NOT NULL CHECK (price_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  sales_limit integer NOT NULL CHECK (sales_limit > 0),
  entitlement_nights integer NOT NULL CHECK (entitlement_nights > 0),
  validity_period text NOT NULL CHECK (btrim(validity_period) <> ''),
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  execution_state text NOT NULL DEFAULT 'REFERENCE_ONLY' CHECK (execution_state = 'REFERENCE_ONLY'),
  source_sheet text NOT NULL CHECK (btrim(source_sheet) <> ''),
  source_range text NOT NULL CHECK (btrim(source_range) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_batch_id, product_code),
  FOREIGN KEY (inventory_catalog_entry_id, import_batch_id)
    REFERENCES inventory_catalog_entries(id, import_batch_id)
);

CREATE INDEX catalog_import_batches_property_created_idx
  ON catalog_import_batches (property_id, created_at DESC);

CREATE INDEX inventory_catalog_entries_batch_idx
  ON inventory_catalog_entries (import_batch_id, type_code);

CREATE INDEX reference_rate_entries_batch_idx
  ON reference_rate_entries (import_batch_id, inventory_catalog_entry_id);

CREATE INDEX reference_membership_products_batch_idx
  ON reference_membership_products (import_batch_id, inventory_catalog_entry_id);

CREATE TRIGGER catalog_import_batches_append_only
BEFORE UPDATE OR DELETE ON catalog_import_batches
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE TRIGGER inventory_catalog_entries_append_only
BEFORE UPDATE OR DELETE ON inventory_catalog_entries
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE TRIGGER reference_rate_entries_append_only
BEFORE UPDATE OR DELETE ON reference_rate_entries
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE TRIGGER reference_membership_products_append_only
BEFORE UPDATE OR DELETE ON reference_membership_products
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
