import { sql, type Kysely, type Transaction } from "kysely";
import { DomainError, type InventoryUnitKind } from "@qintopia/contracts";
import { enumerateServiceDates, newId } from "@qintopia/domain";
import type { Database } from "./schema.ts";

export type DbExecutor = Kysely<Database> | Transaction<Database>;

export interface InventoryUnitRecord {
  id: string;
  propertyId: string;
  kind: InventoryUnitKind;
  roomId: string;
  code: string;
  name: string;
  catalogVersion: string | null;
  buildingCode: string | null;
  roomTypeCode: string | null;
  pricingProductCode: string | null;
  inventoryBasis: "INDEPENDENT" | "WHOLE_ROOM_COMBINATION" | null;
  codeProvenance: "SOURCE_EXPLICIT" | "USER_CONFIRMED_RENAMED" | "PMS_GENERATED" | null;
  physicalBedCount: number | null;
}

export interface AvailabilityNight {
  serviceDate: string;
  available: boolean;
  blockingClaimIds: string[];
}

export interface UnitAvailability extends InventoryUnitRecord {
  nights: AvailabilityNight[];
  available: boolean;
}

export async function loadInventoryUnit(db: DbExecutor, propertyId: string, unitId: string): Promise<InventoryUnitRecord> {
  const row = await db.selectFrom("inventory_units")
    .select(["id", "property_id", "kind", "parent_room_id", "code", "name", "catalog_version", "building_code", "room_type_code", "pricing_product_code", "inventory_basis", "code_provenance", "physical_bed_count"])
    .where("id", "=", unitId)
    .where("property_id", "=", propertyId)
    .where("active", "=", true)
    .executeTakeFirst();
  if (!row) throw new DomainError("NOT_FOUND", "Inventory unit not found", 404);
  return {
    id: row.id,
    propertyId: row.property_id,
    kind: row.kind,
    roomId: row.kind === "ROOM" ? row.id : row.parent_room_id!,
    code: row.code,
    name: row.name,
    catalogVersion: row.catalog_version,
    buildingCode: row.building_code,
    roomTypeCode: row.room_type_code,
    pricingProductCode: row.pricing_product_code,
    inventoryBasis: row.inventory_basis,
    codeProvenance: row.code_provenance,
    physicalBedCount: row.physical_bed_count
  };
}

export async function listAvailability(db: DbExecutor, propertyId: string, arrivalDate: string, departureDate: string, kind?: InventoryUnitKind): Promise<UnitAvailability[]> {
  const dates = enumerateServiceDates(arrivalDate, departureDate);
  let query = db.selectFrom("inventory_units")
    .select(["id", "property_id", "kind", "parent_room_id", "code", "name", "catalog_version", "building_code", "room_type_code", "pricing_product_code", "inventory_basis", "code_provenance", "physical_bed_count"])
    .where("property_id", "=", propertyId)
    .where("active", "=", true);
  if (kind) query = query.where("kind", "=", kind);
  const units = await query.orderBy("code").execute();
  const claims = await db.selectFrom("inventory_claims")
    .select(["id", "room_id", "inventory_unit_id", "service_date"])
    .where("property_id", "=", propertyId)
    .where("active", "=", true)
    .where("service_date", ">=", arrivalDate)
    .where("service_date", "<", departureDate)
    .execute();

  return units.map((unit) => {
    const roomId = unit.kind === "ROOM" ? unit.id : unit.parent_room_id!;
    const nights = dates.map((serviceDate) => {
      const blocking = claims.filter((claim) => claim.service_date === serviceDate && claim.room_id === roomId && (
        unit.kind === "ROOM" || claim.inventory_unit_id === roomId || claim.inventory_unit_id === unit.id
      ));
      return { serviceDate, available: blocking.length === 0, blockingClaimIds: blocking.map((claim) => claim.id) };
    });
    return {
      id: unit.id,
      propertyId: unit.property_id,
      kind: unit.kind,
      roomId,
      code: unit.code,
      name: unit.name,
      catalogVersion: unit.catalog_version,
      buildingCode: unit.building_code,
      roomTypeCode: unit.room_type_code,
      pricingProductCode: unit.pricing_product_code,
      inventoryBasis: unit.inventory_basis,
      codeProvenance: unit.code_provenance,
      physicalBedCount: unit.physical_bed_count,
      nights,
      available: nights.every((night) => night.available)
    };
  });
}

export async function inventoryFingerprint(db: DbExecutor, propertyId: string, unitId: string, arrivalDate: string, departureDate: string, excludeSourceIds: string[] = []): Promise<string[]> {
  const unit = await loadInventoryUnit(db, propertyId, unitId);
  let query = db.selectFrom("inventory_claims")
    .select(["id", "inventory_unit_id", "service_date", "source_id"])
    .where("property_id", "=", propertyId)
    .where("room_id", "=", unit.roomId)
    .where("active", "=", true)
    .where("service_date", ">=", arrivalDate)
    .where("service_date", "<", departureDate);
  if (excludeSourceIds.length > 0) query = query.where("source_id", "not in", excludeSourceIds);
  const claims = await query.orderBy("service_date").orderBy("id").execute();
  return claims
    .filter((claim) => unit.kind === "ROOM" || claim.inventory_unit_id === unit.roomId || claim.inventory_unit_id === unit.id)
    .map((claim) => `${claim.service_date}:${claim.inventory_unit_id}:${claim.id}`);
}

export async function lockRoomDays(trx: Transaction<Database>, roomDates: Array<{ roomId: string; serviceDate: string }>): Promise<void> {
  const unique = [...new Map(roomDates.map((item) => [`${item.roomId}:${item.serviceDate}`, item])).values()]
    .sort((left, right) => `${left.roomId}:${left.serviceDate}`.localeCompare(`${right.roomId}:${right.serviceDate}`));
  for (const item of unique) {
    await trx.insertInto("inventory_room_days")
      .values({ room_id: item.roomId, service_date: item.serviceDate, whole_claim_id: null, version: 0 })
      .onConflict((oc) => oc.columns(["room_id", "service_date"]).doNothing())
      .execute();
    await trx.selectFrom("inventory_room_days")
      .select("room_id")
      .where("room_id", "=", item.roomId)
      .where("service_date", "=", item.serviceDate)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }
}

export async function lockUnitDates(trx: Transaction<Database>, propertyId: string, unitId: string, arrivalDate: string, departureDate: string): Promise<InventoryUnitRecord> {
  const unit = await loadInventoryUnit(trx, propertyId, unitId);
  await lockRoomDays(trx, enumerateServiceDates(arrivalDate, departureDate).map((serviceDate) => ({ roomId: unit.roomId, serviceDate })));
  return unit;
}

export async function assertUnitAvailable(trx: Transaction<Database>, unit: InventoryUnitRecord, dates: string[], excludeSourceIds: string[] = []): Promise<void> {
  for (const serviceDate of dates) {
    const roomDay = await trx.selectFrom("inventory_room_days")
      .select("whole_claim_id")
      .where("room_id", "=", unit.roomId)
      .where("service_date", "=", serviceDate)
      .executeTakeFirstOrThrow();
    if (roomDay.whole_claim_id) {
      const claim = await trx.selectFrom("inventory_claims").select(["id", "source_id"]).where("id", "=", roomDay.whole_claim_id).executeTakeFirst();
      if (claim && !excludeSourceIds.includes(claim.source_id)) {
        throw new DomainError("INVENTORY_CONFLICT", `Inventory is unavailable on ${serviceDate}`, 409, false, { serviceDate, claimId: claim.id });
      }
    }
    if (unit.kind === "ROOM") {
      let bedQuery = trx.selectFrom("inventory_bed_days")
        .innerJoin("inventory_claims", "inventory_claims.id", "inventory_bed_days.bed_claim_id")
        .select(["inventory_claims.id", "inventory_claims.source_id"])
        .where("inventory_bed_days.room_id", "=", unit.roomId)
        .where("inventory_bed_days.service_date", "=", serviceDate)
        .where("inventory_claims.active", "=", true);
      if (excludeSourceIds.length > 0) bedQuery = bedQuery.where("inventory_claims.source_id", "not in", excludeSourceIds);
      const bedClaim = await bedQuery.executeTakeFirst();
      if (bedClaim) throw new DomainError("INVENTORY_CONFLICT", `A bed is occupied on ${serviceDate}`, 409, false, { serviceDate, claimId: bedClaim.id });
    } else {
      const bedDay = await trx.selectFrom("inventory_bed_days")
        .leftJoin("inventory_claims", "inventory_claims.id", "inventory_bed_days.bed_claim_id")
        .select(["inventory_bed_days.bed_claim_id", "inventory_claims.source_id"])
        .where("inventory_bed_days.bed_id", "=", unit.id)
        .where("inventory_bed_days.service_date", "=", serviceDate)
        .executeTakeFirst();
      if (bedDay?.bed_claim_id && (!bedDay.source_id || !excludeSourceIds.includes(bedDay.source_id))) {
        throw new DomainError("INVENTORY_CONFLICT", `Bed is unavailable on ${serviceDate}`, 409, false, { serviceDate, claimId: bedDay.bed_claim_id });
      }
    }
  }
}

export async function createInventoryClaims(trx: Transaction<Database>, options: {
  propertyId: string;
  unit: InventoryUnitRecord;
  dates: string[];
  sourceType: "ORDER_SEGMENT" | "MAINTENANCE";
  sourceId: string;
}): Promise<string[]> {
  await assertUnitAvailable(trx, options.unit, options.dates);
  const claimIds: string[] = [];
  for (const serviceDate of options.dates) {
    const claimId = newId("claim");
    await trx.insertInto("inventory_claims").values({
      id: claimId,
      property_id: options.propertyId,
      room_id: options.unit.roomId,
      inventory_unit_id: options.unit.id,
      service_date: serviceDate,
      source_type: options.sourceType,
      source_id: options.sourceId,
      active: true,
      released_at: null
    }).execute();
    if (options.unit.kind === "ROOM") {
      await trx.updateTable("inventory_room_days")
        .set({ whole_claim_id: claimId, version: sql`version + 1`, updated_at: new Date() })
        .where("room_id", "=", options.unit.roomId)
        .where("service_date", "=", serviceDate)
        .executeTakeFirstOrThrow();
    } else {
      await trx.insertInto("inventory_bed_days")
        .values({ room_id: options.unit.roomId, bed_id: options.unit.id, service_date: serviceDate, bed_claim_id: null, version: 0 })
        .onConflict((oc) => oc.columns(["bed_id", "service_date"]).doNothing())
        .execute();
      await trx.updateTable("inventory_bed_days")
        .set({ bed_claim_id: claimId, version: sql`version + 1`, updated_at: new Date() })
        .where("bed_id", "=", options.unit.id)
        .where("service_date", "=", serviceDate)
        .executeTakeFirstOrThrow();
    }
    claimIds.push(claimId);
  }
  return claimIds;
}

export async function releaseInventoryClaims(trx: Transaction<Database>, sourceType: "ORDER_SEGMENT" | "MAINTENANCE", sourceIds: string[], fromDate?: string): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  let query = trx.selectFrom("inventory_claims")
    .selectAll()
    .where("source_type", "=", sourceType)
    .where("source_id", "in", sourceIds)
    .where("active", "=", true);
  if (fromDate) query = query.where("service_date", ">=", fromDate);
  const claims = await query.orderBy("room_id").orderBy("service_date").execute();
  for (const claim of claims) {
    const unit = await trx.selectFrom("inventory_units").select("kind").where("id", "=", claim.inventory_unit_id).executeTakeFirstOrThrow();
    if (unit.kind === "ROOM") {
      await trx.updateTable("inventory_room_days")
        .set({ whole_claim_id: null, version: sql`version + 1`, updated_at: new Date() })
        .where("room_id", "=", claim.room_id).where("service_date", "=", claim.service_date).where("whole_claim_id", "=", claim.id).execute();
    } else {
      await trx.updateTable("inventory_bed_days")
        .set({ bed_claim_id: null, version: sql`version + 1`, updated_at: new Date() })
        .where("bed_id", "=", claim.inventory_unit_id).where("service_date", "=", claim.service_date).where("bed_claim_id", "=", claim.id).execute();
    }
    await trx.updateTable("inventory_claims").set({ active: false, released_at: new Date() }).where("id", "=", claim.id).execute();
  }
  return claims.map((claim) => claim.id);
}
