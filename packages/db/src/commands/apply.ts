import { sql, type Transaction } from "kysely";
import { DomainError, type CommandReason, type CommandType, type CoverageItemDto } from "@qintopia/contracts";
import { enumerateServiceDates, newId, parseLocalDate, requireTransactionReference, validateBookingChannel } from "@qintopia/domain";
import { createInventoryClaims, loadInventoryUnit, lockRoomDays, lockUnitDates, releaseInventoryClaims } from "../inventory.ts";
import { appendAmendment, consumeCoverage, holdCoverage, incrementContractAndLotVersions, loadActiveStayTimeline, loadOrderContext, lockOrder, reconcileCoverage, releaseCoverage, type StayTimelineItem } from "../orders.ts";
import { loadStoredQuote, lockEntitlementLots } from "../pricing-service.ts";
import type { Database } from "../schema.ts";
import { normalizeIdentityCardNumber, requireObject, requireString } from "./effects.ts";

export interface AppliedCommand {
  persistedResult: Record<string, unknown>;
  resourceRefs: string[];
  factRefs: string[];
}

function rethrowTokenSecretConflict(error: unknown): never {
  const databaseError = error as { code?: unknown; constraint?: unknown };
  if (databaseError.code === "23505" && databaseError.constraint === "api_tokens_secret_hash_key") {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Token secret is already assigned", 409);
  }
  throw error;
}

function rethrowMemberRegistrationConflict(error: unknown): never {
  const databaseError = error as { code?: unknown; constraint?: unknown };
  if (databaseError.code === "23505" && (
    databaseError.constraint === "members_identity_card_number_key"
    || databaseError.constraint === "member_external_references_source_key"
  )) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Member identity or external application linkage changed after Preview", 409);
  }
  throw error;
}

function nestedObject(record: Record<string, unknown>, field: string): Record<string, unknown> {
  return requireObject(record[field], field);
}

function pricingObject(effect: Record<string, unknown>): Record<string, unknown> {
  if (effect.pricing) return requireObject(effect.pricing, "pricing");
  return nestedObject(nestedObject(effect, "after"), "pricing");
}

function moneyMinor(value: unknown, field: string): { currency: string; minorUnits: number } {
  const money = requireObject(value, field);
  const currency = requireString(money, "currency");
  if (!Number.isInteger(money.minorUnits)) throw new DomainError("INTERNAL_ERROR", `${field}.minorUnits is invalid`, 500);
  return { currency, minorUnits: money.minorUnits as number };
}

function pricingSnapshot(effect: Record<string, unknown>) {
  const pricing = pricingObject(effect);
  const coverageSet = pricing.coverageSet;
  const cashLines = pricing.cashLines;
  if (!Array.isArray(coverageSet) || !Array.isArray(cashLines)) throw new DomainError("INTERNAL_ERROR", "Pricing effect is invalid", 500);
  const contract = moneyMinor(pricing.currentContractAmount, "currentContractAmount");
  const cashRemainder = moneyMinor(pricing.cashRemainder, "cashRemainder");
  return {
    coverageSet: coverageSet as CoverageItemDto[],
    cashLines,
    currentContractAmountMinor: contract.minorUnits,
    manualAdjustmentMinor: contract.minorUnits - cashRemainder.minorUnits,
    currency: contract.currency
  };
}

function stayTimelineFromEffect(effect: Record<string, unknown>): StayTimelineItem[] {
  const after = effect.after && typeof effect.after === "object" && !Array.isArray(effect.after) ? effect.after as Record<string, unknown> : undefined;
  const rawTimeline = effect.stayTimeline ?? after?.stayTimeline;
  if (!Array.isArray(rawTimeline) || rawTimeline.length === 0) throw new DomainError("INTERNAL_ERROR", "Command effect has no stay timeline", 500);
  return rawTimeline.map((rawItem, index) => {
    const item = requireObject(rawItem, `stayTimeline[${index}]`);
    return { serviceDate: requireString(item, "serviceDate"), inventoryUnitId: requireString(item, "inventoryUnitId") };
  });
}

function trailingTimelineRun(timeline: StayTimelineItem[]): { inventoryUnitId: string; arrivalDate: string } {
  const last = timeline.at(-1)!;
  let startIndex = timeline.length - 1;
  while (startIndex > 0 && timeline[startIndex - 1]!.inventoryUnitId === last.inventoryUnitId) startIndex -= 1;
  return { inventoryUnitId: last.inventoryUnitId, arrivalDate: timeline[startIndex]!.serviceDate };
}

async function roomDatesForTimeline(trx: Transaction<Database>, propertyId: string, timeline: StayTimelineItem[]) {
  const unitIds = [...new Set(timeline.map((item) => item.inventoryUnitId))];
  const units = new Map((await Promise.all(unitIds.map((unitId) => loadInventoryUnit(trx, propertyId, unitId)))).map((unit) => [unit.id, unit]));
  return timeline.map((item) => ({ roomId: units.get(item.inventoryUnitId)!.roomId, serviceDate: item.serviceDate }));
}

export async function lockCommandResources(trx: Transaction<Database>, commandType: CommandType, rawInput: unknown): Promise<void> {
  const input = requireObject(rawInput);
  const propertyId = requireString(input, "propertyId");

  if (commandType === "CREATE_MEMBER") {
    const identityCardNumber = normalizeIdentityCardNumber(input.identityCardNumber);
    const sourceApplicationRecordId = typeof input.sourceApplicationRecordId === "string" && input.sourceApplicationRecordId.trim()
      ? input.sourceApplicationRecordId.trim()
      : undefined;
    const lockKeys = [`qintopia:member-identity:${identityCardNumber}`];
    if (sourceApplicationRecordId) {
      lockKeys.push(`qintopia:member-external:FEISHU_BASE:wiki:FtxUwOE6diwS8wkmaawcDhEPnMc:tbl4OryeWd0Td8jN:${sourceApplicationRecordId}`);
    }
    for (const lockKey of lockKeys.sort()) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`.execute(trx);
    }
    const member = await trx.selectFrom("members").select("id")
      .where("identity_card_number", "=", identityCardNumber).forUpdate().executeTakeFirst();
    if (member) {
      await trx.selectFrom("member_contracts").select("id")
        .where("member_id", "=", member.id).where("property_id", "=", propertyId).forUpdate().execute();
    }
    if (sourceApplicationRecordId) {
      await trx.selectFrom("member_external_references").select("id")
        .where("provider", "=", "FEISHU_BASE")
        .where("source_container_id", "=", "wiki:FtxUwOE6diwS8wkmaawcDhEPnMc")
        .where("source_table_id", "=", "tbl4OryeWd0Td8jN")
        .where("external_record_id", "=", sourceApplicationRecordId)
        .forUpdate().executeTakeFirst();
    }
    return;
  }

  if (commandType === "CREATE_ORDER") {
    const quote = await loadStoredQuote(trx, requireString(input, "quoteId"));
    await lockEntitlementLots(trx, quote.memberContractId);
    await lockUnitDates(trx, propertyId, quote.inventoryUnitId, quote.arrivalDate, quote.departureDate);
    return;
  }
  if (commandType === "LOCK_MAINTENANCE") {
    await lockUnitDates(trx, propertyId, requireString(input, "inventoryUnitId"), requireString(input, "arrivalDate"), requireString(input, "departureDate"));
    return;
  }
  if (commandType === "RELEASE_MAINTENANCE") {
    const lock = await trx.selectFrom("maintenance_locks").selectAll().where("id", "=", requireString(input, "maintenanceLockId")).where("property_id", "=", propertyId).forUpdate().executeTakeFirst();
    if (!lock) throw new DomainError("NOT_FOUND", "Maintenance lock not found", 404);
    await lockUnitDates(trx, propertyId, lock.inventory_unit_id, lock.arrival_date, lock.departure_date);
    return;
  }
  if (commandType === "ADD_MEMBER_ENTITLEMENT_LOT") {
    const contractId = requireString(input, "memberContractId");
    const contract = await trx.selectFrom("member_contracts").select("id")
      .where("id", "=", contractId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!contract) throw new DomainError("NOT_FOUND", "Member contract not found", 404);
    await lockEntitlementLots(trx, contractId);
    return;
  }
  if (commandType === "ADJUST_MEMBER_ENTITLEMENT" || commandType === "EXPIRE_MEMBER_ENTITLEMENT") {
    const lot = await trx.selectFrom("entitlement_lots").innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.id", "entitlement_lots.contract_id"])
      .where("entitlement_lots.id", "=", requireString(input, "entitlementLotId"))
      .where("member_contracts.property_id", "=", propertyId).executeTakeFirst();
    if (!lot) throw new DomainError("NOT_FOUND", "Entitlement lot not found", 404);
    await lockEntitlementLots(trx, lot.contract_id);
    return;
  }
  if (commandType === "ISSUE_TOKEN") {
    const subjectId = requireString(input, "subjectId");
    const subject = await trx.selectFrom("subjects").select("id").where("id", "=", subjectId).forUpdate().executeTakeFirst();
    if (!subject) throw new DomainError("NOT_FOUND", "Subject not found", 404);
    return;
  }
  if (commandType === "ROTATE_TOKEN" || commandType === "REVOKE_TOKEN") {
    const token = await trx.selectFrom("api_tokens").select("subject_id").where("id", "=", requireString(input, "tokenId")).forUpdate().executeTakeFirst();
    if (!token) throw new DomainError("NOT_FOUND", "Token not found", 404);
    await trx.selectFrom("subjects").select("id").where("id", "=", token.subject_id).forUpdate().executeTakeFirst();
    return;
  }

  const orderId = requireString(input, "orderId");
  await lockOrder(trx, orderId);
  const context = await loadOrderContext(trx, orderId);
  if (context.order.property_id !== propertyId) throw new DomainError("RESOURCE_SCOPE_DENIED", "Order belongs to another property", 403);
  await lockEntitlementLots(trx, context.order.member_contract_id ?? undefined);

  if (["SHORTEN_STAY", "EXTEND_STAY", "MOVE_UNIT", "CANCEL_ORDER", "MARK_NO_SHOW", "CHECK_OUT"].includes(commandType)) {
    const timeline = await loadActiveStayTimeline(trx, context);
    const roomDates = await roomDatesForTimeline(trx, propertyId, timeline);
    if (commandType === "EXTEND_STAY") {
      const extensionUnit = await loadInventoryUnit(trx, propertyId, timeline.at(-1)!.inventoryUnitId);
      roomDates.push(...enumerateServiceDates(context.order.departure_date, requireString(input, "newDepartureDate"))
        .map((serviceDate) => ({ roomId: extensionUnit.roomId, serviceDate })));
    }
    if (commandType === "MOVE_UNIT") {
      const newUnit = await loadInventoryUnit(trx, propertyId, requireString(input, "newInventoryUnitId"));
      const effectiveDate = requireString(input, "effectiveDate");
      parseLocalDate(effectiveDate);
      roomDates.push(...enumerateServiceDates(effectiveDate, context.order.departure_date)
        .map((serviceDate) => ({ roomId: newUnit.roomId, serviceDate })));
    }
    await lockRoomDays(trx, roomDates);
  }
  if (commandType === "RECORD_REFUND") {
    await trx.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .select("collection_facts.fact_id")
      .where("collection_facts.fact_id", "=", requireString(input, "referencesFactId"))
      .where("orders.property_id", "=", propertyId)
      .forUpdate("collection_facts")
      .executeTakeFirst();
  }
  if (commandType === "REVERSE_FACT") {
    await trx.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .select("collection_facts.fact_id")
      .where("collection_facts.fact_id", "=", requireString(input, "reversesFactId"))
      .where("orders.property_id", "=", propertyId)
      .forUpdate("collection_facts")
      .executeTakeFirst();
  }
}

async function insertRevision(trx: Transaction<Database>, options: {
  orderId: string;
  revisionNo: number;
  amendmentId: string;
  policyVersionId: string;
  arrivalDate: string;
  departureDate: string;
  pricing: ReturnType<typeof pricingSnapshot>;
}): Promise<string> {
  const id = newId("revision");
  await trx.insertInto("pricing_revisions").values({
    id,
    order_id: options.orderId,
    revision_no: options.revisionNo,
    amendment_id: options.amendmentId,
    policy_version_id: options.policyVersionId,
    arrival_date: options.arrivalDate,
    departure_date: options.departureDate,
    coverage_set: JSON.stringify(options.pricing.coverageSet),
    cash_lines: JSON.stringify(options.pricing.cashLines),
    manual_adjustment_minor: options.pricing.manualAdjustmentMinor,
    current_contract_amount_minor: options.pricing.currentContractAmountMinor,
    currency: options.pricing.currency
  }).execute();
  return id;
}

async function bumpMembershipForCoverage(trx: Transaction<Database>, contractId: string | null, coverageSet: CoverageItemDto[]): Promise<void> {
  if (!contractId || coverageSet.length === 0) return;
  await incrementContractAndLotVersions(trx, contractId, [...new Set(coverageSet.map((item) => item.entitlementLotId))]);
}

export async function applyCommand(trx: Transaction<Database>, options: {
  commandType: CommandType;
  input: unknown;
  effect: Record<string, unknown>;
  reason: CommandReason;
  commandId: string;
}): Promise<AppliedCommand> {
  const input = requireObject(options.input);
  const propertyId = requireString(input, "propertyId");
  const effect = options.effect;

  if (options.commandType === "CREATE_MEMBER") {
    const operation = requireString(effect, "operation");
    const memberProfile = nestedObject(effect, "member");
    const contractEffect = nestedObject(effect, "contract");
    const memberCreated = operation === "CREATE_MEMBER_WITH_INITIAL_CONTRACT";
    if (!memberCreated && operation !== "MATCH_EXISTING_MEMBER") {
      throw new DomainError("INTERNAL_ERROR", "Member registration effect has an invalid operation", 500);
    }
    const memberId = memberCreated ? newId("member") : requireString(effect, "memberId");
    const memberContractId = memberCreated ? newId("contract") : typeof effect.memberContractId === "string" ? effect.memberContractId : null;
    try {
      if (memberCreated) {
        if (!memberContractId) throw new DomainError("INTERNAL_ERROR", "New member registration has no initial contract ID", 500);
        await trx.insertInto("members").values({
          id: memberId,
          identity_card_number: normalizeIdentityCardNumber(memberProfile.identityCardNumber),
          full_name: requireString(memberProfile, "fullName"),
          phone: requireString(memberProfile, "phone"),
          wechat: requireString(memberProfile, "wechat")
        }).execute();
        await trx.insertInto("member_contracts").values({
          id: memberContractId,
          property_id: propertyId,
          member_id: memberId,
          member_name: requireString(memberProfile, "fullName"),
          status: "ACTIVE",
          valid_from: requireString(contractEffect, "validFrom"),
          valid_until: requireString(contractEffect, "validUntil"),
          version: 1
        }).execute();
      }

      let memberExternalReferenceId: string | null = null;
      let externalReferenceCreated = false;
      if (effect.externalReference !== null && effect.externalReference !== undefined) {
        const externalReference = requireObject(effect.externalReference, "externalReference");
        const referenceOperation = requireString(externalReference, "operation");
        if (referenceOperation === "CREATE_LINK") {
          memberExternalReferenceId = newId("memberref");
          externalReferenceCreated = true;
          await trx.insertInto("member_external_references").values({
            id: memberExternalReferenceId,
            member_id: memberId,
            property_id: propertyId,
            provider: "FEISHU_BASE",
            source_container_id: requireString(externalReference, "sourceContainerId"),
            source_table_id: requireString(externalReference, "sourceTableId"),
            external_record_id: requireString(externalReference, "externalRecordId")
          }).execute();
        } else if (referenceOperation === "USE_EXISTING_LINK") {
          memberExternalReferenceId = requireString(externalReference, "id");
        } else {
          throw new DomainError("INTERNAL_ERROR", "Member external-reference effect has an invalid operation", 500);
        }
      }
      const resourceRefs = [memberId, ...(memberContractId ? [memberContractId] : []), ...(memberExternalReferenceId ? [memberExternalReferenceId] : [])];
      return {
        persistedResult: {
          memberId,
          memberContractId,
          memberCreated,
          memberContractCreated: memberCreated,
          memberExternalReferenceId,
          externalReferenceCreated
        },
        resourceRefs,
        factRefs: []
      };
    } catch (error) {
      rethrowMemberRegistrationConflict(error);
    }
  }

  if (options.commandType === "CREATE_ORDER") {
    const orderId = newId("order");
    const stayId = newId("stay");
    const amendmentId = newId("amend");
    const segmentId = newId("segment");
    const pricing = pricingSnapshot(effect);
    const inventoryUnit = nestedObject(effect, "inventoryUnit");
    const unitId = requireString(inventoryUnit, "id");
    const arrivalDate = requireString(effect, "arrivalDate");
    const departureDate = requireString(effect, "departureDate");
    const stayType = requireString(effect, "stayType");
    const policyVersionId = requireString(effect, "pricingPolicyVersionId");
    const memberContractId = typeof effect.memberContractId === "string" ? effect.memberContractId : null;
    const { bookingChannelCode, channelOrderReference } = validateBookingChannel(
      effect.bookingChannelCode,
      effect.channelOrderReference
    );
    const freeStayReason = stayType === "FREE" ? requireString(effect, "freeStayReason") : null;
    await trx.insertInto("orders").values({
      id: orderId, property_id: propertyId, status: "RESERVED", stay_type: stayType,
      arrival_date: arrivalDate, departure_date: departureDate, primary_guest_snapshot: nestedObject(effect, "primaryGuest"),
      booking_channel_code: bookingChannelCode, channel_order_reference: channelOrderReference, free_stay_reason: freeStayReason,
      pricing_policy_version_id: policyVersionId, member_contract_id: memberContractId, current_revision_id: null, version: 1
    }).execute();
    await trx.insertInto("stays").values({ id: stayId, order_id: orderId, status: "PLANNED" }).execute();
    await trx.insertInto("amendments").values({
      id: amendmentId, order_id: orderId, sequence: 1, amendment_type: "CREATE_ORDER",
      reason_code: options.reason.code, reason_note: options.reason.note, prior_version: 0, new_version: 1,
      payload: { quoteId: effect.quoteId, inventoryUnitId: unitId, arrivalDate, departureDate, bookingChannelCode, channelOrderReference, freeStayReason }
    }).execute();
    await trx.insertInto("stay_segments").values({
      id: segmentId, stay_id: stayId, sequence: 1, inventory_unit_id: unitId, arrival_date: arrivalDate,
      departure_date: departureDate, segment_type: "INITIAL", supersedes_segment_id: null, amendment_id: amendmentId
    }).execute();
    const revisionId = await insertRevision(trx, { orderId, revisionNo: 1, amendmentId, policyVersionId, arrivalDate, departureDate, pricing });
    await trx.updateTable("orders").set({ current_revision_id: revisionId }).where("id", "=", orderId).execute();
    const unit = await loadInventoryUnit(trx, propertyId, unitId);
    await createInventoryClaims(trx, { propertyId, unit, dates: enumerateServiceDates(arrivalDate, departureDate), sourceType: "ORDER_SEGMENT", sourceId: segmentId });
    const coverageRefs = memberContractId
      ? await holdCoverage(trx, { orderId, contractId: memberContractId, inventoryUnitId: unitId, revisionId, coverageSet: pricing.coverageSet, commandId: options.commandId })
      : { coverageIds: [], factIds: [] };
    if (memberContractId) {
      await bumpMembershipForCoverage(trx, memberContractId, pricing.coverageSet);
    }
    return {
      persistedResult: { orderId, stayId, segmentId, pricingRevisionId: revisionId, bookingChannelCode, channelOrderReference, freeStayReason },
      resourceRefs: [orderId, stayId, segmentId, revisionId, ...coverageRefs.coverageIds],
      factRefs: coverageRefs.factIds
    };
  }

  if (options.commandType === "LOCK_MAINTENANCE") {
    const maintenanceLockId = newId("maint");
    const unitObject = nestedObject(effect, "inventoryUnit");
    const unitId = requireString(unitObject, "id");
    const arrivalDate = requireString(effect, "arrivalDate");
    const departureDate = requireString(effect, "departureDate");
    await trx.insertInto("maintenance_locks").values({
      id: maintenanceLockId, property_id: propertyId, inventory_unit_id: unitId, arrival_date: arrivalDate,
      departure_date: departureDate, reason: requireString(effect, "reason"), status: "ACTIVE", version: 1, released_at: null
    }).execute();
    const unit = await loadInventoryUnit(trx, propertyId, unitId);
    await createInventoryClaims(trx, { propertyId, unit, dates: enumerateServiceDates(arrivalDate, departureDate), sourceType: "MAINTENANCE", sourceId: maintenanceLockId });
    return { persistedResult: { maintenanceLockId }, resourceRefs: [maintenanceLockId], factRefs: [] };
  }

  if (options.commandType === "RELEASE_MAINTENANCE") {
    const maintenanceLockId = requireString(effect, "maintenanceLockId");
    await releaseInventoryClaims(trx, "MAINTENANCE", [maintenanceLockId]);
    await trx.updateTable("maintenance_locks").set({ status: "RELEASED", version: sql`version + 1`, released_at: new Date() }).where("id", "=", maintenanceLockId).execute();
    return { persistedResult: { maintenanceLockId, status: "RELEASED" }, resourceRefs: [maintenanceLockId], factRefs: [] };
  }

  if (options.commandType === "ADD_MEMBER_ENTITLEMENT_LOT") {
    const contractId = requireString(effect, "contractId");
    const unitKind = requireString(effect, "unitKind");
    if (unitKind !== "ROOM_NIGHT" && unitKind !== "BED_NIGHT") throw new DomainError("INTERNAL_ERROR", "Entitlement lot effect has an invalid unit kind", 500);
    const units = effect.units;
    if (!Number.isInteger(units) || (units as number) <= 0) throw new DomainError("INTERNAL_ERROR", "Entitlement lot effect has invalid units", 500);
    const expiresOn = requireString(effect, "expiresOn");
    const lotId = newId("lot");
    const factId = newId("fact");
    await trx.insertInto("entitlement_lots").values({
      id: lotId, contract_id: contractId, unit_kind: unitKind, total_units: 0, expires_on: expiresOn, version: 1
    }).execute();
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId, lot_id: lotId, entry_type: "ADJUST", quantity_delta: units as number,
      service_date: null, order_id: null, coverage_id: null,
      reason: `MEMBER_ENTITLEMENT_LOT_ADDED ${options.reason.code}: ${options.reason.note}`,
      command_id: options.commandId
    }).execute();
    await trx.updateTable("member_contracts").set({ version: sql`version + 1` }).where("id", "=", contractId).execute();
    return {
      persistedResult: { entitlementLotId: lotId, contractId, adjustmentFactId: factId, units },
      resourceRefs: [contractId, lotId],
      factRefs: [factId]
    };
  }

  if (options.commandType === "ADJUST_MEMBER_ENTITLEMENT") {
    const lotId = requireString(effect, "entitlementLotId");
    const contractId = requireString(effect, "contractId");
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId, lot_id: lotId, entry_type: "ADJUST", quantity_delta: effect.quantityDelta as number,
      service_date: null, order_id: null, coverage_id: null, reason: requireString(effect, "adjustmentReason"), command_id: options.commandId
    }).execute();
    await incrementContractAndLotVersions(trx, contractId, [lotId]);
    return { persistedResult: { entitlementLotId: lotId, adjustmentFactId: factId }, resourceRefs: [contractId, lotId], factRefs: [factId] };
  }

  if (options.commandType === "EXPIRE_MEMBER_ENTITLEMENT") {
    const lotId = requireString(effect, "entitlementLotId");
    const contractId = requireString(effect, "contractId");
    const asOfDate = requireString(effect, "asOfDate");
    const remainingAvailable = effect.remainingAvailable;
    if (!Number.isInteger(remainingAvailable) || (remainingAvailable as number) < 0) {
      throw new DomainError("INTERNAL_ERROR", "Expiration effect has an invalid remaining balance", 500);
    }
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId,
      lot_id: lotId,
      entry_type: "EXPIRE",
      quantity_delta: -(remainingAvailable as number),
      service_date: null,
      order_id: null,
      coverage_id: null,
      reason: `ENTITLEMENT_EXPIRED asOfDate=${asOfDate}`,
      command_id: options.commandId
    }).execute();
    await incrementContractAndLotVersions(trx, contractId, [lotId]);
    return {
      persistedResult: {
        entitlementLotId: lotId,
        contractId,
        factId,
        entryType: "EXPIRE",
        expiredUnits: remainingAvailable,
        remainingAvailable: 0,
        asOfDate
      },
      resourceRefs: [contractId, lotId],
      factRefs: [factId]
    };
  }

  if (options.commandType === "ISSUE_TOKEN") {
    const tokenId = newId("token");
    const secretHash = requireString(input, "tokenSecretHash");
    const subjectId = requireString(effect, "subjectId");
    try {
      await trx.insertInto("api_tokens").values({
        id: tokenId, subject_id: subjectId, label: requireString(effect, "label"), secret_hash: secretHash,
        access_ceiling: requireString(effect, "accessCeiling") as "READ" | "WRITE", property_scope: propertyId,
        expires_at: requireString(effect, "expiresAt"), revoked_at: null, rotated_from_id: null, replaced_by_id: null
      }).execute();
    } catch (error) {
      rethrowTokenSecretConflict(error);
    }
    return {
      persistedResult: { tokenId, subjectId, accessCeiling: effect.accessCeiling, expiresAt: effect.expiresAt },
      resourceRefs: [tokenId, subjectId],
      factRefs: []
    };
  }

  if (options.commandType === "ROTATE_TOKEN") {
    const oldTokenId = requireString(effect, "tokenId");
    const tokenId = newId("token");
    const secretHash = requireString(input, "tokenSecretHash");
    const subjectId = requireString(effect, "subjectId");
    try {
      await trx.insertInto("api_tokens").values({
        id: tokenId, subject_id: subjectId, label: requireString(effect, "label"), secret_hash: secretHash,
        access_ceiling: requireString(effect, "accessCeiling") as "READ" | "WRITE", property_scope: propertyId,
        expires_at: requireString(effect, "expiresAt"), revoked_at: null, rotated_from_id: oldTokenId, replaced_by_id: null
      }).execute();
    } catch (error) {
      rethrowTokenSecretConflict(error);
    }
    await trx.updateTable("api_tokens").set({ revoked_at: new Date(), replaced_by_id: tokenId }).where("id", "=", oldTokenId).execute();
    return {
      persistedResult: { tokenId, rotatedFromTokenId: oldTokenId, subjectId, accessCeiling: effect.accessCeiling, expiresAt: effect.expiresAt },
      resourceRefs: [oldTokenId, tokenId, subjectId],
      factRefs: []
    };
  }

  if (options.commandType === "REVOKE_TOKEN") {
    const tokenId = requireString(effect, "tokenId");
    await trx.updateTable("api_tokens").set({ revoked_at: new Date() }).where("id", "=", tokenId).execute();
    return { persistedResult: { tokenId, revoked: true }, resourceRefs: [tokenId], factRefs: [] };
  }

  const orderId = requireString(effect, "orderId");
  const context = await loadOrderContext(trx, orderId);

  if (["SHORTEN_STAY", "EXTEND_STAY", "MOVE_UNIT"].includes(options.commandType)) {
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: options.commandType,
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect
    });
    const segmentId = newId("segment");
    const pricing = pricingSnapshot(effect);
    const stayTimeline = stayTimelineFromEffect(effect);
    const currentTail = trailingTimelineRun(stayTimeline);
    const unitId = currentTail.inventoryUnitId;
    let departureDate = context.order.departure_date;
    const segmentArrival = currentTail.arrivalDate;
    let segmentType: string = options.commandType;
    const coverageIds: string[] = [];
    const coverageFactIds: string[] = [];

    if (options.commandType === "SHORTEN_STAY") {
      departureDate = requireString(nestedObject(effect, "after"), "departureDate");
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds, departureDate);
      const released = await releaseCoverage(trx, orderId, options.commandId, { fromDate: departureDate, reholdCoverageSet: pricing.coverageSet });
      coverageIds.push(...released.coverageIds);
      coverageFactIds.push(...released.factIds);
    } else if (options.commandType === "EXTEND_STAY") {
      departureDate = requireString(nestedObject(effect, "after"), "departureDate");
      const unit = await loadInventoryUnit(trx, propertyId, unitId);
      await createInventoryClaims(trx, { propertyId, unit, dates: enumerateServiceDates(context.order.departure_date, departureDate), sourceType: "ORDER_SEGMENT", sourceId: segmentId });
    } else {
      const effectiveDate = requireString(effect, "effectiveDate");
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds, effectiveDate);
      const released = await releaseCoverage(trx, orderId, options.commandId, { fromDate: effectiveDate, reholdCoverageSet: pricing.coverageSet });
      coverageIds.push(...released.coverageIds);
      coverageFactIds.push(...released.factIds);
      const unit = await loadInventoryUnit(trx, propertyId, unitId);
      await createInventoryClaims(trx, { propertyId, unit, dates: enumerateServiceDates(effectiveDate, departureDate), sourceType: "ORDER_SEGMENT", sourceId: segmentId });
      segmentType = "MOVE";
    }
    await trx.insertInto("stay_segments").values({
      id: segmentId, stay_id: context.stay.id, sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: unitId, arrival_date: segmentArrival, departure_date: departureDate,
      segment_type: segmentType, supersedes_segment_id: context.currentSegment.id, amendment_id: amendmentId
    }).execute();
    const revisionId = await insertRevision(trx, {
      orderId, revisionNo: context.revision.revisionNo + 1, amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate: context.order.arrival_date, departureDate, pricing
    });
    if (context.order.member_contract_id) {
      const held = await holdCoverage(trx, { orderId, contractId: context.order.member_contract_id, inventoryUnitId: unitId, revisionId, coverageSet: pricing.coverageSet, commandId: options.commandId });
      coverageIds.push(...held.coverageIds);
      coverageFactIds.push(...held.factIds);
      await bumpMembershipForCoverage(trx, context.order.member_contract_id, pricing.coverageSet);
      if (context.order.status === "CHECKED_IN") {
        const consumed = await consumeCoverage(trx, orderId, options.commandId);
        coverageIds.push(...consumed.coverageIds);
        coverageFactIds.push(...consumed.factIds);
      }
    }
    await trx.updateTable("orders").set({
      departure_date: departureDate, current_revision_id: revisionId,
      version: context.order.version + 1, updated_at: new Date()
    }).where("id", "=", orderId).execute();
    return {
      persistedResult: { orderId, amendmentId, staySegmentId: segmentId, pricingRevisionId: revisionId },
      resourceRefs: [...new Set([orderId, amendmentId, segmentId, revisionId, ...coverageIds])],
      factRefs: [...new Set(coverageFactIds)]
    };
  }

  if (options.commandType === "REPRICE_ORDER" || options.commandType === "REFRESH_MEMBER_COVERAGE") {
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: options.commandType,
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect
    });
    const pricing = pricingSnapshot(effect);
    const revisionId = await insertRevision(trx, {
      orderId, revisionNo: context.revision.revisionNo + 1, amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date, pricing
    });
    const reconciledCoverage = context.order.member_contract_id
      ? await reconcileCoverage(trx, {
        orderId,
        contractId: context.order.member_contract_id,
        revisionId,
        coverageSet: pricing.coverageSet,
        commandId: options.commandId
      })
      : { coverageIds: [], factIds: [] };
    const consumedCoverage = context.order.member_contract_id && context.order.status === "CHECKED_IN"
      ? await consumeCoverage(trx, orderId, options.commandId)
      : { coverageIds: [], factIds: [] };
    const coverageRefs = {
      coverageIds: [...new Set([...reconciledCoverage.coverageIds, ...consumedCoverage.coverageIds])],
      factIds: [...new Set([...reconciledCoverage.factIds, ...consumedCoverage.factIds])]
    };
    await trx.updateTable("orders").set({ current_revision_id: revisionId, version: context.order.version + 1, updated_at: new Date() }).where("id", "=", orderId).execute();
    const persistedResult: Record<string, unknown> = { orderId, amendmentId, pricingRevisionId: revisionId };
    if (options.commandType === "REPRICE_ORDER") {
      persistedResult.policyBaseAmount = moneyMinor(effect.policyBaseAmount, "policyBaseAmount");
      persistedResult.targetCurrentContractAmount = moneyMinor(effect.targetCurrentContractAmount, "targetCurrentContractAmount");
      persistedResult.manualAdjustmentMinor = effect.manualAdjustmentMinor;
    }
    return {
      persistedResult,
      resourceRefs: [orderId, amendmentId, revisionId, ...coverageRefs.coverageIds],
      factRefs: coverageRefs.factIds
    };
  }

  if (options.commandType === "RECORD_COLLECTION" || options.commandType === "RECORD_REFUND" || options.commandType === "REVERSE_FACT") {
    const factId = newId("fact");
    const amountMinor = effect.amountMinor as number;
    const factType = options.commandType === "RECORD_COLLECTION" ? "COLLECTION" : options.commandType === "RECORD_REFUND" ? "REFUND" : "REVERSAL";
    const netEffectMinor = factType === "COLLECTION" ? amountMinor : factType === "REFUND" ? -amountMinor : effect.netEffectMinor as number;
    const transactionReference = factType === "REVERSAL" ? null : requireTransactionReference(effect.transactionReference);
    await trx.insertInto("collection_facts").values({
      fact_id: factId, order_id: orderId, fact_type: factType, amount_minor: amountMinor,
      net_effect_minor: netEffectMinor, currency: requireString(effect, "currency"),
      references_fact_id: typeof effect.referencesFactId === "string" ? effect.referencesFactId : null,
      reverses_fact_id: typeof effect.reversesFactId === "string" ? effect.reversesFactId : null,
      method: typeof effect.method === "string" ? effect.method : "REVERSAL",
      note: typeof effect.note === "string" ? effect.note : options.reason.note,
      transaction_reference: transactionReference,
      command_id: options.commandId
    }).execute();
    return { persistedResult: { orderId, factId, factType, netEffectMinor, transactionReference }, resourceRefs: [orderId], factRefs: [factId] };
  }

  const statusCommands: Partial<Record<CommandType, { orderStatus: string; stayStatus: string }>> = {
    CHECK_IN: { orderStatus: "CHECKED_IN", stayStatus: "IN_HOUSE" },
    CHECK_OUT: { orderStatus: "CHECKED_OUT", stayStatus: "COMPLETED" },
    CANCEL_ORDER: { orderStatus: "CANCELLED", stayStatus: "CANCELLED" },
    MARK_NO_SHOW: { orderStatus: "NO_SHOW", stayStatus: "NO_SHOW" }
  };
  const target = statusCommands[options.commandType];
  if (target) {
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: options.commandType,
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect
    });
    let coverageRefs = { coverageIds: [] as string[], factIds: [] as string[] };
    let statusPricingRevisionId: string | undefined;
    if (context.order.stay_type === "FREE" && (options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW")) {
      const prior = await trx.selectFrom("pricing_revisions").selectAll().where("id", "=", context.revision.id).executeTakeFirstOrThrow();
      const coverageSet = prior.coverage_set as CoverageItemDto[];
      const cashLines = prior.cash_lines as unknown[];
      if (coverageSet.length !== 0 || cashLines.some((line) => {
        const amount = line && typeof line === "object" ? (line as { amount?: { minorUnits?: unknown } }).amount?.minorUnits : undefined;
        return amount !== 0;
      }) || prior.current_contract_amount_minor !== 0) {
        throw new DomainError("INTERNAL_ERROR", "Free stay pricing must remain zero and entitlement-free", 500);
      }
      statusPricingRevisionId = await insertRevision(trx, {
        orderId,
        revisionNo: context.revision.revisionNo + 1,
        amendmentId,
        policyVersionId: context.order.pricing_policy_version_id,
        arrivalDate: context.order.arrival_date,
        departureDate: context.order.departure_date,
        pricing: {
          coverageSet,
          cashLines,
          manualAdjustmentMinor: 0,
          currentContractAmountMinor: 0,
          currency: prior.currency
        }
      });
    }
    if (options.commandType === "CHECK_IN") {
      coverageRefs = await consumeCoverage(trx, orderId, options.commandId);
    }
    if (options.commandType === "CHECK_OUT") {
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
    }
    if (options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW") {
      coverageRefs = await releaseCoverage(trx, orderId, options.commandId);
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
    }
    await trx.updateTable("orders").set({
      status: target.orderStatus,
      ...(statusPricingRevisionId ? { current_revision_id: statusPricingRevisionId } : {}),
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    await trx.updateTable("stays").set({ status: target.stayStatus }).where("id", "=", context.stay.id).execute();
    return {
      persistedResult: {
        orderId,
        amendmentId,
        status: target.orderStatus,
        ...((options.commandType === "CHECK_IN" || options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW") ? {
          entitlementTransition: {
            from: "HELD",
            to: options.commandType === "CHECK_IN" ? "CONSUMED" : "RELEASED",
            coverageCount: coverageRefs.coverageIds.length
          }
        } : {}),
        ...(statusPricingRevisionId ? { pricingRevisionId: statusPricingRevisionId } : {})
      },
      resourceRefs: [orderId, amendmentId, ...(statusPricingRevisionId ? [statusPricingRevisionId] : []), ...coverageRefs.coverageIds],
      factRefs: coverageRefs.factIds
    };
  }

  throw new DomainError("VALIDATION_ERROR", `Unsupported command: ${options.commandType}`);
}
