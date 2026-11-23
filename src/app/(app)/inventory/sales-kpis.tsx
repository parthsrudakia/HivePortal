import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { todayISO } from "@/lib/date";
import {
  BUILTIN_FILTERS,
  OVERALL,
  RANGES,
  aggregateByAccount,
  aggregateOverall,
  filtersFromParams,
  hasKpiParams,
  normalizeFilters,
  previousBounds,
  rangeBounds,
  weekdayAverages,
  weekdayIndex,
  type AccountKpis,
  type DayRow,
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
    <div className={`rounded-lg px-3 py-2 ${alert ? "border border-red-200 bg-red-50" : "bg-cream"}`}>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tabular-nums text-ink">{value}</span>
        {change && (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
              change.good === null
                ? "bg-warm text-muted"
                : change.good
                  ? "bg-green-100 text-green-800"
                  : "bg-red-100 text-red-800"
            }`}
          >
            {change.text}
            <span className="sr-only">{change.good === null ? "" : change.good ? " (better)" : " (worse)"}</span>
          </span>
        )}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
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
    <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
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
    <details className="mt-4 rounded-lg bg-cream">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink">
        Day by day ({rows.length} day{rows.length === 1 ? "" : "s"})
      </summary>
      <div className="max-h-80 overflow-auto px-1 pb-2">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="sticky top-0 bg-cream text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Day</th>
              <th className={`${cell} font-medium`}>Leads</th>
              <th className={`${cell} font-medium`}>First reply</th>
              <th className={`${cell} font-medium`}>Replies</th>
              <th className={`${cell} font-medium`}>Handoffs</th>
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
                <td className={`${cell} text-ink`}>
                  {fmtNum(d.handoffs)}
                  {d.handoffs !== null && d.leads > 0 && (
                    <span className="text-muted"> · {Math.round((d.handoffs / d.leads) * 100)}%</span>
                  )}
                </td>
                <td className={`${cell} text-ink`}>
                  {fmtNum(d.followedUp)}
                  {d.followedUp !== null && d.leads > 0 && (
                    <span className="text-muted"> · {Math.round((d.followedUp / d.leads) * 100)}%</span>
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
    </details>
  );
}

// ---------------------------------------------------------------- account card

function AccountCard({
  a,
  prev,
  compare,
  bounds,
}: {
  a: AccountKpis;
  prev: AccountKpis | undefined;
  /** e.g. "previous 7 days"; null when the range has no previous period. */
  compare: string | null;
  bounds: Bounds;
}) {
  const overall = !!a.byAccount;
  // On the summary, say whose thread each row is.
  const who = (account: string) =>
    overall ? <span className="text-accent-text"> · {account}</span> : null;
  // Only compare against a previous period that actually has data.
  const p = prev && prev.daysWithData > 0 ? prev : undefined;
  const oldestWait = a.waitingOnUs[0]?.days_waiting ?? null;
  const maxAddr = Math.max(1, ...a.leadsByAddress.map((x) => x.leads));

  return (
    <article
      className={`rounded-xl bg-white p-4 shadow-sm ring-1 ${
        overall ? "ring-2 ring-accent/50" : "ring-stone/40"
      }`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-ink">
          {a.accountName}
          {overall && (
            <span className="font-display text-xl font-normal italic text-accent-text">
              {" "}
              · {a.byAccount!.length} account{a.byAccount!.length === 1 ? "" : "s"} combined
            </span>
          )}
          {!overall && a.platforms.length > 0 && (
            <span className="font-display text-xl font-normal italic text-accent-text">
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

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <Stat
          label="Leads received"
          value={fmtNum(a.totalLeads)}
          hint={leadsPerDay(a) !== null ? `${fmtNum(leadsPerDay(a))} per day` : undefined}
          change={delta(a.totalLeads, p?.totalLeads, "pct", true)}
        />
        <Stat
          label="First reply"
          value={fmtNum(a.firstReplyHours, " h")}
          hint="average wait"
          change={delta(a.firstReplyHours, p?.firstReplyHours, "abs", false, " h")}
        />
        <Stat
          label="Replies / day"
          value={fmtNum(a.repliesPerDay)}
          change={delta(a.repliesPerDay, p?.repliesPerDay, "pct", true)}
        />
        <Stat
          label="Handoff rate"
          value={fmtNum(a.handoffRate, "%")}
          hint={a.handoffs !== null ? `${a.handoffs} handed to Vinny` : "Handed to Vinny"}
          change={delta(a.handoffRate, p?.handoffRate, "pts", true)}
        />
        <Stat
          label="Follow-up rate"
          value={fmtNum(a.followUpRate, "%")}
          hint={a.followedUp !== null ? `${a.followedUp} followed up` : undefined}
          change={delta(a.followUpRate, p?.followUpRate, "pts", true)}
        />
        <Stat
          label="Never answered"
          value={fmtNum(a.neverAnswered)}
          hint={
            a.neverAnswered !== null && a.totalLeads > 0
              ? `${Math.round((a.neverAnswered / a.totalLeads) * 100)}% of leads`
              : undefined
          }
          change={delta(a.neverAnswered, p?.neverAnswered, "abs", false)}
          alert={(a.neverAnswered ?? 0) > 0}
        />
        <Stat
          label="Waiting on us now"
          value={fmtNum(a.waitingOnUs.length)}
          hint={oldestWait !== null ? `oldest ${fmtNum(oldestWait)} days` : "all caught up"}
          alert={(oldestWait ?? 0) >= 2}
        />
      </div>
      {compare && (
        <p className="mt-1.5 text-[11px] text-muted">
          {p
            ? `▲▼ change vs the ${compare}. Green = better, red = worse.`
            : `No data in the ${compare} to compare against.`}
        </p>
      )}

      <SalesKpiChart daily={a.daily} from={bounds.from} to={bounds.to} />
      <DayInsights a={a} />
      <DayTable a={a} />

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <h4 className="text-xs uppercase tracking-wide text-muted">
            Waiting on us <span className="text-ink">({a.waitingOnUs.length})</span>
          </h4>
          {a.waitingOnUs.length === 0 ? (
            <p className="mt-1 text-sm text-muted">Nobody waiting.</p>
          ) : (
            <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto pr-1 text-sm">
              {a.waitingOnUs.map((w, i) => (
                <li key={i} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-ink">
                    {w.lead}
                    {who(w.account)}
                    {w.address && <span className="text-muted"> · {w.address}</span>}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${
                      w.days_waiting >= 2 ? "bg-red-100 text-red-800" : "bg-warm text-ink"
                    }`}
                  >
                    {fmtNum(w.days_waiting)}d
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4 className="text-xs uppercase tracking-wide text-muted">
            Never answered <span className="text-ink">({a.neverAnsweredLeads.length})</span>
          </h4>
          {a.neverAnsweredLeads.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No names sent.</p>
          ) : (
            <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto pr-1 text-sm">
              {a.neverAnsweredLeads.map((n, i) => (
                <li key={i} className="truncate text-ink">
                  {n.lead}
                  {who(n.account)}
                  {n.address && <span className="text-muted"> · {n.address}</span>}
                  {n.received_at && (
                    <span className="text-muted"> · {fmtDay(n.received_at.slice(0, 10))}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4 className="text-xs uppercase tracking-wide text-muted">Leads per address</h4>
          {a.leadsByAddress.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No breakdown sent.</p>
          ) : (
            <ul className="mt-1 max-h-48 space-y-1.5 overflow-y-auto pr-1 text-sm">
              {a.leadsByAddress.map((x) => (
                <li key={x.address}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-ink">{x.address}</span>
                    <span className="shrink-0 font-semibold tabular-nums text-ink">{x.leads}</span>
                  </div>
                  <div className="mt-0.5 h-1 rounded-full bg-warm/60" aria-hidden>
                    <div
                      className="h-1 rounded-full bg-accent"
                      style={{ width: `${(x.leads / maxAddr) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- team comparison

/** Side-by-side accounts; ★ marks the best value in each column. */
function TeamTable({ cards }: { cards: AccountKpis[] }) {
  const cols: {
    label: string;
    get: (a: AccountKpis) => number | null;
    suffix?: string;
    lowerIsBetter?: boolean;
  }[] = [
    { label: "Leads", get: (a) => a.totalLeads },
    { label: "Leads / day", get: leadsPerDay },
    { label: "First reply", get: (a) => a.firstReplyHours, suffix: " h", lowerIsBetter: true },
    { label: "Replies / day", get: (a) => a.repliesPerDay },
    { label: "Handoff rate", get: (a) => a.handoffRate, suffix: "%" },
    { label: "Follow-up rate", get: (a) => a.followUpRate, suffix: "%" },
    { label: "Never answered", get: (a) => a.neverAnswered, lowerIsBetter: true },
    { label: "Waiting now", get: (a) => a.waitingOnUs.length, lowerIsBetter: true },
  ];
  const best = cols.map((c) => {
    const vals = cards.map(c.get).filter((v): v is number => v !== null);
    if (vals.length < 2) return null;
    const b = c.lowerIsBetter ? Math.min(...vals) : Math.max(...vals);
    // No star when everyone ties.
    return vals.every((v) => v === b) ? null : b;
  });
  const maxLeads = Math.max(1, ...cards.map((a) => a.totalLeads));
  const rows = [...cards].sort((a, b) => b.totalLeads - a.totalLeads);

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-stone/40">
      <h3 className="text-sm font-semibold text-ink">
        Team <span className="font-display text-lg font-normal italic text-accent-text">comparison</span>
      </h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Account</th>
              {cols.map((c) => (
                <th key={c.label} className="px-2 py-1 text-right font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.accountKey} className="border-t border-stone/30">
                <td className="px-2 py-1.5">
                  <div className="font-medium text-ink">{a.accountName}</div>
                  <div className="mt-1 h-1 w-28 rounded-full bg-warm/60" aria-hidden>
                    <div
                      className="h-1 rounded-full bg-accent"
                      style={{ width: `${(a.totalLeads / maxLeads) * 100}%` }}
                    />
                  </div>
                </td>
                {cols.map((c, i) => {
                  const v = c.get(a);
                  const isBest = v !== null && best[i] !== null && v === best[i];
                  return (
                    <td
                      key={c.label}
                      className={`px-2 py-1.5 text-right tabular-nums text-ink ${isBest ? "font-semibold" : ""}`}
                    >
                      {isBest && (
                        <span className="mr-1 text-accent-text" title="Best in this column">
                          ★<span className="sr-only">best</span>
                        </span>
                      )}
                      {fmtNum(v, c.suffix)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        ★ = best in that column (lowest for first reply, never answered and waiting). The bar under each
        name is its share of the top account&apos;s leads.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- shell

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h2 className="text-sm uppercase tracking-wide text-muted">
        Sales <span className="font-display text-base normal-case italic text-accent-text">KPIs</span>
      </h2>
      {children}
    </section>
  );
}

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <p
      className={`mt-2 rounded-xl bg-white p-4 text-sm shadow-sm ring-1 ${
        error ? "text-red-800 ring-red-200" : "text-muted ring-stone/40"
      }`}
    >
      {children}
    </p>
  );
}

/**
 * Sales KPIs panel at the top of /inventory (render only for users with the
 * 'sales_kpis' permission; RLS enforces it too). Filters come from the k_*
 * URL params, else the user's saved default, else the built-in default.
 * Built for judging the team and the days: every tile shows its change vs
 * the previous equally long period, each account gets a per-day chart with
 * weekday averages and a day-by-day table, and with several accounts a
 * comparison table ranks them side by side. A load failure is shown in the
 * panel instead of taking the inventory table down with it.
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
    .select("account_key, account_name, platform, agent, waiting_on_us, never_answered_leads, open_as_of, last_received_at")
    .order("account_key");

  const error = prefError?.message ?? streamError?.message;
  if (error || !allStreams)
    return <Shell><Notice error>Couldn&apos;t load sales KPIs: {error ?? "no data"}</Notice></Shell>;

  // "all" and OVERALL both span every account; anything else is one account.
  const oneAccount = filters.account !== "all" && filters.account !== OVERALL;
  const matches = (s: { account_key: string; platform: string; agent: string }) =>
    (!oneAccount || s.account_key === filters.account) &&
    (filters.platform === "all" || s.platform === filters.platform) &&
    (filters.agent === "all" || s.agent === filters.agent);
  const streams = allStreams.filter(matches);

  // One read covers the range and the period before it (for the deltas).
  const loaded: DayRow[] = [];
  const loadFrom = prevBounds?.from ?? bounds.from;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("sales_kpi_days")
      .select("account_key, account_name, platform, agent, day, leads, first_reply_hours, replies_sent, handoffs, followed_up, never_answered, leads_by_address")
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
    loaded.push(...data);
    if (data.length < PAGE) break;
  }
  const days = bounds.from ? loaded.filter((d) => d.day >= bounds.from!) : loaded;
  const prevDays = prevBounds ? loaded.filter((d) => d.day <= prevBounds.to) : [];

  const summary = filters.account === OVERALL;
  // Per-account cards always exist (the comparison table needs them); the
  // Summary view shows the composite instead of the cards.
  const cards = aggregateByAccount(days, streams, bounds);
  const overall = summary ? aggregateOverall(days, streams, bounds) : null;
  // Previous period: no streams, so its "right now" lists stay out of it.
  const prevCards = new Map(
    (prevBounds ? aggregateByAccount(prevDays, [], prevBounds) : []).map((a) => [a.accountKey, a]),
  );
  const prevOverall =
    prevBounds && summary ? (aggregateOverall(prevDays, [], prevBounds) ?? undefined) : undefined;

  const rangeLabel = RANGES.find((r) => r.key === filters.range)?.label ?? "";
  const compare = !prevBounds
    ? null
    : filters.range === "today"
      ? "day before"
      : filters.range === "yesterday"
        ? "day before that"
        : `previous ${prevBounds.days} day${prevBounds.days === 1 ? "" : "s"} (${fmtDay(prevBounds.from)} – ${fmtDay(prevBounds.to)})`;

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
          {cards.length === 0 ? (
            <Notice>Nothing matches these filters.</Notice>
          ) : (
            <div className="mt-3 space-y-3">
              {overall && (
                <AccountCard a={overall} prev={prevOverall} compare={compare} bounds={bounds} />
              )}
              {!oneAccount && cards.length > 1 && <TeamTable cards={cards} />}
              {!summary &&
                cards.map((a) => (
                  <AccountCard
                    key={a.accountKey}
                    a={a}
                    prev={prevCards.get(a.accountKey)}
                    compare={compare}
                    bounds={bounds}
                  />
                ))}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
