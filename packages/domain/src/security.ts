import { scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type { AccessLevel } from "@qintopia/contracts";

export function accessAllows(actual: AccessLevel, required: AccessLevel): boolean {
  return actual === "WRITE" || required === "READ";
}

export function narrowAccess(subjectAccess: AccessLevel, tokenCeiling: AccessLevel): AccessLevel {
  return subjectAccess === "READ" || tokenCeiling === "READ" ? "READ" : "WRITE";
}

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export async function verifyPassword(password: string, salt: string, expectedHex: string): Promise<boolean> {
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, (error, derivedKey) => error ? reject(error) : resolve(derivedKey));
  });
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
