import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ balance: 0 }));
// The ledger loaders are covered elsewhere; here every tenant owes `balance`.
vi.mock("@/lib/rent-data", () => ({
  fetchLedgerSidecars: async () => ({
    charges: new Map(),
    allocations: new Map(),
    rentChanges: new Map(),
  }),
  fetchTenantLedgers: async () => ({}),
  tenantLedger: () => ({ netBalance: mocks.balance }),
}));

import { applyMonthlyLateFees } from "@/lib/late-fees";

const TODAY = "2026-11-07";

const tenancy = {
  id: "t1",
  tenant_id: "tenant-1",
  monthly_rent: 1_000,
  first_month_rent: null,
  security_deposit: null,
  start_date: "2026-01-01",
  move_out_date: null,
  paused_at: null,
  tenants: { full_name: "Test Tenant" },
  rooms: { properties: { is_new_york: false } },
  payments: [],
};

type Write = { table: string; op: "insert" | "update" | "delete"; row?: unknown };

// Reads answer from fixed data; every write is recorded.
function fakeSupabase(statement: { coversTill?: string | null; error?: string }) {
  const writes: Write[] = [];
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order", "limit", "returns"]) q[m] = () => q;
    q.single = async () => result;
    q.maybeSingle = async () => result;
    q.then = <R,>(resolve: (r: unknown) => R) => Promise.resolve(result).then(resolve);
    return q;
  };
  const supabase = {
    from(table: string) {
      if (table === "reconciliation_statements") {
        return chain(
          statement.error
            ? { data: null, error: { message: statement.error } }
            : {
                data: statement.coversTill ? { max_deposit_date: statement.coversTill } : null,
                error: null,
              },
        );
      }
      if (table === "tenancies") return chain({ data: [tenancy], error: null });
      return {
        insert: (row: unknown) => {
          writes.push({ table, op: "insert", row });
          return chain({ data: { id: "batch-1" }, error: null });
        },
        update: (row: unknown) => {
          writes.push({ table, op: "update", row });
          return chain({ error: null });
        },
        delete: () => {
          writes.push({ table, op: "delete" });
          return chain({ error: null });
        },
      };
    },
  };
  return { supabase: supabase as never, writes };
}

beforeEach(() => {
  mocks.balance = 1_000;
});

describe("late fees wait for a bank statement covering the 6th", () => {
  it("covers till the 5th: skips without setting the month's marker or charging", async () => {
    const { supabase, writes } = fakeSupabase({ coversTill: "2026-11-05" });

    expect(await applyMonthlyLateFees(supabase, TODAY)).toEqual({
      ran: false,
      reason: "waiting for bank data through 2026-11-06; covers till 2026-11-05",
      period: "2026-11",
    });
    expect(writes).toEqual([]);
  });

  it("no bank statement at all: skips the same way", async () => {
    const { supabase, writes } = fakeSupabase({ coversTill: null });

    expect(await applyMonthlyLateFees(supabase, TODAY)).toMatchObject({
      ran: false,
      reason: "waiting for bank data through 2026-11-06; covers till no bank statement yet",
    });
    expect(writes).toEqual([]);
  });

  it("can't read the statements: reports the error without setting the marker", async () => {
    const { supabase, writes } = fakeSupabase({ error: "504 gateway timeout" });

    expect(await applyMonthlyLateFees(supabase, TODAY)).toEqual({
      ran: false,
      error: "504 gateway timeout",
      period: "2026-11",
    });
    expect(writes).toEqual([]);
  });

  it.each(["2026-11-06", "2026-11-20"])(
    "covers till %s: runs exactly as before",
    async (coversTill) => {
      const { supabase, writes } = fakeSupabase({ coversTill });

      expect(await applyMonthlyLateFees(supabase, TODAY)).toEqual({
        ran: true,
        period: "2026-11",
        charged: 1,
        skippedExistingFee: 0,
        skippedUtilityOnly: 0,
        tenants: ["Test Tenant"],
      });
      expect(writes).toEqual([
        {
          table: "rent_reminder_batches",
          op: "insert",
          row: { kind: "late_fee", period_month: "2026-11", recipient_count: 0, triggered_by: "cron" },
        },
        {
          table: "tenancy_charges",
          op: "insert",
          row: {
            tenancy_id: "t1",
            kind: "late_fee",
            amount: 50,
            charged_on: TODAY,
            dedupe_key: "late_fee:2026-11",
            note: "Auto — balance unpaid after 2026-11-06",
          },
        },
        { table: "rent_reminder_batches", op: "update", row: { recipient_count: 1 } },
      ]);
    },
  );

  it("still applies the $200 threshold once the statement covers the 6th", async () => {
    mocks.balance = 200;
    const { supabase, writes } = fakeSupabase({ coversTill: "2026-11-06" });

    expect(await applyMonthlyLateFees(supabase, TODAY)).toMatchObject({ ran: true, charged: 0 });
    expect(writes.filter((w) => w.table === "tenancy_charges")).toEqual([]);
  });
});
