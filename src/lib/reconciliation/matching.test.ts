import { describe, expect, it } from "vitest";
import type { Deposit } from "./parsers";
import {
  buildPayerIndex,
  autoAssign,
  computeMonthMatches,
  assignSyntheticOrdinals,
  expectedForMonth,
  type PayerTenancy,
  type TenancyInfo,
} from "./matching";

function payerTenancy(overrides: Partial<PayerTenancy>): PayerTenancy {
  return {
    tenancy_id: "t-1",
    status: "active",
    start_date: "2026-06-01",
    keys: ["john doe"],
    ...overrides,
  };
}

function deposit(overrides: Partial<Deposit>): Deposit {
  return {
    description: "john doe",
    raw: "Zelle payment from JOHN DOE Conf# abc123",
    amount: 1500,
    date: "2026-08-01",
    source: "bank",
    externalRef: "zelle:abc123",
    ...overrides,
  };
}

function tenancy(overrides: Partial<TenancyInfo>): TenancyInfo {
  return {
    id: "t-1",
    tenant_id: "ten-1",
    tenant_name: "John Doe",
    pays_as: null,
    full_name: "John Doe",
    monthly_rent: 1500,
    first_month_rent: null,
    start_date: "2026-06-01",
    paused_at: null,
    property_label: "628 Summit Apt 804",
    room_label: "1",
    rent_changes: [],
    alias_keys: [],
    recorded_paid: 0,
    ...overrides,
  };
}

describe("buildPayerIndex / autoAssign", () => {
  it("maps pays_as keys and alias keys to the tenancy", () => {
    const index = buildPayerIndex([
      payerTenancy({ tenancy_id: "t-1", keys: ["john doe", "j doe llc"] }),
    ]);
    expect(index.get("john doe")).toBe("t-1");
    expect(index.get("j doe llc")).toBe("t-1");
  });

  it("prefers an active tenancy over an ended one for a contested key", () => {
    const index = buildPayerIndex([
      payerTenancy({ tenancy_id: "old", status: "ended", start_date: "2026-07-01" }),
      payerTenancy({ tenancy_id: "new", status: "active", start_date: "2026-01-01" }),
    ]);
    expect(index.get("john doe")).toBe("new");
  });

  it("breaks active-vs-active ties by the latest start date", () => {
    const index = buildPayerIndex([
      payerTenancy({ tenancy_id: "early", start_date: "2026-05-01" }),
      payerTenancy({ tenancy_id: "late", start_date: "2026-08-01" }),
    ]);
    expect(index.get("john doe")).toBe("late");
  });

  it("indexes a tenancy that starts AFTER the deposit month (prepayment bug regression)", () => {
    // July deposit, tenancy starting in September: the old per-month runs
    // dropped this tenancy entirely; the continuous index must include it.
    const index = buildPayerIndex([
      payerTenancy({ tenancy_id: "future", start_date: "2026-09-01" }),
    ]);
    const [assigned] = autoAssign(
      [deposit({ date: "2026-07-15" })],
      index,
    );
    expect(assigned.tenancyId).toBe("future");
  });

  it("never auto-assigns an ignored payer", () => {
    const index = buildPayerIndex([payerTenancy({})]);
    const [assigned] = autoAssign([deposit({})], index, new Set(["john doe"]));
    expect(assigned.tenancyId).toBeNull();
  });

  it("leaves unknown payers unassigned", () => {
    const index = buildPayerIndex([payerTenancy({})]);
    const [assigned] = autoAssign([deposit({ description: "someone else" })], index);
    expect(assigned.tenancyId).toBeNull();
  });
});

describe("computeMonthMatches", () => {
  const start = "2026-08-01";
  const end = "2026-08-31";

  it("classifies match, mismatch, and missing rows with totals", () => {
    const { matches, totals } = computeMonthMatches(
      [
        tenancy({ id: "a", monthly_rent: 1500 }),
        tenancy({ id: "b", monthly_rent: 1200 }),
        tenancy({ id: "c", monthly_rent: 1000 }),
      ],
      new Map([
        ["a", 1500],
        ["b", 900],
      ]),
      start,
      end,
    );
    expect(matches.find((m) => m.tenancy_id === "a")?.status).toBe("match");
    expect(matches.find((m) => m.tenancy_id === "b")?.status).toBe("mismatch");
    expect(matches.find((m) => m.tenancy_id === "c")?.status).toBe("missing");
    expect(totals.totalExpected).toBe(3700);
    expect(totals.totalActual).toBe(2400);
    expect(totals.matchCount).toBe(1);
    expect(totals.mismatchCount).toBe(1);
    expect(totals.missingCount).toBe(1);
  });

  it("counts manually recorded rent toward actual", () => {
    const { matches } = computeMonthMatches(
      [tenancy({ recorded_paid: 1500 })],
      new Map(),
      start,
      end,
    );
    expect(matches[0].status).toBe("match");
  });

  it("tolerates sub-cent differences as a match", () => {
    const { matches } = computeMonthMatches(
      [tenancy({})],
      new Map([["t-1", 1500.004]]),
      start,
      end,
    );
    expect(matches[0].status).toBe("match");
  });
});

describe("expectedForMonth", () => {
  it("bills the prorated first month in the starting month", () => {
    expect(
      expectedForMonth("2026-08-15", 1500, 850, "2026-08-01", "2026-08-31", []),
    ).toBe(850);
  });

  it("expects nothing before the tenancy starts", () => {
    expect(
      expectedForMonth("2026-09-01", 1500, null, "2026-08-01", "2026-08-31", []),
    ).toBe(0);
  });

  it("freezes expectations for paused tenancies", () => {
    expect(
      expectedForMonth(
        "2026-01-01",
        1500,
        null,
        "2026-08-01",
        "2026-08-31",
        [],
        "2026-07-10",
      ),
    ).toBe(0);
  });
});

describe("assignSyntheticOrdinals", () => {
  const cash = (n: number) =>
    deposit({
      description: "cash deposit",
      raw: "CASH DEPOSIT",
      amount: 200,
      externalRef: "bank:2026-08-01:CASH DEPOSIT:200.00",
      date: "2026-08-01",
      ...(n > 0 ? {} : {}),
    });

  it("keeps Conf# rows and drops within-file Conf# repeats", () => {
    const { deposits, duplicates } = assignSyntheticOrdinals(
      [deposit({}), deposit({})],
      [],
    );
    expect(deposits).toHaveLength(1);
    expect(duplicates).toBe(1);
    expect(deposits[0].externalRef).toBe("zelle:abc123");
  });

  it("numbers identical synthetic rows 1..n", () => {
    const { deposits } = assignSyntheticOrdinals([cash(1), cash(2)], []);
    expect(deposits.map((d) => d.externalRef)).toEqual([
      "bank:2026-08-01:CASH DEPOSIT:200.00:1",
      "bank:2026-08-01:CASH DEPOSIT:200.00:2",
    ]);
  });

  it("skips occurrences already stored in the new ref format", () => {
    const { deposits, duplicates } = assignSyntheticOrdinals(
      [cash(1), cash(2)],
      ["bank:2026-08-01:CASH DEPOSIT:200.00:1"],
    );
    expect(duplicates).toBe(1);
    expect(deposits.map((d) => d.externalRef)).toEqual([
      "bank:2026-08-01:CASH DEPOSIT:200.00:2",
    ]);
  });

  it("recognises legacy month-scoped refs as the same occurrence", () => {
    // A pre-migration July run stored this row as base:{month}:{ordinal}.
    // Re-uploading an overlapping export must not double-post it.
    const { deposits, duplicates } = assignSyntheticOrdinals(
      [cash(1)],
      ["bank:2026-08-01:CASH DEPOSIT:200.00:2026-07-01:1"],
    );
    expect(duplicates).toBe(1);
    expect(deposits).toHaveLength(0);
  });
});
