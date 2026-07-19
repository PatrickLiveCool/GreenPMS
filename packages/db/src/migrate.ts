import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl } from "./database.ts";

const migrationsDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
const client = new pg.Client({ connectionString: databaseUrl() });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('qintopia:migrate', 0))");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const migrationNames = (await readdir(migrationsDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const migrationName of migrationNames) {
    const applied = await client.query<{ name: string }>("SELECT name FROM schema_migrations WHERE name = $1", [migrationName]);
    if (applied.rowCount === 0) {
      await client.query(await readFile(`${migrationsDirectory}/${migrationName}`, "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [migrationName]);
      process.stdout.write(`Applied ${migrationName}\n`);
    } else {
      process.stdout.write(`${migrationName} already applied\n`);
    }
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
