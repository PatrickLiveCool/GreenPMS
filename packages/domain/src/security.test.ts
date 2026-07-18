import { describe, expect, it } from "vitest";
import { accessAllows, narrowAccess } from "./security.ts";

describe("ordered access", () => {
  it("orders READ below WRITE", () => {
    expect(accessAllows("WRITE", "READ")).toBe(true);
    expect(accessAllows("READ", "WRITE")).toBe(false);
  });

  it("allows a token to narrow but never expand subject access", () => {
    expect(narrowAccess("WRITE", "READ")).toBe("READ");
    expect(narrowAccess("READ", "WRITE")).toBe("READ");
    expect(narrowAccess("WRITE", "WRITE")).toBe("WRITE");
  });
});
