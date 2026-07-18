import pg from "pg";
import { databaseUrl } from "./database.ts";

if (process.env.ALLOW_DB_RESET !== "true") {
  throw new Error("Set ALLOW_DB_RESET=true to reset the database");
}

const client = new pg.Client({ connectionString: databaseUrl() });
await client.connect();
try {
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  process.stdout.write("Database schema reset\n");
} finally {
  await client.end();
}
