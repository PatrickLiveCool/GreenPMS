import { DomainError } from "@qintopia/contracts";

export const POSTGRES_INTEGER_MAX = 2_147_483_647n;

export function parsePostgresBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new DomainError("INTERNAL_ERROR", `${field} is not a valid PostgreSQL bigint`, 500);
}

export function entitlementAvailableBalance(totalUnits: number, ledgerDelta: unknown): number {
  if (!Number.isSafeInteger(totalUnits) || totalUnits < 0) {
    throw new DomainError("INTERNAL_ERROR", "Entitlement lot total is invalid", 500);
  }
  return boundedEntitlementBalance(BigInt(totalUnits) + parsePostgresBigInt(ledgerDelta, "Entitlement ledger sum"));
}

export function adjustedEntitlementAvailableBalance(currentAvailable: number, quantityDelta: number): number {
  if (!Number.isSafeInteger(currentAvailable) || !Number.isSafeInteger(quantityDelta)) {
    throw new DomainError("INTERNAL_ERROR", "Entitlement adjustment operands are invalid", 500);
  }
  return boundedEntitlementBalance(BigInt(currentAvailable) + BigInt(quantityDelta));
}

function boundedEntitlementBalance(balance: bigint): number {
  if (balance < 0n || balance > POSTGRES_INTEGER_MAX) {
    throw new DomainError(
      "ENTITLEMENT_CONFLICT",
      "Entitlement available balance must remain within the PostgreSQL integer range",
      409,
      false,
      { availableBalance: balance.toString(), minimum: "0", maximum: POSTGRES_INTEGER_MAX.toString() }
    );
  }
  return Number(balance);
}
