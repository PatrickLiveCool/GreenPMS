import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { commandTypes, recoverableCommandTypes } from "@qintopia/contracts";
import { newOpaqueSecret } from "@qintopia/domain";
import { buildServer } from "../../apps/api/src/server.ts";
import { importQintopia2026ReferenceCatalog } from "@qintopia/db";
import { demo } from "../../packages/db/src/seed.ts";
import { resetTestDatabase } from "../helpers/database.ts";

let app: FastifyInstance;
const catalogWithoutImportPropertyId = "prop_contract_catalog_without_import";

type JsonSchema = Record<string, unknown>;

const commandInputContract: Record<(typeof commandTypes)[number], { required: string[]; properties: string[] }> = {
  CREATE_MEMBER: {
    required: ["propertyId", "fullName", "identityCardNumber", "phone", "wechat"],
    properties: ["propertyId", "fullName", "identityCardNumber", "phone", "wechat", "validFrom", "validUntil", "memberContractId", "sourceApplicationRecordId"]
  },
  CREATE_ORDER: { required: ["propertyId", "quoteId", "primaryGuest", "bookingChannelCode"], properties: ["propertyId", "quoteId", "primaryGuest", "bookingChannelCode", "channelOrderReference", "freeStayReason"] },
  EXTEND_STAY: { required: ["propertyId", "orderId", "newDepartureDate"], properties: ["propertyId", "orderId", "newDepartureDate"] },
  SHORTEN_STAY: { required: ["propertyId", "orderId", "newDepartureDate"], properties: ["propertyId", "orderId", "newDepartureDate"] },
  MOVE_UNIT: { required: ["propertyId", "orderId", "newInventoryUnitId", "effectiveDate"], properties: ["propertyId", "orderId", "newInventoryUnitId", "effectiveDate"] },
  REPRICE_ORDER: { required: ["propertyId", "orderId", "targetCurrentContractAmountMinor"], properties: ["propertyId", "orderId", "targetCurrentContractAmountMinor"] },
  CANCEL_ORDER: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  MARK_NO_SHOW: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  LOCK_MAINTENANCE: { required: ["propertyId", "inventoryUnitId", "arrivalDate", "departureDate", "reason"], properties: ["propertyId", "inventoryUnitId", "arrivalDate", "departureDate", "reason"] },
  RELEASE_MAINTENANCE: { required: ["propertyId", "maintenanceLockId"], properties: ["propertyId", "maintenanceLockId"] },
  RECORD_COLLECTION: { required: ["propertyId", "orderId", "amountMinor", "method", "transactionReference"], properties: ["propertyId", "orderId", "amountMinor", "method", "transactionReference", "note"] },
  RECORD_REFUND: { required: ["propertyId", "orderId", "amountMinor", "referencesFactId", "method", "transactionReference"], properties: ["propertyId", "orderId", "amountMinor", "referencesFactId", "method", "transactionReference", "note"] },
  REVERSE_FACT: { required: ["propertyId", "orderId", "reversesFactId", "note"], properties: ["propertyId", "orderId", "reversesFactId", "note"] },
  CHECK_IN: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  CHECK_OUT: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  REFRESH_MEMBER_COVERAGE: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  ADD_MEMBER_ENTITLEMENT_LOT: {
    required: ["propertyId", "memberContractId", "unitKind", "units", "expiresOn"],
    properties: ["propertyId", "memberContractId", "unitKind", "units", "expiresOn"]
  },
  ADJUST_MEMBER_ENTITLEMENT: { required: ["propertyId", "entitlementLotId", "quantityDelta", "adjustmentReason"], properties: ["propertyId", "entitlementLotId", "quantityDelta", "adjustmentReason"] },
  EXPIRE_MEMBER_ENTITLEMENT: { required: ["propertyId", "entitlementLotId", "asOfDate"], properties: ["propertyId", "entitlementLotId", "asOfDate"] },
  ISSUE_TOKEN: { required: ["propertyId", "subjectId", "label", "accessCeiling", "expiresAt", "tokenSecret"], properties: ["propertyId", "subjectId", "label", "accessCeiling", "expiresAt", "tokenSecret"] },
  ROTATE_TOKEN: { required: ["propertyId", "tokenId", "tokenSecret"], properties: ["propertyId", "tokenId", "expiresAt", "tokenSecret"] },
  REVOKE_TOKEN: { required: ["propertyId", "tokenId"], properties: ["propertyId", "tokenId"] }
};

function arbitraryRecordLocations(schema: unknown, path = "schema"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const record = schema as JsonSchema;
  const result: string[] = [];
  const additional = record.additionalProperties;
  if (additional === true || (additional !== null && typeof additional === "object" && !Array.isArray(additional) && Object.keys(additional).length === 0)) {
    result.push(`${path}.additionalProperties`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "additionalProperties" && additional !== true) continue;
    if (Array.isArray(value)) value.forEach((entry, index) => result.push(...arbitraryRecordLocations(entry, `${path}.${key}[${index}]`)));
    else if (value && typeof value === "object") result.push(...arbitraryRecordLocations(value, `${path}.${key}`));
  }
  return result;
}

beforeAll(async () => {
  const db = await resetTestDatabase();
  await db.insertInto("properties").values({
    id: catalogWithoutImportPropertyId,
    code: "QTP-NO-CATALOG",
    name: "Property without reference import",
    timezone: "Asia/Shanghai",
    currency: "CNY"
  }).execute();
  await db.insertInto("subject_property_grants").values({
    subject_id: demo.operatorSubjectId,
    property_id: catalogWithoutImportPropertyId,
    access_level: "READ"
  }).execute();
  await importQintopia2026ReferenceCatalog(db);
  app = await buildServer(db);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

describe("OpenAPI 3.1 command contract", () => {
  let commandSequence = 0;
  async function command(token: string, commandType: string, input: Record<string, unknown>) {
    commandSequence += 1;
    const previewResponse = await app.inject({
      method: "POST", url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
        "idempotency-key": `contract-preview-${commandSequence}`, "x-correlation-id": `contract-${commandSequence}`
      },
      payload: { commandType, input }
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json().preview;
    const confirmResponse = await app.inject({
      method: "POST", url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
        "idempotency-key": `contract-confirm-${commandSequence}`, "x-correlation-id": `contract-${commandSequence}`
      },
      payload: { propertyId: input.propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: "CONTRACT_TEST", note: "Token lifecycle contract" } }
    });
    expect(confirmResponse.statusCode).toBe(200);
    return confirmResponse.json();
  }

  it("serves the production Web entry and SPA routes without swallowing API 404s", async () => {
    for (const url of ["/", "/orders/permanent-order-reference"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain('<div id="root"></div>');
    }
    const missingApi = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toMatchObject({ code: "NOT_FOUND", retryable: false });
  });

  it("publishes versioned query, preview/confirm, receipt, fact, and recovery endpoints", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toBe("3.1.0");
    for (const path of [
      "/api/v1/properties/{id}/availability",
      "/api/v1/quotes",
      "/api/v1/command-previews",
      "/api/v1/command-previews/{previewId}/confirm",
      "/api/v1/commands/{id}",
      "/api/v1/command-results",
      "/api/v1/receipts/{id}",
      "/api/v1/facts/{id}",
      "/api/v1/members",
      "/api/v1/members/{id}",
      "/api/v1/maintenance-locks"
    ]) expect(document.paths[path]).toBeDefined();
    const headerParameters = document.paths["/api/v1/command-previews"].post.parameters;
    expect(headerParameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idempotency-key", in: "header", required: true }),
      expect.objectContaining({ name: "x-correlation-id", in: "header", required: true })
    ]));
    const quoteHeaderParameters = document.paths["/api/v1/quotes"].post.parameters;
    expect(quoteHeaderParameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idempotency-key", in: "header", required: true }),
      expect.objectContaining({ name: "x-correlation-id", in: "header", required: true })
    ]));
    const quoteResponse = document.paths["/api/v1/quotes"].post.responses["200"].content["application/json"].schema;
    expect(quoteResponse).toMatchObject({ additionalProperties: false, required: ["quote", "receipt"] });
    const recoveryCommandType = document.paths["/api/v1/command-results"].get.parameters
      .find((parameter: { name: string }) => parameter.name === "commandType").schema;
    expect(recoveryCommandType.anyOf.map((variant: { enum: string[] }) => variant.enum[0]).sort())
      .toEqual([...recoverableCommandTypes].sort());
    const commandSchema = document.paths["/api/v1/command-previews"].post.requestBody.content["application/json"].schema;
    expect(commandSchema.anyOf).toHaveLength(commandTypes.length);
    const variants = new Map<string, JsonSchema>(commandSchema.anyOf.map((variant: JsonSchema) => {
      const properties = variant.properties as Record<string, JsonSchema>;
      return [((properties.commandType!.enum as string[])[0])!, variant];
    }));
    expect([...variants.keys()].sort()).toEqual([...commandTypes].sort());
    expect(variants.has("CREATE_QUOTE")).toBe(false);
    for (const commandType of commandTypes) {
      const variant = variants.get(commandType)!;
      const input = (variant.properties as Record<string, JsonSchema>).input!;
      expect(variant.additionalProperties, commandType).toBe(false);
      expect(variant.required, commandType).toEqual(["commandType", "input"]);
      expect(input.additionalProperties, commandType).toBe(false);
      expect((input.required as string[]).sort(), commandType).toEqual([...commandInputContract[commandType].required].sort());
      expect(Object.keys(input.properties as object).sort(), commandType).toEqual([...commandInputContract[commandType].properties].sort());
    }
    const createInput = (variants.get("CREATE_ORDER")!.properties as Record<string, JsonSchema>).input!;
    const createGuest = ((createInput.properties as Record<string, JsonSchema>).primaryGuest)!;
    expect(createGuest).toMatchObject({ additionalProperties: false, required: ["fullName"] });
    const createChannel = ((createInput.properties as Record<string, JsonSchema>).bookingChannelCode)!;
    const createChannelVariants = createChannel.anyOf as Array<{ enum: string[] }>;
    expect(createChannelVariants.map((variant) => variant.enum[0])).toEqual(["YOUMUDAO", "CTRIP", "MEITUAN", "WECOM"]);
    expect(JSON.stringify((createInput.properties as Record<string, JsonSchema>).channelOrderReference)).toContain('"type":"null"');
    expect((createInput.properties as Record<string, JsonSchema>).freeStayReason).toMatchObject({ minLength: 1, maxLength: 1000 });
    const createMemberInput = (variants.get("CREATE_MEMBER")!.properties as Record<string, JsonSchema>).input!;
    expect((createMemberInput.properties as Record<string, JsonSchema>).identityCardNumber).toMatchObject({ minLength: 1, maxLength: 200 });
    expect((createMemberInput.properties as Record<string, JsonSchema>).validFrom).toMatchObject({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
    const expiryInput = (variants.get("EXPIRE_MEMBER_ENTITLEMENT")!.properties as Record<string, JsonSchema>).input!;
    expect((expiryInput.properties as Record<string, JsonSchema>).asOfDate!).toMatchObject({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
    for (const commandType of ["ISSUE_TOKEN", "ROTATE_TOKEN"] as const) {
      const tokenInput = (variants.get(commandType)!.properties as Record<string, JsonSchema>).input!;
      expect((tokenInput.properties as Record<string, JsonSchema>).tokenSecret).toMatchObject({
        minLength: 47,
        maxLength: 47,
        pattern: "^qtp_[A-Za-z0-9_-]{43}$"
      });
      expect(tokenInput.properties).not.toHaveProperty("tokenSecretHash");
    }
    const topLevelErrorCode = document.paths["/api/v1/command-previews"].post.responses["400"].content["application/json"].schema.properties.code;
    expect(topLevelErrorCode.anyOf.map((variant: { enum: string[] }) => variant.enum[0])).not.toContain("PREVIEW_EXPIRED");
    const repriceInput = (variants.get("REPRICE_ORDER")!.properties as Record<string, JsonSchema>).input!;
    expect((repriceInput.properties as Record<string, JsonSchema>).targetCurrentContractAmountMinor).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      multipleOf: 100
    });
  });

  it("publishes every documented error status for the query and recovery surfaces", async () => {
    const document = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    const expected: Array<[string, string, string[]]> = [
      ["/api/v1/quotes", "post", ["400", "403", "404", "409", "422", "429"]],
      ["/api/v1/command-previews/{previewId}/confirm", "post", ["400", "403", "404", "409", "429"]],
      ["/api/v1/receipts/{id}", "get", ["400", "403", "404", "429"]],
      ["/api/v1/commands/{id}", "get", ["400", "403", "404", "429"]],
      ["/api/v1/command-results", "get", ["400", "403", "404", "429"]]
    ];
    for (const [path, method, statuses] of expected) {
      const responses = document.paths[path][method].responses;
      for (const status of statuses) {
        expect(responses[status], `${method.toUpperCase()} ${path} ${status}`).toBeDefined();
        expect(arbitraryRecordLocations(responses[status].content["application/json"].schema)).toEqual([]);
      }
    }

    const errorSchema = document.paths["/api/v1/quotes"].post.responses["400"].content["application/json"].schema;
    expect(errorSchema.additionalProperties).toBe(false);
    expect(errorSchema.properties.details.anyOf).toHaveLength(12);
    const receiptSchema = document.paths["/api/v1/receipts/{id}"].get.responses["200"].content["application/json"].schema;
    expect(JSON.stringify(receiptSchema)).not.toContain("tokenSecret");
    expect(JSON.stringify(receiptSchema)).toContain("bookingChannelCode");
    expect(JSON.stringify(receiptSchema)).toContain("channelOrderReference");
    expect(JSON.stringify(receiptSchema)).toContain("transactionReference");

    for (const [path, pathItem] of Object.entries(document.paths) as Array<[string, Record<string, unknown>]>) {
      if (!path.startsWith("/api/v1/")) continue;
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const operation = pathItem[method] as { responses?: Record<string, unknown> } | undefined;
        if (operation) expect(operation.responses?.["500"], `${method.toUpperCase()} ${path} 500`).toBeDefined();
      }
    }
  });

  it("publishes finite schemas for every core client response", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const document = response.json();
    const coreResponses: Array<[string, string]> = [
      ["/api/v1/meta", "get"],
      ["/api/v1/properties/{id}/reference-catalog", "get"],
      ["/api/v1/orders", "get"],
      ["/api/v1/orders/{id}", "get"],
      ["/api/v1/members", "get"],
      ["/api/v1/members/{id}", "get"],
      ["/api/v1/facts/{id}", "get"],
      ["/api/v1/maintenance-locks", "get"],
      ["/api/v1/command-results", "get"],
      ["/api/v1/quotes", "post"],
      ["/api/v1/receipts/{id}", "get"],
      ["/api/v1/audit", "get"],
      ["/api/v1/command-previews", "post"],
      ["/api/v1/command-previews/{previewId}/confirm", "post"]
    ];
    for (const [path, method] of coreResponses) {
      const schema = document.paths[path][method].responses["200"].content["application/json"].schema;
      expect(arbitraryRecordLocations(schema), `${method.toUpperCase()} ${path}`).toEqual([]);
    }
    const confirmConflictSchema = document.paths["/api/v1/command-previews/{previewId}/confirm"].post.responses["409"].content["application/json"].schema;
    expect(confirmConflictSchema.anyOf).toHaveLength(2);
    expect(arbitraryRecordLocations(confirmConflictSchema)).toEqual([]);
  });

  it("serves the imported catalog as reference-only data", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/reference-catalog`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(response.statusCode).toBe(200);
    const catalog = response.json();
    expect(catalog.batch).toMatchObject({ sourceRevision: 561, executionState: "REFERENCE_ONLY" });
    expect(catalog.batch).not.toHaveProperty("sourceDocumentToken");
    expect(catalog.inventoryEntries).toHaveLength(8);
    expect(catalog.rates).toHaveLength(32);
    expect(catalog.membershipProducts).toHaveLength(3);
    expect(catalog.unresolvedIssues.length).toBeGreaterThan(0);
    expect(catalog.rates.every((rate: { executionState: string }) => rate.executionState === "REFERENCE_ONLY")).toBe(true);

    const openapi = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    const batchSchema = openapi.paths["/api/v1/properties/{id}/reference-catalog"].get
      .responses["200"].content["application/json"].schema.properties.batch;
    expect(batchSchema.properties).not.toHaveProperty("sourceDocumentToken");
  });

  it("enforces authentication, property scope, and an in-scope missing-catalog 404", async () => {
    const unauthenticated = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/reference-catalog`
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      correlationId: expect.any(String),
      retryable: false
    });

    const outsideTokenScope = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${catalogWithoutImportPropertyId}/reference-catalog`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(outsideTokenScope.statusCode).toBe(403);
    expect(outsideTokenScope.json()).toMatchObject({
      code: "RESOURCE_SCOPE_DENIED",
      correlationId: expect.any(String),
      retryable: false
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "operator", password: "demo-pass-2026" }
    });
    expect(login.statusCode).toBe(200);
    const session = login.cookies.find((entry) => entry.name === "qintopia_session");
    expect(session).toBeDefined();
    const missingCatalog = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${catalogWithoutImportPropertyId}/reference-catalog`,
      cookies: { qintopia_session: session!.value }
    });
    expect(missingCatalog.statusCode).toBe(404);
    expect(missingCatalog.json()).toMatchObject({
      code: "NOT_FOUND",
      message: "Reference catalog not found",
      correlationId: expect.any(String),
      retryable: false
    });
  });

  it("publishes and enforces the scoped maintenance-lock query contract", async () => {
    const openapi = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    const operation = openapi.paths["/api/v1/maintenance-locks"].get;
    const propertyParameter = operation.parameters.find((parameter: { name: string }) => parameter.name === "propertyId");
    const statusParameter = operation.parameters.find((parameter: { name: string }) => parameter.name === "status");
    expect(propertyParameter).toMatchObject({ in: "query", required: true, schema: { type: "string", minLength: 3, maxLength: 160 } });
    expect(statusParameter).toMatchObject({ in: "query", required: false });
    expect(statusParameter.schema.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ enum: ["ACTIVE"] }),
      expect.objectContaining({ enum: ["RELEASED"] })
    ]));
    const responseSchema = operation.responses["200"].content["application/json"].schema;
    expect(responseSchema).toMatchObject({ additionalProperties: false, required: ["maintenanceLocks"] });
    expect(arbitraryRecordLocations(responseSchema)).toEqual([]);
    const lockItem = responseSchema.properties.maintenanceLocks.items;
    expect(lockItem.additionalProperties).toBe(false);
    expect([...lockItem.required].sort()).toEqual([
      "arrival_date", "created_at", "departure_date", "id", "inventory_unit_id", "property_id",
      "reason", "released_at", "status", "version"
    ].sort());

    const createdLater = await command(demo.writeToken, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-04-05",
      departureDate: "2027-04-07",
      reason: "Later maintenance query contract"
    });
    const created = await command(demo.writeToken, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-04-01",
      departureDate: "2027-04-03",
      reason: "Maintenance query contract"
    });
    const maintenanceLockId = created.result.maintenanceLockId as string;
    const authorized = await app.inject({
      method: "GET",
      url: `/api/v1/maintenance-locks?propertyId=${demo.propertyId}&status=ACTIVE`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(authorized.statusCode).toBe(200);
    const maintenanceLocks = authorized.json().maintenanceLocks as Array<{ id: string }>;
    expect(maintenanceLocks
      .filter((candidate) => [maintenanceLockId, createdLater.result.maintenanceLockId].includes(candidate.id))
      .map((candidate) => candidate.id)
    ).toEqual([maintenanceLockId, createdLater.result.maintenanceLockId]);
    const lock = maintenanceLocks.find((candidate) => candidate.id === maintenanceLockId) as Record<string, unknown>;
    expect(lock).toMatchObject({
      id: maintenanceLockId,
      property_id: demo.propertyId,
      inventory_unit_id: demo.secondRoomId,
      arrival_date: "2027-04-01",
      departure_date: "2027-04-03",
      reason: "Maintenance query contract",
      status: "ACTIVE",
      version: 1,
      released_at: null
    });
    expect(Object.keys(lock).sort()).toEqual([
      "arrival_date", "created_at", "departure_date", "id", "inventory_unit_id", "property_id",
      "reason", "released_at", "status", "version"
    ].sort());
    const released = await app.inject({
      method: "GET",
      url: `/api/v1/maintenance-locks?propertyId=${demo.propertyId}&status=RELEASED`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual({ maintenanceLocks: [] });
    const outsideScope = await app.inject({
      method: "GET",
      url: "/api/v1/maintenance-locks?propertyId=prop_outside_scope",
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(outsideScope.statusCode).toBe(403);
    expect(outsideScope.json()).toMatchObject({ code: "RESOURCE_SCOPE_DENIED", retryable: false });
  });

  it("returns a stable 409 error when a Confirm idempotency key is reused with another payload", async () => {
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "confirm-reuse-preview",
        "x-correlation-id": "confirm-reuse"
      },
      payload: {
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: demo.propertyId,
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: "2027-03-01",
          departureDate: "2027-03-02",
          reason: "Contract idempotency test"
        }
      }
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json().preview;
    const confirmHeaders = {
      authorization: `Bearer ${demo.writeToken}`,
      "content-type": "application/json",
      "idempotency-key": "confirm-reused-key",
      "x-correlation-id": "confirm-reuse"
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: confirmHeaders,
      payload: { propertyId: demo.propertyId, commandType: "LOCK_MAINTENANCE", confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: "CONTRACT_TEST", note: "First confirmation payload" } }
    });
    expect(first.statusCode).toBe(200);
    const conflicting = await app.inject({
      method: "POST",
      url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: confirmHeaders,
      payload: { propertyId: demo.propertyId, commandType: "LOCK_MAINTENANCE", confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: "CONTRACT_TEST", note: "Different confirmation payload" } }
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      correlationId: "confirm-reuse",
      retryable: false
    });
  });

  it("enforces the read-only token ceiling and returns a stable error DTO", async () => {
    const read = await app.inject({ method: "GET", url: "/api/v1/meta", headers: { authorization: `Bearer ${demo.readToken}` } });
    expect(read.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.readToken}`,
        "content-type": "application/json",
        "idempotency-key": "readonly-contract",
        "x-correlation-id": "readonly-contract"
      },
      payload: {
        commandType: "LOCK_MAINTENANCE",
        input: { propertyId: demo.propertyId, inventoryUnitId: demo.secondRoomId, arrivalDate: "2026-07-21", departureDate: "2026-07-22", reason: "contract" }
      }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "INSUFFICIENT_ACCESS", correlationId: "readonly-contract", retryable: false });
  });

  it("requires command metadata before any write", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: { authorization: `Bearer ${demo.writeToken}`, "content-type": "application/json" },
      payload: { commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: "order_missing" } }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", retryable: false });

    const quote = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { authorization: `Bearer ${demo.readToken}`, "content-type": "application/json" },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2027-11-01",
        departureDate: "2027-11-02",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quote.statusCode).toBe(400);
    expect(quote.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", retryable: false });
  });

  it("uses an HttpOnly session for Web while preserving the same subject grants", async () => {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "operator", password: "demo-pass-2026" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((entry) => entry.name === "qintopia_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");
    const me = await app.inject({ method: "GET", url: "/api/v1/me", cookies: { qintopia_session: cookie!.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ subjectId: demo.operatorSubjectId, credentialType: "SESSION", propertyAccess: { [demo.propertyId]: "WRITE" } });
  });

  it("distinguishes a command that was never executed", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=CREATE_ORDER&idempotencyKey=never-arrived`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
  });

  it("serializes stable order, member, fact, and audit views from executed facts", async () => {
    const quoteResponse = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-view-quote",
        "x-correlation-id": "contract-view-quote"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2026-11-10",
        departureDate: "2026-11-12",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quoteResponse.statusCode).toBe(200);
    const created = await command(demo.writeToken, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quoteResponse.json().quote.quoteId,
      primaryGuest: { fullName: "Contract View Guest", phone: "13800000000", documentNumber: "DOC-CONTRACT-1" },
      bookingChannelCode: "CTRIP",
      channelOrderReference: "TEST-CONTRACT-ORDER-1"
    });
    const orderId = created.result.orderId as string;
    const listed = await app.inject({
      method: "GET", url: `/api/v1/orders?propertyId=${demo.propertyId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().orders).toEqual(expect.arrayContaining([expect.objectContaining({ id: orderId })]));
    const detail = await app.inject({
      method: "GET", url: `/api/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      order: { id: orderId, primary_guest_snapshot: { fullName: "Contract View Guest" }, booking_channel_code: "CTRIP", channel_order_reference: "TEST-CONTRACT-ORDER-1" },
      stay: { status: "PLANNED" },
      pricingRevisions: [{ revision_no: 1 }]
    });
    const collection = await command(demo.writeToken, "RECORD_COLLECTION", {
      propertyId: demo.propertyId, orderId, amountMinor: 6_000, method: "CASH", transactionReference: "TEST-CONTRACT-TXN-COLLECTION-1", note: "Contract fact"
    });
    const factId = collection.result.factId as string;
    const fact = await app.inject({
      method: "GET", url: `/api/v1/facts/${factId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(fact.statusCode).toBe(200);
    expect(fact.json()).toMatchObject({ fact_id: factId, order_id: orderId, fact_type: "COLLECTION", transaction_reference: "TEST-CONTRACT-TXN-COLLECTION-1", property_id: demo.propertyId });
    const registeredMember = await command(demo.writeToken, "CREATE_MEMBER", {
      propertyId: demo.propertyId,
      fullName: "Contract API Member",
      identityCardNumber: "test-contract-api-member-id",
      phone: "13800000333",
      wechat: "contract-api-member",
      validFrom: "2026-11-01",
      validUntil: "2027-10-31",
      sourceApplicationRecordId: "rec_contract_api_member"
    });
    expect(registeredMember.result).toMatchObject({
      memberCreated: true,
      memberContractCreated: true,
      externalReferenceCreated: true
    });
    const memberId = registeredMember.result.memberId as string;
    const memberContractId = registeredMember.result.memberContractId as string;
    expect(registeredMember.resourceRefs).toEqual([
      memberId,
      memberContractId,
      registeredMember.result.memberExternalReferenceId
    ]);
    const memberSearch = await app.inject({
      method: "GET",
      url: `/api/v1/members?propertyId=${demo.propertyId}&identityCardNumber=TEST-CONTRACT-API-MEMBER-ID`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(memberSearch.statusCode).toBe(200);
    expect(memberSearch.json()).toMatchObject({
      members: [{
        member: { id: memberId, identity_card_number: "TEST-CONTRACT-API-MEMBER-ID", full_name: "Contract API Member" },
        contracts: [{ id: memberContractId, member_id: memberId }],
        availableBalance: { ROOM_NIGHT: 0, BED_NIGHT: 0 }
      }]
    });
    const member = await app.inject({
      method: "GET", url: `/api/v1/members/${memberId}?propertyId=${demo.propertyId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(member.statusCode).toBe(200);
    expect(member.json()).toMatchObject({
      member: { id: memberId, identity_card_number: "TEST-CONTRACT-API-MEMBER-ID" },
      contracts: [{ id: memberContractId, member_id: memberId }],
      lots: [],
      ledger: [],
      externalReferences: [{ provider: "FEISHU_BASE", external_record_id: "rec_contract_api_member", property_id: demo.propertyId }],
      availableBalance: { ROOM_NIGHT: 0, BED_NIGHT: 0 }
    });
    const audit = await app.inject({
      method: "GET", url: `/api/v1/audit?propertyId=${demo.propertyId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries).toEqual(expect.arrayContaining([expect.objectContaining({ action: "RECORD_COLLECTION" })]));
  });

  it("enforces narrowed Token issuance and immediate rotation/revocation", async () => {
    const readSecret = newOpaqueSecret("qtp");
    const readIssue = await command(demo.writeToken, "ISSUE_TOKEN", {
      propertyId: demo.propertyId, subjectId: demo.agentSubjectId, label: "Contract read token",
      accessCeiling: "READ", expiresAt: "2029-01-01T00:00:00.000Z", tokenSecret: readSecret
    });
    expect(readIssue.result).not.toHaveProperty("tokenSecret");
    const denied = await app.inject({
      method: "POST", url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${readSecret}`, "content-type": "application/json",
        "idempotency-key": "narrowed-write", "x-correlation-id": "narrowed-write"
      },
      payload: { commandType: "LOCK_MAINTENANCE", input: { propertyId: demo.propertyId, inventoryUnitId: demo.roomId, arrivalDate: "2026-07-25", departureDate: "2026-07-26", reason: "denied" } }
    });
    expect(denied.statusCode).toBe(403);

    const oldSecret = newOpaqueSecret("qtp");
    const writeIssue = await command(demo.writeToken, "ISSUE_TOKEN", {
      propertyId: demo.propertyId, subjectId: demo.agentSubjectId, label: "Contract rotating token",
      accessCeiling: "WRITE", expiresAt: "2029-01-01T00:00:00.000Z", tokenSecret: oldSecret
    });
    expect(writeIssue.result).not.toHaveProperty("tokenSecret");
    const oldTokenId = writeIssue.result.tokenId as string;
    const replacementSecret = newOpaqueSecret("qtp");
    const rotated = await command(oldSecret, "ROTATE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: oldTokenId,
      tokenSecret: replacementSecret
    });
    expect(rotated.result).not.toHaveProperty("tokenSecret");
    const replacementTokenId = rotated.result.tokenId as string;
    const oldResponse = await app.inject({ method: "GET", url: "/api/v1/meta", headers: { authorization: `Bearer ${oldSecret}` } });
    expect(oldResponse.statusCode).toBe(401);
    expect(oldResponse.json().code).toBe("TOKEN_REVOKED");
    expect((await app.inject({ method: "GET", url: "/api/v1/meta", headers: { authorization: `Bearer ${replacementSecret}` } })).statusCode).toBe(200);
    await command(replacementSecret, "REVOKE_TOKEN", { propertyId: demo.propertyId, tokenId: replacementTokenId });
    const revoked = await app.inject({ method: "GET", url: "/api/v1/meta", headers: { authorization: `Bearer ${replacementSecret}` } });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().code).toBe("TOKEN_REVOKED");
  });
});
