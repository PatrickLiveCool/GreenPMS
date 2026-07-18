import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database } from "@qintopia/db";
import type { Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.PRICING_POLICY_GUARD_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_pricing_policy_guard";

const unapprovedStayTypes = ["WEEKLY", "MONTHLY", "CUSTOM", "FIXED_TERM", "ROLLING"] as const;
const expiredQuoteId = "quote_pricing_guard_expired_sentinel";

let db: Kysely<Database>;

function policyId(stayType: typeof unapprovedStayTypes[number]): string {
  return `policy_unapproved_${stayType.toLowerCase()}`;
}

beforeAll(async () => {
  db = await resetDatabase(databaseUrl);
  await db.insertInto("pricing_policy_versions").values(unapprovedStayTypes.map((stayType) => ({
    id: policyId(stayType),
    property_id: demo.propertyId,
    code: `UNAPPROVED-${stayType}`,
    version: 1,
    stay_type: stayType,
    calculation_kind: "FLAT_NIGHTLY" as const,
    nightly_rate_minor: 9_999,
    currency: "CNY",
    status: "PUBLISHED" as const
  }))).execute();

  await db.insertInto("quotes").values({
    id: expiredQuoteId,
    property_id: demo.propertyId,
    inventory_unit_id: demo.roomId,
    stay_type: "TRANSIENT",
    arrival_date: "2026-07-20",
    departure_date: "2026-07-21",
    policy_version_id: demo.transientPolicyId,
    member_contract_id: null,
    requester_subject_id: demo.agentSubjectId,
    input_hash: "f".repeat(64),
    coverage_set: [],
    cash_lines: [],
    cash_remainder_minor: 0,
    current_contract_amount_minor: 0,
    currency: "CNY",
    expires_at: "2020-01-01T00:00:00.000Z"
  }).execute();
});

afterAll(async () => {
  if (db) await db.destroy();
});

describe.sequential("unapproved pricing policy guard on PostgreSQL", () => {
  it.each(unapprovedStayTypes)("rejects a matching published %s policy and rolls back every quote-side write", async (stayType) => {
    await expect(createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType,
      arrivalDate: "2026-07-20",
      departureDate: "2026-07-22",
      pricingPolicyVersionId: policyId(stayType),
      requesterSubjectId: demo.agentSubjectId
    })).rejects.toMatchObject({
      code: "PRICING_POLICY_UNCONFIGURED",
      statusCode: 422
    });

    const [quotes, orders, claims, coverage] = await Promise.all([
      db.selectFrom("quotes").select("id").orderBy("id").execute(),
      db.selectFrom("orders").select("id").execute(),
      db.selectFrom("inventory_claims").select("id").execute(),
      db.selectFrom("coverage_items").select("id").execute()
    ]);
    expect(quotes).toEqual([{ id: expiredQuoteId }]);
    expect(orders).toHaveLength(0);
    expect(claims).toHaveLength(0);
    expect(coverage).toHaveLength(0);
  });
});
