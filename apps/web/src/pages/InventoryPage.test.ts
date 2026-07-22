import { describe, expect, it } from "vitest";
import {
  QuoteRequestGuard,
  RoomStatusCommandAttemptGuard,
  RoomStatusQueryAttemptGuard,
  quoteRecoveryStorageKey,
  readQuoteCommandRecovery,
  roomStatusBlockDraftWithinSelection,
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

describe("Room-status command attempt lifecycle", () => {
  it("tracks late recovery outcomes after 403 without letting a stale attempt restart polling state", () => {
    const guard = new RoomStatusCommandAttemptGuard();
    const attemptId = guard.begin();
    let phase = "PREVIEW";
    const persisted: string[] = [];

    guard.invalidate();
    for (const progress of ["UNKNOWN", "RESOLVED"] as const) {
      persisted.push(progress);
      guard.runIfActive(attemptId, () => { phase = "CONFIRMING"; });
    }

    expect(persisted).toEqual(["UNKNOWN", "RESOLVED"]);
    expect(phase).toBe("PREVIEW");

    const nextAttemptId = guard.begin();
    expect(nextAttemptId).toBeGreaterThan(attemptId);
    expect(guard.runIfActive(attemptId, () => { phase = "STALE"; })).toBe(false);
    expect(guard.runIfActive(nextAttemptId, () => { phase = "DRAFT"; })).toBe(true);
    expect(phase).toBe("DRAFT");
  });
});

describe("Room-status query attempt lifecycle", () => {
  it("keeps a slow query active so a polling tick can skip overlapping refreshes", () => {
    const guard = new RoomStatusQueryAttemptGuard();
    const slowAttemptId = guard.begin();

    expect(guard.isInFlight()).toBe(true);
    expect(guard.isActive(slowAttemptId)).toBe(true);

    const pollingTickStartedAnotherRequest = guard.isInFlight() ? false : Boolean(guard.begin());
    expect(pollingTickStartedAnotherRequest).toBe(false);
    expect(guard.isActive(slowAttemptId)).toBe(true);

    expect(guard.finish(slowAttemptId)).toBe(true);
    expect(guard.isInFlight()).toBe(false);
  });

  it("does not let a superseded range response finish the current query", () => {
    const guard = new RoomStatusQueryAttemptGuard();
    const oldRangeAttemptId = guard.begin();
    expect(guard.invalidate(oldRangeAttemptId)).toBe(true);

    const currentRangeAttemptId = guard.begin();
    expect(guard.finish(oldRangeAttemptId)).toBe(false);
    expect(guard.isActive(currentRangeAttemptId)).toBe(true);
    expect(guard.finish(currentRangeAttemptId)).toBe(true);
    expect(guard.isInFlight()).toBe(false);
  });
});

describe("Room-status Block draft authorization", () => {
  it("only permits a non-empty interval contained by the server-validated selection", () => {
    expect(roomStatusBlockDraftWithinSelection("2026-07-21", "2026-07-23", "2026-07-20", "2026-07-24")).toBe(true);
    expect(roomStatusBlockDraftWithinSelection("2026-07-19", "2026-07-23", "2026-07-20", "2026-07-24")).toBe(false);
    expect(roomStatusBlockDraftWithinSelection("2026-07-21", "2026-07-25", "2026-07-20", "2026-07-24")).toBe(false);
    expect(roomStatusBlockDraftWithinSelection("2026-07-21", "2026-07-21", "2026-07-20", "2026-07-24")).toBe(false);
    expect(roomStatusBlockDraftWithinSelection("", "2026-07-23", "2026-07-20", "2026-07-24")).toBe(false);
  });
});
