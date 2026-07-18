import { hashPassword, sha256 } from "@qintopia/domain";
import { pathToFileURL } from "node:url";
import type { Kysely } from "kysely";
import { createDatabase } from "./database.ts";
import type { Database } from "./schema.ts";

export const demo = {
  propertyId: "prop_qintopia_demo",
  roomId: "unit_room_101",
  secondRoomId: "unit_room_102",
  bedAId: "unit_room_101_bed_a",
  bedBId: "unit_room_101_bed_b",
  transientPolicyId: "policy_transient_v1",
  freePolicyId: "policy_free_v1",
  memberContractId: "member_demo_contract",
  roomLotId: "lot_demo_room_nights",
  bedLotId: "lot_demo_bed_nights",
  operatorSubjectId: "subject_demo_operator",
  agentSubjectId: "subject_demo_agent",
  readToken: "qtp_demo_read_token_2026",
  writeToken: "qtp_demo_write_token_2026"
} as const;

export async function seedDemo(db: Kysely<Database>): Promise<void> {
  await db.insertInto("properties").values({ id: demo.propertyId, code: "QTP-SH", name: "QinTopia Shanghai", timezone: "Asia/Shanghai", currency: "CNY" }).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("inventory_units").values([
    { id: demo.roomId, property_id: demo.propertyId, kind: "ROOM", parent_room_id: null, code: "101", name: "Room 101", active: true },
    { id: demo.bedAId, property_id: demo.propertyId, kind: "BED", parent_room_id: demo.roomId, code: "101-A", name: "Room 101 / Bed A", active: true },
    { id: demo.bedBId, property_id: demo.propertyId, kind: "BED", parent_room_id: demo.roomId, code: "101-B", name: "Room 101 / Bed B", active: true },
    { id: demo.secondRoomId, property_id: demo.propertyId, kind: "ROOM", parent_room_id: null, code: "102", name: "Room 102", active: true }
  ]).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("pricing_policy_versions").values([
    { id: demo.transientPolicyId, property_id: demo.propertyId, code: "TRANSIENT-FLAT", version: 1, stay_type: "TRANSIENT", calculation_kind: "FLAT_NIGHTLY", nightly_rate_minor: 12_000, currency: "CNY", status: "PUBLISHED" },
    { id: demo.freePolicyId, property_id: demo.propertyId, code: "FREE", version: 1, stay_type: "FREE", calculation_kind: "FREE", nightly_rate_minor: 0, currency: "CNY", status: "PUBLISHED" }
  ]).onConflict((oc) => oc.column("id").doNothing()).execute();

  const passwordSalt = "qintopia-demo-v1";
  const passwordHash = hashPassword("demo-pass-2026", passwordSalt);
  await db.insertInto("subjects").values([
    { id: demo.operatorSubjectId, username: "operator", display_name: "Demo Operator", password_salt: passwordSalt, password_hash: passwordHash, status: "ACTIVE", auth_version: 1 },
    { id: demo.agentSubjectId, username: "agent-demo", display_name: "Demo Agent", password_salt: passwordSalt, password_hash: passwordHash, status: "ACTIVE", auth_version: 1 }
  ]).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("subject_property_grants").values([
    { subject_id: demo.operatorSubjectId, property_id: demo.propertyId, access_level: "WRITE" },
    { subject_id: demo.agentSubjectId, property_id: demo.propertyId, access_level: "WRITE" }
  ]).onConflict((oc) => oc.columns(["subject_id", "property_id"]).doNothing()).execute();
  await db.insertInto("api_tokens").values([
    { id: "token_demo_read", subject_id: demo.agentSubjectId, label: "Demo read-only agent", secret_hash: sha256(demo.readToken), access_ceiling: "READ", property_scope: demo.propertyId, expires_at: "2030-01-01T00:00:00.000Z", revoked_at: null, rotated_from_id: null, replaced_by_id: null },
    { id: "token_demo_write", subject_id: demo.agentSubjectId, label: "Demo write agent", secret_hash: sha256(demo.writeToken), access_ceiling: "WRITE", property_scope: demo.propertyId, expires_at: "2030-01-01T00:00:00.000Z", revoked_at: null, rotated_from_id: null, replaced_by_id: null }
  ]).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("member_contracts").values({ id: demo.memberContractId, property_id: demo.propertyId, member_name: "Demo Member", status: "ACTIVE", valid_from: "2026-01-01", valid_until: "2029-12-31", version: 1 }).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("entitlement_lots").values([
    { id: demo.roomLotId, contract_id: demo.memberContractId, unit_kind: "ROOM_NIGHT", total_units: 2, expires_on: "2029-12-31", version: 1 },
    { id: demo.bedLotId, contract_id: demo.memberContractId, unit_kind: "BED_NIGHT", total_units: 2, expires_on: "2029-12-31", version: 1 }
  ]).onConflict((oc) => oc.column("id").doNothing()).execute();
}

async function runSeed() {
  const db = createDatabase();
  try {
    await seedDemo(db);
    process.stdout.write("Seeded demo property, operator account, and scoped agent credentials.\n");
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSeed().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
