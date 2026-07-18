import { describe, expect, it } from "vitest";
import { enumerateServiceDates, parseLocalDate } from "./dates.ts";

describe("local service dates", () => {
  it("uses the half-open arrival/departure interval", () => {
    expect(enumerateServiceDates("2026-07-20", "2026-07-23")).toEqual(["2026-07-20", "2026-07-21", "2026-07-22"]);
  });

  it("rejects invalid and empty stays", () => {
    expect(() => parseLocalDate("2026-02-30")).toThrow(/Invalid local date/);
    expect(() => enumerateServiceDates("2026-07-20", "2026-07-20")).toThrow(/must be after/);
  });

  it("rejects resource-exhausting service-date ranges", () => {
    expect(() => enumerateServiceDates("2026-01-01", "2027-01-03")).toThrow(/cannot exceed 366/);
    expect(enumerateServiceDates("2026-01-01", "2027-01-02")).toHaveLength(366);
  });
});
