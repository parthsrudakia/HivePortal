import { describe, expect, it } from "vitest";
import { proratedDaysStayed } from "@/lib/date";
import { buildLedgerEntries, computeLedger, type LedgerTenancy } from "@/lib/rent";
import { parseMoney } from "@/lib/agreement-transfer";

const tenancy = (overrides: Partial<LedgerTenancy> = {}): LedgerTenancy => ({
  start_date: "2026-06-01",
  move_out_date: null,
  monthly_rent: 1650,
  first_month_rent: null,
  last_month_rent: null,
  security_deposit: null,
  paused_at: null,
  ...overrides,
});

describe("proratedDaysStayed", () => {
  it("bills rent / days in month × days stayed through the move-out day", () => {
    // Nov has 30 days; moving out on the 18th = 18 days stayed.
    expect(proratedDaysStayed("2026-03-14", "2026-11-18", 1650)).toBe(990);
  });

  it("counts from the start day when the tenancy began that month", () => {
    // Started the 10th, out the 20th = 11 days of a 31-day month.
    expect(proratedDaysStayed("2026-12-10", "2026-12-20", 3100)).toBe(1100);
  });

  it("bills the full month when the move-out is the last day", () => {
    expect(proratedDaysStayed("2026-01-01", "2026-02-28", 1500)).toBe(1500);
  });
});

describe("last_month_rent in the ledger", () => {
  const today = "2026-12-05";

  it("bills the move-out month at last_month_rent", () => {
    const t = tenancy({ move_out_date: "2026-11-18", last_month_rent: 990 });
    // Jun–Oct full (5 × 1650) + Nov prorated.
    expect(computeLedger(t, [], [], [], today).rent.owed).toBe(5 * 1650 + 990);
    const nov = buildLedgerEntries(t, [], [], today).find((e) =>
      e.description.includes("Nov"),
    );
    expect(nov?.charge).toBe(990);
  });

  it("ignores last_month_rent without a move-out date", () => {
    const t = tenancy({ last_month_rent: 990 });
    expect(computeLedger(t, [], [], [], "2026-07-15").rent.owed).toBe(2 * 1650);
  });

  it("prefers last_month_rent over first_month_rent in a same-month stay", () => {
    const t = tenancy({
      start_date: "2026-08-10",
      move_out_date: "2026-08-20",
      first_month_rent: 1200,
      last_month_rent: 585,
    });
    expect(computeLedger(t, [], [], [], today).rent.owed).toBe(585);
  });
});

describe("parseMoney", () => {
  it("reads agreement amounts", () => {
    expect(parseMoney("$1,750.00")).toBe(1750);
    expect(parseMoney(" 700 ")).toBe(700);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
  });
});
