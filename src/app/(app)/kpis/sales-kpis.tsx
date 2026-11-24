import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { todayISO } from "@/lib/date";
import { addDaysISO } from "@/lib/date";
import {
  BUILTIN_FILTERS,
  ListingSchema,
  OVERALL,
  RANGES,
  TREND_WINDOW_DAYS,
  aggregateByAccount,
  aggregateOverall,
  filtersFromParams,
  hasKpiParams,
  inventoryResolver,
  normalizeFilters,
  parseList,
  previousBounds,
  priceChangeTrends,
  rangeBounds,
  resolveDayRow,
  resolveStreamRow,
  streetBuildings,
  weekdayAverages,
  weekdayIndex,
  type AccountKpis,
  type DayRow,
  type PriceTrend,
  type UnitDemand,
} from "@/lib/sales-kpis";
import { SalesKpiFilters } from "./sales-kpi-filters";
import { SalesKpiChart } from "./sales-kpi-chart";

const NY = "America/New_York";
const PAGE = 1000;

type Params = Record<string, string | string[] | undefined>;
type Bounds = { from: string | null; to: string | null };

function fmtNum(n: number | null, suffix = "") {
  if (n === null) return "—";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
}

function fmtDay(d: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
}
const fmtDayLong = (d: string) => fmtDay(d, { weekday: "short", month: "short", day: "numeric" });
const fmtDayYear = (d: string) => fmtDay(d, { month: "short", day: "numeric", year: "numeric" });

function fmtUpdated(ts: string) {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: NY,
  });
}

const leadsPerDay = (a: AccountKpis) =>
  a.daysWithData > 0 ? Math.round((a.totalLeads / a.daysWithData) * 10) / 10 : null;

// ---------------------------------------------------------------- stat tiles

type Delta = { text: string; good: boolean | null } | null;

/**
 * Change vs the previous period. `kind`: pct = relative change, pts =
 * percentage points (for rates), abs = plain difference. `good` follows
 * whether up is good for that metric; null when nothing moved.
 */
function delta(
  cur: number | null,
  prev: number | null | undefined,
  kind: "pct" | "pts" | "abs",
  upIsGood: boolean,
  unit = "",
): Delta {
  if (cur === null || prev === null || prev === undefined) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < 0.05) return { text: "no change", good: null };
  let body: string;
  if (kind === "pct") {
    if (prev === 0) return null;
    body = `${Math.abs(Math.round((diff / prev) * 100))}%`;
  } else {
    body = `${fmtNum(Math.abs(Math.round(diff * 10) / 10))}${kind === "pts" ? " pts" : unit}`;
  }
  return { text: `${diff > 0 ? "▲" : "▼"} ${body}`, good: diff > 0 === upIsGood };
}

const CARD = "rounded-xl bg-white shadow-sm ring-1 ring-stone/40";

/** One figure in the summary row: label, big number, then change and context. */
function Stat({
  label,
  value,
  hint,
  change,
  alert = false,
}: {
  label: string;
  value: string;
  hint?: string;
  change?: Delta;
  alert?: boolean;
}) {
  return (
    <div className="min-w-0 border-l border-stone/40 pl-4 pr-3">
      <div className="flex items-center gap-1.5 text-sm text-muted">
        {alert && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-600" aria-hidden />}
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-1 text-3xl font-semibold tabular-nums ${alert ? "text-red-800" : "text-ink"}`}>{value}</div>
      <div className="mt-1 min-h-[1rem] text-xs text-muted">
        {change && (
          <span
            className={`font-medium tabular-nums ${
              change.good === null ? "text-muted" : change.good ? "text-green-800" : "text-red-800"
            }`}
          >
            {change.text}
            <span className="sr-only">{change.good === null ? "" : change.good ? " (better)" : " (worse)"}</span>
          </span>
        )}
        {change && hint && " · "}
        {hint}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- day insights

function Insight({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="truncate text-sm font-semibold text-ink">{value}</div>
      {sub && <div className="truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

/** Average leads by weekday — which days of the week bring the work. */
function WeekdayStrip({ a }: { a: AccountKpis }) {
  const wk = weekdayAverages(a.daily);
  const max = Math.max(1, ...wk.map((w) => w.avg ?? 0));
  const best = Math.max(...wk.map((w) => w.avg ?? -1));
  return (
    <div>
      <h4 className="text-xs uppercase tracking-wide text-muted">Average leads by weekday</h4>
      <div className="mt-2 flex items-end gap-2" style={{ height: 96 }}>
        {wk.map((w) => (
          <div
            key={w.label}
            className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
            title={
              w.avg === null
                ? `${w.label}: no data`
                : `${w.label}: ${w.total} leads over ${w.days} day${w.days === 1 ? "" : "s"}`
            }
          >
            <span className="mb-0.5 text-[11px] font-medium tabular-nums text-ink">
              {w.avg === null ? "—" : fmtNum(w.avg)}
            </span>
            {w.avg !== null && (
              <span
                className={`w-full max-w-[24px] rounded-t-[4px] ${w.avg === best ? "bg-accent" : "bg-accent/45"}`}
                style={{ height: Math.max(2, (w.avg / max) * 56) }}
                aria-hidden
              />
            )}
            <span
              className={`mt-1 text-[11px] ${w.avg === best && w.avg !== null ? "font-semibold text-ink" : "text-muted"}`}
            >
              {w.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DayInsights({ a }: { a: AccountKpis }) {
  if (a.daily.length < 2) return null;
  const best = a.daily.reduce((m, d) => (d.leads > m.leads ? d : m));
  const slow = a.daily.reduce((m, d) => (d.leads < m.leads ? d : m));
  const wk = weekdayAverages(a.daily).filter((w) => w.avg !== null);
  const busiest = wk.reduce((m, w) => (w.avg! > m.avg! ? w : m));
  const quietest = wk.reduce((m, w) => (w.avg! < m.avg! ? w : m));
  const unanswered = a.daily.filter((d) => (d.neverAnswered ?? 0) > 0).length;
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="grid grid-cols-2 content-start gap-3">
        <Insight label="Best day" value={`${best.leads} leads`} sub={fmtDayLong(best.day)} />
        <Insight label="Slowest day" value={`${slow.leads} leads`} sub={fmtDayLong(slow.day)} />
        <Insight
          label="Busiest weekday"
          value={busiest.label}
          sub={`${fmtNum(busiest.avg)} leads on average`}
        />
        <Insight
          label="Quietest weekday"
          value={quietest.label}
          sub={`${fmtNum(quietest.avg)} leads on average`}
        />
        <Insight
          label="Days with unanswered leads"
          value={`${unanswered} of ${a.daily.length}`}
          sub={unanswered === 0 ? "Every day fully answered" : "See the day-by-day table"}
        />
        <Insight
          label="Leads per day"
          value={fmtNum(leadsPerDay(a))}
          sub={`over ${a.daysWithData} day${a.daysWithData === 1 ? "" : "s"} with data`}
        />
      </div>
      <WeekdayStrip a={a} />
    </div>
  );
}

/** Every day's numbers, newest first — the table view of the chart. */
function DayTable({ a }: { a: AccountKpis }) {
  if (a.daily.length === 0) return null;
  const rows = [...a.daily].reverse();
  const cell = "px-2 py-1 text-right tabular-nums";
  return (
    <div className="mt-5 max-h-80 overflow-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="sticky top-0 bg-white text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Day</th>
              <th className={`${cell} font-medium`}>Leads</th>
              <th className={`${cell} font-medium`}>First reply</th>
              <th className={`${cell} font-medium`}>Replies</th>
              <th className={`${cell} font-medium`}>Rejected</th>
              <th className={`${cell} font-medium`}>Handed over</th>
              <th className={`${cell} font-medium`}>Follow-ups</th>
              <th className={`${cell} font-medium`}>Never answered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.day} className="border-t border-stone/30">
                <td className="whitespace-nowrap px-2 py-1 text-ink">
                  <span className={weekdayIndex(d.day) >= 5 ? "font-semibold" : ""}>{fmtDayLong(d.day)}</span>
                </td>
                <td className={`${cell} font-semibold text-ink`}>{d.leads}</td>
                <td className={`${cell} text-ink`}>{fmtNum(d.firstReplyHours, " h")}</td>
                <td className={`${cell} text-ink`}>{fmtNum(d.replies)}</td>
                <td className={`${cell} text-ink`}>{fmtNum(d.rejected)}</td>
                <td className={`${cell} text-ink`}>
                  {fmtNum(d.handoffs)}
                  {d.handoffs !== null && d.leads - (d.rejected ?? 0) > 0 && (
                    <span className="text-muted">
                      {" "}
                      · {Math.round((d.handoffs / (d.leads - (d.rejected ?? 0))) * 100)}%
                    </span>
                  )}
                </td>
                <td className={`${cell} text-ink`}>
                  {fmtNum(d.followedUp)}
                  {d.followedUp !== null && d.leads - (d.rejected ?? 0) > 0 && (
                    <span className="text-muted">
                      {" "}
                      · {Math.round((d.followedUp / (d.leads - (d.rejected ?? 0))) * 100)}%
                    </span>
                  )}
                </td>
                <td className={cell}>
                  {(d.neverAnswered ?? 0) > 0 ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800">
                      {d.neverAnswered}
                    </span>
                  ) : (
                    <span className="text-ink">{fmtNum(d.neverAnswered)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
    </div>
  );
}

// ---------------------------------------------------------------- demand per unit

type Trend = PriceTrend & { account: string };
/** Our building on an ad's street, when exactly one is. */
type BuildingOf = (address: string) => string | null;

const fmtMoney = (n: number | null) => (n === null ? "—" : `$${n.toLocaleString()}`);

/**
 * Unit-wise KPIs: one row per street address shown on the ads — leads, leads
 * per day, qualified leads, and (once the agent sends its listings) price,
 * listed date, days on market and what the latest price change did to demand.
 */
function UnitTable({ a, trends, buildingOf }: { a: AccountKpis; trends: Trend[]; buildingOf: BuildingOf }) {
  const overall = !!a.byAccount;
  // Agents that send only { address, leads } still get a row per address.
  const rows: UnitDemand[] =
    a.units.length > 0
      ? a.units
      : a.leadsByAddress.map((x) => ({
          address: x.address,
          unit: null,
          style: null,
          account: a.accountName,
          leads: x.leads,
          qualified: null,
          rejected: null,
          leadsPerDay: a.daysWithData > 0 ? Math.round((x.leads / a.daysWithData) * 100) / 100 : null,
          listedOn: null,
          deactivatedOn: null,
          daysOnMarket: null,
          price: null,
        }));
  const max = Math.max(1, ...rows.map((u) => u.leads));
  // Trends arrive newest first, so the first one per address is its latest change.
  const latest = new Map<string, Trend>();
  for (const t of trends) {
    const k = `${t.account}|${t.address.toLowerCase()}`;
    if (!latest.has(k)) latest.set(k, t);
  }
  const th = "px-3 py-2 text-right font-medium";
  const td = "px-3 py-3 text-right tabular-nums text-ink";
  const dash = <span className="text-muted">—</span>;

  return (
    <div>
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted">Unit-wise KPIs</h4>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          No per-address leads sent by this agent yet. They appear once it sends <code>leads_by_address</code>.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[940px] text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Street address on the ad</th>
                <th className={th}>Leads</th>
                <th className={th}>Leads / day</th>
                <th className={th}>Rejected</th>
                <th className={th}>Handed over</th>
                <th className={th}>Price</th>
                <th className={th}>Listed</th>
                <th className={th}>Days on market</th>
                <th className={th}>After price change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const building = buildingOf(u.address);
                const t = latest.get(`${u.account}|${u.address.toLowerCase()}`);
                return (
                  <tr key={`${u.account}|${u.address}`} className="border-t border-stone/30">
                    <td className="px-3 py-3">
                      <div className="whitespace-nowrap">
                        <span className="font-semibold text-ink">{u.address}</span>
                        {building && <span className="text-muted"> · {building}</span>}
                        {overall && <span className="text-accent-text"> · {u.account}</span>}
                      </div>
                      <div
                        className="mt-1.5 h-1 rounded-full bg-accent"
                        style={{ width: `${Math.max(4, (u.leads / max) * 140)}px` }}
                        aria-hidden
                      />
                    </td>
                    <td className={`${td} font-semibold`}>{u.leads}</td>
                    <td className={td}>{u.leadsPerDay === null ? dash : u.leadsPerDay.toFixed(2)}</td>
                    <td className={td}>{u.rejected === null ? dash : u.rejected}</td>
                    <td className={td}>
                      {u.qualified === null ? (
                        dash
                      ) : (
                        <>
                          {u.qualified}
                          {u.leads - (u.rejected ?? 0) > 0 && (
                            <span className="text-muted">
                              {" "}
                              ({Math.round((u.qualified / (u.leads - (u.rejected ?? 0))) * 100)}%)
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className={td}>{u.price === null ? dash : fmtMoney(u.price)}</td>
                    <td className={td}>{u.listedOn ? fmtDay(u.listedOn) : dash}</td>
                    <td className={td}>
                      {u.daysOnMarket === null ? (
                        dash
                      ) : (
                        <>
                          {u.daysOnMarket}
                          <span
                            className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
                              u.deactivatedOn ? "bg-warm text-muted" : "bg-green-100 text-green-800"
                            }`}
                          >
                            {u.deactivatedOn ? `off ${fmtDay(u.deactivatedOn)}` : "live"}
                          </span>
                        </>
                      )}
                    </td>
                    <td className={td}>
                      {!t ? (
                        dash
                      ) : (
                        <>
                          <div className="text-xs text-muted">
                            {t.from !== null && `${fmtMoney(t.from)} → `}
                            {fmtMoney(t.to)} · {fmtDay(t.date)}
                          </div>
                          <div>
                            {fmtNum(t.beforePerWeek)} → <span className="font-semibold">{fmtNum(t.afterPerWeek)}</span>
                            <span className="text-xs text-muted"> leads / wk</span>
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {a.units.every((u) => u.listedOn === null) && (
            <p className="mt-2 text-xs text-muted">
              Price, listed date, days on market and the price-change effect fill in once the agent sends its
              listings.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- account view

const ROW_ICONS = {
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  mail: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </>
  ),
  bars: <path d="M6 20v-6M12 20V4M18 20v-10" />,
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </>
  ),
} as const;

/** A supporting table: one closed row that opens to show the detail. */
function Row({
  icon,
  title,
  sub,
  count,
  children,
}: {
  icon: keyof typeof ROW_ICONS;
  title: string;
  sub: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group/row border-t border-stone/30">
      <summary className="flex cursor-pointer select-none list-none items-center gap-3 py-3 transition hover:text-accent-text [&::-webkit-details-marker]:hidden">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cream text-ink">
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            {ROW_ICONS[icon]}
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-ink">{title}</span>
          <span className="block truncate text-sm text-muted">{sub}</span>
        </span>
        <span className="shrink-0 text-sm tabular-nums text-muted">{count}</span>
        <span className="shrink-0 text-muted transition-transform group-open/row:rotate-90" aria-hidden>
          ›
        </span>
      </summary>
      <div className="pb-5 pt-1">{children}</div>
    </details>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * One account (or the summary of all) as one card: every KPI in a row on
 * top, the per-day graph, the unit-wise table, then the lists (waiting on
 * us, never answered, day by day), each closed until opened.
 */
function AccountCard({
  a,
  prev,
  bounds,
  trends,
  buildingOf,
}: {
  a: AccountKpis;
  prev: AccountKpis | undefined;
  bounds: Bounds;
  trends: Trend[];
  buildingOf: BuildingOf;
}) {
  const overall = !!a.byAccount;
  // On the summary, say whose thread each row is.
  const who = (account: string) =>
    overall ? <span className="text-accent-text"> · {account}</span> : null;
  // Only compare against a previous period that actually has data.
  const p = prev && prev.daysWithData > 0 ? prev : undefined;
  const oldestWait = a.waitingOnUs[0]?.days_waiting ?? null;

  return (
    <section className={`${CARD} p-6 ${overall ? "ring-2 ring-accent/50" : ""}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xl font-semibold text-ink">
          {a.accountName}
          {overall && (
            <span className="font-display text-2xl font-normal italic text-accent-text">
              {" "}
              · {a.byAccount!.length} account{a.byAccount!.length === 1 ? "" : "s"} combined
            </span>
          )}
          {!overall && a.platforms.length > 0 && (
            <span className="font-display text-2xl font-normal italic text-accent-text">
              {" "}
              · {a.platforms.join(", ")}
            </span>
          )}
        </h3>
        <p className="text-xs text-muted">
          {a.firstDay && a.lastDay
            ? `Data ${fmtDayYear(a.firstDay)} – ${fmtDayYear(a.lastDay)} · ${a.daysWithData} day${a.daysWithData === 1 ? "" : "s"}`
            : "No days in this range"}
          {" · via "}
          {a.agents.join(", ")}
          {a.lastReceivedAt && <> · updated {fmtUpdated(a.lastReceivedAt)}</>}
        </p>
      </header>

      {/* Every KPI, one row. Each figure carries a left rule; the first column's is clipped away. */}
      <div className="mt-5 overflow-hidden">
        <div className="-ml-[17px] grid grid-cols-2 gap-y-5 sm:grid-cols-4 xl:grid-cols-8">
          <Stat
            label="Leads received"
            value={fmtNum(a.totalLeads)}
            hint={leadsPerDay(a) !== null ? `${fmtNum(leadsPerDay(a))} per day` : undefined}
            change={delta(a.totalLeads, p?.totalLeads, "pct", true)}
          />
          <Stat
            label="First reply"
            value={fmtNum(a.firstReplyHours, " h")}
            hint={a.firstReplyHours === null ? "not reported" : "average wait"}
            change={delta(a.firstReplyHours, p?.firstReplyHours, "abs", false, " h")}
          />
          <Stat
            label="Replies / day"
            value={fmtNum(a.repliesPerDay)}
            change={delta(a.repliesPerDay, p?.repliesPerDay, "pct", true)}
          />
          <Stat
            label="Rejected"
            value={fmtNum(a.rejected)}
            hint={a.rejected !== null ? `${fmtNum(a.workableLeads)} left to work` : "after vetting"}
            change={delta(a.rejected, p?.rejected, "abs", false)}
          />
          <Stat
            label="Handed over"
            value={fmtNum(a.handoffRate, "%")}
            hint={a.handoffs !== null ? `${a.handoffs} of ${fmtNum(a.workableLeads)} to work` : "sent Vinny's number"}
            change={delta(a.handoffRate, p?.handoffRate, "pts", true)}
          />
          <Stat
            label="Follow-up rate"
            value={fmtNum(a.followUpRate, "%")}
            hint={a.followedUp !== null ? `${a.followedUp} of ${fmtNum(a.workableLeads)} to work` : undefined}
            change={delta(a.followUpRate, p?.followUpRate, "pts", true)}
          />
          <Stat
            label="Never answered"
            value={fmtNum(a.neverAnswered)}
            hint={
              a.neverAnswered !== null && a.workableLeads > 0
                ? `${Math.round((a.neverAnswered / a.workableLeads) * 100)}% of leads to work`
                : undefined
            }
            change={delta(a.neverAnswered, p?.neverAnswered, "abs", false)}
            alert={(a.neverAnswered ?? 0) > 0}
          />
          <Stat
            label="Waiting on us"
            value={fmtNum(a.waitingOnUs.length)}
            hint={oldestWait !== null ? `oldest ${fmtNum(oldestWait)} days` : "all caught up"}
            alert={(oldestWait ?? 0) >= 2}
          />
        </div>
      </div>

      {/* The graph */}
      <div className="mt-6 border-t border-stone/30 pt-6">
        {a.daily.length === 0 ? (
          <>
            <h4 className="text-lg font-semibold text-ink">Lead volume</h4>
            <p className="mt-1 text-sm text-muted">No days in this range.</p>
          </>
        ) : (
          <SalesKpiChart daily={a.daily} from={bounds.from} to={bounds.to} />
        )}
      </div>

      {/* Unit-wise KPIs */}
      <div className="mt-6 border-t border-stone/30 pt-6">
        <UnitTable a={a} trends={trends} buildingOf={buildingOf} />
      </div>

      {/* Lists, closed until needed */}
      <div className="mt-6">
        <Row
          icon="list"
          title="Waiting on us"
          sub="Renters who last wrote in these dates and have no reply, longest wait first"
          count={plural(a.waitingOnUs.length, "lead")}
        >
          {a.waitingOnUs.length === 0 ? (
            <p className="text-sm text-muted">Nobody waiting.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-stone/30 overflow-y-auto pr-1">
              {a.waitingOnUs.map((w, i) => (
                <li key={i} className="flex items-center gap-3 py-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cream text-xs font-semibold text-ink">
                    {initials(w.lead)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink">
                      {w.lead}
                      {who(w.account)}
                    </span>
                    <span className="block truncate text-sm text-muted">{w.address ?? "No ad on the thread"}</span>
                  </span>
                  <span
                    className={`shrink-0 text-sm font-medium tabular-nums ${
                      w.days_waiting >= 2 ? "text-red-800" : "text-accent-text"
                    }`}
                  >
                    {fmtNum(w.days_waiting)}d waiting
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Row>

        <Row
          icon="calendar"
          title="Day by day"
          sub="Every day's numbers, best and slowest days, and the weekday pattern"
          count={plural(a.daily.length, "day")}
        >
          {a.daily.length === 0 ? (
            <p className="text-sm text-muted">No days in this range.</p>
          ) : (
            <>
              <DayInsights a={a} />
              <DayTable a={a} />
            </>
          )}
        </Row>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- shell

/** The page body: each block below is its own card on the page background. */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mt-6">{children}</div>;
}

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <p
      className={`rounded-xl p-4 text-sm shadow-sm ring-1 ${
        error ? "bg-red-50 text-red-800 ring-red-200" : "bg-white text-muted ring-stone/40"
      }`}
    >
      {children}
    </p>
  );
}

/**
 * Sales KPIs panel, the body of /kpis (the page checks the 'sales_kpis'
 * permission; RLS enforces it too). Filters come from the k_*
 * URL params, else the user's saved default, else the built-in default.
 * Built for judging the team and the days: every tile shows its change vs
 * the previous equally long period, each account gets a per-day chart with
 * weekday averages and a day-by-day table, and with several accounts a
 * comparison table ranks them side by side. A load failure is shown in the
 * panel rather than thrown.
 */
export async function SalesKpis({ params }: { params: Params }) {
  const supabase = await createClient();
  const user = await getSessionUser();

  const { data: pref, error: prefError } = user
    ? await supabase.from("sales_kpi_prefs").select("filters").eq("user_id", user.id).maybeSingle()
    : { data: null, error: null };
  const savedDefault = pref ? normalizeFilters(pref.filters) : { ...BUILTIN_FILTERS };
  const filters = hasKpiParams(params) ? filtersFromParams(params) : savedDefault;
  const bounds = rangeBounds(filters, todayISO());
  const prevBounds = previousBounds(bounds);

  // Every account on file feeds the filter options; the cards use the filtered subset.
  const { data: allStreams, error: streamError } = await supabase
    .from("sales_kpi_streams")
    .select("account_key, account_name, platform, agent, waiting_on_us, never_answered_leads, listings, open_as_of, last_received_at")
    .order("account_key");

  const error = prefError?.message ?? streamError?.message;
  if (error || !allStreams)
    return <Shell><Notice error>Couldn&apos;t load sales KPIs: {error ?? "no data"}</Notice></Shell>;

  // Ads show a street address but not the building or unit, so the street
  // address is the record; our buildings are matched to it by street name.
  const { data: propRows, error: propError } = await supabase
    .from("properties")
    .select("building_name, street_address");
  if (propError || !propRows)
    return (
      <Shell>
        <Notice error>Couldn&apos;t load buildings to match addresses: {propError?.message ?? "no data"}</Notice>
      </Shell>
    );
  const resolve = inventoryResolver();
  const buildingOf = streetBuildings(propRows);

  // "all" and OVERALL both span every account; anything else is one account.
  const oneAccount = filters.account !== "all" && filters.account !== OVERALL;
  const matches = (s: { account_key: string; platform: string; agent: string }) =>
    (!oneAccount || s.account_key === filters.account) &&
    (filters.platform === "all" || s.platform === filters.platform) &&
    (filters.agent === "all" || s.agent === filters.agent);
  const streams = allStreams.filter(matches).map((s) => resolveStreamRow(s, resolve));

  // One read covers the range and the period before it (for the deltas).
  const loaded: DayRow[] = [];
  const loadFrom = prevBounds?.from ?? bounds.from;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("sales_kpi_days")
      .select("account_key, account_name, platform, agent, day, leads, first_reply_hours, replies_sent, handoffs, followed_up, never_answered, rejected, leads_by_address")
      .order("day")
      .order("id")
      .range(from, from + PAGE - 1);
    if (oneAccount) q = q.eq("account_key", filters.account);
    if (filters.platform !== "all") q = q.eq("platform", filters.platform);
    if (filters.agent !== "all") q = q.eq("agent", filters.agent);
    if (loadFrom) q = q.gte("day", loadFrom);
    if (bounds.to) q = q.lte("day", bounds.to);
    const { data, error: dayError } = await q;
    if (dayError)
      return <Shell><Notice error>Couldn&apos;t load sales KPIs: {dayError.message}</Notice></Shell>;
    loaded.push(...data.map((d) => resolveDayRow(d, resolve)));
    if (data.length < PAGE) break;
  }
  const days = bounds.from ? loaded.filter((d) => d.day >= bounds.from!) : loaded;
  const prevDays = prevBounds ? loaded.filter((d) => d.day <= prevBounds.to) : [];

  const summary = filters.account === OVERALL;
  // Per-account cards always exist (the comparison table needs them); the
  // Summary view shows the composite instead of the cards.
  const today = todayISO();
  const cards = aggregateByAccount(days, streams, bounds, { today });
  const overall = summary ? aggregateByAccount(days, streams, bounds, { combine: true, today })[0] ?? null : null;

  // Demand after a price change looks 4 weeks either side of each change,
  // whatever date range is on screen, so it gets its own read.
  const withChanges = streams
    .map((s) => ({ s, listings: parseList(ListingSchema, s.listings).filter((l) => l.price_changes?.length) }))
    .filter((x) => x.listings.length > 0);
  const trendsByAccount = new Map<string, Trend[]>();
  if (withChanges.length > 0) {
    const dates = withChanges.flatMap((x) => x.listings.flatMap((l) => l.price_changes!.map((c) => c.date))).sort();
    const trendDays: (Pick<DayRow, "account_key" | "platform" | "agent" | "day" | "leads_by_address">)[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error: trendError } = await supabase
        .from("sales_kpi_days")
        .select("account_key, platform, agent, day, leads_by_address")
        .in("account_key", [...new Set(withChanges.map((x) => x.s.account_key))])
        .gte("day", addDaysISO(dates[0], -TREND_WINDOW_DAYS))
        .lte("day", addDaysISO(dates.at(-1)!, TREND_WINDOW_DAYS))
        .order("day")
        .order("id")
        .range(from, from + PAGE - 1);
      if (trendError)
        return <Shell><Notice error>Couldn&apos;t load sales KPIs: {trendError.message}</Notice></Shell>;
      trendDays.push(...data.map((d) => resolveDayRow(d, resolve)));
      if (data.length < PAGE) break;
    }
    for (const { s, listings } of withChanges) {
      const own = trendDays.filter(
        (d) => d.account_key === s.account_key && d.platform === s.platform && d.agent === s.agent,
      );
      const list = trendsByAccount.get(s.account_key) ?? [];
      list.push(...priceChangeTrends(listings, own, today).map((t) => ({ ...t, account: s.account_name })));
      trendsByAccount.set(s.account_key, list);
    }
  }
  const allTrends = [...trendsByAccount.values()].flat().sort((a, b) => b.date.localeCompare(a.date));
  // Previous period: no streams, so its "right now" lists stay out of it.
  const prevCards = new Map(
    (prevBounds ? aggregateByAccount(prevDays, [], prevBounds) : []).map((a) => [a.accountKey, a]),
  );
  const prevOverall =
    prevBounds && summary ? (aggregateOverall(prevDays, [], prevBounds) ?? undefined) : undefined;

  const rangeLabel = RANGES.find((r) => r.key === filters.range)?.label ?? "";
  const accountOptions = [
    ...new Map(allStreams.map((s) => [s.account_key, { key: s.account_key, name: s.account_name }])).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
  // Keep a saved/URL account that has since vanished selectable, so the select doesn't lie.
  if (oneAccount && !accountOptions.some((a) => a.key === filters.account))
    accountOptions.push({ key: filters.account, name: filters.account });

  return (
    <Shell>
      {allStreams.length === 0 ? (
        <Notice>
          No KPIs yet — the sales agents post them to <code>/api/sales-kpis</code>.
        </Notice>
      ) : (
        <>
          <div className={`${CARD} px-4 pb-3 pt-1`}>
          <SalesKpiFilters
            filters={filters}
            savedDefault={savedDefault}
            accounts={accountOptions}
            platforms={[...new Set(allStreams.map((s) => s.platform))].sort()}
            agents={[...new Set(allStreams.map((s) => s.agent))].sort()}
          />
          <p className="mt-2 text-xs text-muted">
            Showing <span className="font-medium text-ink">{rangeLabel}</span>
            {bounds.from && bounds.to && (
              <>
                {" "}
                ({bounds.from === bounds.to ? fmtDayYear(bounds.from) : `${fmtDay(bounds.from)} – ${fmtDayYear(bounds.to)}`})
              </>
            )}
          </p>
          </div>
          {cards.length === 0 ? (
            <div className="mt-4">
              <Notice>Nothing matches these filters.</Notice>
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {overall && (
                <AccountCard a={overall} prev={prevOverall} bounds={bounds} trends={allTrends} buildingOf={buildingOf} />
              )}
              {!summary &&
                cards.map((a) => (
                  <AccountCard
                    key={a.accountKey}
                    a={a}
                    prev={prevCards.get(a.accountKey)}
                    bounds={bounds}
                    trends={trendsByAccount.get(a.accountKey) ?? []}
                    buildingOf={buildingOf}
                  />
                ))}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
