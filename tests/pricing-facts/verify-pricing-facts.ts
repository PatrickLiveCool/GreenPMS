import path from "node:path";
import { pathToFileURL } from "node:url";
import { pricingFactExecutors } from "./executors.ts";
import { PricingFactsError, runPricingFactsGate } from "./harness.ts";

export async function verifyPricingFacts(projectRoot = process.cwd()): Promise<void> {
  const result = await runPricingFactsGate({
    casesDirectory: path.join(projectRoot, "docs", "pricing-facts", "cases"),
    schemaPath: path.join(projectRoot, "docs", "pricing-facts", "pricing-case.schema.json"),
    executors: pricingFactExecutors
  });
  process.stdout.write(`Verified ${result.caseCount} real pricing fact cases.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void verifyPricingFacts().catch((error: unknown) => {
    if (error instanceof PricingFactsError) {
      process.stderr.write(`${error.code}: ${error.message}\n${JSON.stringify(error.details, null, 2)}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
