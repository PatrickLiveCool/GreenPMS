import { createDatabase } from "@qintopia/db";
import { buildServer } from "./server.ts";

const app = await buildServer(createDatabase());
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4100) });
