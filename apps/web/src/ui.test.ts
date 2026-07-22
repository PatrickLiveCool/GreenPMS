import { describe, expect, it } from "vitest";
import { guestNicknameLabel, receiptTransactionReferenceLabel } from "./ui.tsx";

describe("Receipt transaction reference labels", () => {
  it("distinguishes reversal non-applicability from a historical missing collection or refund reference", () => {
    expect(receiptTransactionReferenceLabel({ factType: "REVERSAL", transactionReference: null })).toBe("不适用");
    expect(receiptTransactionReferenceLabel({ factType: "COLLECTION", transactionReference: null })).toBe("历史未记录");
    expect(receiptTransactionReferenceLabel({ factType: "REFUND", transactionReference: "TXN-REFUND-001" })).toBe("TXN-REFUND-001");
  });
});

describe("Guest nickname labels", () => {
  it("keeps a recorded nickname and derives an explicit historical compatibility label", () => {
    expect(guestNicknameLabel({ fullName: "Legal Name", nickname: "山风" })).toBe("山风");
    expect(guestNicknameLabel({ fullName: "Legacy Missing" })).toBe("历史未记录");
    expect(guestNicknameLabel({ fullName: "Legacy Null", nickname: null })).toBe("历史未记录");
  });
});
