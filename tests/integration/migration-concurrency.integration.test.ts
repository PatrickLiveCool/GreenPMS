import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

beforeAll(async () => {
  await dropDatabase();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
});

afterAll(dropDatabase);

describe("database migration concurrency", () => {
  it("serializes two fresh-database migrators and applies every migration once", async () => {
    const runMigration = () => execFileAsync(
      process.execPath,
      ["--import", "tsx", "packages/db/src/migrate.ts"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl.toString() } }
    );

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
      expect(expectedMigrations).toHaveLength(11);
      expect(expectedMigrations).toContain("011_core_fact_shape_guards.sql");
    } finally {
      await client.end();
    }
  });
});
