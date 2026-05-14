import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import {
  getCollectionSummary,
  getMonthlyCollections,
  getPropertyCollections,
  getPropertyOptions,
} from "@/lib/analytics/collections";

export const dynamic = "force-dynamic";

function fmtMoney(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtPct(num: number, denom: number) {
  if (denom <= 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

function monthLabel(monthIso: string) {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function monthBoundsLocal(yyyymm: string): { start: string; end: string } {
  const [y, m] = yyyymm.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function isMonth(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}$/.test(s);
}

type SearchParams = Promise<{
  from?: string;
  to?: string;
  property?: string;
  neighborhood?: string;
}>;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isMaster(user?.email)) {
    redirect("/");
  }

  const sp = await searchParams;
  const fromMonth = isMonth(sp.from) ? sp.from : undefined;
  const toMonth = isMonth(sp.to) ? sp.to : undefined;
  const propertyParam =
    typeof sp.property === "string" && sp.property.length > 0
      ? sp.property
      : "";
  const neighborhoodParam =
    typeof sp.neighborhood === "string" && sp.neighborhood.length > 0
      ? sp.neighborhood
      : "";

  const propertyOptions = await getPropertyOptions();
  const neighborhoods = Array.from(
    new Set(
      propertyOptions
        .map((p) => p.neighborhood?.trim() || null)
        .filter((n): n is string => !!n),
    ),
  ).sort();

  let propertyIds: string[] | undefined;
  if (propertyParam) {
    propertyIds = [propertyParam];
  } else if (neighborhoodParam) {
    propertyIds = propertyOptions
      .filter((p) => p.neighborhood === neighborhoodParam)
      .map((p) => p.id);
  }

  const [summary, monthly, byProperty] = await Promise.all([
    getCollectionSummary(propertyIds),
    getMonthlyCollections(fromMonth, toMonth, propertyIds),
    getPropertyCollections(
      fromMonth ? monthBoundsLocal(fromMonth).start : undefined,
      toMonth ? monthBoundsLocal(toMonth).end : undefined,
      propertyIds,
    ),
  ]);

  // Bar chart scale: highest expected across all months.
  const maxBar = Math.max(
    1,
    ...monthly.map((m) => Math.max(m.expected, m.collected)),
  );

  // Reverse so latest is first in the table.
  const monthlyDesc = [...monthly].reverse();

  // Range totals (always reflect the filter selection).
  const rangeExpected = monthly.reduce((s, m) => s + m.expected, 0);
  const rangeCollected = monthly.reduce((s, m) => s + m.collected, 0);
  const rangeOutstanding = rangeExpected - rangeCollected;
  const rangeFrom = monthly[0]?.month;
  const rangeTo = monthly[monthly.length - 1]?.month;

  const hasFilter =
    !!fromMonth || !!toMonth || !!propertyParam || !!neighborhoodParam;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="border-b border-stone/60 pb-4">
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Reports</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Historic rent collection and analytics across your portfolio.
        </p>
      </header>

      <form
        method="get"
        className="mt-6 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone/40"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              From
            </span>
            <input
              type="month"
              name="from"
              defaultValue={fromMonth ?? ""}
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              To
            </span>
            <input
              type="month"
              name="to"
              defaultValue={toMonth ?? ""}
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              Neighborhood
            </span>
            <select
              name="neighborhood"
              defaultValue={neighborhoodParam}
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            >
              <option value="">All neighborhoods</option>
              {neighborhoods.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 lg:col-span-2">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              Property
            </span>
            <select
              name="property"
              defaultValue={propertyParam}
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            >
              <option value="">All properties</option>
              {propertyOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.neighborhood ? ` — ${p.neighborhood}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            className="rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-white transition hover:bg-accent-dark"
          >
            Apply
          </button>
          {hasFilter && (
            <Link
              href="/reports"
              className="text-xs uppercase tracking-wide text-muted hover:text-ink"
            >
              Clear filters
            </Link>
          )}
          {propertyParam && neighborhoodParam && (
            <span className="text-[11px] text-muted">
              Property overrides neighborhood
            </span>
          )}
        </div>
      </form>

      <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Range expected"
          value={fmtMoney(rangeExpected)}
          sub={
            rangeFrom && rangeTo
              ? `${monthLabel(rangeFrom)} → ${monthLabel(rangeTo)}`
              : "—"
          }
        />
        <Stat
          label="Range collected"
          value={fmtMoney(rangeCollected)}
          sub={`${fmtPct(rangeCollected, rangeExpected)} collection rate`}
        />
        <Stat
          label="Outstanding"
          value={fmtMoney(Math.max(0, rangeOutstanding))}
          sub={
            rangeOutstanding > 0
              ? "to be collected"
              : rangeExpected > 0
                ? "fully collected"
                : "—"
          }
        />
        <Stat
          label="All-time collected"
          value={fmtMoney(summary.lifetime.collected)}
          sub={`${summary.lifetime.payment_count.toLocaleString()} payments${propertyIds ? " (filtered)" : ""}`}
        />
      </section>

      <section className="mt-10">
        <h2 className="text-xs uppercase tracking-wide text-muted">
          Collection trend
        </h2>
        <CollectionChart data={monthly} />
      </section>

      <section className="mt-10">
        <h2 className="text-xs uppercase tracking-wide text-muted">
          Monthly collection
        </h2>
        <div className="mt-3 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
          <table className="w-full min-w-[800px] text-sm">
            <thead className="bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Month</th>
                <th className="px-3 py-2 text-right font-medium">Expected</th>
                <th className="px-3 py-2 text-right font-medium">Collected</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                <th className="px-3 py-2 font-medium">Bar</th>
              </tr>
            </thead>
            <tbody>
              {monthlyDesc.map((m, i) => {
                const expectedPct = (m.expected / maxBar) * 100;
                const collectedPct = (m.collected / maxBar) * 100;
                return (
                  <tr
                    key={m.month}
                    className={`border-t border-stone/30 ${i % 2 === 1 ? "bg-cream/40" : "bg-white"}`}
                  >
                    <td className="px-3 py-2 text-ink">{monthLabel(m.month)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {fmtMoney(m.expected)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {fmtMoney(m.collected)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {fmtPct(m.collected, m.expected)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {m.outstanding > 0 ? fmtMoney(m.outstanding) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="relative h-3 w-full rounded-full bg-warm/50">
                        <div
                          className="absolute inset-y-0 left-0 rounded-full bg-stone/60"
                          style={{ width: `${expectedPct}%` }}
                          title={`Expected: ${fmtMoney(m.expected)}`}
                        />
                        <div
                          className="absolute inset-y-0 left-0 rounded-full bg-accent"
                          style={{ width: `${collectedPct}%` }}
                          title={`Collected: ${fmtMoney(m.collected)}`}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {monthlyDesc.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-10 text-center text-sm text-muted"
                  >
                    No payments in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          <span className="mr-3">
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent align-middle" />
            Collected
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-stone/60 align-middle" />
            Expected
          </span>
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-xs uppercase tracking-wide text-muted">
          Revenue by property{hasFilter ? " (in range)" : " (lifetime)"}
        </h2>
        <div className="mt-3 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Property</th>
                <th className="px-3 py-2 text-right font-medium">Collected</th>
                <th className="px-3 py-2 font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {byProperty.length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-3 py-10 text-center text-sm text-muted"
                  >
                    No rent payments in this range.
                  </td>
                </tr>
              )}
              {byProperty.map((row, i) => {
                const totalCollected = byProperty.reduce(
                  (s, r) => s + r.collected,
                  0,
                );
                const share =
                  totalCollected > 0 ? row.collected / totalCollected : 0;
                return (
                  <tr
                    key={row.property_id}
                    className={`border-t border-stone/30 ${i % 2 === 1 ? "bg-cream/40" : "bg-white"}`}
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/properties/${row.property_id}`}
                        className="text-ink hover:text-accent-text"
                      >
                        {row.property_label}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {fmtMoney(row.collected)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="relative h-2 w-32 rounded-full bg-warm/50">
                          <div
                            className="absolute inset-y-0 left-0 rounded-full bg-accent"
                            style={{ width: `${Math.round(share * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted tabular-nums">
                          {Math.round(share * 100)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-8 text-xs text-muted">
        Numbers update in real time. AI agent: the same analytics are available
        via the <code>get_collection_summary</code>,{" "}
        <code>get_monthly_collections</code>, and{" "}
        <code>get_property_collections</code> tools.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 text-3xl font-light text-ink">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </div>
  );
}

type ChartRow = {
  month: string;
  expected: number;
  collected: number;
};

function CollectionChart({ data }: { data: ChartRow[] }) {
  if (data.length === 0) {
    return (
      <div className="mt-3 rounded-xl bg-white p-10 text-center text-sm text-muted shadow-sm ring-1 ring-stone/40">
        No data in this range.
      </div>
    );
  }

  const W = 800;
  const H = 240;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxY = Math.max(
    1,
    ...data.map((d) => Math.max(d.expected, d.collected)),
  );
  // Round the axis ceiling up to a nicer number.
  const niceMax = niceCeil(maxY);

  const n = data.length;
  // When there is only one point, center it; otherwise spread across innerW.
  const xAt = (i: number) =>
    n === 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW;
  const yAt = (v: number) => padT + innerH - (v / niceMax) * innerH;

  const expectedPath = buildPath(data.map((d, i) => [xAt(i), yAt(d.expected)]));
  const collectedPath = buildPath(
    data.map((d, i) => [xAt(i), yAt(d.collected)]),
  );
  const collectedArea = `${collectedPath} L ${xAt(n - 1)} ${padT + innerH} L ${xAt(0)} ${padT + innerH} Z`;

  // Y-axis ticks: 0, 1/2, max.
  const yTicks = [0, niceMax / 2, niceMax];

  // X-axis labels: show ~6 evenly spaced months max.
  const stride = Math.max(1, Math.ceil(n / 6));
  const xLabels = data
    .map((d, i) => ({ i, m: d.month }))
    .filter(({ i }) => i % stride === 0 || i === n - 1);

  return (
    <div className="mt-3 overflow-hidden rounded-xl bg-white p-4 shadow-sm ring-1 ring-stone/40">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label="Monthly rent collection chart"
      >
        {/* horizontal grid + Y labels */}
        {yTicks.map((v, idx) => {
          const y = yAt(v);
          return (
            <g key={idx}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="#e8e3db"
                strokeWidth={1}
              />
              <text
                x={padL - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-muted text-[10px]"
              >
                ${shortMoney(v)}
              </text>
            </g>
          );
        })}

        {/* collected area */}
        <path d={collectedArea} fill="rgba(212, 146, 11, 0.18)" />

        {/* expected line (dashed, muted) */}
        <path
          d={expectedPath}
          fill="none"
          stroke="#8a8378"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />

        {/* collected line (accent) */}
        <path
          d={collectedPath}
          fill="none"
          stroke="#d4920b"
          strokeWidth={2}
        />

        {/* data point markers + tooltip titles */}
        {data.map((d, i) => (
          <g key={d.month}>
            <circle
              cx={xAt(i)}
              cy={yAt(d.collected)}
              r={3}
              fill="#d4920b"
            >
              <title>{`${monthLabel(d.month)} · collected $${Math.round(d.collected).toLocaleString()} of $${Math.round(d.expected).toLocaleString()} expected`}</title>
            </circle>
          </g>
        ))}

        {/* X-axis month labels */}
        {xLabels.map(({ i, m }) => (
          <text
            key={m}
            x={xAt(i)}
            y={H - padB + 16}
            textAnchor="middle"
            className="fill-muted text-[10px]"
          >
            {shortMonth(m)}
          </text>
        ))}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm bg-accent" />
          Collected
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-[2px] w-3"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, #8a8378 0 4px, transparent 4px 8px)",
            }}
          />
          Expected
        </span>
      </div>
    </div>
  );
}

function buildPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");
}

function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const norm = n / pow;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * pow;
}

function shortMoney(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return Math.round(n).toString();
}

function shortMonth(monthIso: string): string {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}
