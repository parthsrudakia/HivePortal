/**
 * Sales KPIs from the lead-handling agents (Grok and others), shown at the
 * /kpis page to users with the 'sales_kpis' permission.
 *
 * Each POST /api/sales-kpis covers ONE account, named by `account_name`
 * (accounts are told apart by that name, case-insensitively). The first call
 * dumps every past day the agent has; later calls send only new or corrected
 * days — a day re-sent replaces the stored one. Tables:
 *   sales_kpi_days     one row per account + platform + agent + day
 *   sales_kpi_streams  account registry + "right now" open threads
 *   sales_kpi_prefs    each user's saved default filters
 *
 * Everything here is pure (no I/O) so the API, page and tests share it.
 */

import { z } from "zod";
import { addDaysISO } from "@/lib/date";

// ---------------------------------------------------------------- intake

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.iso.date();
const count = z.number().int().nonnegative();
const nonNeg = z.number().nonnegative().finite();
const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * The listing site's ad number (or the ad's URL). Our ads hide the building
 * and unit numbers, so this is what ties a lead or a listing to the real
 * room: the portal looks it up among the ad links saved on Inventory.
 */
const adRef = text(300).optional();

export const WaitingThreadSchema = z.object({
  lead: text(120),
  days_waiting: nonNeg,
  address: text(200).optional(),
  ad_ref: adRef,
  last_message_at: z.string().max(40).optional(),
});

export const NeverAnsweredLeadSchema = z.object({
  lead: text(120),
  address: text(200).optional(),
  ad_ref: adRef,
  received_at: z.string().max(40).optional(),
});

/**
 * One address's leads on a day. `unit` / `unit_style` split a building into
 * its units; `handoffs` are that unit's qualified leads (given Vinny's number).
 */
export const AddressLeadsSchema = z.object({
  address: text(200),
  ad_ref: adRef,
  unit: text(60).optional(),
  unit_style: text(60).optional(),
  leads: count,
  handoffs: count.optional(),
  rejected: count.optional(),
});

export const PriceChangeSchema = z.object({
  date: isoDate,
  from: nonNeg.optional(),
  to: nonNeg,
  note: text(200).optional(),
});

/** One ad the account runs: when it was last listed / taken down, and its price history. */
export const ListingSchema = z.object({
  address: text(200),
  ad_ref: adRef,
  unit: text(60).optional(),
  unit_style: text(60).optional(),
  listed_on: isoDate,
  deactivated_on: isoDate.optional(),
  price: nonNeg.optional(),
  price_changes: z.array(PriceChangeSchema).max(100).optional(),
});

export const KpiDaySchema = z
  .object({
    date: isoDate,
    leads: count,
    first_reply_hours: nonNeg.optional(),
    replies_sent: count.optional(),
    handoffs: count.optional(),
    followed_up: count.optional(),
    never_answered: count.optional(),
    rejected: count.optional(),
    leads_by_address: z.array(AddressLeadsSchema).max(200).optional(),
  })
  .strict();

export const SalesKpiPayloadSchema = z
  .object({
    account_name: text(100),
    agent: text(60),
    platform: text(60).optional(),
    days: z.array(KpiDaySchema).max(3000).optional(),
    open: z
      .object({
        as_of: z.iso.datetime({ offset: true }).optional(),
        waiting_on_us: z.array(WaitingThreadSchema).max(500).optional(),
        never_answered_leads: z.array(NeverAnsweredLeadSchema).max(1000).optional(),
      })
      .strict()
      .optional(),
    listings: z.array(ListingSchema).max(500).optional(),
  })
  .strict()
  .refine((p) => (p.days?.length ?? 0) > 0 || p.open || p.listings, {
    message: "send at least one of days, open or listings",
    path: ["days"],
  })
  .refine(
    (p) => new Set((p.days ?? []).map((d) => d.date)).size === (p.days ?? []).length,
    { message: "each date may appear only once", path: ["days"] },
  );

/**
 * Measurement starts here: the team dropped all earlier history and counts
 * leads from this day on. The API refuses days before it.
 */
export const KPI_START_DAY = "2026-11-24";

export type SalesKpiPayload = z.infer<typeof SalesKpiPayloadSchema>;
export type WaitingThread = z.infer<typeof WaitingThreadSchema>;
export type NeverAnsweredLead = z.infer<typeof NeverAnsweredLeadSchema>;
export type AddressLeads = z.infer<typeof AddressLeadsSchema>;
export type Listing = z.infer<typeof ListingSchema>;
export type PriceChange = z.infer<typeof PriceChangeSchema>;

/** An account's identity: its name, lower-cased with whitespace collapsed. */
export function accountKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const r2 = (n: number | undefined) =>
  n === undefined ? null : Math.round(n * 100) / 100;

/** The stream identity shared by every row a payload writes. */
export function streamOf(p: SalesKpiPayload) {
  return {
    account_key: accountKey(p.account_name),
    account_name: p.account_name.trim().replace(/\s+/g, " "),
    platform: p.platform ?? "",
    agent: p.agent.trim().toLowerCase(),
  };
}

/** Payload days → `sales_kpi_days` upsert rows. */
export function toDayRows(p: SalesKpiPayload, now = new Date().toISOString()) {
  const s = streamOf(p);
  return (p.days ?? []).map((d) => ({
    ...s,
    day: d.date,
    leads: d.leads,
    first_reply_hours: r2(d.first_reply_hours),
    replies_sent: d.replies_sent ?? null,
    handoffs: d.handoffs ?? null,
    followed_up: d.followed_up ?? null,
    never_answered: d.never_answered ?? null,
    rejected: d.rejected ?? null,
    leads_by_address: d.leads_by_address ?? [],
    updated_at: now,
  }));
}

// ---------------------------------------------------------------- filters

export const RANGES = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "ytd", label: "This year" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom" },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];

/**
 * `account` values besides a real account_key: "all" = every account, each
 * in its own card; OVERALL = "All accounts — Summary", one composite card.
 */
export const OVERALL = "_overall";
export const OVERALL_NAME = "All accounts";

export const KpiFiltersSchema = z.object({
  account: z.string().max(100).default("all"),
  platform: z.string().max(60).default("all"),
  agent: z.string().max(60).default("all"),
  range: z.enum(RANGES.map((r) => r.key) as [RangeKey, ...RangeKey[]]).default("30d"),
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
});
export type KpiFilters = z.infer<typeof KpiFiltersSchema>;

export const BUILTIN_FILTERS: KpiFilters = {
  account: "all",
  platform: "all",
  agent: "all",
  range: "30d",
};

/** URL params the KPI panel owns (prefixed so they never clash with the table's). */
export const KPI_PARAMS = {
  account: "k_acct",
  platform: "k_plat",
  agent: "k_agent",
  range: "k_range",
  from: "k_from",
  to: "k_to",
} as const;

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Whether the URL carries any KPI filter (otherwise the saved default applies). */
export function hasKpiParams(params: Params): boolean {
  return Object.values(KPI_PARAMS).some((k) => first(params[k]) !== undefined);
}

/** Coerce anything (URL params, a saved jsonb) into valid filters. */
export function normalizeFilters(raw: unknown): KpiFilters {
  const p = KpiFiltersSchema.safeParse(raw ?? {});
  if (!p.success) return { ...BUILTIN_FILTERS };
  const f = p.data;
  if (f.range !== "custom") return { account: f.account, platform: f.platform, agent: f.agent, range: f.range };
  if (f.from && f.to && f.from > f.to) [f.from, f.to] = [f.to, f.from];
  return f;
}

export function filtersFromParams(params: Params): KpiFilters {
  return normalizeFilters({
    account: first(params[KPI_PARAMS.account]) || undefined,
    platform: first(params[KPI_PARAMS.platform]) || undefined,
    agent: first(params[KPI_PARAMS.agent]) || undefined,
    range: first(params[KPI_PARAMS.range]) || undefined,
    from: first(params[KPI_PARAMS.from]) || undefined,
    to: first(params[KPI_PARAMS.to]) || undefined,
  });
}

/** Filters → URL params (every key set, so the URL alone reproduces the view). */
export function filtersToParams(f: KpiFilters): Record<string, string> {
  const out: Record<string, string> = {
    [KPI_PARAMS.account]: f.account,
    [KPI_PARAMS.platform]: f.platform,
    [KPI_PARAMS.agent]: f.agent,
    [KPI_PARAMS.range]: f.range,
  };
  if (f.range === "custom") {
    if (f.from) out[KPI_PARAMS.from] = f.from;
    if (f.to) out[KPI_PARAMS.to] = f.to;
  }
  return out;
}

export function sameFilters(a: KpiFilters, b: KpiFilters): boolean {
  const pa = filtersToParams(a);
  const pb = filtersToParams(b);
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  return [...keys].every((k) => pa[k] === pb[k]);
}

/** Inclusive day bounds for a range; null means unbounded. Relative ranges roll with `today`. */
export function rangeBounds(f: KpiFilters, today: string): { from: string | null; to: string | null } {
  switch (f.range) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDaysISO(today, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: addDaysISO(today, -6), to: today };
    case "30d":
      return { from: addDaysISO(today, -29), to: today };
    case "90d":
      return { from: addDaysISO(today, -89), to: today };
    case "ytd":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "all":
      return { from: null, to: null };
    case "custom":
      return { from: f.from ?? null, to: f.to ?? null };
  }
}

// ---------------------------------------------------------------- aggregation

export type DayRow = {
  account_key: string;
  account_name: string;
  platform: string;
  agent: string;
  day: string;
  leads: number;
  first_reply_hours: number | null;
  replies_sent: number | null;
  handoffs: number | null;
  followed_up: number | null;
  never_answered: number | null;
  /** Optional so older callers and tests need not set it. */
  rejected?: number | null;
  leads_by_address: unknown;
};

export type StreamRow = {
  account_key: string;
  account_name: string;
  platform: string;
  agent: string;
  waiting_on_us: unknown;
  never_answered_leads: unknown;
  /** Optional so callers that don't need unit demand can leave it out. */
  listings?: unknown;
  open_as_of: string | null;
  last_received_at: string;
};

/** Demand for one unit (address + unit) over the range. */
export type UnitDemand = {
  address: string;
  unit: string | null;
  style: string | null;
  /** Account the unit's numbers came from (shown on the composite). */
  account: string;
  leads: number;
  /** Qualified = given Vinny's number; null when the agent didn't split handoffs by unit. */
  qualified: number | null;
  /** Labelled "Rejected"; null when the agent didn't split it by address. */
  rejected: number | null;
  /** Leads ÷ days the unit was listed inside the range (or days with data when no listing was sent). */
  leadsPerDay: number | null;
  listedOn: string | null;
  deactivatedOn: string | null;
  /** Last listed → deactivated, or → today while still live. */
  daysOnMarket: number | null;
  price: number | null;
};

/** One day's numbers for an account (or the composite); null = not reported. */
export type DailyPoint = {
  day: string;
  leads: number;
  replies: number | null;
  handoffs: number | null;
  followedUp: number | null;
  neverAnswered: number | null;
  rejected: number | null;
  /** Leads-weighted across the streams that reported it. */
  firstReplyHours: number | null;
};

export type AccountKpis = {
  accountKey: string;
  accountName: string;
  platforms: string[];
  agents: string[];
  firstDay: string | null;
  lastDay: string | null;
  daysWithData: number;
  totalLeads: number;
  /** Leads-weighted average over days that reported it. */
  firstReplyHours: number | null;
  repliesPerDay: number | null;
  handoffs: number | null;
  handoffRate: number | null;
  followedUp: number | null;
  followUpRate: number | null;
  neverAnswered: number | null;
  /** Leads labelled "Rejected" after vetting; null when the agent didn't report it. */
  rejected: number | null;
  rejectedRate: number | null;
  /** Leads left to work once the rejected ones are set aside (= all leads when none are reported). */
  workableLeads: number;
  leadsByAddress: { address: string; leads: number }[];
  /** Per-unit demand, most leads first; empty when no unit detail or listings were sent. */
  units: UnitDemand[];
  /** Leads per unit style over the range, most first. */
  leadsByStyle: { style: string; leads: number }[];
  /** Leads per day, oldest first (only days with data). */
  daily: DailyPoint[];
  waitingOnUs: (WaitingThread & { platform: string; account: string })[];
  neverAnsweredLeads: (NeverAnsweredLead & { platform: string; account: string })[];
  lastReceivedAt: string | null;
  /** Only on the composite: leads per account over the range, most first. */
  byAccount?: { name: string; leads: number }[];
};

/** With no start date chosen, "Waiting on us" stops at threads this old: past it the lead is gone, not waiting. */
export const WAITING_MAX_DAYS = 45;

/** jsonb columns arrive untyped; keep only well-formed entries. */
export function parseList<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const p = schema.safeParse(x);
    return p.success ? [p.data] : [];
  });
}

/** A unit's identity within an account: address + unit, case-insensitive. */
export function unitKey(address: string, unit?: string | null): string {
  return `${address.trim().toLowerCase()}|${(unit ?? "").trim().toLowerCase()}`;
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/**
 * Roll already-filtered day rows and stream rows up to one card per account.
 * Rates are recomputed from summed counts, so they stay correct over any
 * date range. Never-answered names are narrowed to the range when they carry
 * a `received_at` date.
 */
export function aggregateByAccount(
  days: DayRow[],
  streams: StreamRow[],
  bounds: { from: string | null; to: string | null },
  opts: { combine?: boolean; today?: string } = {},
): AccountKpis[] {
  const keyOf = (r: { account_key: string }) => (opts.combine ? OVERALL : r.account_key);
  const byKey = new Map<string, { days: DayRow[]; streams: StreamRow[] }>();
  const slot = (k: string) => {
    let s = byKey.get(k);
    if (!s) byKey.set(k, (s = { days: [], streams: [] }));
    return s;
  };
  for (const d of days) slot(keyOf(d)).days.push(d);
  for (const s of streams) slot(keyOf(s)).streams.push(s);

  const inRange = (iso: string | undefined) => {
    if (!iso) return true;
    const d = iso.slice(0, 10);
    return (!bounds.from || d >= bounds.from) && (!bounds.to || d <= bounds.to);
  };

  const out: AccountKpis[] = [];
  for (const [key, { days: ds, streams: ss }] of byKey) {
    let leads = 0;
    let replyWeighted = 0;
    let replyWeight = 0;
    let replies = 0;
    let repliesDays = 0;
    let handoffs = 0;
    let handoffLeads = 0;
    let followed = 0;
    let followLeads = 0;
    let never = 0;
    let neverSeen = false;
    let rejected = 0;
    let rejectedLeads = 0;
    const addr = new Map<string, { address: string; leads: number }>();
    const units = new Map<string, UnitDemand & { detailed: boolean }>();
    const styles = new Map<string, { style: string; leads: number }>();
    const unitSlot = (address: string, unit: string | undefined, account: string) => {
      const k = `${opts.combine ? `${account}|` : ""}${unitKey(address, unit)}`;
      let u = units.get(k);
      if (!u)
        units.set(
          k,
          (u = {
            address: address.trim(),
            unit: unit?.trim() || null,
            style: null,
            account,
            leads: 0,
            qualified: null,
            rejected: null,
            leadsPerDay: null,
            listedOn: null,
            deactivatedOn: null,
            daysOnMarket: null,
            price: null,
            detailed: false,
          }),
        );
      return u;
    };
    const daily = new Map<string, DailyPoint & { rw: number; rwt: number }>();
    const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);

    for (const d of ds) {
      leads += d.leads;
      let pt = daily.get(d.day);
      if (!pt)
        daily.set(
          d.day,
          (pt = { day: d.day, leads: 0, replies: null, handoffs: null, followedUp: null, neverAnswered: null, rejected: null, firstReplyHours: null, rw: 0, rwt: 0 }),
        );
      pt.leads += d.leads;
      pt.rejected = add(pt.rejected, d.rejected ?? null);
      if (d.rejected !== null && d.rejected !== undefined) {
        rejected += d.rejected;
        rejectedLeads += d.leads;
      }
      pt.replies = add(pt.replies, d.replies_sent);
      pt.handoffs = add(pt.handoffs, d.handoffs);
      pt.followedUp = add(pt.followedUp, d.followed_up);
      pt.neverAnswered = add(pt.neverAnswered, d.never_answered);
      if (d.first_reply_hours !== null) {
        const w = Math.max(d.leads, 1);
        pt.rw += Number(d.first_reply_hours) * w;
        pt.rwt += w;
        pt.firstReplyHours = Math.round((pt.rw / pt.rwt) * 100) / 100;
      }
      if (d.first_reply_hours !== null) {
        // A zero-lead day still counts once so a reported time isn't lost.
        const w = Math.max(d.leads, 1);
        replyWeighted += Number(d.first_reply_hours) * w;
        replyWeight += w;
      }
      if (d.replies_sent !== null) {
        replies += d.replies_sent;
        repliesDays += 1;
      }
      // Rejected leads need no reply, so rates are out of the leads left to work.
      const workable = Math.max(0, d.leads - (d.rejected ?? 0));
      if (d.handoffs !== null) {
        handoffs += d.handoffs;
        handoffLeads += workable;
      }
      if (d.followed_up !== null) {
        followed += d.followed_up;
        followLeads += workable;
      }
      if (d.never_answered !== null) {
        never += d.never_answered;
        neverSeen = true;
      }
      for (const a of parseList(AddressLeadsSchema, d.leads_by_address)) {
        const k = a.address.trim().toLowerCase();
        const cur = addr.get(k);
        if (cur) cur.leads += a.leads;
        else addr.set(k, { address: a.address.trim(), leads: a.leads });

        const u = unitSlot(a.address, a.unit, d.account_name);
        u.leads += a.leads;
        if (a.unit || a.unit_style || a.handoffs !== undefined) u.detailed = true;
        if (a.unit_style) u.style = a.unit_style.trim();
        if (a.handoffs !== undefined) u.qualified = (u.qualified ?? 0) + a.handoffs;
        if (a.rejected !== undefined) u.rejected = (u.rejected ?? 0) + a.rejected;
        if (a.unit_style) {
          const sk = a.unit_style.trim().toLowerCase();
          const st = styles.get(sk);
          if (st) st.leads += a.leads;
          else styles.set(sk, { style: a.unit_style.trim(), leads: a.leads });
        }
      }
    }

    // Listings: the latest listing per unit sets its dates, style and price.
    const today = opts.today ?? bounds.to ?? ds.map((d) => d.day).sort().at(-1) ?? null;
    let anyListing = false;
    for (const s of ss) {
      const latest = new Map<string, Listing>();
      for (const l of parseList(ListingSchema, s.listings)) {
        const k = unitKey(l.address, l.unit);
        const cur = latest.get(k);
        if (!cur || l.listed_on > cur.listed_on) latest.set(k, l);
      }
      for (const l of latest.values()) {
        anyListing = true;
        const u = unitSlot(l.address, l.unit, s.account_name);
        u.detailed = true;
        u.style ??= l.unit_style?.trim() ?? null;
        u.listedOn = l.listed_on;
        u.deactivatedOn = l.deactivated_on ?? null;
        u.price = l.price ?? [...(l.price_changes ?? [])].sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.to ?? null;
        const end = l.deactivated_on ?? today;
        u.daysOnMarket = end && end >= l.listed_on ? daysBetween(l.listed_on, end) : null;
      }
    }
    const dataDays = new Set(ds.map((d) => d.day)).size;
    const firstData = ds.map((d) => d.day).sort()[0] ?? null;
    for (const u of units.values()) {
      let span = dataDays;
      if (u.listedOn) {
        const from = [u.listedOn, bounds.from ?? firstData ?? u.listedOn].sort().at(-1)!;
        const to = [u.deactivatedOn ?? today ?? from, bounds.to ?? today ?? from].sort()[0];
        span = to >= from ? daysBetween(from, to) + 1 : 0;
      }
      u.leadsPerDay = span > 0 ? Math.round((u.leads / span) * 100) / 100 : null;
    }
    const showUnits = anyListing || [...units.values()].some((u) => u.detailed);

    const waiting = ss
      .flatMap((s) =>
        parseList(WaitingThreadSchema, s.waiting_on_us).map((w) => ({
          ...w,
          platform: s.platform,
          account: s.account_name,
          // The day the renter last wrote: sent, or worked back from the wait.
          since:
            w.last_message_at?.slice(0, 10) ??
            (s.open_as_of ? addDaysISO(s.open_as_of.slice(0, 10), -Math.floor(w.days_waiting)) : undefined),
        })),
      )
      // Follows the date filter (by the day the renter last wrote); with no
      // start date ("All time") it stops at WAITING_MAX_DAYS instead.
      .filter((w) => (bounds.from ? inRange(w.since) : w.days_waiting <= WAITING_MAX_DAYS && inRange(w.since)))
      .map(({ since, ...w }) => {
        void since;
        return w;
      })
      .sort((a, b) => b.days_waiting - a.days_waiting);
    const neverLeads = ss
      .flatMap((s) =>
        parseList(NeverAnsweredLeadSchema, s.never_answered_leads).map((n) => ({ ...n, platform: s.platform, account: s.account_name })),
      )
      .filter((n) => inRange(n.received_at));

    const sortedDays = [...daily.keys()].sort();
    const names = [...ds.map((d) => d.account_name), ...ss.map((s) => s.account_name)];
    const lastReceived = ss.map((s) => s.last_received_at).sort().at(-1) ?? null;

    const nameOf = (k: string) =>
      ss.find((s) => s.account_key === k)?.account_name ?? ds.find((d) => d.account_key === k)?.account_name ?? k;
    let byAccount: AccountKpis["byAccount"];
    if (opts.combine) {
      const leadsBy = new Map<string, number>();
      for (const s of ss) leadsBy.set(s.account_key, 0);
      for (const d of ds) leadsBy.set(d.account_key, (leadsBy.get(d.account_key) ?? 0) + d.leads);
      byAccount = [...leadsBy]
        .map(([k, leads]) => ({ name: nameOf(k), leads }))
        .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name));
    }

    out.push({
      byAccount,
      accountKey: key,
      accountName: opts.combine
        ? OVERALL_NAME
        : ss.find((s) => s.last_received_at === lastReceived)?.account_name ?? names[0] ?? key,
      platforms: [...new Set([...ds.map((d) => d.platform), ...ss.map((s) => s.platform)].filter(Boolean))].sort(),
      agents: [...new Set([...ds.map((d) => d.agent), ...ss.map((s) => s.agent)])].sort(),
      firstDay: sortedDays[0] ?? null,
      lastDay: sortedDays.at(-1) ?? null,
      daysWithData: sortedDays.length,
      totalLeads: leads,
      firstReplyHours: replyWeight > 0 ? Math.round((replyWeighted / replyWeight) * 10) / 10 : null,
      repliesPerDay: repliesDays > 0 ? Math.round((replies / repliesDays) * 10) / 10 : null,
      handoffs: handoffLeads > 0 || handoffs > 0 ? handoffs : null,
      handoffRate: pct(handoffs, handoffLeads),
      followedUp: followLeads > 0 || followed > 0 ? followed : null,
      followUpRate: pct(followed, followLeads),
      // Per-day counts and the named list measure the same thing; an agent
      // that sent only some days undercounts per day, so take the larger.
      neverAnswered: neverSeen ? Math.max(never, neverLeads.length) : neverLeads.length > 0 ? neverLeads.length : null,
      rejected: rejectedLeads > 0 || rejected > 0 ? rejected : null,
      rejectedRate: pct(rejected, rejectedLeads),
      workableLeads: Math.max(0, leads - rejected),
      leadsByAddress: [...addr.values()].sort(
        (a, b) => b.leads - a.leads || a.address.localeCompare(b.address),
      ),
      units: showUnits
        ? [...units.values()]
            .map((u): UnitDemand => {
              const { detailed, ...rest } = u;
              void detailed;
              return rest;
            })
            .sort(
              (a, b) =>
                b.leads - a.leads ||
                a.address.localeCompare(b.address) ||
                (a.unit ?? "").localeCompare(b.unit ?? ""),
            )
        : [],
      leadsByStyle: [...styles.values()].sort((a, b) => b.leads - a.leads || a.style.localeCompare(b.style)),
      daily: sortedDays.map((day): DailyPoint => {
        const p = daily.get(day)!;
        return {
          day,
          leads: p.leads,
          replies: p.replies,
          handoffs: p.handoffs,
          followedUp: p.followedUp,
          neverAnswered: p.neverAnswered,
          rejected: p.rejected,
          firstReplyHours: p.firstReplyHours,
        };
      }),
      waitingOnUs: waiting,
      neverAnsweredLeads: neverLeads,
      lastReceivedAt: lastReceived,
    });
  }
  return out.sort((a, b) => a.accountName.localeCompare(b.accountName));
}

/** The composite of every account in the rows given; null when there are none. */
export function aggregateOverall(
  days: DayRow[],
  streams: StreamRow[],
  bounds: { from: string | null; to: string | null },
): AccountKpis | null {
  return aggregateByAccount(days, streams, bounds, { combine: true })[0] ?? null;
}


/**
 * The equally long window right before `bounds`, for "vs previous period"
 * deltas. Null when the range is open-ended (All time).
 */
export function previousBounds(bounds: { from: string | null; to: string | null }) {
  if (!bounds.from || !bounds.to) return null;
  const len = Math.round((Date.parse(bounds.to) - Date.parse(bounds.from)) / 86_400_000) + 1;
  return { from: addDaysISO(bounds.from, -len), to: addDaysISO(bounds.from, -1), days: len };
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** 0 = Monday … 6 = Sunday for a YYYY-MM-DD day. */
export function weekdayIndex(day: string): number {
  return (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/** Average leads per weekday over the days that have data, Monday first. */
export function weekdayAverages(daily: DailyPoint[]) {
  const sum = Array<number>(7).fill(0);
  const n = Array<number>(7).fill(0);
  for (const d of daily) {
    const i = weekdayIndex(d.day);
    sum[i] += d.leads;
    n[i] += 1;
  }
  return WEEKDAYS.map((label, i) => ({
    label,
    days: n[i],
    total: sum[i],
    avg: n[i] > 0 ? Math.round((sum[i] / n[i]) * 10) / 10 : null,
  }));
}

// ---------------------------------------------------------------- matching to inventory

/** A building as the portal knows it. */
export type InventoryRoom = {
  building_name: string | null;
  street_address: string;
};

/** The ad number inside an ad URL or any text that mentions one ("ad 103252360"). */
export function adNumber(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const all = t?.match(/\d{6,}/g);
    if (all) return all.at(-1)!;
  }
  return null;
}

const STREET_WORDS: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", boulevard: "blvd", place: "pl", road: "rd", drive: "dr",
  east: "e", west: "w", north: "n", south: "s",
};

/** "628 Summit Avenue, Jersey City, NJ" → "summit ave": the street name alone. */
export function streetName(address: string): string {
  return address
    .split(",")[0]
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/^\s*\d+(-\d+)?\s+(?=\S)/, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w.replace(/^(\d+)(st|nd|rd|th)$/, "$1"))
    .join(" ")
    // One street, two common spellings.
    .replace(/\bjohn f kennedy\b/, "jfk");
}

const buildingLabel = (r: InventoryRoom) => r.building_name?.trim() || r.street_address.split(",")[0].trim();

type Place = { address: string; unit?: string; ad_ref?: string };

/**
 * Ads show a street address but hide the building and unit numbers, so the
 * street address on the ad is the record: every ad on the same street is one
 * line, however each was spelled ("Summit Avenue" = "Summit Ave"). The line
 * is named the way it was first written, and no unit is kept.
 */
export function inventoryResolver() {
  const labels = new Map<string, string>();
  return function resolve<T extends Place>(p: T): T {
    const sent = p.address.trim();
    const key = streetName(sent) || sent.toLowerCase();
    let label = labels.get(key);
    if (!label) labels.set(key, (label = sent));
    return { ...p, address: label, unit: undefined };
  };
}

/**
 * For the record: which of our buildings an ad's street address belongs to,
 * matched by street name alone. Null when no building, or more than one,
 * sits on that street — it never guesses between two.
 */
export function streetBuildings(rooms: InventoryRoom[]) {
  const byStreet = new Map<string, Set<string>>();
  for (const r of rooms) {
    const st = streetName(r.street_address);
    if (st) byStreet.set(st, (byStreet.get(st) ?? new Set()).add(buildingLabel(r)));
  }
  return (address: string): string | null => {
    const hit = byStreet.get(streetName(address));
    return hit?.size === 1 ? [...hit][0] : null;
  };
}

/** Resolve every address a day row or a stream row carries (see `inventoryResolver`). */
export function resolveDayRow<T extends { leads_by_address: unknown }>(
  d: T,
  resolve: ReturnType<typeof inventoryResolver>,
): T {
  return { ...d, leads_by_address: parseList(AddressLeadsSchema, d.leads_by_address).map((a) => resolve(a)) };
}

export function resolveStreamRow<T extends StreamRow>(s: T, resolve: ReturnType<typeof inventoryResolver>): T {
  const loose = <X extends { address?: string; ad_ref?: string }>(x: X): X => {
    if (!x.address) return x;
    return { ...x, address: resolve<Place>({ address: x.address }).address };
  };
  return {
    ...s,
    waiting_on_us: parseList(WaitingThreadSchema, s.waiting_on_us).map(loose),
    never_answered_leads: parseList(NeverAnsweredLeadSchema, s.never_answered_leads).map(loose),
    listings: parseList(ListingSchema, s.listings).map((l) => resolve(l)),
  };
}

// ---------------------------------------------------------------- demand after a price change

/** How far either side of a price change we look. */
export const TREND_WINDOW_DAYS = 28;

export type PriceTrend = {
  address: string;
  unit: string | null;
  date: string;
  from: number | null;
  to: number;
  note: string | null;
  /** Leads per week in the window before / after; null when that side has no days yet. */
  beforePerWeek: number | null;
  afterPerWeek: number | null;
  beforeDays: number;
  afterDays: number;
};

/**
 * Leads per week before vs after each logged price change, for ONE stream's
 * listings and day rows. Each side is up to 28 days, cut short by the
 * listing's own dates, by today, and by the neighbouring price changes so
 * two changes never share days. A day with no row counts as zero leads.
 */
export function priceChangeTrends(
  listings: Listing[],
  days: { day: string; leads_by_address: unknown }[],
  today: string,
): PriceTrend[] {
  // unit → day → leads
  const byUnit = new Map<string, Map<string, number>>();
  for (const d of days)
    for (const a of parseList(AddressLeadsSchema, d.leads_by_address)) {
      const k = unitKey(a.address, a.unit);
      let m = byUnit.get(k);
      if (!m) byUnit.set(k, (m = new Map()));
      m.set(d.day, (m.get(d.day) ?? 0) + a.leads);
    }
  const sumRange = (m: Map<string, number> | undefined, from: string, to: string) => {
    let n = 0;
    if (m) for (const [day, leads] of m) if (day >= from && day <= to) n += leads;
    return n;
  };
  const perWeek = (leads: number, span: number) =>
    span > 0 ? Math.round((leads / span) * 70) / 10 : null;

  const out: PriceTrend[] = [];
  for (const l of listings) {
    const changes = [...(l.price_changes ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const leads = byUnit.get(unitKey(l.address, l.unit));
    const end = [l.deactivated_on ?? today, today].sort()[0];
    changes.forEach((c, i) => {
      const prev = changes[i - 1]?.date;
      const next = changes[i + 1]?.date;
      const beforeFrom = [addDaysISO(c.date, -TREND_WINDOW_DAYS), l.listed_on, prev ?? ""].sort().at(-1)!;
      const beforeTo = addDaysISO(c.date, -1);
      const afterTo = [addDaysISO(c.date, TREND_WINDOW_DAYS - 1), end, next ? addDaysISO(next, -1) : end].sort()[0];
      const beforeDays = beforeTo >= beforeFrom ? daysBetween(beforeFrom, beforeTo) + 1 : 0;
      const afterDays = afterTo >= c.date ? daysBetween(c.date, afterTo) + 1 : 0;
      out.push({
        address: l.address.trim(),
        unit: l.unit?.trim() || null,
        date: c.date,
        from: c.from ?? changes[i - 1]?.to ?? null,
        to: c.to,
        note: c.note ?? null,
        beforePerWeek: perWeek(beforeDays > 0 ? sumRange(leads, beforeFrom, beforeTo) : 0, beforeDays),
        afterPerWeek: perWeek(afterDays > 0 ? sumRange(leads, c.date, afterTo) : 0, afterDays),
        beforeDays,
        afterDays,
      });
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.address.localeCompare(b.address));
}

// ---------------------------------------------------------------- dictionary

/**
 * What each KPI means and how it is counted. Shown on the KPIs page and
 * mirrored in the brief the agents work from — keep the two in step.
 */
export const KPI_DICTIONARY = [
  {
    group: "Inbox team",
    about: "How well each account's inbox is being worked.",
    items: [
      {
        name: "Total leads received",
        meaning:
          "New renters who wrote to the account. Each person counts once, on the day of their first message.",
      },
      {
        name: "Time to first reply (hours)",
        meaning:
          "Average hours between a lead's first message and our first reply. Leads we never answered are left out of the average and show under Never answered instead.",
      },
      {
        name: "Replies sent per day",
        meaning: "Messages we sent that day, to any lead. Auto-replies don't count.",
      },
      {
        name: "Handoff rate",
        meaning:
          "Share of leads handed over to Vinny by sending them his phone number. Counted out of the leads left to work, i.e. leads received in the chosen dates minus the rejected ones.",
      },
      {
        name: "Rejected leads",
        meaning:
          "Leads the team labelled \"Rejected\" on SpareRoom after vetting: unqualified renters who do not need to be reached out to. They still count in total leads, but are set aside for everything else: the handoff and follow-up rates are out of the leads left to work, and rejected leads never show in waiting on us or never answered.",
      },
      {
        name: "Follow-up rate",
        meaning:
          "Share of leads we wrote to again after they went quiet on our last message: of the leads received in the chosen dates, how many got at least one follow-up. Counted out of the leads left to work (rejected ones set aside).",
      },
      {
        name: "Waiting on us",
        meaning:
          "Threads where the renter wrote last and we haven't answered, with how many days each has waited. Rejected leads are left out. These are warm leads going cold. The list follows the chosen dates, by the day the renter last wrote; on All time it stops at 45 days.",
      },
      {
        name: "Never answered",
        meaning: "Leads received in the chosen dates who have had no reply from us at all. Rejected leads are left out.",
      },
      {
        name: "Leads per address",
        meaning:
          "Leads for each street address shown on the ad, e.g. 5 leads to John St. Ads on the same street are counted together. Where only one of our buildings is on that street, the building is noted beside it.",
      },
    ],
  },
  {
    group: "Demand per unit and time on market",
    about: "Which units pull interest, and how long each one sits.",
    items: [
      {
        name: "Leads per unit",
        meaning: "Leads for one street address in the chosen dates. Our ads don't show the unit, so ads on the same street are one line.",
      },
      {
        name: "Leads per day",
        meaning:
          "An address's leads divided by the days it was listed inside the chosen dates. Lets an ad listed for 5 days be compared with one listed for 30.",
      },
      {
        name: "Handed over leads per unit",
        meaning:
          "Leads for that street address who were sent Vinny's number (also called qualified leads). The percentage beside it is out of that address's leads left to work.",
      },
      {
        name: "Rejected leads per unit",
        meaning: "Leads for that street address the team labelled \"Rejected\".",
      },
      {
        name: "Days on market",
        meaning:
          "Days from the date the ad was last listed to the date it was deactivated, or to today while it is still live.",
      },
      {
        name: "Demand trend after a change",
        meaning:
          "For every logged price change: leads per week in the 4 weeks before it against the 4 weeks after it, for that street address.",
      },
    ],
  },
] as const;
