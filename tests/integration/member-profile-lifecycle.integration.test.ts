import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getMemberView,
  getOrderView,
  listMemberSummaries,
  type Database
} from "@qintopia/db";
import type { Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.MEMBER_PROFILE_LIFECYCLE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_member_profile_lifecycle";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function confirm(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const created = await preview(envelope, prefix);
  return confirmCommandPreview(db, principal, created.preview.previewId, {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: created.preview.effectHash,
    reason: { code: "MEMBER_LIFECYCLE_TEST", note: `Confirm ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMemberOrder(prefix: string, arrivalDate: string, departureDate: string): Promise<string> {
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: demo.roomId,
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.transientPolicyId,
    memberContractId: demo.memberContractId
  });
  const receipt = await confirm({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `Member lifecycle ${prefix}` },
      bookingChannelCode: "WECOM",
      channelOrderReference: null
    }
  }, `${prefix}-create-order`);
  return receipt.result!.orderId as string;
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  await db.destroy();
});

describe("member profile registration and derived balances", () => {
  it("creates one immutable member identity, one initial empty contract, and an append-only Feishu application reference", async () => {
    const envelope: CommandEnvelope = {
      commandType: "CREATE_MEMBER",
      input: {
        propertyId: demo.propertyId,
        fullName: "张三",
        identityCardNumber: "31000019900101001x",
        phone: "13800000088",
        wechat: "zhangsan-wechat",
        validFrom: "2026-08-01",
        validUntil: "2027-07-31",
        sourceApplicationRecordId: "rec_member_application_001"
      }
    };
    const createdPreview = await preview(envelope, "create-member");
    expect(createdPreview.preview.effect).toMatchObject({
      operation: "CREATE_MEMBER_WITH_INITIAL_CONTRACT",
      memberId: null,
      memberContractId: null,
      profileMatch: true,
      member: { identityCardNumber: "31000019900101001X" },
      contract: { operation: "CREATE_INITIAL_EMPTY_CONTRACT", validFrom: "2026-08-01", validUntil: "2027-07-31" },
      externalReference: {
        operation: "CREATE_LINK",
        provider: "FEISHU_BASE",
        sourceContainerId: "wiki:FtxUwOE6diwS8wkmaawcDhEPnMc",
        sourceTableId: "tbl4OryeWd0Td8jN",
        externalRecordId: "rec_member_application_001"
      }
    });
    const receipt = await confirmCommandPreview(db, principal, createdPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_MEMBER",
      confirmation: true,
      expectedEffectHash: createdPreview.preview.effectHash,
      reason: { code: "MEMBER_CREATED", note: "Create member from a verified application" }
    }, metadata("create-member-confirm"));
    expect(receipt.result).toMatchObject({
      memberCreated: true,
      memberContractCreated: true,
      externalReferenceCreated: true
    });
    const memberId = receipt.result!.memberId as string;
    const contractId = receipt.result!.memberContractId as string;
    const externalReferenceId = receipt.result!.memberExternalReferenceId as string;
    expect(receipt.resourceRefs).toEqual([memberId, contractId, externalReferenceId]);

    const view = await getMemberView(db, demo.propertyId, memberId);
    expect(view.member).toMatchObject({ id: memberId, identity_card_number: "31000019900101001X", full_name: "张三" });
    expect(view.contracts).toEqual([expect.objectContaining({ id: contractId, member_id: memberId, status: "ACTIVE" })]);
    expect(view.availableBalance).toEqual({ ROOM_NIGHT: 0, BED_NIGHT: 0 });
    expect(view.externalReferences).toEqual([expect.objectContaining({ id: externalReferenceId, external_record_id: "rec_member_application_001" })]);
    await expect(db.insertInto("members").values({
      id: "member_duplicate_identity_case",
      identity_card_number: "31000019900101001x",
      full_name: "Duplicate Identity",
      phone: "13800000089",
      wechat: "duplicate-identity"
    }).execute()).rejects.toMatchObject({ constraint: "members_identity_card_number_key" });

    await db.insertInto("properties").values({
      id: "prop_member_isolation",
      code: "MEMBER-ISOLATION",
      name: "Member isolation property",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    }).execute();
    await db.insertInto("member_contracts").values({
      id: "contract_member_isolation",
      property_id: "prop_member_isolation",
      member_id: memberId,
      member_name: "张三",
      status: "ACTIVE",
      valid_from: "2026-08-01",
      valid_until: "2027-07-31",
      version: 1
    }).execute();
    expect((await getMemberView(db, "prop_member_isolation", memberId)).externalReferences).toEqual([]);

    await expect(db.updateTable("members").set({ identity_card_number: "CHANGED" }).where("id", "=", memberId).execute())
      .rejects.toThrow(/member identity is immutable/);
    await expect(db.deleteFrom("members").where("id", "=", memberId).execute())
      .rejects.toThrow(/member identity is immutable/);
    await expect(db.updateTable("member_external_references").set({ external_record_id: "changed" }).where("id", "=", externalReferenceId).execute())
      .rejects.toThrow(/member_external_references is append-only/);
    await expect(db.insertInto("member_contracts").values({
      id: "contract_without_member_profile",
      property_id: demo.propertyId,
      member_name: "Forbidden historical-shaped insert",
      status: "ACTIVE",
      valid_from: "2026-01-01",
      valid_until: "2026-12-31",
      version: 1
    }).execute()).rejects.toMatchObject({ constraint: "member_contracts_new_member_required" });
  });

  it("matches an existing identity without overwriting profile fields or requiring a contract, and links each application once", async () => {
    const first = await confirm({
      commandType: "CREATE_MEMBER",
      input: {
        propertyId: demo.propertyId,
        fullName: "Existing Member",
        identityCardNumber: "TEST-EXISTING-MEMBER-ID",
        phone: "13800000111",
        wechat: "existing-member",
        validFrom: "2026-01-01",
        validUntil: "2027-01-01"
      }
    }, "existing-member-first");
    const memberId = first.result!.memberId as string;
    const contractId = first.result!.memberContractId as string;
    await db.updateTable("member_contracts").set({ status: "EXPIRED" }).where("id", "=", contractId).execute();

    const matchEnvelope: CommandEnvelope = {
      commandType: "CREATE_MEMBER",
      input: {
        propertyId: demo.propertyId,
        fullName: "Different submitted name",
        identityCardNumber: "test-existing-member-id",
        phone: "13999999999",
        wechat: "different-submitted-wechat",
        sourceApplicationRecordId: "rec_member_application_existing"
      }
    };
    const matchPreview = await preview(matchEnvelope, "existing-member-match");
    expect(matchPreview.preview.effect).toMatchObject({
      operation: "MATCH_EXISTING_MEMBER",
      memberId,
      memberContractId: null,
      profileMatch: false,
      member: { fullName: "Existing Member", phone: "13800000111", wechat: "existing-member" },
      submittedProfile: { fullName: "Different submitted name", phone: "13999999999" },
      contract: { operation: "NO_CONTRACT_SELECTED", validFrom: null, validUntil: null }
    });
    const matched = await confirmCommandPreview(db, principal, matchPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_MEMBER",
      confirmation: true,
      expectedEffectHash: matchPreview.preview.effectHash,
      reason: { code: "APPLICATION_LINKED", note: "Link application to the existing identity" }
    }, metadata("existing-member-match-confirm"));
    expect(matched.result).toMatchObject({ memberId, memberContractId: null, memberCreated: false, memberContractCreated: false, externalReferenceCreated: true });
    expect(await db.selectFrom("members").selectAll().where("identity_card_number", "=", "TEST-EXISTING-MEMBER-ID").execute())
      .toEqual([expect.objectContaining({ full_name: "Existing Member", phone: "13800000111", wechat: "existing-member" })]);

    const replayedLink = await confirm(matchEnvelope, "existing-member-link-replay-new-key");
    expect(replayedLink.result).toMatchObject({
      memberId,
      memberContractId: null,
      memberCreated: false,
      memberExternalReferenceId: matched.result!.memberExternalReferenceId,
      externalReferenceCreated: false
    });
    expect(await db.selectFrom("member_external_references").select("id").where("member_id", "=", memberId).execute()).toHaveLength(1);
  });

  it("searches by normalized identity and returns balances derived from Lot and Ledger facts", async () => {
    await confirm({
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: demo.roomLotId, quantityDelta: 3, adjustmentReason: "Derived balance test" }
    }, "derived-balance-adjust");
    const summaries = await listMemberSummaries(db, demo.propertyId, "demo-id-310000199001010001");
    expect(summaries).toEqual([expect.objectContaining({
      member: expect.objectContaining({ id: demo.memberId, identity_card_number: "DEMO-ID-310000199001010001" }),
      availableBalance: { ROOM_NIGHT: 5, BED_NIGHT: 2 }
    })]);
    const current = await getMemberView(db, demo.propertyId, demo.memberId);
    const expiry = new Date(`${current.balanceAsOfDate}T00:00:00.000Z`);
    expiry.setUTCDate(expiry.getUTCDate() - 1);
    await db.insertInto("entitlement_lots").values({
      id: "lot_ledger_available_but_date_expired",
      contract_id: demo.memberContractId,
      unit_kind: "ROOM_NIGHT",
      total_units: 10,
      expires_on: expiry.toISOString().slice(0, 10),
      version: 1
    }).execute();
    const afterExpiredLot = await getMemberView(db, demo.propertyId, demo.memberId);
    expect(afterExpiredLot.lotBalances.find((lot) => lot.lotId === "lot_ledger_available_but_date_expired")?.availableUnits).toBe(0);
    expect(afterExpiredLot.availableBalance).toEqual({ ROOM_NIGHT: 5, BED_NIGHT: 2 });
    expect(await listMemberSummaries(db, demo.propertyId, "identity-not-present")).toEqual([]);
  });

  it("rejects a stale concurrent registration Preview without a second member write", async () => {
    const envelope: CommandEnvelope = {
      commandType: "CREATE_MEMBER",
      input: {
        propertyId: demo.propertyId,
        fullName: "Concurrent Member",
        identityCardNumber: "TEST-CONCURRENT-MEMBER-ID",
        phone: "13800000222",
        wechat: "concurrent-member",
        validFrom: "2026-01-01",
        validUntil: "2027-01-01"
      }
    };
    const first = await preview(envelope, "member-concurrent-first");
    const second = await preview(envelope, "member-concurrent-second");
    await confirmCommandPreview(db, principal, first.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_MEMBER",
      confirmation: true,
      expectedEffectHash: first.preview.effectHash,
      reason: { code: "FIRST_WINS", note: "First concurrent member registration" }
    }, metadata("member-concurrent-first-confirm"));
    const stale = await confirmCommandPreview(db, principal, second.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_MEMBER",
      confirmation: true,
      expectedEffectHash: second.preview.effectHash,
      reason: { code: "SECOND_STALE", note: "Second concurrent member registration" }
    }, metadata("member-concurrent-second-confirm"));
    expect(stale).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" },
      resourceRefs: [],
      factRefs: []
    });
    expect(await db.selectFrom("members").select("id").where("identity_card_number", "=", "TEST-CONCURRENT-MEMBER-ID").execute()).toHaveLength(1);
  });
});

describe("check-in entitlement consumption lifecycle", () => {
  it("consumes HELD coverage at CHECK_IN and CHECK_OUT does not consume it again", async () => {
    const orderId = await createMemberOrder("check-in-consume", "2028-06-01", "2028-06-03");
    const checkedInPreview = await preview({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "check-in-consume");
    expect(checkedInPreview.preview.effect).toMatchObject({ entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: 2 } });
    const checkedIn = await confirmCommandPreview(db, principal, checkedInPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CHECK_IN",
      confirmation: true,
      expectedEffectHash: checkedInPreview.preview.effectHash,
      reason: { code: "CHECKED_IN", note: "Consume held member entitlement on arrival" }
    }, metadata("check-in-consume-confirm"));
    expect(checkedIn.factRefs).toHaveLength(2);
    expect((await getOrderView(db, orderId)).coverageSet.map((coverage) => coverage.status)).toEqual(["CONSUMED", "CONSUMED"]);

    const checkedOut = await confirm({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId } }, "check-out-no-repeat");
    expect(checkedOut.factRefs).toEqual([]);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("order_id", "=", orderId).where("entry_type", "=", "CONSUME").execute()).toHaveLength(2);
  });

  it("never restores consumed nights when an in-house member stay is shortened", async () => {
    const orderId = await createMemberOrder("shorten-consumed", "2028-07-01", "2028-07-03");
    await confirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "shorten-consumed-check-in");
    const shortened = await confirm({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: "2028-07-02" }
    }, "shorten-consumed-command");
    expect(shortened.factRefs).toEqual([]);
    const coverage = (await getOrderView(db, orderId)).coverageSet;
    expect(coverage).toHaveLength(2);
    expect(coverage.every((item) => item.status === "CONSUMED")).toBe(true);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("order_id", "=", orderId).where("entry_type", "=", "RELEASE").execute()).toHaveLength(0);
  });

  it("keeps consumed coverage identity on a same-kind in-house move", async () => {
    const orderId = await createMemberOrder("move-consumed", "2028-08-01", "2028-08-03");
    await confirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "move-consumed-check-in");
    const before = await getOrderView(db, orderId);
    const moved = await confirm({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: "2028-08-02" }
    }, "move-consumed-command");
    expect(moved.factRefs).toEqual([]);
    const after = await getOrderView(db, orderId);
    expect(after.currentSegment.inventoryUnitId).toBe(demo.secondRoomId);
    expect(after.coverageSet.map((coverage) => ({ id: coverage.id, inventory: coverage.inventory_unit_id, status: coverage.status })))
      .toEqual(before.coverageSet.map((coverage) => ({ id: coverage.id, inventory: coverage.inventory_unit_id, status: "CONSUMED" })));
  });

  it("immediately consumes newly covered nights added to an in-house order", async () => {
    const orderId = await createMemberOrder("refresh-in-house", "2028-09-01", "2028-09-04");
    await confirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "refresh-in-house-check-in");
    expect((await getOrderView(db, orderId)).coverageSet).toHaveLength(2);
    await confirm({
      commandType: "ADD_MEMBER_ENTITLEMENT_LOT",
      input: { propertyId: demo.propertyId, memberContractId: demo.memberContractId, unitKind: "ROOM_NIGHT", units: 1, expiresOn: "2029-12-31" }
    }, "refresh-in-house-top-up");
    const refreshed = await confirm({ commandType: "REFRESH_MEMBER_COVERAGE", input: { propertyId: demo.propertyId, orderId } }, "refresh-in-house-command");
    const refreshedFacts = await db.selectFrom("entitlement_ledger").select(["entry_type", "coverage_id"])
      .where("command_id", "=", refreshed.commandId).orderBy("entry_type").execute();
    expect(refreshedFacts.map((fact) => fact.entry_type).sort()).toEqual(["CONSUME", "HOLD"]);
    const view = await getOrderView(db, orderId);
    expect(view.coverageSet).toHaveLength(3);
    expect(view.coverageSet.every((coverage) => coverage.status === "CONSUMED")).toBe(true);
    expect(view.pricingRevisions.at(-1)!.current_contract_amount_minor).toBe(0);
  });
});
