import { describe, expect, it } from "vitest";
import { receiptTransactionReferenceLabel } from "./ui.tsx";

describe("Receipt transaction reference labels", () => {
  it("distinguishes reversal non-applicability from a historical missing collection or refund reference", () => {
    expect(receiptTransactionReferenceLabel({ factType: "REVERSAL", transactionReference: null })).toBe("不适用");
    expect(receiptTransactionReferenceLabel({ factType: "COLLECTION", transactionReference: null })).toBe("历史未记录");
    expect(receiptTransactionReferenceLabel({ factType: "REFUND", transactionReference: "TXN-REFUND-001" })).toBe("TXN-REFUND-001");
  });
});
