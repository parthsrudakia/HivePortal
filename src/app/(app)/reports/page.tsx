import Link from "next/link";
import {
  getCollectionSummary,
  getMonthlyCollections,
  getPropertyCollections,
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

export default async function ReportsPage() {
  const [summary, monthly, byProperty] = await Promise.all([
    getCollectionSummary(),
    getMonthlyCollections(),
    getPropertyCollections(),
  ]);

  // Bar chart scale: highest expected across all months.
  const maxBar = Math.max(
    1,
    ...monthly.map((m) => Math.max(m.expected, m.collected)),
  );

  // Reverse so latest is first in the table.
  const monthlyDesc = [...monthly].reverse();

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

      <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="This month — collected"
          value={fmtMoney(summary.this_month.collected)}
          sub={`of ${fmtMoney(summary.this_month.expected)} expected`}
        />
        <Stat
          label="This month — outstanding"
          value={fmtMoney(summary.this_month.outstanding)}
          sub={fmtPct(summary.this_month.collected, summary.this_month.expected) + " collected"}
        />
        <Stat
          label="Year-to-date collected"
          value={fmtMoney(summary.ytd.collected)}
          sub={`of ${fmtMoney(summary.ytd.expected)} expected`}
        />
        <Stat
          label="All-time collected"
          value={fmtMoney(summary.lifetime.collected)}
          sub={`${summary.lifetime.payment_count.toLocaleString()} payments`}
        />
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
                    No payments recorded yet.
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
          Lifetime revenue by property
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
                    No rent payments yet.
                  </td>
                </tr>
              )}
              {byProperty.map((row, i) => {
                const share = summary.lifetime.collected > 0
                  ? row.collected / summary.lifetime.collected
                  : 0;
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
