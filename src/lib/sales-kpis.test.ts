import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upserts: [] as { table: string; rows: unknown; opts: unknown }[],
  failTable: null as null | string,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      upsert: async (rows: unknown, opts: unknown) => {
        mocks.upserts.push({ table, rows, opts });
        return { error: mocks.failTable === table ? { message: "boom" } : null };
      },
    }),
  }),
}));

import { POST } from "@/app/api/sales-kpis/route";
import {
  BUILTIN_FILTERS,
  accountKey,
  aggregateByAccount,
  aggregateOverall,
  filtersFromParams,
  filtersToParams,
  hasKpiParams,
  normalizeFilters,
  rangeBounds,
  sameFilters,
  type DayRow,
  type StreamRow,
} from "@/lib/sales-kpis";

const KEY = "test-key";
const post = (body: unknown, auth = `Bearer ${KEY}`) =>
  POST(
    new Request("https://portal.test/api/sales-kpis", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const history = {
  account_name: "  Sample   Agent ",
  agent: "Grok",
  platform: "ExampleListings",
  days: [
    { date: "2026-11-01", leads: 3, first_reply_hours: 2, replies_sent: 5, handoffs: 1, followed_up: 2, leads_by_address: [{ address: "Sample Tower", leads: 3 }] },
    { date: "2026-11-02", leads: 1, first_reply_hours: 6, replies_sent: 3, handoffs: 0, followed_up: 1 },
  ],
  open: {
    waiting_on_us: [
      { lead: "Alex", days_waiting: 1 },
      { lead: "Sam", days_waiting: 3 },
    ],
    never_answered_leads: [{ lead: "Jo", received_at: "2026-11-02" }],
  },
};

describe("POST /api/sales-kpis", () => {
  beforeEach(() => {
    process.env.SALES_KPIS_API_KEY = KEY;
    mocks.upserts = [];
    mocks.failTable = null;
  });

  it("rejects a wrong token", async () => {
    expect((await post(history, "Bearer nope")).status).toBe(401);
  });

  it("upserts each day by account + platform + agent + day, keyed by name", async () => {
    const res = await post(history);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      account_name: "Sample Agent",
      saved_days: 2,
      first_day: "2026-11-01",
      last_day: "2026-11-02",
      open_updated: true,
    });
    const days = mocks.upserts.find((u) => u.table === "sales_kpi_days")!;
    expect(days.opts).toEqual({ onConflict: "account_key,platform,agent,day" });
    expect((days.rows as { account_key: string; agent: string }[])[0]).toMatchObject({
      account_key: "sample agent",
      agent: "grok",
    });
    const stream = mocks.upserts.find((u) => u.table === "sales_kpi_streams")!;
    expect((stream.rows as { waiting_on_us: { lead: string }[] }).waiting_on_us[0].lead).toBe("Sam");
  });

  it("leaves open threads untouched on an incremental call without `open`", async () => {
    await post({ account_name: "Sample Agent", agent: "grok", days: [{ date: "2026-11-03", leads: 2 }] });
    const stream = mocks.upserts.find((u) => u.table === "sales_kpi_streams")!;
    expect(stream.rows).not.toHaveProperty("waiting_on_us");
  });

  it("rejects duplicate dates, empty calls and unknown fields", async () => {
    const dup = { ...history, days: [history.days[0], history.days[0]] };
    expect((await post(dup)).status).toBe(400);
    expect((await post({ account_name: "A", agent: "grok" })).status).toBe(400);
    expect((await post({ ...history, bogus: 1 })).status).toBe(400);
    expect(mocks.upserts).toHaveLength(0);
  });

  it("surfaces a database failure", async () => {
    mocks.failTable = "sales_kpi_days";
    expect((await post(history)).status).toBe(500);
  });
});

describe("filters", () => {
  it("falls back to the saved default only when no k_ params are present", () => {
    expect(hasKpiParams({ sort: "rent" })).toBe(false);
    expect(hasKpiParams({ k_range: "7d" })).toBe(true);
  });

  it("round-trips through URL params and ignores junk", () => {
    const f = normalizeFilters({ account: "sample agent", range: "custom", from: "2026-11-09", to: "2026-11-01" });
    expect(f).toMatchObject({ from: "2026-11-01", to: "2026-11-09" });
    expect(sameFilters(filtersFromParams(filtersToParams(f)), f)).toBe(true);
    expect(normalizeFilters({ range: "forever" })).toEqual(BUILTIN_FILTERS);
    // Dates only matter for a custom range.
    expect(sameFilters(normalizeFilters({ range: "7d", from: "2026-01-01" }), normalizeFilters({ range: "7d" }))).toBe(true);
  });

  it("computes rolling bounds from today", () => {
    expect(rangeBounds({ ...BUILTIN_FILTERS, range: "today" }, "2026-11-23")).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(rangeBounds({ ...BUILTIN_FILTERS, range: "yesterday" }, "2026-11-01")).toEqual({ from: "2026-10-31", to: "2026-10-31" });
    expect(rangeBounds({ ...BUILTIN_FILTERS, range: "7d" }, "2026-11-23")).toEqual({ from: "2026-11-17", to: "2026-11-23" });
    expect(rangeBounds({ ...BUILTIN_FILTERS, range: "ytd" }, "2026-11-23")).toEqual({ from: "2026-01-01", to: "2026-11-23" });
    expect(rangeBounds({ ...BUILTIN_FILTERS, range: "all" }, "2026-11-23")).toEqual({ from: null, to: null });
  });
});

describe("aggregateByAccount", () => {
  const day = (p: Partial<DayRow>): DayRow => ({
    account_key: "vineet", account_name: "Vineet", platform: "", agent: "grok", day: "2026-11-01",
    leads: 0, first_reply_hours: null, replies_sent: null, handoffs: null, followed_up: null,
    never_answered: null, leads_by_address: [], ...p,
  });
  const stream = (p: Partial<StreamRow>): StreamRow => ({
    account_key: "vineet", account_name: "Vineet", platform: "", agent: "grok",
    waiting_on_us: [], never_answered_leads: [], open_as_of: null, last_received_at: "2026-11-02T00:00:00Z", ...p,
  });

  it("sums counts and recomputes rates per account", () => {
    const [p, v] = aggregateByAccount(
      [
        day({ day: "2026-11-01", leads: 3, first_reply_hours: 2, replies_sent: 6, handoffs: 1, followed_up: 3, leads_by_address: [{ address: "Epic", leads: 3 }] }),
        day({ day: "2026-11-02", leads: 1, first_reply_hours: 6, replies_sent: 2, handoffs: 1, followed_up: 0, leads_by_address: [{ address: "epic", leads: 1 }, { address: "85 John", leads: 2 }] }),
        day({ account_key: "parth", account_name: "Parth", leads: 5 }),
      ],
      [stream({}), stream({ account_key: "parth", account_name: "Parth" })],
      { from: null, to: null },
    );
    expect(p.accountName).toBe("Parth");
    expect(p.totalLeads).toBe(5);
    expect(p.handoffRate).toBeNull();
    expect(v.totalLeads).toBe(4);
    expect(v.firstReplyHours).toBe(3); // (2×3 + 6×1) / 4
    expect(v.repliesPerDay).toBe(4);
    expect(v.handoffRate).toBe(50);
    expect(v.followUpRate).toBe(75);
    expect(v.leadsByAddress).toEqual([{ address: "Epic", leads: 4 }, { address: "85 John", leads: 2 }]);
    expect(v.daily.map((d) => d.leads)).toEqual([3, 1]);
  });

  it("combines every account into one overall composite", () => {
    const o = aggregateOverall(
      [
        day({ leads: 3, handoffs: 1, first_reply_hours: 2, leads_by_address: [{ address: "Epic", leads: 3 }] }),
        day({ account_key: "parth", account_name: "Parth", leads: 1, handoffs: 1, first_reply_hours: 6, leads_by_address: [{ address: "Epic", leads: 1 }] }),
      ],
      [
        stream({ waiting_on_us: [{ lead: "Alex", days_waiting: 1 }] }),
        stream({ account_key: "parth", account_name: "Parth", waiting_on_us: [{ lead: "Sam", days_waiting: 4 }] }),
        stream({ account_key: "marcus d", account_name: "Marcus D" }),
      ],
      { from: null, to: null },
    )!;
    expect(o.accountName).toBe("All accounts");
    expect(o.totalLeads).toBe(4);
    expect(o.handoffRate).toBe(50);
    expect(o.firstReplyHours).toBe(3);
    expect(o.leadsByAddress).toEqual([{ address: "Epic", leads: 4 }]);
    expect(o.waitingOnUs.map((w) => `${w.lead}/${w.account}`)).toEqual(["Sam/Parth", "Alex/Vineet"]);
    // Accounts with no leads in range still appear, at zero.
    expect(o.byAccount).toEqual([
      { name: "Vineet", leads: 3 },
      { name: "Parth", leads: 1 },
      { name: "Marcus D", leads: 0 },
    ]);
    expect(aggregateOverall([], [], { from: null, to: null })).toBeNull();
  });

  it("narrows never-answered names to the range", () => {
    const [v] = aggregateByAccount(
      [],
      [stream({ never_answered_leads: [{ lead: "Old", received_at: "2026-10-01" }, { lead: "New", received_at: "2026-11-20" }, { lead: "Undated" }] })],
      { from: "2026-11-01", to: "2026-11-30" },
    );
    expect(v.neverAnsweredLeads.map((n) => n.lead)).toEqual(["New", "Undated"]);
    expect(v.neverAnswered).toBe(2);
  });

  it("tells accounts apart by name, ignoring case and spacing", () => {
    expect(accountKey("  Vineet   SpareRoom ")).toBe(accountKey("vineet spareroom"));
  });
});
