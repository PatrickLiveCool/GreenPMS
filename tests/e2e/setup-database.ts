import { resetDatabase } from "../helpers/database.ts";

export const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";

async function main() {
  const db = await resetDatabase(e2eDatabaseUrl);
  await db.destroy();
  process.stdout.write("Prepared qintopia_e2e with migrations and demo seed\n");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
