CREATE OR REPLACE FUNCTION qintopia_validate_inventory_unit_hierarchy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_kind text;
  parent_property_id text;
BEGIN
  IF NEW.kind = 'BED' THEN
    SELECT kind, property_id
      INTO parent_kind, parent_property_id
      FROM inventory_units
      WHERE id = NEW.parent_room_id;

    IF parent_kind IS DISTINCT FROM 'ROOM' OR parent_property_id IS DISTINCT FROM NEW.property_id THEN
      RAISE EXCEPTION 'a BED parent must be a ROOM in the same property'
        USING ERRCODE = '23514', CONSTRAINT = 'inventory_units_bed_parent_room_same_property';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

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
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'inventory unit property, kind, and parent identity are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory_units child
    LEFT JOIN inventory_units parent ON parent.id = child.parent_room_id
    WHERE child.kind = 'BED'
      AND (parent.id IS NULL OR parent.kind <> 'ROOM' OR parent.property_id <> child.property_id)
  ) THEN
    RAISE EXCEPTION 'existing BED parent is not a ROOM in the same property' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_units_validate_hierarchy
AFTER INSERT OR UPDATE ON inventory_units
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_inventory_unit_hierarchy();

CREATE TRIGGER inventory_units_protect_identity
BEFORE UPDATE OR DELETE ON inventory_units
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_inventory_unit_identity();

CREATE OR REPLACE FUNCTION qintopia_protect_coverage_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'HELD' THEN
      RAISE EXCEPTION 'coverage must be created in HELD status' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'coverage identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
    OR NEW.lot_id IS DISTINCT FROM OLD.lot_id
    OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
    OR NEW.service_date IS DISTINCT FROM OLD.service_date
    OR NEW.unit_kind IS DISTINCT FROM OLD.unit_kind
    OR NEW.held_by_revision_id IS DISTINCT FROM OLD.held_by_revision_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'coverage identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'HELD' AND NEW.status IN ('RELEASED', 'CONSUMED') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'coverage status may only advance from HELD to RELEASED or CONSUMED' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER coverage_items_protect_identity
BEFORE INSERT OR UPDATE OR DELETE ON coverage_items
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_coverage_identity();

ALTER TABLE api_tokens
  ADD CONSTRAINT api_tokens_rotation_not_self CHECK (
    (rotated_from_id IS NULL OR rotated_from_id <> id)
    AND (replaced_by_id IS NULL OR replaced_by_id <> id)
    AND (rotated_from_id IS NULL OR replaced_by_id IS NULL OR rotated_from_id <> replaced_by_id)
  ),
  ADD CONSTRAINT api_tokens_replacement_requires_revocation CHECK (
    replaced_by_id IS NULL OR revoked_at IS NOT NULL
  );

CREATE UNIQUE INDEX api_tokens_one_successor_per_source_idx
  ON api_tokens (rotated_from_id)
  WHERE rotated_from_id IS NOT NULL;

CREATE UNIQUE INDEX api_tokens_one_source_per_successor_idx
  ON api_tokens (replaced_by_id)
  WHERE replaced_by_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM api_tokens token
    LEFT JOIN api_tokens source ON source.id = token.rotated_from_id
    LEFT JOIN api_tokens successor ON successor.id = token.replaced_by_id
    WHERE (token.rotated_from_id IS NOT NULL AND (
      source.id IS NULL
      OR source.replaced_by_id IS DISTINCT FROM token.id
      OR source.revoked_at IS NULL
      OR source.subject_id IS DISTINCT FROM token.subject_id
      OR source.property_scope IS DISTINCT FROM token.property_scope
    )) OR (token.replaced_by_id IS NOT NULL AND (
      successor.id IS NULL
      OR successor.rotated_from_id IS DISTINCT FROM token.id
      OR successor.subject_id IS DISTINCT FROM token.subject_id
      OR successor.property_scope IS DISTINCT FROM token.property_scope
    ))
  ) THEN
    RAISE EXCEPTION 'existing API Token rotation chain is inconsistent' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_api_token_rotation_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_token api_tokens%ROWTYPE;
  source_token api_tokens%ROWTYPE;
  successor_token api_tokens%ROWTYPE;
  has_cycle boolean;
BEGIN
  SELECT * INTO current_token FROM api_tokens WHERE id = NEW.id;
  IF current_token.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF current_token.rotated_from_id IS NOT NULL THEN
    SELECT * INTO source_token FROM api_tokens WHERE id = current_token.rotated_from_id;
    IF source_token.id IS NULL
      OR source_token.replaced_by_id IS DISTINCT FROM current_token.id
      OR source_token.revoked_at IS NULL
      OR source_token.subject_id IS DISTINCT FROM current_token.subject_id
      OR source_token.property_scope IS DISTINCT FROM current_token.property_scope THEN
      RAISE EXCEPTION 'rotated_from and replaced_by must be reciprocal for the same subject and property'
        USING ERRCODE = '23514', CONSTRAINT = 'api_tokens_rotation_chain_consistent';
    END IF;
  END IF;

  IF current_token.replaced_by_id IS NOT NULL THEN
    SELECT * INTO successor_token FROM api_tokens WHERE id = current_token.replaced_by_id;
    IF successor_token.id IS NULL
      OR successor_token.rotated_from_id IS DISTINCT FROM current_token.id
      OR successor_token.subject_id IS DISTINCT FROM current_token.subject_id
      OR successor_token.property_scope IS DISTINCT FROM current_token.property_scope THEN
      RAISE EXCEPTION 'replaced_by and rotated_from must be reciprocal for the same subject and property'
        USING ERRCODE = '23514', CONSTRAINT = 'api_tokens_rotation_chain_consistent';
    END IF;
  END IF;

  WITH RECURSIVE successors(id, path) AS (
    SELECT current_token.replaced_by_id, ARRAY[current_token.id]
    UNION ALL
    SELECT token.replaced_by_id, successors.path || successors.id
    FROM successors
    JOIN api_tokens token ON token.id = successors.id
    WHERE successors.id <> ALL(successors.path)
  )
  SELECT EXISTS (SELECT 1 FROM successors WHERE id = current_token.id) INTO has_cycle;

  IF has_cycle THEN
    RAISE EXCEPTION 'API Token rotation chain cannot contain a cycle'
      USING ERRCODE = '23514', CONSTRAINT = 'api_tokens_rotation_chain_acyclic';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER api_tokens_validate_rotation_chain
AFTER INSERT OR UPDATE ON api_tokens
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_api_token_rotation_chain();

ALTER TABLE quotes
  ADD COLUMN requester_subject_id text REFERENCES subjects(id);

CREATE INDEX quotes_requester_expiry_idx
  ON quotes (requester_subject_id, expires_at)
  WHERE requester_subject_id IS NOT NULL;
