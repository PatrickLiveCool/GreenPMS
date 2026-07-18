import { sql } from "kysely";
import { DomainError, type CommandType, type CoverageItemDto, type InventoryUnitKind, type StayType } from "@qintopia/contracts";
import { calculatePricing, enumerateServiceDates, parseLocalDate, stableHash, type PricingResult } from "@qintopia/domain";
import { adjustedEntitlementAvailableBalance, entitlementAvailableBalance, parsePostgresBigInt } from "../entitlement-balance.ts";
import { activeCoverageCandidates, loadActiveStayTimeline, loadOrderContext, orderAmountSummary, type StayTimelineItem } from "../orders.ts";
import { allocateCoverageCandidates, loadPricingPolicy, loadStoredQuote } from "../pricing-service.ts";
import { inventoryFingerprint, loadInventoryUnit, type DbExecutor } from "../inventory.ts";

export interface BuiltCommandEffect {
  propertyId: string;
  effect: Record<string, unknown>;
  basisVersions: Record<string, unknown>;
  effectHash: string;
}

export function requireObject(value: unknown, field = "input"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainError("VALIDATION_ERROR", `${field} must be an object`);
  return value as Record<string, unknown>;
}

export function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") throw new DomainError("VALIDATION_ERROR", `${field} is required`);
  return value.trim();
}

export function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", `${field} must be a string`);
  return value.trim();
}

const strictDateTime = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256Hex = /^[a-f0-9]{64}$/;

function requireFutureDateTime(input: Record<string, unknown>, field: string): string {
  const value = requireString(input, field);
  const match = strictDateTime.exec(value);
  if (!match) throw new DomainError("VALIDATION_ERROR", `${field} must be an RFC 3339 date-time`);
  parseLocalDate(match[1]!);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a valid date-time`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new DomainError("VALIDATION_ERROR", `${field} must be in the future`);
  return value;
}

function optionalTokenSecretHash(input: Record<string, unknown>): string | undefined {
  const value = input.tokenSecretHash;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !sha256Hex.test(value)) {
    throw new DomainError("VALIDATION_ERROR", "tokenSecretHash must be a 64-character lowercase SHA-256 hex digest");
  }
  return value;
}

function requireTokenSecretHash(input: Record<string, unknown>): string {
  const value = optionalTokenSecretHash(input);
  if (!value) throw new DomainError("VALIDATION_ERROR", "tokenSecretHash is required for Token rotation");
  return value;
}

export function requireInteger(input: Record<string, unknown>, field: string, options: { min?: number; allowZero?: boolean } = {}): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || (value as number) < -2_147_483_648 || (value as number) > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a safe PostgreSQL integer`);
  }
  const number = value as number;
  if (options.min !== undefined && number < options.min) throw new DomainError("VALIDATION_ERROR", `${field} must be at least ${options.min}`);
  if (options.allowZero === false && number === 0) throw new DomainError("VALIDATION_ERROR", `${field} must not be zero`);
  return number;
}

function optionalInteger(input: Record<string, unknown>, field: string): number {
  if (input[field] === undefined) return 0;
  return requireInteger(input, field);
}

function assertOrderMutable(status: string): void {
  if (!new Set(["RESERVED", "CHECKED_IN"]).has(status)) throw new DomainError("INVALID_ORDER_STATE", `Order cannot be changed from ${status}`, 409);
}

async function memberBasis(db: DbExecutor, memberContractId: string | null) {
  if (!memberContractId) return null;
  const contract = await db.selectFrom("member_contracts").select(["id", "version", "status"]).where("id", "=", memberContractId).executeTakeFirst();
  const lots = await db.selectFrom("entitlement_lots")
    .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
    .select(["entitlement_lots.id", "entitlement_lots.version", sql<string>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("delta")])
    .where("entitlement_lots.contract_id", "=", memberContractId)
    .groupBy(["entitlement_lots.id", "entitlement_lots.version"])
    .orderBy("entitlement_lots.id").execute();
  return {
    contract,
    lots: lots.map((lot) => ({ ...lot, delta: parsePostgresBigInt(lot.delta, "Entitlement ledger sum").toString() }))
  };
}

async function priceSingleUnit(db: DbExecutor, options: {
  propertyId: string;
  orderId?: string;
  memberContractId: string | null;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  stayType: StayType;
  policyVersionId: string;
  manualAdjustmentMinor: number;
}): Promise<PricingResult> {
  if (options.stayType === "FREE" && options.memberContractId) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Free stays cannot use member entitlement coverage", 409);
  }
  const unit = await loadInventoryUnit(db, options.propertyId, options.unitId);
  const dates = enumerateServiceDates(options.arrivalDate, options.departureDate);
  const preserved = options.orderId ? await activeCoverageCandidates(db, options.orderId, dates) : [];
  const candidates = await allocateCoverageCandidates(db, {
    propertyId: options.propertyId,
    inventoryUnitKind: unit.kind,
    dates,
    preserved,
    ...(options.memberContractId ? { memberContractId: options.memberContractId } : {})
  });
  const policy = await loadPricingPolicy(db, options.propertyId, options.policyVersionId);
  return calculatePricing({
    propertyId: options.propertyId,
    inventoryUnitId: unit.id,
    inventoryUnitKind: unit.kind,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    stayType: options.stayType,
    policy,
    coverageCandidates: candidates,
    manualAdjustmentMinor: options.manualAdjustmentMinor
  });
}

function nextServiceDate(serviceDate: string): string {
  const date = parseLocalDate(serviceDate);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function timelineRuns(timeline: StayTimelineItem[]): Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }> {
  const runs: Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }> = [];
  for (const item of timeline) {
    const current = runs.at(-1);
    if (current && current.inventoryUnitId === item.inventoryUnitId && current.departureDate === item.serviceDate) {
      current.departureDate = nextServiceDate(item.serviceDate);
    } else {
      runs.push({ inventoryUnitId: item.inventoryUnitId, arrivalDate: item.serviceDate, departureDate: nextServiceDate(item.serviceDate) });
    }
  }
  return runs;
}

async function priceStayTimeline(db: DbExecutor, options: {
  propertyId: string;
  orderId: string;
  memberContractId: string | null;
  arrivalDate: string;
  departureDate: string;
  stayType: StayType;
  policyVersionId: string;
  timeline: StayTimelineItem[];
  manualAdjustmentMinor: number;
}): Promise<PricingResult> {
  if (options.stayType === "FREE" && options.memberContractId) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Free stays cannot use member entitlement coverage", 409);
  }
  const expectedDates = enumerateServiceDates(options.arrivalDate, options.departureDate);
  if (expectedDates.length !== options.timeline.length || expectedDates.some((date, index) => options.timeline[index]?.serviceDate !== date)) {
    throw new DomainError("INTERNAL_ERROR", "Stay pricing timeline does not cover the order interval", 500);
  }

  const unitIds = [...new Set(options.timeline.map((item) => item.inventoryUnitId))];
  const units = new Map((await Promise.all(unitIds.map((unitId) => loadInventoryUnit(db, options.propertyId, unitId)))).map((unit) => [unit.id, unit]));
  const unitKinds = new Set([...units.values()].map((unit) => unit.kind));
  if (options.memberContractId && unitKinds.size !== 1) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Member coverage cannot span room and bed inventory without an approved business case", 409);
  }

  const preserved = await activeCoverageCandidates(db, options.orderId, expectedDates);
  const firstUnit = units.get(options.timeline[0]!.inventoryUnitId)!;
  const candidates = await allocateCoverageCandidates(db, {
    propertyId: options.propertyId,
    inventoryUnitKind: firstUnit.kind,
    dates: expectedDates,
    preserved,
    ...(options.memberContractId ? { memberContractId: options.memberContractId } : {})
  });
  const policy = await loadPricingPolicy(db, options.propertyId, options.policyVersionId);
  const pieces = timelineRuns(options.timeline).map((run) => {
    const unit = units.get(run.inventoryUnitId)!;
    return calculatePricing({
      propertyId: options.propertyId,
      inventoryUnitId: unit.id,
      inventoryUnitKind: unit.kind,
      arrivalDate: run.arrivalDate,
      departureDate: run.departureDate,
      stayType: options.stayType,
      policy,
      coverageCandidates: candidates.filter((candidate) => candidate.serviceDate >= run.arrivalDate && candidate.serviceDate < run.departureDate),
      manualAdjustmentMinor: 0
    });
  });
  const cashRemainderMinor = pieces.reduce((sum, piece) => sum + piece.cashRemainder.minorUnits, 0);
  const currentContractAmountMinor = cashRemainderMinor + options.manualAdjustmentMinor;
  if (!Number.isSafeInteger(cashRemainderMinor) || !Number.isSafeInteger(currentContractAmountMinor)
    || cashRemainderMinor > 2_147_483_647
    || currentContractAmountMinor < -2_147_483_648
    || currentContractAmountMinor > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", "Calculated amount exceeds the supported integer range");
  }
  return {
    coverageSet: pieces.flatMap((piece) => piece.coverageSet),
    cashLines: pieces.flatMap((piece) => piece.cashLines),
    cashRemainder: { currency: policy.currency, minorUnits: cashRemainderMinor },
    currentContractAmount: { currency: policy.currency, minorUnits: currentContractAmountMinor }
  };
}

async function activeRefundedAmount(db: DbExecutor, collectionFactId: string): Promise<number> {
  const refunds = await db.selectFrom("collection_facts as refund")
    .leftJoin("collection_facts as reversal", "reversal.reverses_fact_id", "refund.fact_id")
    .select(["refund.amount_minor", "reversal.fact_id as reversal_id"])
    .where("refund.references_fact_id", "=", collectionFactId)
    .where("refund.fact_type", "=", "REFUND")
    .execute();
  return refunds.filter((refund) => !refund.reversal_id).reduce((sum, refund) => sum + refund.amount_minor, 0);
}

function finalize(propertyId: string, effect: Record<string, unknown>, basisVersions: Record<string, unknown>): BuiltCommandEffect {
  return { propertyId, effect, basisVersions, effectHash: stableHash({ effect, basisVersions }) };
}

export async function buildCommandEffect(db: DbExecutor, commandType: CommandType, rawInput: unknown): Promise<BuiltCommandEffect> {
  const input = requireObject(rawInput);
  const propertyId = requireString(input, "propertyId");

  if (commandType === "LOCK_MAINTENANCE") {
    const arrivalDate = requireString(input, "arrivalDate");
    const departureDate = requireString(input, "departureDate");
    parseLocalDate(arrivalDate);
    parseLocalDate(departureDate);
    enumerateServiceDates(arrivalDate, departureDate);
  }
  if (commandType === "EXTEND_STAY") {
    parseLocalDate(requireString(input, "newDepartureDate"));
  }

  if (commandType === "CREATE_ORDER") {
    const quoteId = requireString(input, "quoteId");
    const guest = requireObject(input.primaryGuest, "primaryGuest");
    requireString(guest, "fullName");
    const quote = await loadStoredQuote(db, quoteId);
    if (quote.propertyId !== propertyId) throw new DomainError("RESOURCE_SCOPE_DENIED", "Quote belongs to another property", 403);
    const unit = await loadInventoryUnit(db, propertyId, quote.inventoryUnitId);
    const fingerprint = await inventoryFingerprint(db, propertyId, unit.id, quote.arrivalDate, quote.departureDate);
    if (fingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Quoted inventory is no longer available", 409);
    const pricing = await priceSingleUnit(db, {
      propertyId,
      memberContractId: quote.memberContractId ?? null,
      unitId: quote.inventoryUnitId,
      arrivalDate: quote.arrivalDate,
      departureDate: quote.departureDate,
      stayType: quote.stayType,
      policyVersionId: quote.pricingPolicyVersionId,
      manualAdjustmentMinor: 0
    });
    const effect = {
      quoteId,
      primaryGuest: guest,
      inventoryUnit: unit,
      stayType: quote.stayType,
      arrivalDate: quote.arrivalDate,
      departureDate: quote.departureDate,
      pricingPolicyVersionId: quote.pricingPolicyVersionId,
      memberContractId: quote.memberContractId ?? null,
      pricing
    };
    return finalize(propertyId, effect, { quoteInputHash: quote.inputHash, inventory: fingerprint, membership: await memberBasis(db, quote.memberContractId ?? null) });
  }

  if (commandType === "LOCK_MAINTENANCE") {
    const unitId = requireString(input, "inventoryUnitId");
    const arrivalDate = requireString(input, "arrivalDate");
    const departureDate = requireString(input, "departureDate");
    const reason = requireString(input, "reason");
    const unit = await loadInventoryUnit(db, propertyId, unitId);
    const fingerprint = await inventoryFingerprint(db, propertyId, unitId, arrivalDate, departureDate);
    if (fingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Inventory cannot be locked for maintenance", 409);
    return finalize(propertyId, { inventoryUnit: unit, arrivalDate, departureDate, reason }, { inventory: fingerprint });
  }

  if (commandType === "RELEASE_MAINTENANCE") {
    const maintenanceLockId = requireString(input, "maintenanceLockId");
    const lock = await db.selectFrom("maintenance_locks").selectAll().where("id", "=", maintenanceLockId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!lock) throw new DomainError("NOT_FOUND", "Maintenance lock not found", 404);
    if (lock.status !== "ACTIVE") throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Maintenance lock is already released", 409);
    return finalize(propertyId, { maintenanceLockId, inventoryUnitId: lock.inventory_unit_id, arrivalDate: lock.arrival_date, departureDate: lock.departure_date }, { maintenanceVersion: lock.version, status: lock.status });
  }

  if (commandType === "ADJUST_MEMBER_ENTITLEMENT") {
    const lotId = requireString(input, "entitlementLotId");
    const quantityDelta = requireInteger(input, "quantityDelta", { allowZero: false });
    const adjustmentReason = requireString(input, "adjustmentReason");
    const lot = await db.selectFrom("entitlement_lots").innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.id", "entitlement_lots.version", "entitlement_lots.contract_id", "entitlement_lots.unit_kind", "entitlement_lots.total_units", "member_contracts.property_id", "member_contracts.version as contract_version"])
      .where("entitlement_lots.id", "=", lotId).where("member_contracts.property_id", "=", propertyId).executeTakeFirst();
    if (!lot) throw new DomainError("NOT_FOUND", "Entitlement lot not found", 404);
    const expiration = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("lot_id", "=", lotId).where("entry_type", "=", "EXPIRE").executeTakeFirst();
    if (expiration) throw new DomainError("ENTITLEMENT_CONFLICT", "An expired entitlement lot cannot be adjusted", 409, false, { expirationFactId: expiration.fact_id });
    const ledger = await db.selectFrom("entitlement_ledger")
      .select(sql<string>`cast(coalesce(sum(quantity_delta), 0) as text)`.as("delta"))
      .where("lot_id", "=", lotId)
      .executeTakeFirstOrThrow();
    const availableBefore = entitlementAvailableBalance(lot.total_units, ledger.delta);
    const availableAfter = adjustedEntitlementAvailableBalance(availableBefore, quantityDelta);
    return finalize(propertyId, {
      entitlementLotId: lot.id,
      contractId: lot.contract_id,
      unitKind: lot.unit_kind,
      quantityDelta,
      adjustmentReason,
      availableBefore,
      availableAfter
    }, {
      lotVersion: lot.version,
      contractVersion: lot.contract_version,
      availableBefore
    });
  }

  if (commandType === "EXPIRE_MEMBER_ENTITLEMENT") {
    const lotId = requireString(input, "entitlementLotId");
    const asOfDate = requireString(input, "asOfDate");
    const asOf = parseLocalDate(asOfDate);
    const lot = await db.selectFrom("entitlement_lots")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
      .select([
        "entitlement_lots.id",
        "entitlement_lots.version",
        "entitlement_lots.contract_id",
        "entitlement_lots.unit_kind",
        "entitlement_lots.total_units",
        "entitlement_lots.expires_on",
        "member_contracts.property_id",
        "member_contracts.version as contract_version",
        sql<string>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("ledger_delta"),
        sql<string>`cast(count(*) filter (where entitlement_ledger.entry_type = 'EXPIRE') as text)`.as("expire_count")
      ])
      .where("entitlement_lots.id", "=", lotId)
      .where("member_contracts.property_id", "=", propertyId)
      .groupBy([
        "entitlement_lots.id",
        "entitlement_lots.version",
        "entitlement_lots.contract_id",
        "entitlement_lots.unit_kind",
        "entitlement_lots.total_units",
        "entitlement_lots.expires_on",
        "member_contracts.property_id",
        "member_contracts.version"
    ])
      .executeTakeFirst();
    if (!lot) throw new DomainError("NOT_FOUND", "Entitlement lot not found", 404);
    if (parsePostgresBigInt(lot.expire_count, "Entitlement expiration count") > 0n) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot is already expired", 409);
    }
    if (asOf.getTime() <= parseLocalDate(lot.expires_on).getTime()) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot is still valid on asOfDate", 409, false, { expiresOn: lot.expires_on, asOfDate });
    }
    const remainingAvailable = entitlementAvailableBalance(lot.total_units, lot.ledger_delta);
    return finalize(propertyId, {
      entitlementLotId: lot.id,
      contractId: lot.contract_id,
      unitKind: lot.unit_kind,
      expiresOn: lot.expires_on,
      asOfDate,
      remainingAvailable,
      quantityDelta: -remainingAvailable,
      entryType: "EXPIRE"
    }, {
      lotVersion: lot.version,
      contractVersion: lot.contract_version,
      remainingAvailable
    });
  }

  if (commandType === "ISSUE_TOKEN") {
    const subjectId = requireString(input, "subjectId");
    const label = requireString(input, "label");
    const accessCeiling = requireString(input, "accessCeiling");
    if (accessCeiling !== "READ" && accessCeiling !== "WRITE") throw new DomainError("VALIDATION_ERROR", "accessCeiling must be READ or WRITE");
    const expiresAt = requireFutureDateTime(input, "expiresAt");
    const tokenSecretHash = optionalTokenSecretHash(input);
    const subject = await db.selectFrom("subjects").innerJoin("subject_property_grants", "subject_property_grants.subject_id", "subjects.id")
      .select(["subjects.id", "subjects.status", "subjects.auth_version", "subject_property_grants.access_level"])
      .where("subjects.id", "=", subjectId).where("subject_property_grants.property_id", "=", propertyId).executeTakeFirst();
    if (!subject || subject.status !== "ACTIVE") throw new DomainError("SUBJECT_DISABLED", "Subject is not active for this property", 409);
    if (subject.access_level === "READ" && accessCeiling === "WRITE") throw new DomainError("INSUFFICIENT_ACCESS", "Token cannot exceed subject READ access", 403);
    return finalize(propertyId, { subjectId, label, accessCeiling, expiresAt }, {
      subjectAuthVersion: subject.auth_version,
      subjectAccess: subject.access_level,
      ...(tokenSecretHash ? { tokenSecretHash } : {})
    });
  }

  if (commandType === "ROTATE_TOKEN" || commandType === "REVOKE_TOKEN") {
    const tokenId = requireString(input, "tokenId");
    const token = await db.selectFrom("api_tokens").innerJoin("subjects", "subjects.id", "api_tokens.subject_id")
      .select(["api_tokens.id", "api_tokens.subject_id", "api_tokens.label", "api_tokens.access_ceiling", "api_tokens.property_scope", "api_tokens.expires_at", "api_tokens.revoked_at", "api_tokens.replaced_by_id", "subjects.auth_version"])
      .where("api_tokens.id", "=", tokenId).where("api_tokens.property_scope", "=", propertyId).executeTakeFirst();
    if (!token) throw new DomainError("NOT_FOUND", "Token not found", 404);
    if (token.revoked_at) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Token is already revoked", 409);
    const requestedExpiresAt = optionalString(input, "expiresAt");
    const expiresAt = commandType === "ROTATE_TOKEN"
      ? (requestedExpiresAt ? requireFutureDateTime(input, "expiresAt") : new Date(token.expires_at).toISOString())
      : new Date(token.expires_at).toISOString();
    if (commandType === "ROTATE_TOKEN" && Date.parse(expiresAt) <= Date.now()) throw new DomainError("VALIDATION_ERROR", "Rotated token expiry must be in the future");
    const tokenSecretHash = commandType === "ROTATE_TOKEN" ? requireTokenSecretHash(input) : undefined;
    return finalize(propertyId, {
      tokenId: token.id, subjectId: token.subject_id, label: token.label, accessCeiling: token.access_ceiling,
      expiresAt, operation: commandType === "ROTATE_TOKEN" ? "ROTATE" : "REVOKE"
    }, {
      tokenRevokedAt: token.revoked_at,
      replacedById: token.replaced_by_id,
      subjectAuthVersion: token.auth_version,
      ...(tokenSecretHash ? { tokenSecretHash } : {})
    });
  }

  const orderId = requireString(input, "orderId");
  const context = await loadOrderContext(db, orderId);
  if (context.order.property_id !== propertyId) throw new DomainError("RESOURCE_SCOPE_DENIED", "Order belongs to another property", 403);
  const baseBasis: Record<string, unknown> = {
    orderVersion: context.order.version,
    orderStatus: context.order.status,
    policyVersionId: context.order.pricing_policy_version_id,
    membership: await memberBasis(db, context.order.member_contract_id)
  };

  if (commandType === "SHORTEN_STAY") {
    assertOrderMutable(context.order.status);
    const newDepartureDate = requireString(input, "newDepartureDate");
    const dates = enumerateServiceDates(context.order.arrival_date, newDepartureDate);
    if (newDepartureDate >= context.order.departure_date) throw new DomainError("VALIDATION_ERROR", "New departure must shorten the stay");
    const currentTimeline = await loadActiveStayTimeline(db, context);
    const stayTimeline = currentTimeline.filter((item) => item.serviceDate < newDepartureDate);
    const pricing = await priceStayTimeline(db, {
      propertyId, orderId, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: newDepartureDate,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: optionalInteger(input, "manualAdjustmentMinor")
    });
    return finalize(propertyId, {
      orderId, inventoryUnitId: stayTimeline.at(-1)!.inventoryUnitId,
      before: { departureDate: context.order.departure_date, currentContractAmount: (await orderAmountSummary(db, context)).currentContractAmount },
      after: { departureDate: newDepartureDate, nights: dates.length, stayTimeline, pricing }
    }, { ...baseBasis, stayTimeline: currentTimeline });
  }

  if (commandType === "EXTEND_STAY") {
    assertOrderMutable(context.order.status);
    const newDepartureDate = requireString(input, "newDepartureDate");
    if (newDepartureDate <= context.order.departure_date) throw new DomainError("VALIDATION_ERROR", "New departure must extend the stay");
    const currentTimeline = await loadActiveStayTimeline(db, context);
    const extensionUnitId = currentTimeline.at(-1)!.inventoryUnitId;
    const extraFingerprint = await inventoryFingerprint(db, propertyId, extensionUnitId, context.order.departure_date, newDepartureDate, context.segmentIds);
    if (extraFingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Extension inventory is unavailable", 409);
    const stayTimeline = [
      ...currentTimeline,
      ...enumerateServiceDates(context.order.departure_date, newDepartureDate).map((serviceDate) => ({ serviceDate, inventoryUnitId: extensionUnitId }))
    ];
    const pricing = await priceStayTimeline(db, {
      propertyId, orderId, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: newDepartureDate,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: optionalInteger(input, "manualAdjustmentMinor")
    });
    return finalize(propertyId, {
      orderId, inventoryUnitId: extensionUnitId,
      before: { departureDate: context.order.departure_date, currentContractAmount: (await orderAmountSummary(db, context)).currentContractAmount },
      after: { departureDate: newDepartureDate, stayTimeline, pricing }
    }, { ...baseBasis, stayTimeline: currentTimeline, inventory: extraFingerprint });
  }

  if (commandType === "MOVE_UNIT") {
    assertOrderMutable(context.order.status);
    const newInventoryUnitId = requireString(input, "newInventoryUnitId");
    const effectiveDate = requireString(input, "effectiveDate");
    parseLocalDate(effectiveDate);
    if (effectiveDate < context.order.arrival_date || effectiveDate >= context.order.departure_date) throw new DomainError("VALIDATION_ERROR", "effectiveDate must be within the stay");
    const currentTimeline = await loadActiveStayTimeline(db, context);
    const effectiveUnitId = currentTimeline.find((item) => item.serviceDate === effectiveDate)!.inventoryUnitId;
    const currentUnit = await loadInventoryUnit(db, propertyId, effectiveUnitId);
    const newUnit = await loadInventoryUnit(db, propertyId, newInventoryUnitId);
    if (currentUnit.id === newUnit.id) throw new DomainError("VALIDATION_ERROR", "New inventory unit must differ from the current unit");
    if (context.order.member_contract_id && currentUnit.kind !== newUnit.kind) throw new DomainError("ENTITLEMENT_CONFLICT", "Cross-kind move with member coverage requires an approved business case", 409);
    const fingerprint = await inventoryFingerprint(db, propertyId, newUnit.id, effectiveDate, context.order.departure_date, context.segmentIds);
    if (fingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Destination inventory is unavailable", 409);
    const stayTimeline = currentTimeline.map((item) => item.serviceDate < effectiveDate ? item : { ...item, inventoryUnitId: newUnit.id });
    const pricing = await priceStayTimeline(db, {
      propertyId, orderId, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: optionalInteger(input, "manualAdjustmentMinor")
    });
    return finalize(propertyId, { orderId, fromInventoryUnit: currentUnit, toInventoryUnit: newUnit, effectiveDate, stayTimeline, pricing }, { ...baseBasis, stayTimeline: currentTimeline, inventory: fingerprint });
  }

  if (commandType === "REPRICE_ORDER") {
    assertOrderMutable(context.order.status);
    const manualAdjustmentMinor = requireInteger(input, "manualAdjustmentMinor");
    const stayTimeline = await loadActiveStayTimeline(db, context);
    const pricing = await priceStayTimeline(db, {
      propertyId, orderId, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor
    });
    return finalize(propertyId, {
      orderId, inventoryUnitId: stayTimeline.at(-1)!.inventoryUnitId, stayTimeline,
      before: { currentContractAmount: (await orderAmountSummary(db, context)).currentContractAmount },
      pricing, manualAdjustmentMinor
    }, { ...baseBasis, stayTimeline });
  }

  if (commandType === "RECORD_COLLECTION") {
    const amountMinor = requireInteger(input, "amountMinor", { min: 1 });
    const method = requireString(input, "method");
    if (!["RESERVED", "CHECKED_IN", "CHECKED_OUT"].includes(context.order.status)) throw new DomainError("INVALID_ORDER_STATE", "Cannot record a collection for this order", 409);
    return finalize(propertyId, { orderId, amountMinor, currency: context.revision.currency, method, note: optionalString(input, "note") ?? "" }, baseBasis);
  }

  if (commandType === "RECORD_REFUND") {
    const amountMinor = requireInteger(input, "amountMinor", { min: 1 });
    const referencesFactId = requireString(input, "referencesFactId");
    const original = await db.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .selectAll("collection_facts")
      .where("collection_facts.fact_id", "=", referencesFactId)
      .where("orders.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!original) throw new DomainError("NOT_FOUND", "Referenced collection fact not found", 404);
    if (original.order_id !== orderId) throw new DomainError("CROSS_ORDER_FACT_REFERENCE", "Refund must reference a collection in the same order", 409);
    if (original.fact_type !== "COLLECTION") throw new DomainError("VALIDATION_ERROR", "Refund must reference a collection fact");
    const originalReversal = await db.selectFrom("collection_facts").select("fact_id").where("reverses_fact_id", "=", referencesFactId).executeTakeFirst();
    if (originalReversal) throw new DomainError("FACT_ALREADY_REVERSED", "Cannot refund a reversed collection", 409, false, { reversalFactId: originalReversal.fact_id });
    const activeRefunded = await activeRefundedAmount(db, referencesFactId);
    if (activeRefunded + amountMinor > original.amount_minor) throw new DomainError("REFUND_LIMIT_EXCEEDED", "Refund exceeds the remaining referenced collection", 409);
    return finalize(propertyId, { orderId, amountMinor, currency: original.currency, referencesFactId, method: requireString(input, "method"), note: optionalString(input, "note") ?? "" }, { ...baseBasis, originalFact: original, activeRefunded });
  }

  if (commandType === "REVERSE_FACT") {
    const reversesFactId = requireString(input, "reversesFactId");
    const original = await db.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .selectAll("collection_facts")
      .where("collection_facts.fact_id", "=", reversesFactId)
      .where("orders.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!original) throw new DomainError("NOT_FOUND", "Fact not found", 404);
    if (original.order_id !== orderId) throw new DomainError("CROSS_ORDER_FACT_REFERENCE", "Reversal must remain within the order", 409);
    if (original.fact_type === "REVERSAL") throw new DomainError("VALIDATION_ERROR", "A reversal fact cannot itself be reversed");
    const reversal = await db.selectFrom("collection_facts").select("fact_id").where("reverses_fact_id", "=", reversesFactId).executeTakeFirst();
    if (reversal) throw new DomainError("FACT_ALREADY_REVERSED", "Fact is already reversed", 409);
    const activeRefunded = original.fact_type === "COLLECTION" ? await activeRefundedAmount(db, reversesFactId) : 0;
    if (activeRefunded > 0) {
      throw new DomainError("REFUND_LIMIT_EXCEEDED", "Reverse active refunds before reversing their collection", 409, false, { activeRefunded });
    }
    return finalize(propertyId, { orderId, reversesFactId, amountMinor: original.amount_minor, netEffectMinor: -original.net_effect_minor, currency: original.currency, note: requireString(input, "note") }, { ...baseBasis, originalFact: original, activeRefunded });
  }

  if (commandType === "CHECK_IN") {
    if (context.order.status !== "RESERVED") throw new DomainError("INVALID_ORDER_STATE", "Only a reserved order can check in", 409);
    return finalize(propertyId, { orderId, fromStatus: context.order.status, toStatus: "CHECKED_IN", inventoryUnitId: context.currentSegment.inventoryUnitId }, baseBasis);
  }

  if (commandType === "CHECK_OUT") {
    if (context.order.status !== "CHECKED_IN") throw new DomainError("INVALID_ORDER_STATE", "Only an in-house order can check out", 409);
    return finalize(propertyId, { orderId, fromStatus: context.order.status, toStatus: "CHECKED_OUT", inventoryUnitId: context.currentSegment.inventoryUnitId, amounts: await orderAmountSummary(db, context) }, baseBasis);
  }

  if (commandType === "CANCEL_ORDER" || commandType === "MARK_NO_SHOW") {
    if (context.order.status !== "RESERVED") throw new DomainError("INVALID_ORDER_STATE", `${commandType} requires a reserved order`, 409);
    return finalize(propertyId, { orderId, fromStatus: context.order.status, toStatus: commandType === "CANCEL_ORDER" ? "CANCELLED" : "NO_SHOW", inventoryUnitId: context.currentSegment.inventoryUnitId }, baseBasis);
  }

  throw new DomainError("VALIDATION_ERROR", `Unsupported command type: ${commandType}`);
}

export function coverageFromEffect(effect: Record<string, unknown>): CoverageItemDto[] {
  const pricing = requireObject(effect.pricing ?? requireObject(effect.after, "after").pricing, "pricing");
  const coverageSet = pricing.coverageSet;
  if (!Array.isArray(coverageSet)) throw new DomainError("INTERNAL_ERROR", "Effect pricing has no coverage set", 500);
  return coverageSet as CoverageItemDto[];
}

export function inventoryKindFromEffect(effect: Record<string, unknown>): InventoryUnitKind | undefined {
  const unit = effect.inventoryUnit ?? effect.toInventoryUnit;
  if (!unit || typeof unit !== "object") return undefined;
  const kind = (unit as Record<string, unknown>).kind;
  return kind === "ROOM" || kind === "BED" ? kind : undefined;
}
