CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE properties (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  timezone text NOT NULL,
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_units (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  kind text NOT NULL CHECK (kind IN ('ROOM', 'BED')),
  parent_room_id text REFERENCES inventory_units(id),
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  CHECK ((kind = 'ROOM' AND parent_room_id IS NULL) OR (kind = 'BED' AND parent_room_id IS NOT NULL))
);

CREATE TABLE pricing_policy_versions (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  code text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  stay_type text NOT NULL CHECK (stay_type IN ('TRANSIENT','WEEKLY','MONTHLY','CUSTOM','FIXED_TERM','ROLLING','FREE')),
  calculation_kind text NOT NULL CHECK (calculation_kind IN ('FLAT_NIGHTLY','FREE')),
  nightly_rate_minor integer NOT NULL CHECK (nightly_rate_minor >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'PUBLISHED' CHECK (status = 'PUBLISHED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code, version),
  CHECK ((calculation_kind = 'FREE' AND nightly_rate_minor = 0) OR calculation_kind = 'FLAT_NIGHTLY')
);

CREATE TABLE subjects (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  auth_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subject_property_grants (
  subject_id text NOT NULL REFERENCES subjects(id),
  property_id text NOT NULL REFERENCES properties(id),
  access_level text NOT NULL CHECK (access_level IN ('READ','WRITE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, property_id)
);

CREATE TABLE api_tokens (
  id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  label text NOT NULL,
  secret_hash char(64) NOT NULL UNIQUE,
  access_ceiling text NOT NULL CHECK (access_ceiling IN ('READ','WRITE')),
  property_scope text NOT NULL REFERENCES properties(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_from_id text REFERENCES api_tokens(id),
  replaced_by_id text REFERENCES api_tokens(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE web_sessions (
  id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  secret_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member_contracts (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  member_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','EXPIRED')),
  valid_from date NOT NULL,
  valid_until date NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until >= valid_from)
);

CREATE TABLE entitlement_lots (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES member_contracts(id),
  unit_kind text NOT NULL CHECK (unit_kind IN ('ROOM_NIGHT','BED_NIGHT')),
  total_units integer NOT NULL CHECK (total_units >= 0),
  expires_on date NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  stay_type text NOT NULL,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  policy_version_id text NOT NULL REFERENCES pricing_policy_versions(id),
  member_contract_id text REFERENCES member_contracts(id),
  input_hash char(64) NOT NULL,
  coverage_set jsonb NOT NULL,
  cash_lines jsonb NOT NULL,
  cash_remainder_minor integer NOT NULL,
  current_contract_amount_minor integer NOT NULL,
  currency char(3) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (departure_date > arrival_date)
);

CREATE TABLE orders (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  status text NOT NULL CHECK (status IN ('RESERVED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW')),
  stay_type text NOT NULL,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  primary_guest_snapshot jsonb NOT NULL,
  pricing_policy_version_id text NOT NULL REFERENCES pricing_policy_versions(id),
  member_contract_id text REFERENCES member_contracts(id),
  current_revision_id text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (departure_date > arrival_date)
);

CREATE TABLE stays (
  id text PRIMARY KEY,
  order_id text NOT NULL UNIQUE REFERENCES orders(id),
  status text NOT NULL CHECK (status IN ('PLANNED','IN_HOUSE','COMPLETED','CANCELLED','NO_SHOW')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE amendments (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  amendment_type text NOT NULL,
  reason_code text NOT NULL,
  reason_note text NOT NULL,
  prior_version integer NOT NULL,
  new_version integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, sequence),
  CHECK (new_version = prior_version + 1 OR (prior_version = 0 AND new_version = 1))
);

CREATE TABLE stay_segments (
  id text PRIMARY KEY,
  stay_id text NOT NULL REFERENCES stays(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  segment_type text NOT NULL,
  supersedes_segment_id text REFERENCES stay_segments(id),
  amendment_id text NOT NULL REFERENCES amendments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stay_id, sequence),
  CHECK (departure_date > arrival_date)
);

CREATE TABLE pricing_revisions (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  revision_no integer NOT NULL CHECK (revision_no > 0),
  amendment_id text NOT NULL REFERENCES amendments(id),
  policy_version_id text NOT NULL REFERENCES pricing_policy_versions(id),
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  coverage_set jsonb NOT NULL,
  cash_lines jsonb NOT NULL,
  manual_adjustment_minor integer NOT NULL DEFAULT 0,
  current_contract_amount_minor integer NOT NULL,
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, revision_no),
  CHECK (departure_date > arrival_date)
);

ALTER TABLE orders ADD CONSTRAINT orders_current_revision_fk FOREIGN KEY (current_revision_id) REFERENCES pricing_revisions(id);

CREATE TABLE coverage_items (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  contract_id text NOT NULL REFERENCES member_contracts(id),
  lot_id text NOT NULL REFERENCES entitlement_lots(id),
  inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  service_date date NOT NULL,
  unit_kind text NOT NULL CHECK (unit_kind IN ('ROOM_NIGHT','BED_NIGHT')),
  status text NOT NULL CHECK (status IN ('HELD','CONSUMED','RELEASED')),
  held_by_revision_id text NOT NULL REFERENCES pricing_revisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, service_date, inventory_unit_id)
);

CREATE TABLE entitlement_ledger (
  fact_id text PRIMARY KEY,
  lot_id text NOT NULL REFERENCES entitlement_lots(id),
  entry_type text NOT NULL CHECK (entry_type IN ('ADJUST','HOLD','RELEASE','CONSUME','EXPIRE')),
  quantity_delta integer NOT NULL,
  service_date date,
  order_id text REFERENCES orders(id),
  coverage_id text REFERENCES coverage_items(id),
  reason text NOT NULL,
  command_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_room_days (
  room_id text NOT NULL REFERENCES inventory_units(id),
  service_date date NOT NULL,
  whole_claim_id text,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, service_date)
);

CREATE TABLE inventory_bed_days (
  room_id text NOT NULL REFERENCES inventory_units(id),
  bed_id text NOT NULL REFERENCES inventory_units(id),
  service_date date NOT NULL,
  bed_claim_id text,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bed_id, service_date),
  UNIQUE (room_id, bed_id, service_date)
);

CREATE TABLE inventory_claims (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  room_id text NOT NULL REFERENCES inventory_units(id),
  inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  service_date date NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('ORDER_SEGMENT','MAINTENANCE')),
  source_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_claims_active_source_idx ON inventory_claims (source_type, source_id) WHERE active;
CREATE INDEX inventory_claims_active_room_date_idx ON inventory_claims (room_id, service_date) WHERE active;

ALTER TABLE inventory_room_days ADD CONSTRAINT inventory_room_day_claim_fk FOREIGN KEY (whole_claim_id) REFERENCES inventory_claims(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE inventory_bed_days ADD CONSTRAINT inventory_bed_day_claim_fk FOREIGN KEY (bed_claim_id) REFERENCES inventory_claims(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE maintenance_locks (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','RELEASED')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK (departure_date > arrival_date)
);

CREATE TABLE collection_facts (
  fact_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  fact_type text NOT NULL CHECK (fact_type IN ('COLLECTION','REFUND','REVERSAL')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  net_effect_minor integer NOT NULL,
  currency char(3) NOT NULL,
  references_fact_id text REFERENCES collection_facts(fact_id),
  reverses_fact_id text UNIQUE REFERENCES collection_facts(fact_id),
  method text NOT NULL,
  note text NOT NULL,
  command_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE command_previews (
  id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  property_id text NOT NULL REFERENCES properties(id),
  command_type text NOT NULL,
  normalized_input jsonb NOT NULL,
  input_hash char(64) NOT NULL,
  effect jsonb NOT NULL,
  effect_hash char(64) NOT NULL,
  basis_versions jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','USED','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE TABLE command_executions (
  id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  credential_id text NOT NULL,
  property_id text NOT NULL REFERENCES properties(id),
  command_type text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  correlation_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('EXECUTING','APPLIED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (subject_id, command_type, idempotency_key)
);

CREATE TABLE command_receipts (
  id text PRIMARY KEY,
  command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  execution_status text NOT NULL CHECK (execution_status IN ('EXECUTED','NOT_EXECUTED','UNKNOWN')),
  business_committed boolean NOT NULL,
  result jsonb,
  error jsonb,
  resource_refs jsonb NOT NULL,
  fact_refs jsonb NOT NULL,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_entries (
  id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  credential_id text NOT NULL,
  action text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ALLOWED','DENIED')),
  command_id text REFERENCES command_executions(id),
  correlation_id text NOT NULL,
  reason jsonb,
  target_refs jsonb NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_property_status_idx ON orders(property_id, status);
CREATE INDEX quotes_expires_idx ON quotes(expires_at);
CREATE INDEX previews_subject_idx ON command_previews(subject_id, created_at DESC);
CREATE INDEX receipts_created_idx ON command_receipts(created_at DESC);
CREATE INDEX audit_correlation_idx ON audit_entries(correlation_id);
CREATE INDEX collection_order_idx ON collection_facts(order_id, created_at);
