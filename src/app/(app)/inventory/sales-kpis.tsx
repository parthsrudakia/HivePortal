import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { todayISO } from "@/lib/date";
import {
  BUILTIN_FILTERS,
  OVERALL,
  aggregateByAccount,
  aggregateOverall,
  filtersFromParams,
  hasKpiParams,
  normalizeFilters,
  rangeBounds,
  type AccountKpis,
  type DayRow,
} from "@/lib/sales-kpis";
import { SalesKpiFilters } from "./sales-kpi-filters";

const NY = "America/New_York";
const PAGE = 1000;

type Params = Record<string, string | string[] | undefined>;

function fmtNum(n: number | null, suffix = "") {
  if (n === null) return "—";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
}

function fmtDay(d: string, withYear = false) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

function fmtUpdated(ts: string) {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: NY,
  });
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-cream px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-ink">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

/** Leads-per-day bars; weekly buckets once the range is long. */
function LeadsTrend({ daily }: { daily: AccountKpis["daily"] }) {
  if (daily.length < 2) return null;
  const weekly = daily.length > 120;
  const buckets: { label: string; leads: number }[] = [];
  for (const d of daily) {
    const label = weekly ? `wk of ${fmtDay(weekStart(d.day), true)}` : fmtDay(d.day, true);
    const last = buckets.at(-1);
    if (weekly && last?.label === label) last.leads += d.leads;
    else buckets.push({ label, leads: d.leads });
  }
  const max = Math.max(1, ...buckets.map((b) => b.leads));
  return (
    <div className="mt-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">
        Leads per {weekly ? "week" : "day"}
      </div>
      <div className="mt-1 flex h-12 items-end gap-px" role="img" aria-label={`Leads per ${weekly ? "week" : "day"}`}>
        {buckets.map((b, i) => (
          <div
            key={i}
            title={`${b.label}: ${b.leads} lead${b.leads === 1 ? "" : "s"}`}
            className="min-w-[2px] flex-1 rounded-t-sm bg-accent/70 hover:bg-accent"
            style={{ height: `${Math.max(4, (b.leads / max) * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function weekStart(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function AccountCard({ a }: { a: AccountKpis }) {
  const overall = !!a.byAccount;
  // On the composite, say whose thread each row is.
  const who = (account: string) =>
    overall ? <span className="text-accent-text"> · {account}</span> : null;
  return (
    <article
      className={`rounded-xl bg-white p-4 shadow-sm ring-1 ${
        overall ? "ring-2 ring-accent/50" : "ring-stone/40"
      }`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">
          {a.accountName}
          {overall && (
            <span className="font-display text-lg font-normal italic text-accent-text">
              {" "}
              · {a.byAccount!.length} account{a.byAccount!.length === 1 ? "" : "s"} combined
            </span>
          )}
          {!overall && a.platforms.length > 0 && (
            <span className="font-display text-lg font-normal italic text-accent-text">
              {" "}
              · {a.platforms.join(", ")}
            </span>
          )}
        </h3>
        <p className="text-xs text-muted">
          {a.firstDay && a.lastDay
            ? `${fmtDay(a.firstDay, true)} – ${fmtDay(a.lastDay, true)} · ${a.daysWithData} day${a.daysWithData === 1 ? "" : "s"}`
            : "No days in this range"}
          {" · via "}
          {a.agents.join(", ")}
          {a.lastReceivedAt && <> · updated {fmtUpdated(a.lastReceivedAt)}</>}
        </p>
      </header>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Leads received" value={fmtNum(a.totalLeads)} />
        <Stat label="First reply" value={fmtNum(a.firstReplyHours, " h")} hint="avg hours" />
        <Stat label="Replies / day" value={fmtNum(a.repliesPerDay)} />
        <Stat
          label="Handoff rate"
          value={fmtNum(a.handoffRate, "%")}
          hint={a.handoffs !== null ? `${a.handoffs} handed to Vinny` : "Handed to Vinny"}
        />
        <Stat
          label="Follow-up rate"
          value={fmtNum(a.followUpRate, "%")}
          hint={a.followedUp !== null ? `${a.followedUp} followed up` : undefined}
        />
        <Stat label="Never answered" value={fmtNum(a.neverAnswered)} />
      </div>

      <LeadsTrend daily={a.daily} />

      <div className={`mt-3 grid gap-3 ${overall ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-3"}`}>
        {overall && (
          <div>
            <h4 className="text-xs uppercase tracking-wide text-muted">Leads per account</h4>
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1 text-sm">
              {a.byAccount!.map((x) => (
                <li key={x.name} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-ink">{x.name}</span>
                  <span className="shrink-0 font-medium tabular-nums text-accent-text">{x.leads}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h4 className="text-xs uppercase tracking-wide text-muted">
            Waiting on us <span className="text-ink">({a.waitingOnUs.length})</span>
          </h4>
          {a.waitingOnUs.length === 0 ? (
            <p className="mt-1 text-sm text-muted">Nobody waiting.</p>
          ) : (
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1 text-sm">
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
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1 text-sm">
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
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1 text-sm">
              {a.leadsByAddress.map((x) => (
                <li key={x.address} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-ink">{x.address}</span>
                  <span className="shrink-0 font-medium tabular-nums text-accent-text">{x.leads}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </article>
  );
}

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
 * A load failure is shown in the panel instead of taking the inventory
 * table down with it.
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

  // Every account on file feeds the filter options; the cards use the filtered subset.
  const { data: allStreams, error: streamError } = await supabase
    .from("sales_kpi_streams")
    .select("account_key, account_name, platform, agent, waiting_on_us, never_answered_leads, open_as_of, last_received_at")
    .order("account_key");

  const error = prefError?.message ?? streamError?.message;
  if (error || !allStreams) return <Shell><Notice error>Couldn&apos;t load sales KPIs: {error ?? "no data"}</Notice></Shell>;

  // "all" and OVERALL both span every account; anything else is one account.
  const oneAccount = filters.account !== "all" && filters.account !== OVERALL;
  const matches = (s: { account_key: string; platform: string; agent: string }) =>
    (!oneAccount || s.account_key === filters.account) &&
    (filters.platform === "all" || s.platform === filters.platform) &&
    (filters.agent === "all" || s.agent === filters.agent);
  const streams = allStreams.filter(matches);

  const days: DayRow[] = [];
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
    if (bounds.from) q = q.gte("day", bounds.from);
    if (bounds.to) q = q.lte("day", bounds.to);
    const { data, error: dayError } = await q;
    if (dayError)
      return <Shell><Notice error>Couldn&apos;t load sales KPIs: {dayError.message}</Notice></Shell>;
    days.push(...data);
    if (data.length < PAGE) break;
  }

  // Summary = every account combined into one card; "all" = one card per account.
  const overall = filters.account === OVERALL ? aggregateOverall(days, streams, bounds) : null;
  const cards = filters.account === OVERALL ? [] : aggregateByAccount(days, streams, bounds);
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
          {!overall && cards.length === 0 ? (
            <Notice>Nothing matches these filters.</Notice>
          ) : (
            <div className="mt-3 space-y-6">
              {overall && (
                <div>
                  <h3 className="mb-2 text-xs uppercase tracking-wide text-muted">Summary</h3>
                  <AccountCard a={overall} />
                </div>
              )}
              {cards.length > 0 && (
                <div>
                  {overall && (
                    <h3 className="mb-2 text-xs uppercase tracking-wide text-muted">
                      By account
                    </h3>
                  )}
                  <div className="space-y-3">
                    {cards.map((a) => (
                      <AccountCard key={a.accountKey} a={a} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
