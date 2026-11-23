/**
 * Sales KPIs from the lead-handling agents (Grok and others), shown at the
 * top of /inventory to users with the 'sales_kpis' permission.
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

export const WaitingThreadSchema = z.object({
  lead: text(120),
  days_waiting: nonNeg,
  address: text(200).optional(),
  last_message_at: z.string().max(40).optional(),
});

export const NeverAnsweredLeadSchema = z.object({
  lead: text(120),
  address: text(200).optional(),
  received_at: z.string().max(40).optional(),
});

export const AddressLeadsSchema = z.object({
  address: text(200),
  leads: count,
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
  })
  .strict()
  .refine((p) => (p.days?.length ?? 0) > 0 || p.open, {
    message: "send at least one of days or open",
    path: ["days"],
  })
  .refine(
    (p) => new Set((p.days ?? []).map((d) => d.date)).size === (p.days ?? []).length,
    { message: "each date may appear only once", path: ["days"] },
  );

export type SalesKpiPayload = z.infer<typeof SalesKpiPayloadSchema>;
export type WaitingThread = z.infer<typeof WaitingThreadSchema>;
export type NeverAnsweredLead = z.infer<typeof NeverAnsweredLeadSchema>;
export type AddressLeads = z.infer<typeof AddressLeadsSchema>;

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
  leads_by_address: unknown;
};

export type StreamRow = {
  account_key: string;
  account_name: string;
  platform: string;
  agent: string;
  waiting_on_us: unknown;
  never_answered_leads: unknown;
  open_as_of: string | null;
  last_received_at: string;
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
  leadsByAddress: AddressLeads[];
  /** Leads per day, oldest first (only days with data). */
  daily: { day: string; leads: number }[];
  waitingOnUs: (WaitingThread & { platform: string; account: string })[];
  neverAnsweredLeads: (NeverAnsweredLead & { platform: string; account: string })[];
  lastReceivedAt: string | null;
  /** Only on the composite: leads per account over the range, most first. */
  byAccount?: { name: string; leads: number }[];
};

/** jsonb columns arrive untyped; keep only well-formed entries. */
export function parseList<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const p = schema.safeParse(x);
    return p.success ? [p.data] : [];
  });
}

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
  opts: { combine?: boolean } = {},
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
    const addr = new Map<string, AddressLeads>();
    const daily = new Map<string, number>();

    for (const d of ds) {
      leads += d.leads;
      daily.set(d.day, (daily.get(d.day) ?? 0) + d.leads);
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
      if (d.handoffs !== null) {
        handoffs += d.handoffs;
        handoffLeads += d.leads;
      }
      if (d.followed_up !== null) {
        followed += d.followed_up;
        followLeads += d.leads;
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
      }
    }

    const waiting = ss
      .flatMap((s) => parseList(WaitingThreadSchema, s.waiting_on_us).map((w) => ({ ...w, platform: s.platform, account: s.account_name })))
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
      // Per-day counts when the agent sends them; otherwise the open list.
      neverAnswered: neverSeen ? never : neverLeads.length > 0 ? neverLeads.length : null,
      leadsByAddress: [...addr.values()].sort(
        (a, b) => b.leads - a.leads || a.address.localeCompare(b.address),
      ),
      daily: sortedDays.map((day) => ({ day, leads: daily.get(day)! })),
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
