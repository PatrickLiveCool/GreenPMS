import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

pg.types.setTypeParser(1082, (value) => value);

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";
}

export function createDatabase(url = databaseUrl()): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url, max: 20 })
    })
  });
}

export async function databaseReady(db: Kysely<Database>): Promise<boolean> {
  try {
    const rows = await db.selectFrom("schema_migrations").select("name").execute();
    const applied = new Set(rows.map((row) => row.name));
    return applied.has("001_initial.sql")
      && applied.has("002_immutability.sql")
      && applied.has("003_active_coverage_uniqueness.sql")
      && applied.has("004_security_identity_guards.sql")
      && applied.has("005_core_identity_and_entitlement_guards.sql")
      && applied.has("006_property_scoped_idempotency.sql")
      && applied.has("007_reference_catalog.sql")
      && applied.has("008_reference_catalog_sealing.sql")
      && applied.has("009_booking_channels_and_transaction_references.sql")
      && applied.has("010_qintopia_2026_catalog_pricing_and_free_stays.sql")
      && applied.has("011_core_fact_shape_guards.sql");
  } catch {
    return false;
  }
}
