import { sql, type Kysely, type Transaction } from "kysely";
import { DomainError, type InventoryUnitKind, type QuoteDto, type StayType, type StoredQuoteDto } from "@qintopia/contracts";
import { calculatePricing, entitlementKindFor, enumerateServiceDates, newId, stableHash, type CoverageCandidate, type PricingPolicy } from "@qintopia/domain";
import { entitlementAvailableBalance, parsePostgresBigInt } from "./entitlement-balance.ts";
import { listAvailability, loadInventoryUnit, type DbExecutor } from "./inventory.ts";
import type { Database } from "./schema.ts";

export interface QuoteRequest {
  propertyId: string;
  inventoryUnitId: string;
  stayType: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  memberContractId?: string;
  requesterSubjectId?: string;
}

export type StoredQuote = StoredQuoteDto;

export async function loadPricingPolicy(db: DbExecutor, propertyId: string, policyVersionId: string): Promise<PricingPolicy> {
  const row = await db.selectFrom("pricing_policy_versions")
    .selectAll()
    .where("id", "=", policyVersionId)
    .where("property_id", "=", propertyId)
    .where("status", "=", "PUBLISHED")
    .executeTakeFirst();
  if (!row) throw new DomainError("POLICY_VERSION_NOT_FOUND", "Pricing policy version not found", 404);
  return {
    id: row.id,
    stayType: row.stay_type as StayType,
    calculationKind: row.calculation_kind,
    nightlyRateMinor: row.nightly_rate_minor,
    currency: row.currency
  };
}

export async function allocateCoverageCandidates(db: DbExecutor, options: {
  propertyId: string;
  memberContractId?: string;
  inventoryUnitKind: InventoryUnitKind;
  dates: string[];
  preserved?: CoverageCandidate[];
}): Promise<CoverageCandidate[]> {
  if (!options.memberContractId) return options.preserved ?? [];
  const contract = await db.selectFrom("member_contracts")
    .selectAll()
    .where("id", "=", options.memberContractId)
    .where("property_id", "=", options.propertyId)
    .executeTakeFirst();
  if (!contract || contract.status !== "ACTIVE") throw new DomainError("ENTITLEMENT_CONFLICT", "Membership contract is not active", 409);

  const unitKind = entitlementKindFor(options.inventoryUnitKind);
  const lots = await db.selectFrom("entitlement_lots")
    .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
    .select([
      "entitlement_lots.id",
      "entitlement_lots.expires_on",
      "entitlement_lots.total_units",
      sql<string>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("ledger_delta"),
      sql<string>`cast(count(*) filter (where entitlement_ledger.entry_type = 'EXPIRE') as text)`.as("expire_count")
    ])
    .where("entitlement_lots.contract_id", "=", options.memberContractId)
    .where("entitlement_lots.unit_kind", "=", unitKind)
    .groupBy(["entitlement_lots.id", "entitlement_lots.expires_on", "entitlement_lots.total_units"])
    .orderBy("entitlement_lots.expires_on")
    .orderBy("entitlement_lots.id")
    .execute();

  const eligibleLots = lots.filter((lot) => parsePostgresBigInt(lot.expire_count, "Entitlement expiration count") === 0n);
  const remaining = new Map(eligibleLots.map((lot) => [lot.id, entitlementAvailableBalance(lot.total_units, lot.ledger_delta)]));
  const result: CoverageCandidate[] = [];
  for (const preserved of options.preserved ?? []) {
    if (options.dates.includes(preserved.serviceDate)) result.push(preserved);
  }
  const alreadyCovered = new Set(result.map((candidate) => candidate.serviceDate));
  for (const serviceDate of options.dates) {
    if (alreadyCovered.has(serviceDate)) continue;
    if (serviceDate < contract.valid_from || serviceDate > contract.valid_until) continue;
    const lot = eligibleLots.find((candidate) => candidate.expires_on >= serviceDate && (remaining.get(candidate.id) ?? 0) > 0);
    if (!lot) continue;
    remaining.set(lot.id, (remaining.get(lot.id) ?? 0) - 1);
    result.push({ serviceDate, entitlementLotId: lot.id });
  }
  return result.sort((left, right) => left.serviceDate.localeCompare(right.serviceDate));
}

async function enforceQuoteQuota(db: Transaction<Database>, propertyId: string, requesterSubjectId?: string): Promise<void> {
  if (!requesterSubjectId) return;
  const active = await db.selectFrom("quotes")
    .select(sql<string>`cast(count(*) as text)`.as("count"))
    .where("requester_subject_id", "=", requesterSubjectId)
    .where("property_id", "=", propertyId)
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirstOrThrow();
  const activeCount = parsePostgresBigInt(active.count, "Active quote count");
  if (activeCount >= 200n) {
    throw new DomainError("RATE_LIMITED", "A subject may hold at most 200 unexpired quotes", 429, true, {
      activeQuoteCount: activeCount.toString(),
      limit: 200
    });
  }
}

export async function createQuoteInTransaction(db: Transaction<Database>, request: QuoteRequest): Promise<StoredQuote> {
  await enforceQuoteQuota(db, request.propertyId, request.requesterSubjectId);
  if (request.stayType === "FREE" && request.memberContractId) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Free stays cannot use member entitlement coverage", 409);
  }
  const unit = await loadInventoryUnit(db, request.propertyId, request.inventoryUnitId);
  const policy = await loadPricingPolicy(db, request.propertyId, request.pricingPolicyVersionId);
  const availability = await listAvailability(db, request.propertyId, request.arrivalDate, request.departureDate, unit.kind);
  const selected = availability.find((candidate) => candidate.id === unit.id);
  if (!selected?.available) throw new DomainError("INVENTORY_CONFLICT", "Inventory is not available for the requested dates", 409);
  const dates = enumerateServiceDates(request.arrivalDate, request.departureDate);
  const coverageCandidates = await allocateCoverageCandidates(db, {
    propertyId: request.propertyId,
    inventoryUnitKind: unit.kind,
    dates,
    ...(request.memberContractId ? { memberContractId: request.memberContractId } : {})
  });
  const calculated = calculatePricing({
    propertyId: request.propertyId,
    inventoryUnitId: unit.id,
    inventoryUnitKind: unit.kind,
    arrivalDate: request.arrivalDate,
    departureDate: request.departureDate,
    stayType: request.stayType,
    policy,
    coverageCandidates
  });
  const quoteId = newId("quote");
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const inputHash = stableHash(request);
  await db.insertInto("quotes").values({
    id: quoteId,
    property_id: request.propertyId,
    inventory_unit_id: unit.id,
    stay_type: request.stayType,
    arrival_date: request.arrivalDate,
    departure_date: request.departureDate,
    policy_version_id: policy.id,
    member_contract_id: request.memberContractId ?? null,
    requester_subject_id: request.requesterSubjectId ?? null,
    input_hash: inputHash,
    coverage_set: JSON.stringify(calculated.coverageSet),
    cash_lines: JSON.stringify(calculated.cashLines),
    cash_remainder_minor: calculated.cashRemainder.minorUnits,
    current_contract_amount_minor: calculated.currentContractAmount.minorUnits,
    currency: policy.currency,
    expires_at: expiresAt
  }).execute();
  return {
    quoteId,
    propertyId: request.propertyId,
    inventoryUnitId: unit.id,
    stayType: request.stayType,
    arrivalDate: request.arrivalDate,
    departureDate: request.departureDate,
    pricingPolicyVersionId: policy.id,
    coverageSet: calculated.coverageSet,
    cashLines: calculated.cashLines,
    cashRemainder: calculated.cashRemainder,
    currentContractAmount: calculated.currentContractAmount,
    expiresAt: expiresAt.toISOString(),
    ...(request.memberContractId ? { memberContractId: request.memberContractId } : {}),
    inputHash
  };
}

async function createQuoteSnapshot(db: Kysely<Database>, request: QuoteRequest): Promise<StoredQuote> {
  return db.transaction().setIsolationLevel("repeatable read").execute((trx) => createQuoteInTransaction(trx, request));
}

export async function createQuoteForTesting(db: Kysely<Database>, request: QuoteRequest): Promise<StoredQuote> {
  if (!request.requesterSubjectId) return createQuoteSnapshot(db, request);
  const lockKey = `qintopia:quote:${request.requesterSubjectId}`;
  return db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
    try {
      return await createQuoteSnapshot(connection, request);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
    }
  });
}

export async function loadStoredQuote(db: DbExecutor, quoteId: string, requireFresh = true): Promise<StoredQuote> {
  const row = await db.selectFrom("quotes").selectAll().where("id", "=", quoteId).executeTakeFirst();
  if (!row) throw new DomainError("NOT_FOUND", "Quote not found", 404);
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  if (requireFresh && expiresAt.getTime() <= Date.now()) throw new DomainError("QUOTE_EXPIRED", "Quote has expired", 409);
  return {
    quoteId: row.id,
    propertyId: row.property_id,
    inventoryUnitId: row.inventory_unit_id,
    stayType: row.stay_type as StayType,
    arrivalDate: row.arrival_date,
    departureDate: row.departure_date,
    pricingPolicyVersionId: row.policy_version_id,
    coverageSet: row.coverage_set as QuoteDto["coverageSet"],
    cashLines: row.cash_lines as QuoteDto["cashLines"],
    cashRemainder: { currency: row.currency, minorUnits: row.cash_remainder_minor },
    currentContractAmount: { currency: row.currency, minorUnits: row.current_contract_amount_minor },
    expiresAt: expiresAt.toISOString(),
    ...(row.member_contract_id ? { memberContractId: row.member_contract_id } : {}),
    inputHash: row.input_hash
  };
}

export async function lockEntitlementLots(trx: Transaction<Database>, contractId?: string): Promise<void> {
  if (!contractId) return;
  await trx.selectFrom("member_contracts").select("id").where("id", "=", contractId).forUpdate().executeTakeFirstOrThrow();
  await trx.selectFrom("entitlement_lots").select("id").where("contract_id", "=", contractId).orderBy("id").forUpdate().execute();
}
