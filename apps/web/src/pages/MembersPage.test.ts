import { describe, expect, it } from "vitest";
import type { EntitlementLedgerDto, EntitlementLotDto } from "../types";
import { availableUnits } from "./MembersPage";

const lot: EntitlementLotDto = {
  id: "lot_room_member_test",
  contract_id: "member_contract_test",
  unit_kind: "ROOM_NIGHT",
  total_units: 5,
  expires_on: "2027-12-31",
  version: 1,
  created_at: "2026-01-01T00:00:00.000Z"
};

function ledgerEntry(factId: string, quantityDelta: number, entryType: EntitlementLedgerDto["entry_type"], lotId = lot.id): EntitlementLedgerDto {
  return {
    fact_id: factId,
    lot_id: lotId,
    entry_type: entryType,
    quantity_delta: quantityDelta,
    service_date: null,
    order_id: null,
    coverage_id: null,
    reason: "test",
    command_id: null,
    created_at: "2026-01-01T00:00:00.000Z"
  };
}

describe("member entitlement availability", () => {
  it("adds only the selected lot ledger deltas to its initial units", () => {
    const ledger = [
      ledgerEntry("fact_hold", -1, "HOLD"),
      ledgerEntry("fact_release", 1, "RELEASE"),
      ledgerEntry("fact_adjust", 3, "ADJUST"),
      ledgerEntry("fact_consume", 0, "CONSUME"),
      ledgerEntry("fact_other_lot", -50, "HOLD", "lot_bed_other")
    ];

    expect(availableUnits(lot, ledger)).toBe(8);
  });
});
