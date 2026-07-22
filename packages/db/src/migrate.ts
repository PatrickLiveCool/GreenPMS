import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl } from "./database.ts";

const migrationsDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
const client = new pg.Client({ connectionString: databaseUrl() });

await client.connect();
let transactionOpen = false;
let migrationLockHeld = false;
try {
  await client.query("SELECT pg_advisory_lock(hashtextextended('qintopia:migrate', 0))");
  migrationLockHeld = true;

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  await client.query("COMMIT");
  transactionOpen = false;

  const migrationNames = (await readdir(migrationsDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const migrationName of migrationNames) {
    await client.query("BEGIN");
    transactionOpen = true;
    try {
      const applied = await client.query<{ name: string }>("SELECT name FROM schema_migrations WHERE name = $1", [migrationName]);
      if (applied.rowCount === 0) {
        await client.query(await readFile(`${migrationsDirectory}/${migrationName}`, "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [migrationName]);
      }
      await client.query("COMMIT");
      transactionOpen = false;
      process.stdout.write(applied.rowCount === 0 ? `Applied ${migrationName}\n` : `${migrationName} already applied\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      throw error;
    }
  }
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK");
  throw error;
} finally {
  if (migrationLockHeld) await client.query("SELECT pg_advisory_unlock(hashtextextended('qintopia:migrate', 0))");
  await client.end();
}
