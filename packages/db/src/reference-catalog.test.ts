import { describe, expect, it } from "vitest";
import {
  loadBundledQintopia2026Catalog,
  referenceCatalogSummary,
  validateQintopia2026ReferenceCatalogSnapshot
} from "./reference-catalog.ts";

describe("QinTopia 2026 reference catalog snapshot", () => {
  it("preserves the verified inventory and published-price totals", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    expect(referenceCatalogSummary(snapshot)).toMatchObject({
      importId: "qintopia-2026-feishu-revision-561-user-confirmed-v3",
      sourceRevision: 561,
      physicalRoomCount: 44,
      physicalBedCount: 91,
      baseInventoryUnitCount: 77,
      wholeRoomCombinationCount: 13,
      salesEntryCount: 90,
      inventoryCategoryCount: 8,
      publicRateCount: 32,
      membershipProductCount: 3,
      executionState: "REFERENCE_ONLY"
    });
    expect(snapshot.inventory.summary).toMatchObject({
      roomSaleUnitCount: 31,
      bedSaleUnitCount: 46
    });
  });

  it("imports only the externally published rates, not the floor-price worksheet", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    const publishedRows = snapshot.publicRates.rates.map((rate) => Number(/\d+$/.exec(rate.sourceCell)?.[0]));
    expect(publishedRows.every((row) => !Number.isNaN(row) && row >= 31 && row <= 44)).toBe(true);
    expect(snapshot.source.sheets.find((sheet) => sheet.sheetName === "2026价格表")).toMatchObject({
      publicPriceRange: "A28:F44",
      excludedPriceRanges: [expect.objectContaining({ range: "A9:F25" })]
    });
    expect(snapshot.publicRates.rates.find((rate) => rate.roomTypeKey === "shared_bath_quad" && rate.nights === 30)?.amountMinor).toBe(78_000);
    expect(snapshot.publicRates.rates.find((rate) => rate.roomTypeKey === "private_bath_suite" && rate.nights === 1)?.amountMinor).toBe(32_000);
  });

  it("keeps generated identities explicit and the latest membership policy authoritative", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    const unresolved = JSON.stringify(snapshot.unresolvedIssues);
    expect(unresolved).toContain("OPERATING_TARGET_WINDOWS_MISSING");
    expect(unresolved).toContain("ANCILLARY_CHARGES_NOT_SPECIFIED");
    expect(unresolved).not.toContain("MEMBERSHIP_REFUND_CALCULATION_AMBIGUOUS");
    expect(unresolved).not.toContain("FREE_PRICING_CASES_MISSING");
    expect(snapshot.inventory.rooms.filter((room) => ["D", "E"].includes(room.buildingCode)).every((room) => room.codeProvenance === "PMS_GENERATED" && room.sourceCode === null)).toBe(true);
    expect(snapshot.membershipRules.refundPolicy).toBe("NON_REFUNDABLE_MEMBERSHIP");
    expect(snapshot.membershipRules.refundCalculation).toBeNull();
    expect(snapshot.membershipProducts.every((product) => product.validity.period === "P1Y")).toBe(true);
    expect(snapshot.membershipProducts.reduce((sum, product) => sum + product.quota, 0)).toBe(30);
  });

  it("rejects malformed operating facts instead of coercing them", async () => {
    const source = await loadBundledQintopia2026Catalog();

    const invalidElectricity = structuredClone(source) as unknown as {
      inventory: { categories: Array<{ separateElectricityCharge: boolean }> };
    };
    invalidElectricity.inventory.categories[0]!.separateElectricityCharge = true;
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(invalidElectricity)).toThrow(/electricity must not be charged separately/);

    const invalidEntitlement = structuredClone(source) as unknown as {
      membershipProducts: Array<{ entitlementUnit: string }>;
    };
    invalidEntitlement.membershipProducts[0]!.entitlementUnit = "BED_NIGHT";
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(invalidEntitlement)).toThrow(/does not match ROOM/);

    const wrongDurationColumn = structuredClone(source) as unknown as {
      publicRates: { rates: Array<{ sourceCell: string }> };
    };
    wrongDurationColumn.publicRates.rates[0]!.sourceCell = "F31";
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(wrongDurationColumn)).toThrow(/wrong duration column/);

    const duplicateSourceCell = structuredClone(source) as unknown as {
      publicRates: { rates: Array<{ sourceCell: string }> };
    };
    duplicateSourceCell.publicRates.rates[4]!.sourceCell = "C31";
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(duplicateSourceCell)).toThrow(/duplicate public rate source cell/);
  });
});
