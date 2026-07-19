import { describe, expect, it } from "vitest";
import type { CommandRequest } from "../types";
import {
  clearPersistedCommandRecovery,
  commandRecoveryStorageKey,
  readPersistedCommandRecovery,
  savePersistedCommandRecovery,
  transitionPersistedCommandRecovery,
  type CommandDialogProgress
} from "../ui";

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

const context = {
  subjectId: "subject_operator",
  scopeId: "property:property_qintopia",
  request: {
    commandType: "RECORD_COLLECTION",
    title: "记录收款事实",
    description: "test",
    input: {
      propertyId: "property_qintopia",
      orderId: "order_recovery",
      amountMinor: 5800,
      transactionReference: "WX-BUSINESS-REFERENCE-001",
      tokenSecret: "must-never-be-retained"
    }
  } satisfies CommandRequest
};

const confirming: CommandDialogProgress = {
  state: "CONFIRMING",
  previewId: "preview_recovery",
  confirmationKey: "web-confirm-record-collection-original"
};

const receipt = {
  receiptId: "receipt_recovery",
  commandId: "command_recovery",
  executionStatus: "EXECUTED" as const,
  businessCommitted: true,
  correlationId: "correlation_recovery",
  result: { factId: "fact_recovery", transactionReference: "WX-BUSINESS-REFERENCE-001" },
  resourceRefs: ["order_recovery"],
  factRefs: ["fact_recovery"],
  committedAt: "2026-07-19T10:00:00.000Z"
};

describe("shared Web command recovery persistence", () => {
  it("retains only recovery identity before resolution and survives a fresh load", () => {
    const storage = new MemoryStorage();
    const transition = transitionPersistedCommandRecovery(undefined, context, confirming, "2026-07-19T09:00:00.000Z");

    expect(transition.accepted).toBe(true);
    expect(transition.recovery).toMatchObject({
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      propertyId: "property_qintopia",
      commandType: "RECORD_COLLECTION",
      confirmationKey: confirming.confirmationKey,
      state: "CONFIRMING"
    });
    expect(transition.recovery?.targetRefs).toEqual(["orderId=order_recovery"]);
    expect(savePersistedCommandRecovery(storage, transition.recovery!)).toBe(true);

    const serialized = storage.getItem(commandRecoveryStorageKey(context.subjectId, context.scopeId));
    expect(serialized).not.toContain("must-never-be-retained");
    expect(serialized).not.toContain("tokenSecret");
    expect(serialized).not.toContain("amountMinor");
    expect(serialized).not.toContain("transactionReference");
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toEqual({ kind: "VALID", recovery: transition.recovery });
  });

  it("keeps the original key through UNKNOWN and persists the terminal Receipt", () => {
    const storage = new MemoryStorage();
    const started = transitionPersistedCommandRecovery(undefined, context, confirming).recovery!;
    const unknown = transitionPersistedCommandRecovery(started, context, {
      state: "UNKNOWN",
      confirmationKey: confirming.confirmationKey
    }, "2026-07-19T09:01:00.000Z").recovery!;
    const resolved = transitionPersistedCommandRecovery(unknown, context, {
      state: "RESOLVED",
      confirmationKey: confirming.confirmationKey,
      receipt
    }, "2026-07-19T09:02:00.000Z").recovery!;

    expect(unknown).toMatchObject({ state: "UNKNOWN", confirmationKey: confirming.confirmationKey });
    expect(resolved).toMatchObject({
      state: "EXECUTED",
      confirmationKey: confirming.confirmationKey,
      receipt: { commandId: "command_recovery", receiptId: "receipt_recovery" }
    });
    expect(savePersistedCommandRecovery(storage, resolved)).toBe(true);
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toEqual({ kind: "VALID", recovery: resolved });
  });

  it("does not regress a terminal result or resurrect a cleared attempt from delayed callbacks", () => {
    const terminal = transitionPersistedCommandRecovery(
      transitionPersistedCommandRecovery(undefined, context, confirming).recovery,
      context,
      { state: "RESOLVED", confirmationKey: confirming.confirmationKey, receipt }
    ).recovery!;

    expect(transitionPersistedCommandRecovery(terminal, context, {
      state: "UNKNOWN",
      confirmationKey: confirming.confirmationKey
    }).recovery).toBe(terminal);
    expect(transitionPersistedCommandRecovery(undefined, context, {
      state: "RESOLVED",
      confirmationKey: confirming.confirmationKey,
      receipt
    }).recovery).toBeUndefined();
  });

  it("rejects a second confirmation key until the retained command is explicitly cleared", () => {
    const storage = new MemoryStorage();
    const retained = transitionPersistedCommandRecovery(undefined, context, confirming).recovery!;
    expect(savePersistedCommandRecovery(storage, retained)).toBe(true);

    const conflicting = transitionPersistedCommandRecovery(retained, context, {
      ...confirming,
      confirmationKey: "web-confirm-record-collection-new-key"
    });
    expect(conflicting).toEqual({ accepted: false, recovery: retained });

    expect(clearPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toBe(true);
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toEqual({ kind: "ABSENT" });
  });

  it("uses the same property scope for entitlement commands while excluding Token secrets", () => {
    const entitlementRequest = {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      title: "调整会员权益",
      description: "test",
      input: {
        propertyId: "property_qintopia",
        entitlementLotId: "lot_member_room",
        quantityDelta: 1,
        adjustmentReason: "manual correction"
      }
    } satisfies CommandRequest;
    const entitlement = transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request: entitlementRequest
    }, { ...confirming, confirmationKey: "web-confirm-entitlement" }).recovery;
    expect(entitlement).toMatchObject({
      scopeId: "property:property_qintopia",
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      targetRefs: ["entitlementLotId=lot_member_room"]
    });

    const tokenRequest = {
      commandType: "ISSUE_TOKEN",
      title: "Issue Token",
      description: "test",
      input: { propertyId: "property_qintopia", tokenSecret: "qtp_do-not-persist" }
    } satisfies CommandRequest;
    expect(transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request: tokenRequest
    }, { ...confirming, confirmationKey: "web-confirm-token" })).toEqual({ accepted: false, recovery: undefined });
  });

  it("reports storage failure so Confirm can fail closed before sending", () => {
    const recovery = transitionPersistedCommandRecovery(undefined, context, confirming).recovery!;
    const unavailableStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("session storage unavailable"); },
      removeItem: () => { throw new Error("session storage unavailable"); }
    };

    expect(savePersistedCommandRecovery(unavailableStorage, recovery)).toBe(false);
    expect(clearPersistedCommandRecovery(unavailableStorage, context.subjectId, context.scopeId)).toBe(false);
  });

  it("distinguishes truncated JSON, wrong versions, and read failures from an absent record", () => {
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(context.subjectId, context.scopeId);
    storage.setItem(key, "{\"version\":1");
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");

    storage.setItem(key, JSON.stringify({ version: 2 }));
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");

    const unreadableStorage = {
      getItem: () => { throw new Error("read denied"); },
      setItem: () => undefined,
      removeItem: () => undefined
    };
    expect(readPersistedCommandRecovery(unreadableStorage, context.subjectId, context.scopeId).kind).toBe("READ_ERROR");
  });
});
