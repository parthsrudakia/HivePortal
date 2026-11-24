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
  inventoryResolver,
  streetBuildings,
  streetName,
  normalizeFilters,
  previousBounds,
  priceChangeTrends,
  rangeBounds,
  weekdayAverages,
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
    { date: "2026-12-01", leads: 3, first_reply_hours: 2, replies_sent: 5, handoffs: 1, followed_up: 2, leads_by_address: [{ address: "Sample Tower", leads: 3 }] },
    { date: "2026-12-02", leads: 1, first_reply_hours: 6, replies_sent: 3, handoffs: 0, followed_up: 1 },
  ],
  open: {
    waiting_on_us: [
      { lead: "Alex", days_waiting: 1 },
      { lead: "Sam", days_waiting: 3 },
    ],
    never_answered_leads: [{ lead: "Jo", received_at: "2026-12-02" }],
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
      first_day: "2026-12-01",
      last_day: "2026-12-02",
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
    await post({ account_name: "Sample Agent", agent: "grok", days: [{ date: "2026-12-03", leads: 2 }] });
    const stream = mocks.upserts.find((u) => u.table === "sales_kpi_streams")!;
    expect(stream.rows).not.toHaveProperty("waiting_on_us");
  });

  it("rejects duplicate dates, empty calls and unknown fields", async () => {
    const dup = { ...history, days: [history.days[0], history.days[0]] };
    expect((await post(dup)).status).toBe(400);
    expect((await post({ account_name: "A", agent: "grok" })).status).toBe(400);
    expect((await post({ ...history, bogus: 1 })).status).toBe(400);
    // Measurement starts on KPI_START_DAY; older days are refused.
    const early = await post({ account_name: "A", agent: "grok", days: [{ date: "2026-11-23", leads: 1 }] });
    expect(early.status).toBe(400);
    expect((await early.json()).error).toContain("2026-11-24");
    expect((await post({ ...history, listings: [{ address: "Sample Tower", listed_on: "soon" }] })).status).toBe(400);
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
    expect(v.daily[0]).toMatchObject({ day: "2026-11-01", replies: 6, handoffs: 1, followedUp: 3, neverAnswered: null, firstReplyHours: 2 });
    // 2026-11-01 is a Sunday, 11-02 a Monday.
    const wk = weekdayAverages(v.daily);
    expect(wk[6]).toMatchObject({ label: "Sun", avg: 3, days: 1 });
    expect(wk[0]).toMatchObject({ label: "Mon", avg: 1 });
    expect(wk[2].avg).toBeNull();
    expect(previousBounds({ from: "2026-11-17", to: "2026-11-23" })).toEqual({ from: "2026-11-10", to: "2026-11-16", days: 7 });
    expect(previousBounds({ from: null, to: null })).toBeNull();
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

  it("breaks demand down per unit and joins the listing dates", () => {
    const [v] = aggregateByAccount(
      [
        day({ day: "2026-11-10", leads: 5, leads_by_address: [
          { address: "Sample Tower", unit: "Room 2", unit_style: "Private room", leads: 3, handoffs: 1 },
          { address: "Sample Tower", unit: "Room 3", unit_style: "Private room", leads: 2, handoffs: 0 },
        ] }),
        day({ day: "2026-11-11", leads: 2, leads_by_address: [
          { address: "sample tower", unit: "room 2", leads: 1, handoffs: 1 },
          { address: "100 Example St", unit: "4B", unit_style: "Studio", leads: 1 },
        ] }),
      ],
      [stream({ listings: [
        { address: "Sample Tower", unit: "Room 2", listed_on: "2026-10-01", deactivated_on: "2026-10-20" },
        { address: "Sample Tower", unit: "Room 2", listed_on: "2026-11-08", price: 1450 },
        { address: "100 Example St", unit: "4B", listed_on: "2026-11-01", deactivated_on: "2026-11-11" },
        { address: "9 Quiet Rd", listed_on: "2026-11-05" },
      ] })],
      { from: "2026-11-05", to: "2026-11-14" },
      { today: "2026-11-14" },
    );
    expect(v.leadsByAddress).toEqual([{ address: "Sample Tower", leads: 6 }, { address: "100 Example St", leads: 1 }]);
    expect(v.leadsByStyle).toEqual([{ style: "Private room", leads: 5 }, { style: "Studio", leads: 1 }]);
    expect(v.units.map((u) => [u.address, u.unit, u.leads, u.qualified, u.daysOnMarket, u.leadsPerDay])).toEqual([
      // Latest listing wins: listed Nov 8, still live → 6 days; 4 leads over Nov 8–14 (7 days).
      ["Sample Tower", "Room 2", 4, 2, 6, 0.57],
      ["Sample Tower", "Room 3", 2, 0, null, 1],
      ["100 Example St", "4B", 1, null, 10, 0.14],
      // Listed but no leads still shows, at zero.
      ["9 Quiet Rd", null, 0, null, 9, 0],
    ]);
    expect(v.units[0]).toMatchObject({ style: "Private room", price: 1450, deactivatedOn: null });
    // Plain { address, leads } with no listings keeps the unit table out of the way.
    const [plain] = aggregateByAccount([day({ leads: 1, leads_by_address: [{ address: "Epic", leads: 1 }] })], [], { from: null, to: null });
    expect(plain.units).toEqual([]);
  });

  it("compares leads per week before and after a price change", () => {
    const rows = (unit: string, list: [string, number][]) =>
      list.map(([d, leads]) => ({ day: d, leads_by_address: [{ address: "Sample Tower", unit, leads }] }));
    const trends = priceChangeTrends(
      [{
        address: "Sample Tower", unit: "Room 2", listed_on: "2026-10-25",
        price_changes: [{ date: "2026-11-01", from: 1500, to: 1450 }, { date: "2026-11-15", to: 1400 }],
      }],
      [
        ...rows("Room 2", [["2026-10-26", 1], ["2026-10-31", 1], ["2026-11-01", 3], ["2026-11-10", 4], ["2026-11-16", 2]]),
        ...rows("Room 3", [["2026-11-02", 9]]),
      ],
      "2026-11-17",
    );
    // Newest first. Second change: before = Nov 1–14 (cut at the first change), after = Nov 15–17.
    expect(trends[0]).toMatchObject({ date: "2026-11-15", from: 1450, to: 1400, beforeDays: 14, beforePerWeek: 3.5, afterDays: 3, afterPerWeek: 4.7 });
    // First change: before = Oct 25–31 (cut at listed_on), after = Nov 1–14 (cut at the next change).
    expect(trends[1]).toMatchObject({ date: "2026-11-01", from: 1500, to: 1450, beforeDays: 7, beforePerWeek: 2, afterDays: 14, afterPerWeek: 3.5 });
  });

  it("groups ads by the street address shown and matches buildings by street name", () => {
    const resolve = inventoryResolver();
    expect(streetName("628 Example Avenue, Sampleville, NJ 07000")).toBe("example ave");
    expect(streetName("53-55 East 95th Street")).toBe("e 95 st");
    expect(streetName("John F. Kennedy Blvd")).toBe(streetName("3516 JFK Boulevard"));
    // Same street, however it was spelled or whichever ad it came from → one line, no unit.
    expect(resolve({ address: "Sample St", ad_ref: "103000001", unit: "Room 2" })).toMatchObject({ address: "Sample St", unit: undefined });
    expect(resolve({ address: "sample street", ad_ref: "103000009" }).address).toBe("Sample St");
    expect(resolve({ address: "Example Ave" }).address).toBe("Example Ave");

    const buildingOf = streetBuildings([
      { building_name: null, street_address: "85 Sample St" },
      { building_name: "Sample Tower", street_address: "628 Example Avenue, Sampleville, NJ 07000" },
      { building_name: "Sample Tower", street_address: "628 Example Avenue, Sampleville, NJ 07000" },
      { building_name: "Other Court", street_address: "505 Example Ave, Sampleville, NJ 07000" },
    ]);
    expect(buildingOf("Sample Street")).toBe("85 Sample St");
    // Two buildings on the street → never guess.
    expect(buildingOf("Example Ave")).toBeNull();
    expect(buildingOf("Nowhere Rd")).toBeNull();
  });

  it("counts rejected leads overall and per address", () => {
    const [v] = aggregateByAccount(
      [
        day({ day: "2026-11-24", leads: 10, handoffs: 3, rejected: 4, leads_by_address: [
          { address: "Sample St", leads: 6, handoffs: 2, rejected: 3 },
          { address: "Example Ave", leads: 4, handoffs: 1, rejected: 1 },
        ] }),
        day({ day: "2026-11-25", leads: 5, handoffs: 1, leads_by_address: [{ address: "Sample St", leads: 5, handoffs: 1 }] }),
      ],
      [],
      { from: null, to: null },
    );
    // The rate only counts days that reported it: 4 of 10, not 4 of 15.
    expect(v).toMatchObject({ totalLeads: 15, rejected: 4, rejectedRate: 40, handoffs: 4 });
    // Rejected leads need no reply: 4 handed over out of the 11 left to work.
    expect(v).toMatchObject({ workableLeads: 11, handoffRate: 36.4 });
    expect(v.daily.map((d) => d.rejected)).toEqual([4, null]);
    expect(v.units.map((u) => [u.address, u.leads, u.rejected, u.qualified])).toEqual([
      ["Sample St", 11, 3, 3],
      ["Example Ave", 4, 1, 1],
    ]);
  });

  it("makes the waiting list follow the date filter", () => {
    const st = stream({
      open_as_of: "2026-11-20T12:00:00Z",
      waiting_on_us: [
        { lead: "Old", days_waiting: 46 }, // last wrote Oct 5
        { lead: "Edge", days_waiting: 45 }, // Oct 6
        { lead: "Mid", days_waiting: 10 }, // Nov 10
        { lead: "Dated", days_waiting: 3, last_message_at: "2026-11-17T09:00:00-05:00" },
        { lead: "New", days_waiting: 1 }, // Nov 19
      ],
    });
    const names = (b: { from: string | null; to: string | null }) =>
      aggregateByAccount([], [st], b)[0].waitingOnUs.map((w) => w.lead);
    // A range keeps threads whose renter last wrote inside it, however old.
    expect(names({ from: "2026-11-14", to: "2026-11-20" })).toEqual(["Dated", "New"]);
    expect(names({ from: "2026-10-01", to: "2026-11-20" })).toEqual(["Old", "Edge", "Mid", "Dated", "New"]);
    // All time stops at 45 days.
    expect(names({ from: null, to: null })).toEqual(["Edge", "Mid", "Dated", "New"]);
  });

  it("tells accounts apart by name, ignoring case and spacing", () => {
    expect(accountKey("  Vineet   SpareRoom ")).toBe(accountKey("vineet spareroom"));
  });
});
