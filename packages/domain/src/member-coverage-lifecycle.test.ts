import { describe, expect, it } from "vitest";
import { calculatePricing, type PricingPolicy } from "./pricing.ts";

const policy: PricingPolicy = {
  id: "policy_member_lifecycle",
  stayType: "TRANSIENT",
  calculationKind: "FLAT_NIGHTLY",
  nightlyRateMinor: 12_000,
  currency: "CNY"
};

describe("consumed member coverage identity", () => {
  it("keeps the original inventory identity for consumed same-kind coverage", () => {
    const result = calculatePricing({
      propertyId: "prop_member_lifecycle",
      inventoryUnitId: "unit_room_destination",
      inventoryUnitKind: "ROOM",
      arrivalDate: "2028-01-01",
      departureDate: "2028-01-02",
      stayType: "TRANSIENT",
      policy,
      memberCoverage: true,
      coverageCandidates: [{
        serviceDate: "2028-01-01",
        entitlementLotId: "lot_consumed_room",
        status: "CONSUMED",
        inventoryUnitId: "unit_room_original",
        unitKind: "ROOM_NIGHT"
      }]
    });

    expect(result.coverageSet).toEqual([{
      serviceDate: "2028-01-01",
      entitlementLotId: "lot_consumed_room",
      inventoryUnitId: "unit_room_original",
      unitKind: "ROOM_NIGHT"
    }]);
    expect(result.currentContractAmount.minorUnits).toBe(0);
  });

  it("rejects moving consumed coverage across ROOM_NIGHT and BED_NIGHT", () => {
    expect(() => calculatePricing({
      propertyId: "prop_member_lifecycle",
      inventoryUnitId: "unit_bed_destination",
      inventoryUnitKind: "BED",
      arrivalDate: "2028-01-01",
      departureDate: "2028-01-02",
      stayType: "TRANSIENT",
      policy,
      memberCoverage: true,
      coverageCandidates: [{
        serviceDate: "2028-01-01",
        entitlementLotId: "lot_consumed_room",
        status: "CONSUMED",
        inventoryUnitId: "unit_room_original",
        unitKind: "ROOM_NIGHT"
      }]
    })).toThrow(/cannot move across entitlement unit kinds/);
  });
});
