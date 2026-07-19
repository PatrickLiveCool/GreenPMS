import { describe, expect, it } from "vitest";
import type { EntitlementLotDto, MemberViewDto } from "../types";
import { entitlementLotUiState, serverAvailableUnits } from "./MembersPage";

describe("member entitlement availability", () => {
  it("uses the server-derived lot balance instead of recalculating ledger facts in Web", () => {
    const member = {
      lotBalances: [
        { lotId: "lot_room_member_test", unitKind: "ROOM_NIGHT", availableUnits: 8 },
        { lotId: "lot_bed_member_test", unitKind: "BED_NIGHT", availableUnits: 3 }
      ]
    } as MemberViewDto;

    expect(serverAvailableUnits(member, "lot_room_member_test")).toBe(8);
    expect(serverAvailableUnits(member, "lot_missing")).toBe(0);
  });

  it("uses the property balance date for natural expiry and never offers premature expiry", () => {
    const member = {
      balanceAsOfDate: "2026-07-19"
    } as MemberViewDto;
    const expiredYesterday = { id: "lot_expired", expires_on: "2026-07-18" } as EntitlementLotDto;
    const validToday = { id: "lot_valid_today", expires_on: "2026-07-19" } as EntitlementLotDto;
    const validFuture = { id: "lot_valid_future", expires_on: "2026-07-20" } as EntitlementLotDto;

    expect(entitlementLotUiState(member, expiredYesterday, false)).toEqual({
      expired: true,
      canAdjust: false,
      canRecordExpiration: true
    });
    expect(entitlementLotUiState(member, validToday, false)).toEqual({
      expired: false,
      canAdjust: true,
      canRecordExpiration: false
    });
    expect(entitlementLotUiState(member, validFuture, false).canRecordExpiration).toBe(false);
    expect(entitlementLotUiState(member, expiredYesterday, true)).toEqual({
      expired: true,
      canAdjust: false,
      canRecordExpiration: false
    });
  });
});
