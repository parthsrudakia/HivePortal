import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deposit, ParseResult } from "@/lib/reconciliation/parsers";

const mocks = vi.hoisted(() => ({
  supabase: null as unknown,
  parsed: null as unknown,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ email: "ops@example.com" }),
}));
vi.mock("@/lib/section-access", () => ({
  assertSection: async () => {},
  hasPermission: async () => true,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.supabase }));
vi.mock("@/lib/reconciliation/parsers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reconciliation/parsers")>()),
  parseBankFile: async () => mocks.parsed,
}));
vi.mock("@/lib/reconciliation/matching", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reconciliation/matching")>()),
  loadPayerTenancies: async () => ({ rows: [], error: null }),
  loadIgnoredPayerKeys: async () => new Set<string>(),
}));

import { addStatement } from "./actions";
import { cappedTable } from "@/lib/testing/capped-table";

type Sent = { external_ref: string }[];

// reconciliation_deposits behind PostgREST (each response capped at 1,000
// rows), plus the storage bucket and the ingest RPC, which records what the
// upload would have inserted.
function fakeSupabase(storedRefs: string[], opts: { failRead?: boolean } = {}) {
  const ingested: Sent[] = [];
  const uploads: string[] = [];
  return {
    ingested,
    uploads,
    from(table: string) {
      expect(table).toBe("reconciliation_deposits");
      return cappedTable(
        storedRefs.map((external_ref) => ({ external_ref })),
        { fail: () => !!opts.failRead },
      );
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push(path);
          return { error: null };
        },
        remove: async () => ({ error: null }),
      }),
    },
    rpc: async (_fn: string, args: { p_deposits: Sent }) => {
      ingested.push(args.p_deposits);
      return {
        data: { statement_id: "s1", inserted: args.p_deposits.length, duplicates: 0, posted: 0 },
        error: null,
      };
    },
  };
}

// A deposit without a Zelle Conf#: its stored ref is this base plus ":n".
const cashRow = (day: string, amount: number): Deposit => ({
  description: "cash deposit",
  raw: `CASH DEPOSIT ${day}`,
  amount,
  date: day,
  source: "bank",
  externalRef: `cash ${day} ${amount}`,
});

function upload(deposits: Deposit[]) {
  const parsed: ParseResult = { deposits, parsedRowCount: deposits.length, skipped: [], reversals: [] };
  mocks.parsed = parsed;
  const form = new FormData();
  form.set("bank_statement", new File(["x"], "statement.csv", { type: "text/csv" }));
  return addStatement(undefined, form);
}

// 1,500 stored deposits; the one this upload repeats sits past row 1,000.
const stored = Array.from({ length: 1_500 }, (_, i) => `zelle:CONF${i}`);
stored[1_250] = "cash 2026-10-01 500:1";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("addStatement duplicate pre-check past the 1,000-row cap", () => {
  it("sees a stored deposit beyond row 1,000 and doesn't send it again", async () => {
    const supabase = fakeSupabase(stored);
    mocks.supabase = supabase;

    const result = await upload([cashRow("2026-10-01", 500), cashRow("2026-10-02", 75)]);

    expect(result).toMatchObject({ success: expect.stringMatching(/^Added 1 deposit/) });
    expect(supabase.ingested).toEqual([[expect.objectContaining({ external_ref: "cash 2026-10-02 75:1" })]]);
  });

  it("gives a second identical row the next ordinal when the first is stored past row 1,000", async () => {
    const supabase = fakeSupabase(stored);
    mocks.supabase = supabase;

    await upload([cashRow("2026-10-01", 500), cashRow("2026-10-01", 500)]);

    expect(supabase.ingested[0].map((d) => d.external_ref)).toEqual(["cash 2026-10-01 500:2"]);
  });

  it("stops before uploading anything when the stored deposits can't be read", async () => {
    const supabase = fakeSupabase(stored, { failRead: true });
    mocks.supabase = supabase;

    const result = await upload([cashRow("2026-10-02", 75)]);

    expect(result).toEqual({ error: expect.stringMatching(/existing deposits.*504/) });
    expect(supabase.uploads).toHaveLength(0);
    expect(supabase.ingested).toHaveLength(0);
  });
});
