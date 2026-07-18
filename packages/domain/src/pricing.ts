import type { CashLineDto, CoverageItemDto, EntitlementUnitKind, InventoryUnitKind, MoneyDto, StayType } from "@qintopia/contracts";
import { DomainError } from "@qintopia/contracts";
import { enumerateServiceDates } from "./dates.ts";

export interface PricingPolicy {
  id: string;
  stayType: StayType;
  calculationKind: "FLAT_NIGHTLY" | "FREE";
  nightlyRateMinor: number;
  currency: string;
}

export interface CoverageCandidate {
  serviceDate: string;
  entitlementLotId: string;
}

export interface PricingInput {
  propertyId: string;
  inventoryUnitId: string;
  inventoryUnitKind: InventoryUnitKind;
  arrivalDate: string;
  departureDate: string;
  stayType: StayType;
  policy: PricingPolicy;
  coverageCandidates?: CoverageCandidate[];
  manualAdjustmentMinor?: number;
}

export interface PricingResult {
  coverageSet: CoverageItemDto[];
  cashLines: CashLineDto[];
  cashRemainder: MoneyDto;
  currentContractAmount: MoneyDto;
}

export function entitlementKindFor(unitKind: InventoryUnitKind): EntitlementUnitKind {
  return unitKind === "ROOM" ? "ROOM_NIGHT" : "BED_NIGHT";
}

export function calculatePricing(input: PricingInput): PricingResult {
  if (input.policy.stayType !== input.stayType) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", `Policy does not support ${input.stayType}`, 422);
  }
  const approvedPolicyShape = (input.stayType === "TRANSIENT" && input.policy.calculationKind === "FLAT_NIGHTLY")
    || (input.stayType === "FREE" && input.policy.calculationKind === "FREE");
  if (!approvedPolicyShape) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", `${input.stayType} pricing requires approved real pricing facts`, 422);
  }
  if (!Number.isInteger(input.policy.nightlyRateMinor) || input.policy.nightlyRateMinor < 0) {
    throw new DomainError("VALIDATION_ERROR", "Policy nightly rate must be a non-negative integer");
  }
  if (input.policy.calculationKind === "FREE" && input.policy.nightlyRateMinor !== 0) {
    throw new DomainError("VALIDATION_ERROR", "A free policy must have a zero nightly rate");
  }
  const dates = enumerateServiceDates(input.arrivalDate, input.departureDate);
  if (input.arrivalDate.slice(0, 7) !== input.departureDate.slice(0, 7)) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Cross-month pricing requires an approved real pricing case", 422);
  }
  const candidates = new Map((input.coverageCandidates ?? []).map((candidate) => [candidate.serviceDate, candidate]));
  const unitKind = entitlementKindFor(input.inventoryUnitKind);
  const coverageSet: CoverageItemDto[] = [];
  const cashLines: CashLineDto[] = [];

  for (const serviceDate of dates) {
    const candidate = candidates.get(serviceDate);
    if (candidate !== undefined) {
      coverageSet.push({ serviceDate, inventoryUnitId: input.inventoryUnitId, unitKind, entitlementLotId: candidate.entitlementLotId });
      continue;
    }
    const amount = input.policy.calculationKind === "FREE" ? 0 : input.policy.nightlyRateMinor;
    cashLines.push({
      serviceDate,
      inventoryUnitId: input.inventoryUnitId,
      description: input.policy.calculationKind === "FREE" ? "Free accommodation" : "Nightly accommodation",
      amount: { currency: input.policy.currency, minorUnits: amount }
    });
  }

  const cashSubtotal = cashLines.reduce((sum, line) => sum + line.amount.minorUnits, 0);
  const manualAdjustment = input.manualAdjustmentMinor ?? 0;
  if (!Number.isInteger(manualAdjustment)) throw new DomainError("VALIDATION_ERROR", "Manual adjustment must be an integer");
  return {
    coverageSet,
    cashLines,
    cashRemainder: { currency: input.policy.currency, minorUnits: cashSubtotal },
    currentContractAmount: { currency: input.policy.currency, minorUnits: cashSubtotal + manualAdjustment }
  };
}

export function amountSummary(currency: string, currentContractAmount: number, signedCollectionEffects: number[]) {
  const netRecordedCollection = signedCollectionEffects.reduce((sum, effect) => sum + effect, 0);
  return {
    currentContractAmount: { currency, minorUnits: currentContractAmount },
    netRecordedCollection: { currency, minorUnits: netRecordedCollection },
    collectionDifference: { currency, minorUnits: currentContractAmount - netRecordedCollection }
  };
}
