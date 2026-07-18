import type { ColumnType } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, unknown, unknown>;

export interface Database {
  schema_migrations: { name: string; applied_at: GeneratedTimestamp };
  properties: { id: string; code: string; name: string; timezone: string; currency: string; created_at: GeneratedTimestamp };
  inventory_units: { id: string; property_id: string; kind: "ROOM" | "BED"; parent_room_id: string | null; code: string; name: string; active: boolean; created_at: GeneratedTimestamp };
  pricing_policy_versions: { id: string; property_id: string; code: string; version: number; stay_type: string; calculation_kind: "FLAT_NIGHTLY" | "FREE"; nightly_rate_minor: number; currency: string; status: "PUBLISHED"; created_at: GeneratedTimestamp };
  subjects: { id: string; username: string; display_name: string; password_salt: string; password_hash: string; status: "ACTIVE" | "DISABLED"; auth_version: number; created_at: GeneratedTimestamp };
  subject_property_grants: { subject_id: string; property_id: string; access_level: "READ" | "WRITE"; created_at: GeneratedTimestamp };
  api_tokens: { id: string; subject_id: string; label: string; secret_hash: string; access_ceiling: "READ" | "WRITE"; property_scope: string; expires_at: Timestamp; revoked_at: Timestamp | null; rotated_from_id: string | null; replaced_by_id: string | null; created_at: GeneratedTimestamp };
  web_sessions: { id: string; subject_id: string; secret_hash: string; expires_at: Timestamp; revoked_at: Timestamp | null; created_at: GeneratedTimestamp };
  member_contracts: { id: string; property_id: string; member_name: string; status: "ACTIVE" | "EXPIRED"; valid_from: string; valid_until: string; version: number; created_at: GeneratedTimestamp };
  entitlement_lots: { id: string; contract_id: string; unit_kind: "ROOM_NIGHT" | "BED_NIGHT"; total_units: number; expires_on: string; version: number; created_at: GeneratedTimestamp };
  entitlement_ledger: { fact_id: string; lot_id: string; entry_type: "ADJUST" | "HOLD" | "RELEASE" | "CONSUME" | "EXPIRE"; quantity_delta: number; service_date: string | null; order_id: string | null; coverage_id: string | null; reason: string; command_id: string | null; created_at: GeneratedTimestamp };
  quotes: { id: string; property_id: string; inventory_unit_id: string; stay_type: string; arrival_date: string; departure_date: string; policy_version_id: string; member_contract_id: string | null; requester_subject_id: string | null; input_hash: string; coverage_set: Json; cash_lines: Json; cash_remainder_minor: number; current_contract_amount_minor: number; currency: string; expires_at: Timestamp; created_at: GeneratedTimestamp };
  orders: { id: string; property_id: string; status: string; stay_type: string; arrival_date: string; departure_date: string; primary_guest_snapshot: Json; pricing_policy_version_id: string; member_contract_id: string | null; current_revision_id: string | null; version: number; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp };
  stays: { id: string; order_id: string; status: string; created_at: GeneratedTimestamp };
  stay_segments: { id: string; stay_id: string; sequence: number; inventory_unit_id: string; arrival_date: string; departure_date: string; segment_type: string; supersedes_segment_id: string | null; amendment_id: string; created_at: GeneratedTimestamp };
  amendments: { id: string; order_id: string; sequence: number; amendment_type: string; reason_code: string; reason_note: string; prior_version: number; new_version: number; payload: Json; created_at: GeneratedTimestamp };
  pricing_revisions: { id: string; order_id: string; revision_no: number; amendment_id: string; policy_version_id: string; arrival_date: string; departure_date: string; coverage_set: Json; cash_lines: Json; manual_adjustment_minor: number; current_contract_amount_minor: number; currency: string; created_at: GeneratedTimestamp };
  coverage_items: { id: string; order_id: string; contract_id: string; lot_id: string; inventory_unit_id: string; service_date: string; unit_kind: string; status: "HELD" | "CONSUMED" | "RELEASED"; held_by_revision_id: string; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp };
  inventory_room_days: { room_id: string; service_date: string; whole_claim_id: string | null; version: number; updated_at: GeneratedTimestamp };
  inventory_bed_days: { room_id: string; bed_id: string; service_date: string; bed_claim_id: string | null; version: number; updated_at: GeneratedTimestamp };
  inventory_claims: { id: string; property_id: string; room_id: string; inventory_unit_id: string; service_date: string; source_type: "ORDER_SEGMENT" | "MAINTENANCE"; source_id: string; active: boolean; released_at: Timestamp | null; created_at: GeneratedTimestamp };
  maintenance_locks: { id: string; property_id: string; inventory_unit_id: string; arrival_date: string; departure_date: string; reason: string; status: "ACTIVE" | "RELEASED"; version: number; created_at: GeneratedTimestamp; released_at: Timestamp | null };
  collection_facts: { fact_id: string; order_id: string; fact_type: "COLLECTION" | "REFUND" | "REVERSAL"; amount_minor: number; net_effect_minor: number; currency: string; references_fact_id: string | null; reverses_fact_id: string | null; method: string; note: string; command_id: string; created_at: GeneratedTimestamp };
  command_previews: { id: string; subject_id: string; property_id: string; command_type: string; normalized_input: Json; input_hash: string; effect: Json; effect_hash: string; basis_versions: Json; expires_at: Timestamp; status: "OPEN" | "USED" | "EXPIRED"; created_at: GeneratedTimestamp; used_at: Timestamp | null };
  command_executions: { id: string; subject_id: string; credential_id: string; property_id: string; command_type: string; idempotency_key: string; request_hash: string; correlation_id: string; state: "EXECUTING" | "APPLIED" | "REJECTED"; created_at: GeneratedTimestamp; completed_at: Timestamp | null };
  command_receipts: { id: string; command_id: string; execution_status: "EXECUTED" | "NOT_EXECUTED" | "UNKNOWN"; business_committed: boolean; result: Json | null; error: Json | null; resource_refs: Json; fact_refs: Json; committed_at: Timestamp | null; created_at: GeneratedTimestamp };
  audit_entries: { id: string; subject_id: string; credential_id: string; action: string; decision: "ALLOWED" | "DENIED"; command_id: string | null; correlation_id: string; reason: Json | null; target_refs: Json; metadata: Json; created_at: GeneratedTimestamp };
}
