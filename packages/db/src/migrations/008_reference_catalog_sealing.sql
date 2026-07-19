DROP TRIGGER catalog_import_batches_append_only ON catalog_import_batches;

ALTER TABLE catalog_import_batches
  ADD COLUMN sealed_at timestamptz;

UPDATE catalog_import_batches
SET sealed_at = created_at
WHERE sealed_at IS NULL;

CREATE OR REPLACE FUNCTION qintopia_protect_catalog_batch_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.sealed_at IS NULL
      AND NEW.sealed_at IS NOT NULL
      AND NEW.sealed_at >= OLD.created_at
      AND NEW.id IS NOT DISTINCT FROM OLD.id
      AND NEW.property_id IS NOT DISTINCT FROM OLD.property_id
      AND NEW.source_document_token IS NOT DISTINCT FROM OLD.source_document_token
      AND NEW.source_revision IS NOT DISTINCT FROM OLD.source_revision
      AND NEW.source_version_date IS NOT DISTINCT FROM OLD.source_version_date
      AND NEW.source_snapshot IS NOT DISTINCT FROM OLD.source_snapshot
      AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
      AND NEW.execution_state IS NOT DISTINCT FROM OLD.execution_state
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'catalog_import_batches is append-only except for one-way sealing' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER catalog_import_batches_append_only
BEFORE UPDATE OR DELETE ON catalog_import_batches
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_catalog_batch_mutation();

CREATE OR REPLACE FUNCTION qintopia_require_unsealed_catalog_batch_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'catalog import batches must be inserted unsealed' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER catalog_import_batches_require_unsealed_insert
BEFORE INSERT ON catalog_import_batches
FOR EACH ROW EXECUTE FUNCTION qintopia_require_unsealed_catalog_batch_insert();

CREATE OR REPLACE FUNCTION qintopia_require_open_catalog_batch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
  FROM catalog_import_batches
  WHERE id = NEW.import_batch_id
    AND sealed_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog import batch % is sealed or missing', NEW.import_batch_id USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_catalog_entries_require_open_batch
BEFORE INSERT ON inventory_catalog_entries
FOR EACH ROW EXECUTE FUNCTION qintopia_require_open_catalog_batch();

CREATE TRIGGER reference_rate_entries_require_open_batch
BEFORE INSERT ON reference_rate_entries
FOR EACH ROW EXECUTE FUNCTION qintopia_require_open_catalog_batch();

CREATE TRIGGER reference_membership_products_require_open_batch
BEFORE INSERT ON reference_membership_products
FOR EACH ROW EXECUTE FUNCTION qintopia_require_open_catalog_batch();
