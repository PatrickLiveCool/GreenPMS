import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@qintopia/db";
import { demo, seedDemo } from "../../packages/db/src/seed.ts";

const execFileAsync = promisify(execFile);
const adminUrl = process.env.MIGRATION_CONCURRENCY_ADMIN_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";
const databaseName = `qintopia_migration_concurrency_${process.pid}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

async function dropDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

async function recreateDatabase(): Promise<void> {
  await dropDatabase();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

function runMigration() {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx", "packages/db/src/migrate.ts"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl.toString() } }
  );
}

beforeAll(async () => {
  await recreateDatabase();
});

afterAll(dropDatabase);

describe("database migration concurrency", () => {
  it("serializes two fresh-database migrators and applies every migration once", async () => {
    const outcomes = await Promise.allSettled([runMigration(), runMigration()]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);

    const client = new pg.Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    try {
      const expectedMigrations = (await readdir("packages/db/src/migrations"))
        .filter((name) => /^\d+.*\.sql$/.test(name))
        .sort();
      const rows = await client.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
      expect(rows.rows.map((row) => row.name)).toEqual(expectedMigrations);
      expect(expectedMigrations).toHaveLength(19);
      expect(expectedMigrations).toContain("015_generated_room_operational_codes.sql");
      expect(expectedMigrations).toContain("016_member_property_links.sql");
      expect(expectedMigrations).toContain("017_membership_orders.sql");
      expect(expectedMigrations).toContain("018_member_stay_identity_and_coverage_guards.sql");
      expect(expectedMigrations).toContain("019_member_stay_booking_channel_rules.sql");
    } finally {
      await client.end();
    }
  });

  it("upgrades a populated revision-010 database with a historical maintenance lock longer than 90 nights", async () => {
    await recreateDatabase();
    const migrationNames = (await readdir("packages/db/src/migrations"))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    const client = new pg.Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    try {
      for (const migrationName of migrationNames.slice(0, 10)) {
        await client.query(await readFile(`packages/db/src/migrations/${migrationName}`, "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [migrationName]);
      }
    } finally {
      await client.end();
    }

    const seeded = createDatabase(databaseUrl.toString());
    try {
      await seedDemo(seeded);
    } finally {
      await seeded.destroy();
    }

    let historicalFactsBefore: { contracts: number; lots: number; ledger: number } | undefined;
    const legacy = new pg.Client({ connectionString: databaseUrl.toString() });
    await legacy.connect();
    try {
      await legacy.query("ALTER TABLE inventory_units DISABLE TRIGGER inventory_units_protect_identity");
      await legacy.query(`
        UPDATE inventory_units
        SET name = CASE id
              WHEN 'unit_room_101' THEN 'Room 101'
              WHEN 'unit_room_102' THEN 'Room 102'
              WHEN 'unit_room_101_bed_a' THEN 'Room 101 / Bed A'
              WHEN 'unit_room_101_bed_b' THEN 'Room 101 / Bed B'
            END,
            catalog_version = NULL,
            building_code = NULL,
            room_type_code = NULL,
            pricing_product_code = NULL,
            inventory_basis = NULL,
            code_provenance = NULL,
            physical_bed_count = NULL
        WHERE id IN ('unit_room_101', 'unit_room_102', 'unit_room_101_bed_a', 'unit_room_101_bed_b')
      `);
      await legacy.query("ALTER TABLE inventory_units ENABLE TRIGGER inventory_units_protect_identity");
      await legacy.query(`
        INSERT INTO maintenance_locks (
          id, property_id, inventory_unit_id, arrival_date, departure_date, reason, status, version, released_at
        ) VALUES (
          'maint_legacy_long_interval', 'prop_qintopia_demo', 'unit_room_102',
          '2030-01-01', '2030-07-01', 'Historical long maintenance interval', 'ACTIVE', 1, NULL
        )
      `);
      await legacy.query(`
        INSERT INTO members (id, identity_card_number, full_name, phone, wechat)
        VALUES ('member_external_only_legacy', 'EXTERNAL-ONLY-LEGACY', 'External only legacy', '13900009991', 'external-only-legacy')
      `);
      await legacy.query(`
        INSERT INTO member_external_references (
          id, member_id, property_id, provider, source_container_id, source_table_id, external_record_id
        ) VALUES (
          'memberref_external_only_legacy', 'member_external_only_legacy', 'prop_qintopia_demo',
          'FEISHU_BASE', 'legacy-container', 'legacy-table', 'legacy-external-only-record'
        )
      `);
      historicalFactsBefore = (await legacy.query<{ contracts: number; lots: number; ledger: number }>(`
        SELECT
          (SELECT count(*)::int FROM member_contracts) AS contracts,
          (SELECT count(*)::int FROM entitlement_lots) AS lots,
          (SELECT count(*)::int FROM entitlement_ledger) AS ledger
      `)).rows[0];
    } finally {
      await legacy.end();
    }

    const outcome = await runMigration();
    expect(outcome.stderr).toBe("");

    const upgraded = new pg.Client({ connectionString: databaseUrl.toString() });
    await upgraded.connect();
    try {
      const rows = await upgraded.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
      expect(rows.rows.map((row) => row.name)).toEqual(migrationNames);
      const catalog = await upgraded.query<{ catalog_version: string | null }>(
        "SELECT catalog_version FROM inventory_units WHERE id = 'unit_room_101'"
      );
      expect(catalog.rows[0]?.catalog_version).not.toBeNull();
      expect((await upgraded.query("SELECT 1 FROM room_status_revisions LIMIT 1")).rowCount).toBe(1);
      const memberLinks = await upgraded.query<{ member_id: string; property_id: string }>(
        "SELECT member_id, property_id FROM member_property_links WHERE member_id = $1 AND property_id = $2",
        [demo.memberId, demo.propertyId]
      );
      expect(memberLinks.rows).toEqual([{ member_id: demo.memberId, property_id: demo.propertyId }]);
      const externalOnlyLinks = await upgraded.query<{ member_id: string; property_id: string }>(
        "SELECT member_id, property_id FROM member_property_links WHERE member_id = 'member_external_only_legacy'"
      );
      expect(externalOnlyLinks.rows).toEqual([{ member_id: "member_external_only_legacy", property_id: demo.propertyId }]);
      const historicalFactsAfter = (await upgraded.query<{ contracts: number; lots: number; ledger: number }>(`
        SELECT
          (SELECT count(*)::int FROM member_contracts) AS contracts,
          (SELECT count(*)::int FROM entitlement_lots) AS lots,
          (SELECT count(*)::int FROM entitlement_ledger) AS ledger
      `)).rows[0];
      expect(historicalFactsAfter).toEqual(historicalFactsBefore);

      await upgraded.query(`
        INSERT INTO members (id, identity_card_number, full_name, phone, wechat) VALUES
          ('member_contract_during_cutover', 'CONTRACT-DURING-CUTOVER', 'Contract cutover', '13900009992', 'contract-cutover'),
          ('member_reference_during_cutover', 'REFERENCE-DURING-CUTOVER', 'Reference cutover', '13900009993', 'reference-cutover')
      `);
      await upgraded.query(`
        INSERT INTO member_contracts (
          id, property_id, member_id, member_name, status, valid_from, valid_until, version
        ) VALUES (
          'contract_during_cutover', 'prop_qintopia_demo', 'member_contract_during_cutover',
          'Contract cutover', 'ACTIVE', '2026-01-01', '2026-12-31', 1
        )
      `);
      await upgraded.query(`
        INSERT INTO member_external_references (
          id, member_id, property_id, provider, source_container_id, source_table_id, external_record_id
        ) VALUES (
          'memberref_during_cutover', 'member_reference_during_cutover', 'prop_qintopia_demo',
          'FEISHU_BASE', 'cutover-container', 'cutover-table', 'cutover-record'
        )
      `);
      const cutoverLinks = await upgraded.query<{ member_id: string }>(`
        SELECT member_id FROM member_property_links
        WHERE member_id IN ('member_contract_during_cutover', 'member_reference_during_cutover')
        ORDER BY member_id
      `);
      expect(cutoverLinks.rows).toEqual([
        { member_id: "member_contract_during_cutover" },
        { member_id: "member_reference_during_cutover" }
      ]);
      const longMaintenance = await upgraded.query<{ nights: number }>(
        "SELECT departure_date - arrival_date AS nights FROM maintenance_locks WHERE id = 'maint_legacy_long_interval'"
      );
      expect(longMaintenance.rows[0]?.nights).toBeGreaterThan(90);
    } finally {
      await upgraded.end();
    }
  });
});
