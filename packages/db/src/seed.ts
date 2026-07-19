import { hashPassword, sha256 } from "@qintopia/domain";
import { pathToFileURL } from "node:url";
import type { Insertable, Kysely } from "kysely";
import { createDatabase } from "./database.ts";
import { loadBundledQintopia2026Catalog } from "./reference-catalog.ts";
import type { Database } from "./schema.ts";

export const demo = {
  propertyId: "prop_qintopia_demo",
  roomId: "unit_room_101",
  secondRoomId: "unit_room_102",
  bedAId: "unit_room_101_bed_a",
  bedBId: "unit_room_101_bed_b",
  bedCId: "unit_room_101_bed_c",
  bedDId: "unit_room_101_bed_d",
  transientPolicyId: "policy_transient_v1",
  publicPricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  freePolicyId: "policy_free_v1",
  memberId: "member_demo_profile",
  memberContractId: "member_demo_contract",
  roomLotId: "lot_demo_room_nights",
  bedLotId: "lot_demo_bed_nights",
  operatorSubjectId: "subject_demo_operator",
  agentSubjectId: "subject_demo_agent",
  readToken: "qtp_demo_read_token_2026",
  writeToken: "qtp_demo_write_token_2026"
} as const;

function slug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

function roomUnitId(operationalCode: string): string {
  return `unit_room_${slug(operationalCode)}`;
}

export function publicPricingPolicyId(): string {
  return demo.publicPricingPolicyId;
}

function roomPricingProduct(roomTypeKey: string, saleMode: "INDEPENDENT_ROOM" | "BED_WITH_WHOLE_ROOM_COMBINATION"): string {
  return saleMode === "INDEPENDENT_ROOM" ? `${roomTypeKey}_room` : `${roomTypeKey}_whole_room`;
}

export async function buildQintopia2026OperationalCatalogRows(propertyId = demo.propertyId) {
  const snapshot = await loadBundledQintopia2026Catalog();
  const categoryNames = new Map(snapshot.inventory.categories.map((category) => [category.roomTypeKey, category.sourceName]));
  const rooms = snapshot.inventory.rooms.map((room) => ({
    id: roomUnitId(room.operationalCode),
    property_id: propertyId,
    kind: "ROOM" as const,
    parent_room_id: null,
    code: room.operationalCode,
    name: `${room.operationalCode} · ${categoryNames.get(room.roomTypeKey)}`,
    active: true,
    catalog_version: snapshot.importId,
    building_code: room.buildingCode,
    room_type_code: room.roomTypeKey,
    pricing_product_code: roomPricingProduct(room.roomTypeKey, room.saleMode),
    inventory_basis: room.saleMode === "INDEPENDENT_ROOM" ? "INDEPENDENT" as const : "WHOLE_ROOM_COMBINATION" as const,
    code_provenance: room.codeProvenance,
    physical_bed_count: room.physicalBedCount
  }));
  const beds = snapshot.inventory.rooms.flatMap((room) => room.saleMode === "BED_WITH_WHOLE_ROOM_COMBINATION"
    ? (room.physicalBedCodes ?? []).map((bedCode) => ({
      id: `${roomUnitId(room.operationalCode)}_bed_${bedCode.toLowerCase()}`,
      property_id: propertyId,
      kind: "BED" as const,
      parent_room_id: roomUnitId(room.operationalCode),
      code: `${room.operationalCode}-${bedCode}`,
      name: `${room.operationalCode} · 床位 ${bedCode}`,
      active: true,
      catalog_version: snapshot.importId,
      building_code: room.buildingCode,
      room_type_code: room.roomTypeKey,
      pricing_product_code: `${room.roomTypeKey}_bed`,
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: room.codeProvenance,
      physical_bed_count: null
    }))
    : []);
  return { snapshot, rooms, beds };
}

function publicPricingPolicyRow(snapshot: Awaited<ReturnType<typeof loadBundledQintopia2026Catalog>>) {
  return {
    id: publicPricingPolicyId(),
    property_id: demo.propertyId,
    code: snapshot.pricingRule.code,
    version: snapshot.pricingRule.version,
    stay_type: null,
    calculation_kind: "DURATION_BAND_TOTAL" as const,
    nightly_rate_minor: null,
    product_anchor_rates_minor: Object.fromEntries(snapshot.publicRates.products.map((product) => [product.productCode, product.anchorsMinor])),
    effective_from: snapshot.pricingRule.effectiveFrom,
    effective_until: snapshot.pricingRule.effectiveUntil,
    rounding_rule: "FINAL_TOTAL_WHOLE_YUAN_HALF_UP" as const,
    currency: snapshot.publicRates.currency,
    status: "PUBLISHED" as const
  };
}

export async function seedDemo(db: Kysely<Database>, options: { includeProtocolFixturePolicy?: boolean } = {}): Promise<void> {
  const catalog = await buildQintopia2026OperationalCatalogRows();
  await db.insertInto("properties").values({ id: demo.propertyId, code: "QTP-SH", name: "QinTopia", timezone: "Asia/Shanghai", currency: "CNY" }).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("inventory_units").values(catalog.rooms).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("inventory_units").values(catalog.beds).onConflict((oc) => oc.column("id").doNothing()).execute();
  const pricingPolicies: Insertable<Database["pricing_policy_versions"]>[] = [
    { id: demo.freePolicyId, property_id: demo.propertyId, code: "FREE", version: 1, stay_type: "FREE", calculation_kind: "FREE", nightly_rate_minor: 0, currency: "CNY", status: "PUBLISHED" },
    publicPricingPolicyRow(catalog.snapshot)
  ];
  if (options.includeProtocolFixturePolicy) {
    pricingPolicies.push({
      id: demo.transientPolicyId,
      property_id: demo.propertyId,
      code: "DEMO-ONLY-TRANSIENT-FLAT",
      version: 1,
      stay_type: "TRANSIENT",
      calculation_kind: "FLAT_NIGHTLY",
      nightly_rate_minor: 12_000,
      product_anchor_rates_minor: null,
      effective_from: null,
      effective_until: null,
      rounding_rule: null,
      currency: "CNY",
      status: "PUBLISHED"
    });
  }
  await db.insertInto("pricing_policy_versions").values(pricingPolicies).onConflict((oc) => oc.column("id").doNothing()).execute();

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
  await db.insertInto("members").values({
    id: demo.memberId,
    identity_card_number: "DEMO-ID-310000199001010001",
    full_name: "Demo Member",
    phone: "13800000000",
    wechat: "qintopia-demo-member"
  }).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("member_contracts").values({
    id: demo.memberContractId,
    property_id: demo.propertyId,
    member_id: demo.memberId,
    member_name: "Demo Member",
    status: "ACTIVE",
    valid_from: "2026-01-01",
    valid_until: "2029-12-31",
    version: 1
  }).onConflict((oc) => oc.column("id").doUpdateSet({ member_id: demo.memberId })).execute();
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
