import { describe, expect, it } from "vitest";
import {
  QuoteRequestGuard,
  quoteRecoveryStorageKey,
  readQuoteCommandRecovery,
  saveQuoteCommandRecovery
} from "./InventoryPage";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const subjectId = "subject_operator";
const propertyId = "property_qintopia";
const scope = quoteRecoveryStorageKey(subjectId, propertyId);
const pending = {
  version: 1,
  subjectId,
  propertyId,
  input: {
    propertyId,
    inventoryUnitId: "unit_room_101",
    stayType: "FREE",
    arrivalDate: "2026-10-10",
    departureDate: "2026-10-12",
    pricingPolicyVersionId: "policy_free_v1"
  },
  inputSignature: JSON.stringify({
    propertyId,
    inventoryUnitId: "unit_room_101",
    stayType: "FREE",
    arrivalDate: "2026-10-10",
    departureDate: "2026-10-12",
    pricingPolicyVersionId: "policy_free_v1"
  }),
  metadata: {
    idempotencyKey: "web-create-quote-original-key",
    correlationId: "web-create-quote-original-correlation"
  },
  state: "SENDING"
} as const;

describe("CREATE_QUOTE request lifecycle", () => {
  it("leaves the original SENDING recovery record untouched after unmount", () => {
    const storage = new MemoryStorage();
    expect(saveQuoteCommandRecovery(storage, pending)).toBe(true);

    const guard = new QuoteRequestGuard(scope);
    guard.mount();
    const lease = guard.begin(scope);
    guard.unmount();

    if (guard.isActive(lease)) storage.removeItem(quoteRecoveryStorageKey(subjectId, propertyId));

    expect(readQuoteCommandRecovery(storage, subjectId, propertyId)).toEqual({ kind: "VALID", pending });
  });

  it("isolates delayed callbacks across property switches, including a switch back", () => {
    const otherScope = quoteRecoveryStorageKey(subjectId, "property_other");
    const guard = new QuoteRequestGuard(scope);
    guard.mount();
    const originalLease = guard.begin(scope);

    guard.enterScope(otherScope);
    expect(guard.isActive(originalLease)).toBe(false);
    const otherPropertyLease = guard.begin(otherScope);
    expect(guard.isActive(otherPropertyLease)).toBe(true);

    guard.enterScope(scope);
    expect(guard.isActive(originalLease)).toBe(false);
    expect(guard.isActive(otherPropertyLease)).toBe(false);
  });

  it("loads a persisted SENDING command with its original idempotency key for recovery", () => {
    const storage = new MemoryStorage();
    expect(saveQuoteCommandRecovery(storage, pending)).toBe(true);

    const restored = readQuoteCommandRecovery(storage, subjectId, propertyId);
    expect(restored.kind).toBe("VALID");
    if (restored.kind !== "VALID") throw new Error("expected a valid quote recovery record");
    expect(restored.pending.state).toBe("SENDING");
    expect(restored.pending.metadata.idempotencyKey).toBe(pending.metadata.idempotencyKey);

    const remountedGuard = new QuoteRequestGuard(scope);
    remountedGuard.mount();
    expect(remountedGuard.isActive(remountedGuard.begin(scope))).toBe(true);
  });
});
