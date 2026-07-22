CREATE TABLE room_status_revisions (
  property_id text PRIMARY KEY REFERENCES properties(id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO room_status_revisions (property_id, revision)
SELECT id, 0 FROM properties
ON CONFLICT (property_id) DO NOTHING;

CREATE TABLE internal_use_blocks (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  room_id text NOT NULL REFERENCES inventory_units(id),
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  released_by_command_id text UNIQUE REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT internal_use_blocks_dates_valid CHECK (departure_date > arrival_date),
  CONSTRAINT internal_use_blocks_reason_nonblank CHECK (reason !~ '^[[:space:]]*$'),
  CONSTRAINT internal_use_blocks_release_shape CHECK (
    (status = 'ACTIVE' AND released_at IS NULL AND released_by_command_id IS NULL)
    OR (status = 'RELEASED' AND released_at IS NOT NULL AND released_by_command_id IS NOT NULL)
  )
);

CREATE TABLE cleaning_tasks (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  order_id text NOT NULL UNIQUE REFERENCES orders(id),
  stay_id text NOT NULL REFERENCES stays(id),
  inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  room_id text NOT NULL REFERENCES inventory_units(id),
  service_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  completed_by_command_id text UNIQUE REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT cleaning_tasks_completion_shape CHECK (
    (status = 'PENDING' AND completed_at IS NULL AND completed_by_command_id IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND completed_by_command_id IS NOT NULL)
  )
);

ALTER TABLE amendments ADD COLUMN command_id text REFERENCES command_executions(id);

ALTER TABLE maintenance_locks
  ADD COLUMN created_by_command_id text UNIQUE REFERENCES command_executions(id),
  ADD COLUMN released_by_command_id text UNIQUE REFERENCES command_executions(id);

CREATE OR REPLACE FUNCTION qintopia_reject_append_only_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and cannot be deleted', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER maintenance_locks_reject_delete
BEFORE DELETE ON maintenance_locks
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_append_only_delete();

CREATE OR REPLACE FUNCTION qintopia_validate_maintenance_lock_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
    OR NEW.arrival_date IS DISTINCT FROM OLD.arrival_date
    OR NEW.departure_date IS DISTINCT FROM OLD.departure_date
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.created_by_command_id IS DISTINCT FROM OLD.created_by_command_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'maintenance lock identity and interval are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'RELEASED' OR NEW.version <> OLD.version + 1
    OR NEW.released_at IS NULL OR NEW.released_by_command_id IS NULL THEN
    RAISE EXCEPTION 'maintenance lock only supports one complete release' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM inventory_claims
    WHERE source_type = 'MAINTENANCE' AND source_id = OLD.id AND active IS TRUE
  ) THEN
    RAISE EXCEPTION 'maintenance lock cannot be released while active inventory Claims remain'
      USING ERRCODE = '23514', CONSTRAINT = 'maintenance_locks_active_claims_released';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER maintenance_locks_validate_update
BEFORE UPDATE ON maintenance_locks
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_maintenance_lock_update();

ALTER TABLE inventory_claims DROP CONSTRAINT inventory_claims_source_type_check;
ALTER TABLE inventory_claims ADD CONSTRAINT inventory_claims_source_type_check
  CHECK (source_type IN ('ORDER_SEGMENT', 'MAINTENANCE', 'INTERNAL_USE'));

CREATE OR REPLACE FUNCTION qintopia_validate_internal_use_block() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit_property_id text;
  expected_room_id text;
BEGIN
  SELECT property_id, CASE WHEN kind = 'ROOM' THEN id ELSE parent_room_id END
  INTO unit_property_id, expected_room_id
  FROM inventory_units WHERE id = NEW.inventory_unit_id;
  IF unit_property_id IS NULL
    OR unit_property_id <> NEW.property_id
    OR expected_room_id IS NULL
    OR expected_room_id <> NEW.room_id THEN
    RAISE EXCEPTION 'internal-use Block inventory identity is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'internal_use_blocks_inventory_identity_valid';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.property_id IS DISTINCT FROM OLD.property_id
      OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
      OR NEW.room_id IS DISTINCT FROM OLD.room_id
      OR NEW.arrival_date IS DISTINCT FROM OLD.arrival_date
      OR NEW.departure_date IS DISTINCT FROM OLD.departure_date
      OR NEW.reason IS DISTINCT FROM OLD.reason
      OR NEW.created_by_command_id IS DISTINCT FROM OLD.created_by_command_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'internal-use Block identity and interval are immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.status <> 'ACTIVE' OR NEW.status <> 'RELEASED' OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'internal-use Block only supports one complete release' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM inventory_claims
      WHERE source_type = 'INTERNAL_USE' AND source_id = OLD.id AND active IS TRUE
    ) THEN
      RAISE EXCEPTION 'internal-use Block cannot be released while active inventory Claims remain'
        USING ERRCODE = '23514', CONSTRAINT = 'internal_use_blocks_active_claims_released';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER internal_use_blocks_validate
BEFORE INSERT OR UPDATE ON internal_use_blocks
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_internal_use_block();

CREATE TRIGGER internal_use_blocks_reject_delete
BEFORE DELETE ON internal_use_blocks
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_append_only_delete();

CREATE OR REPLACE FUNCTION qintopia_validate_cleaning_task() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit_property_id text;
  expected_room_id text;
  order_property_id text;
  stay_order_id text;
BEGIN
  SELECT property_id, CASE WHEN kind = 'ROOM' THEN id ELSE parent_room_id END
  INTO unit_property_id, expected_room_id
  FROM inventory_units WHERE id = NEW.inventory_unit_id;
  SELECT property_id INTO order_property_id FROM orders WHERE id = NEW.order_id;
  SELECT order_id INTO stay_order_id FROM stays WHERE id = NEW.stay_id;
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
    OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
    OR NEW.room_id IS DISTINCT FROM OLD.room_id
    OR NEW.service_date IS DISTINCT FROM OLD.service_date
    OR NEW.created_by_command_id IS DISTINCT FROM OLD.created_by_command_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'cleaning task identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF unit_property_id IS NULL
    OR unit_property_id <> NEW.property_id
    OR expected_room_id IS NULL
    OR expected_room_id <> NEW.room_id
    OR order_property_id IS NULL
    OR order_property_id <> NEW.property_id
    OR stay_order_id IS NULL
    OR stay_order_id <> NEW.order_id THEN
    RAISE EXCEPTION 'cleaning task business identity is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'cleaning_tasks_business_identity_valid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM stay_segments AS segment
    WHERE segment.stay_id = NEW.stay_id
      AND segment.inventory_unit_id = NEW.inventory_unit_id
      AND segment.arrival_date <= NEW.service_date
  ) THEN
    RAISE EXCEPTION 'cleaning task inventory and service date do not belong to the Stay timeline'
      USING ERRCODE = '23514', CONSTRAINT = 'cleaning_tasks_stay_segment_valid';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'PENDING' OR NEW.status <> 'COMPLETED' OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'cleaning task only supports one completion' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cleaning_tasks_validate
BEFORE INSERT OR UPDATE ON cleaning_tasks
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_cleaning_task();

CREATE TRIGGER cleaning_tasks_reject_delete
BEFORE DELETE ON cleaning_tasks
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_append_only_delete();

CREATE OR REPLACE FUNCTION qintopia_validate_inventory_claim_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit_property_id text;
  expected_room_id text;
  source_property_id text;
  source_inventory_unit_id text;
  source_room_id text;
  source_arrival_date date;
  source_departure_date date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.property_id IS DISTINCT FROM OLD.property_id
      OR NEW.room_id IS DISTINCT FROM OLD.room_id
      OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
      OR NEW.service_date IS DISTINCT FROM OLD.service_date
      OR NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.source_id IS DISTINCT FROM OLD.source_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'inventory claim identity and typed source are immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.active IS NOT TRUE OR NEW.active IS NOT FALSE OR NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'inventory claim only supports one active-to-released transition' USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT property_id, CASE WHEN kind = 'ROOM' THEN id ELSE parent_room_id END
  INTO unit_property_id, expected_room_id
  FROM inventory_units WHERE id = NEW.inventory_unit_id;
  IF unit_property_id IS NULL
    OR unit_property_id <> NEW.property_id
    OR expected_room_id IS NULL
    OR expected_room_id <> NEW.room_id THEN
    RAISE EXCEPTION 'inventory claim unit identity is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_claims_unit_identity_valid';
  END IF;

  IF NEW.source_type = 'ORDER_SEGMENT' THEN
    SELECT orders.property_id, segment.inventory_unit_id,
      CASE WHEN unit.kind = 'ROOM' THEN unit.id ELSE unit.parent_room_id END,
      segment.arrival_date, segment.departure_date
    INTO source_property_id, source_inventory_unit_id, source_room_id, source_arrival_date, source_departure_date
    FROM stay_segments AS segment
    JOIN stays ON stays.id = segment.stay_id
    JOIN orders ON orders.id = stays.order_id
    JOIN inventory_units AS unit ON unit.id = segment.inventory_unit_id
    WHERE segment.id = NEW.source_id;
  ELSIF NEW.source_type = 'MAINTENANCE' THEN
    SELECT lock.property_id, lock.inventory_unit_id,
      CASE WHEN unit.kind = 'ROOM' THEN unit.id ELSE unit.parent_room_id END,
      lock.arrival_date, lock.departure_date
    INTO source_property_id, source_inventory_unit_id, source_room_id, source_arrival_date, source_departure_date
    FROM maintenance_locks AS lock
    JOIN inventory_units AS unit ON unit.id = lock.inventory_unit_id
    WHERE lock.id = NEW.source_id;
  ELSE
    SELECT block.property_id, block.inventory_unit_id, block.room_id,
      block.arrival_date, block.departure_date
    INTO source_property_id, source_inventory_unit_id, source_room_id, source_arrival_date, source_departure_date
    FROM internal_use_blocks AS block
    WHERE block.id = NEW.source_id;
  END IF;

  IF source_property_id IS NULL
    OR source_property_id <> NEW.property_id
    OR source_inventory_unit_id <> NEW.inventory_unit_id
    OR source_room_id <> NEW.room_id
    OR NEW.service_date < source_arrival_date
    OR NEW.service_date >= source_departure_date THEN
    RAISE EXCEPTION 'inventory claim typed source does not match its property, unit, room, or date'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_claims_typed_source_integrity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_claims_validate_source
BEFORE INSERT OR UPDATE ON inventory_claims
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_inventory_claim_source();

CREATE TRIGGER inventory_claims_reject_delete
BEFORE DELETE ON inventory_claims
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_append_only_delete();

CREATE INDEX inventory_claims_room_status_projection_idx
  ON inventory_claims (property_id, service_date, room_id, inventory_unit_id, source_type, source_id);
CREATE INDEX internal_use_blocks_property_dates_idx
  ON internal_use_blocks (property_id, arrival_date, departure_date, status);
CREATE INDEX cleaning_tasks_property_service_idx
  ON cleaning_tasks (property_id, service_date, status);
CREATE INDEX stay_segments_inventory_dates_idx
  ON stay_segments (inventory_unit_id, arrival_date, departure_date);

CREATE INDEX orders_room_status_tasks_idx
  ON orders (property_id, status, arrival_date, departure_date);
CREATE INDEX amendments_command_id_idx ON amendments (command_id) WHERE command_id IS NOT NULL;
