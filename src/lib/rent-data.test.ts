import { describe, expect, it, vi } from "vitest";
import {
  LedgerDataError,
  allLedgerRows,
  fetchLedgerSidecars,
  ledgerRows,
} from "@/lib/rent-data";

// The React cache() wrapper needs a request context in Next; outside of it
// the underlying function just runs, which is what these tests exercise.

type Result<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };

const ok = <T,>(data: T[], count?: number): Result<T> => ({ data, error: null, count });
const fail = (message: string): Result<never> => ({ data: null, error: { message } });

/** Minimal chainable stand-in for a PostgREST builder. */
function builder<T>(respond: (from: number, to: number) => Result<T>) {
  let from = 0;
  let to = 0;
  const b = {
    select: () => b,
    order: () => b,
    range: (f: number, t: number) => {
      from = f;
      to = t;
      return b;
    },
    returns: () => b,
    then: <R>(res: (v: Result<T>) => R) => Promise.resolve(respond(from, to)).then(res),
  };
  return b;
}

describe("ledger reads never degrade to empty data", () => {
  it("returns the rows when the query succeeds", async () => {
    const rows = await ledgerRows("charges", () => Promise.resolve(ok([{ id: 1 }])));
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("retries once, then succeeds on a transient failure", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(fail("504 gateway timeout"))
      .mockResolvedValueOnce(ok([{ id: 1 }]));
    const rows = await ledgerRows("charges", run);
    expect(rows).toEqual([{ id: 1 }]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("throws LedgerDataError instead of returning [] when the read keeps failing", async () => {
    const run = vi.fn().mockResolvedValue(fail("504 gateway timeout"));
    await expect(ledgerRows("charges", run)).rejects.toBeInstanceOf(LedgerDataError);
    await expect(ledgerRows("charges", run)).rejects.toThrow(/charges.*504/);
  });

  it("treats a null body with no error as a failure", async () => {
    const run = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(ledgerRows("payments", run)).rejects.toBeInstanceOf(LedgerDataError);
  });

  it("surfaces a rejected fetch as LedgerDataError", async () => {
    const run = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(ledgerRows("payments", run)).rejects.toThrow(/fetch failed/);
  });
});

describe("full-table ledger reads page to the exact count", () => {
  it("keeps paging until every row is in hand", async () => {
    const total = 2_345;
    const rows = await allLedgerRows("charges", (from, to) =>
      Promise.resolve(
        ok(
          Array.from({ length: Math.min(to, total - 1) - from + 1 }, (_, i) => ({ id: from + i })),
          total,
        ),
      ),
    );
    expect(rows).toHaveLength(total);
    expect(rows[0]).toEqual({ id: 0 });
    expect(rows[total - 1]).toEqual({ id: total - 1 });
  });

  it("refuses a truncated result instead of computing balances from it", async () => {
    // Server says 176 rows exist but a capped response hands back 100 and
    // then nothing — the old code would have used the 100 silently.
    const run = vi
      .fn()
      .mockResolvedValueOnce(ok(Array.from({ length: 100 }, (_, i) => ({ id: i })), 176))
      .mockResolvedValue(ok([], 176));
    await expect(allLedgerRows("charges", run)).rejects.toThrow(/100 of 176/);
  });

  it("refuses a response with no row count", async () => {
    await expect(
      allLedgerRows("charges", () => Promise.resolve(ok([{ id: 1 }]))),
    ).rejects.toThrow(/no row count/);
  });
});

describe("fetchLedgerSidecars", () => {
  it("throws when any sidecar table fails, even if the others load", async () => {
    const supabase = {
      from: (table: string) =>
        builder(() =>
          table === "tenancy_charges" ? fail("504 gateway timeout") : ok([], 0),
        ),
    };
    await expect(
      fetchLedgerSidecars(supabase as never),
    ).rejects.toBeInstanceOf(LedgerDataError);
  });

  it("groups every charge by tenancy when all reads succeed", async () => {
    const charges = [
      { id: "a", tenancy_id: "t1", kind: "late_fee", amount: 50, charged_on: "2026-07-11", note: null, bill_id: null },
      { id: "b", tenancy_id: "t1", kind: "utility_overage", amount: 38.84, charged_on: "2026-07-10", note: null, bill_id: "x" },
    ];
    const supabase = {
      from: (table: string) =>
        builder(() =>
          table === "tenancy_charges" ? ok(charges, charges.length) : ok([], 0),
        ),
    };
    const { charges: byTenancy } = await fetchLedgerSidecars(supabase as never);
    expect(byTenancy.get("t1")).toHaveLength(2);
  });
});
