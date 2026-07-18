import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { commandTypes, type CommandType } from "@qintopia/contracts";
import { newOpaqueSecret } from "@qintopia/domain";
import type { Database } from "@qintopia/db";
import type { Kysely } from "kysely";
import { CommandEffectSchema } from "../../apps/api/src/schemas.ts";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const effectContractDatabaseUrl = process.env.EFFECT_CONTRACT_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_effect_contract";

const expectedEffectKeys: Record<CommandType, string[]> = {
  CREATE_ORDER: ["arrivalDate", "departureDate", "inventoryUnit", "memberContractId", "pricing", "pricingPolicyVersionId", "primaryGuest", "quoteId", "stayType"],
  EXTEND_STAY: ["after", "before", "inventoryUnitId", "orderId"],
  SHORTEN_STAY: ["after", "before", "inventoryUnitId", "orderId"],
  MOVE_UNIT: ["effectiveDate", "fromInventoryUnit", "orderId", "pricing", "stayTimeline", "toInventoryUnit"],
  REPRICE_ORDER: ["before", "inventoryUnitId", "manualAdjustmentMinor", "orderId", "pricing", "stayTimeline"],
  CANCEL_ORDER: ["fromStatus", "inventoryUnitId", "orderId", "toStatus"],
  MARK_NO_SHOW: ["fromStatus", "inventoryUnitId", "orderId", "toStatus"],
  LOCK_MAINTENANCE: ["arrivalDate", "departureDate", "inventoryUnit", "reason"],
  RELEASE_MAINTENANCE: ["arrivalDate", "departureDate", "inventoryUnitId", "maintenanceLockId"],
  RECORD_COLLECTION: ["amountMinor", "currency", "method", "note", "orderId"],
  RECORD_REFUND: ["amountMinor", "currency", "method", "note", "orderId", "referencesFactId"],
  REVERSE_FACT: ["amountMinor", "currency", "netEffectMinor", "note", "orderId", "reversesFactId"],
  CHECK_IN: ["fromStatus", "inventoryUnitId", "orderId", "toStatus"],
  CHECK_OUT: ["amounts", "fromStatus", "inventoryUnitId", "orderId", "toStatus"],
  ADJUST_MEMBER_ENTITLEMENT: ["adjustmentReason", "availableAfter", "availableBefore", "contractId", "entitlementLotId", "quantityDelta", "unitKind"],
  EXPIRE_MEMBER_ENTITLEMENT: ["asOfDate", "contractId", "entitlementLotId", "entryType", "expiresOn", "quantityDelta", "remainingAvailable", "unitKind"],
  ISSUE_TOKEN: ["accessCeiling", "expiresAt", "label", "subjectId"],
  ROTATE_TOKEN: ["accessCeiling", "expiresAt", "label", "operation", "subjectId", "tokenId"],
  REVOKE_TOKEN: ["accessCeiling", "expiresAt", "label", "operation", "subjectId", "tokenId"]
};

type Preview = {
  previewId: string;
  commandType: CommandType;
  effectHash: string;
  effect: Record<string, unknown>;
};

let app: FastifyInstance;
let db: Kysely<Database>;
let sequence = 0;

function headers(prefix: string) {
  sequence += 1;
  return {
    authorization: `Bearer ${demo.writeToken}`,
    "content-type": "application/json",
    "idempotency-key": `${prefix}-${sequence}`,
    "x-correlation-id": `${prefix}-${sequence}`
  };
}

async function requestPreview(commandType: CommandType, input: Record<string, unknown>): Promise<Preview> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/command-previews",
    headers: headers(`effect-${commandType.toLowerCase()}-preview`),
    payload: { commandType, input }
  });
  expect(response.statusCode, `${commandType}: ${response.body}`).toBe(200);
  const preview = (response.json() as { preview: Preview }).preview;
  expect(preview.commandType).toBe(commandType);
  expect(Object.keys(preview.effect).sort(), commandType).toEqual(expectedEffectKeys[commandType]);
  expect(Value.Check(CommandEffectSchema, preview.effect), `${commandType}: ${JSON.stringify(preview.effect)}`).toBe(true);
  return preview;
}

async function confirm(preview: Preview): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/command-previews/${preview.previewId}/confirm`,
    headers: headers(`effect-${preview.commandType.toLowerCase()}-confirm`),
    payload: {
      propertyId: demo.propertyId,
      commandType: preview.commandType,
      confirmation: true,
      expectedEffectHash: preview.effectHash,
      reason: { code: "EFFECT_CONTRACT", note: `Prepare state for ${preview.commandType} effect coverage` }
    }
  });
  expect(response.statusCode, `${preview.commandType}: ${response.body}`).toBe(200);
  return (response.json() as { result: Record<string, unknown> }).result;
}

async function quote() {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/quotes",
    headers: headers("effect-create-quote"),
    payload: {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "TRANSIENT",
      arrivalDate: "2028-04-10",
      departureDate: "2028-04-14",
      pricingPolicyVersionId: demo.transientPolicyId
    }
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { quote: { quoteId: string } }).quote;
}

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  process.env.BEARER_AUTH_RATE_LIMIT_MAX = "5000";
  FormatRegistry.Set("date-time", (value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
  db = await resetDatabase(effectContractDatabaseUrl);
  app = await buildServer(db);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

describe("Command effect HTTP contract", () => {
  it("serializes and validates the real Preview effect for every command type", async () => {
    const covered = new Set<CommandType>();
    const capture = async (commandType: CommandType, input: Record<string, unknown>) => {
      const preview = await requestPreview(commandType, input);
      covered.add(commandType);
      return preview;
    };

    const maintenance = await capture("LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2028-03-01",
      departureDate: "2028-03-03",
      reason: "Effect contract maintenance window"
    });
    const maintenanceResult = await confirm(maintenance);
    await capture("RELEASE_MAINTENANCE", {
      propertyId: demo.propertyId,
      maintenanceLockId: maintenanceResult.maintenanceLockId
    });

    await capture("ADJUST_MEMBER_ENTITLEMENT", {
      propertyId: demo.propertyId,
      entitlementLotId: demo.roomLotId,
      quantityDelta: 1,
      adjustmentReason: "Effect contract adjustment"
    });
    await capture("EXPIRE_MEMBER_ENTITLEMENT", {
      propertyId: demo.propertyId,
      entitlementLotId: demo.roomLotId,
      asOfDate: "2030-01-02"
    });

    await capture("ISSUE_TOKEN", {
      propertyId: demo.propertyId,
      subjectId: demo.agentSubjectId,
      label: "Effect contract issued Token",
      accessCeiling: "READ",
      expiresAt: "2029-01-01T00:00:00.000Z",
      tokenSecret: newOpaqueSecret("qtp")
    });
    await capture("ROTATE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: "token_demo_read",
      tokenSecret: newOpaqueSecret("qtp")
    });
    await capture("REVOKE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: "token_demo_read"
    });

    const priced = await quote();
    const createOrder = await capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: priced.quoteId,
      primaryGuest: {
        fullName: "Effect Contract Guest",
        phone: "+86-138-0000-0000",
        documentNumber: "EFFECT-CONTRACT-001"
      }
    });
    const orderId = (await confirm(createOrder)).orderId as string;

    await capture("SHORTEN_STAY", {
      propertyId: demo.propertyId,
      orderId,
      newDepartureDate: "2028-04-13",
      manualAdjustmentMinor: -100
    });
    await capture("EXTEND_STAY", {
      propertyId: demo.propertyId,
      orderId,
      newDepartureDate: "2028-04-15",
      manualAdjustmentMinor: 100
    });
    await capture("MOVE_UNIT", {
      propertyId: demo.propertyId,
      orderId,
      newInventoryUnitId: demo.secondRoomId,
      effectiveDate: "2028-04-12",
      manualAdjustmentMinor: 200
    });
    await capture("REPRICE_ORDER", {
      propertyId: demo.propertyId,
      orderId,
      manualAdjustmentMinor: 0
    });
    await capture("CANCEL_ORDER", { propertyId: demo.propertyId, orderId });
    await capture("MARK_NO_SHOW", { propertyId: demo.propertyId, orderId });

    const collection = await capture("RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 10_000,
      method: "CARD",
      note: "Effect contract collection"
    });
    const collectionFactId = (await confirm(collection)).factId as string;
    await capture("RECORD_REFUND", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 1_000,
      referencesFactId: collectionFactId,
      method: "CARD",
      note: "Effect contract refund"
    });
    await capture("REVERSE_FACT", {
      propertyId: demo.propertyId,
      orderId,
      reversesFactId: collectionFactId,
      note: "Effect contract reversal"
    });

    const checkIn = await capture("CHECK_IN", { propertyId: demo.propertyId, orderId });
    await confirm(checkIn);
    await capture("CHECK_OUT", { propertyId: demo.propertyId, orderId });

    expect([...covered].sort()).toEqual([...commandTypes].sort());
  }, 30_000);
});
