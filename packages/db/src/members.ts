import { DomainError } from "@qintopia/contracts";
import { entitlementAvailableBalance } from "./entitlement-balance.ts";
import type { DbExecutor } from "./inventory.ts";

export function localDateInTimeZone(timeZone: string, instant = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function propertyLocalToday(db: DbExecutor, propertyId: string): Promise<string> {
  const property = await db.selectFrom("properties").select("timezone").where("id", "=", propertyId).executeTakeFirst();
  if (!property) throw new DomainError("NOT_FOUND", "Property not found", 404);
  return localDateInTimeZone(property.timezone);
}

export async function getMemberView(db: DbExecutor, propertyId: string, memberId: string) {
  const balanceAsOfDate = await propertyLocalToday(db, propertyId);
  const member = await db.selectFrom("members").selectAll().where("id", "=", memberId).executeTakeFirst();
  if (!member) throw new DomainError("NOT_FOUND", "Member not found", 404);
  const contracts = await db.selectFrom("member_contracts").selectAll()
    .where("member_id", "=", memberId)
    .where("property_id", "=", propertyId)
    .orderBy("valid_from", "desc")
    .orderBy("id")
    .execute();
  if (contracts.length === 0) throw new DomainError("NOT_FOUND", "Member not found for this property", 404);
  const contractIds = contracts.map((contract) => contract.id);
  const lots = await db.selectFrom("entitlement_lots").selectAll()
    .where("contract_id", "in", contractIds)
    .orderBy("expires_on")
    .orderBy("id")
    .execute();
  const lotIds = lots.map((lot) => lot.id);
  const ledger = lotIds.length > 0
    ? await db.selectFrom("entitlement_ledger").selectAll()
      .where("lot_id", "in", lotIds)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute()
    : [];
  const ledgerDeltaByLot = new Map<string, number>();
  for (const entry of ledger) {
    ledgerDeltaByLot.set(entry.lot_id, (ledgerDeltaByLot.get(entry.lot_id) ?? 0) + entry.quantity_delta);
  }
  const contractStatusById = new Map(contracts.map((contract) => [contract.id, contract.status]));
  const lotBalances = lots.map((lot) => ({
    lotId: lot.id,
    unitKind: lot.unit_kind,
    availableUnits: contractStatusById.get(lot.contract_id) !== "ACTIVE" || lot.expires_on < balanceAsOfDate
      ? 0
      : entitlementAvailableBalance(lot.total_units, ledgerDeltaByLot.get(lot.id) ?? 0)
  }));
  const availableBalance = lotBalances.reduce((total, lot) => {
    total[lot.unitKind] += lot.availableUnits;
    return total;
  }, { ROOM_NIGHT: 0, BED_NIGHT: 0 });
  if (!Number.isSafeInteger(availableBalance.ROOM_NIGHT) || !Number.isSafeInteger(availableBalance.BED_NIGHT)) {
    throw new DomainError("INTERNAL_ERROR", "Member entitlement balance exceeds the supported integer range", 500);
  }
  const externalReferences = await db.selectFrom("member_external_references").selectAll()
    .where("member_id", "=", memberId)
    .where("property_id", "=", propertyId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return { member, contracts, lots, ledger, externalReferences, lotBalances, availableBalance, balanceAsOfDate };
}

export async function listMemberSummaries(db: DbExecutor, propertyId: string, identityCardNumber?: string) {
  let selection = db.selectFrom("members")
    .innerJoin("member_contracts", "member_contracts.member_id", "members.id")
    .selectAll("members")
    .distinct()
    .where("member_contracts.property_id", "=", propertyId);
  if (identityCardNumber) selection = selection.where("members.identity_card_number", "=", identityCardNumber.trim().toUpperCase());
  const members = await selection.orderBy("members.full_name").orderBy("members.id").execute();
  return Promise.all(members.map(async (member) => {
    const view = await getMemberView(db, propertyId, member.id);
    return { member, contracts: view.contracts, availableBalance: view.availableBalance, balanceAsOfDate: view.balanceAsOfDate };
  }));
}
