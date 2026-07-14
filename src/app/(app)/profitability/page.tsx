import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canViewProfitability } from "@/lib/access";
import { todayISO } from "@/lib/date";
import {
  loadProfitability,
  profitUnitLabel,
  PROFIT_MONTHS,
  type ProfitCell,
} from "@/lib/profitability";
import { deleteLineItem } from "./actions";
import { LineItemForm } from "./line-item-form";
import { NetProfitChart, RevenueExpenseChart } from "./charts";

export const dynamic = "force-dynamic";

// Mirrors the operator's "Profitability <year>" workbook: one grid per
// metric — units down, Jan–Dec across (grouped by quarter) with a year
// Total — switched by pill tabs. Profit is the derived view.

type PageProps = {
  searchParams: Promise<{ year?: string; view?: string }>;
};

const MONTHS = PROFIT_MONTHS;

const VIEWS = [
  { key: "summary", label: "Summary" },
  { key: "profit", label: "Profit" },
  { key: "collection", label: "Rent Collection" },
  { key: "rent_paid", label: "Rent Paid" },
  { key: "utilities", label: "Utilities" },
  { key: "internet", label: "Internet" },
  { key: "cleaning", label: "Cleaning" },
  { key: "amenity", label: "Amenity Fees" },
  { key: "misc", label: "Misc Fees" },
  { key: "insurance", label: "Insurance" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];
type MetricKey = Exclude<ViewKey, "summary">;

/** One metric cell: null = no data / out of lease; estimated = ~ prefix. */
type Cell = ProfitCell;

type UnitGrid = {
  id: string;
  label: string;
  cells: Cell[]; // 12 entries
  total: number | null;
};

function fmtMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

export default async function ProfitabilityPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canViewProfitability(user?.email)) notFound();

  const sp = await searchParams;
  const today = todayISO();
  const currentYear = Number(today.slice(0, 4));
  const year = /^\d{4}$/.test(sp.year ?? "")
    ? Number(sp.year)
    : currentYear;
  const view: ViewKey = (VIEWS.find((v) => v.key === sp.view)?.key ??
    "summary") as ViewKey;

  // All figures come from the shared computation (also behind the Telegram
  // bot's get_profitability), so every consumer always agrees.
  const data = await loadProfitability(supabase, year, today);
  const props = data.units;
  const {
    monthlyRevenue,
    monthlyExpenses,
    monthlyNet,
    expenseSeries,
    unitRevenueYear,
    revenueItems,
    expenseItems,
    totalRevenue,
    totalExpenses,
    netTotal,
  } = data.summary;

  // The per-unit grid renders every non-summary view; Summary derives its
  // series from the same builders so both always agree.
  const metric: MetricKey = view === "summary" ? "profit" : view;

  const grid: UnitGrid[] = props.map((p) => {
    const build = data.cellFor(metric, p);
    const cells = MONTHS.map((_, m) => build(m));
    const present = cells.filter((c): c is NonNullable<Cell> => c !== null);
    return {
      id: p.id,
      label: profitUnitLabel(p),
      cells,
      total:
        present.length > 0
          ? present.reduce((s, c) => s + c.value, 0)
          : null,
    };
  });

  // Column totals (footer), summed over units with data in that month.
  const columnTotals: (number | null)[] = MONTHS.map((_, m) => {
    const vals = grid.map((r) => r.cells[m]).filter((c): c is NonNullable<Cell> => c !== null);
    return vals.length > 0 ? vals.reduce((s, c) => s + c.value, 0) : null;
  });
  const grandTotal = grid.reduce((s, r) => s + (r.total ?? 0), 0);
  const anyEstimates = grid.some((r) => r.cells.some((c) => c?.estimated));

  const isProfit = view === "profit";
  const valueCls = (c: NonNullable<Cell>) =>
    c.estimated
      ? "text-accent-text"
      : isProfit && c.value < -0.005
        ? "text-red-700"
        : isProfit && c.value > 0.005
          ? "text-green-800"
          : "text-ink";

  return (
    <div className="mx-auto w-full max-w-none">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone/60 pb-6">
        <div>
          <h1 className="text-3xl tracking-tight text-ink">
            Unit{" "}
            <span className="font-display text-accent-text">profitability</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Units by month, one grid per metric — profit is revenue collected
            minus rent paid, utilities, internet, cleaning, amenity, misc, and
            insurance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/profitability?year=${year - 1}&view=${view}`}
            aria-label="Previous year"
            className="rounded-full border border-stone bg-white px-3 py-1.5 text-sm text-ink hover:bg-warm"
          >
            ←
          </Link>
          <span className="min-w-16 text-center text-sm font-medium text-ink">
            {year}
          </span>
          {year < currentYear ? (
            <Link
              href={`/profitability?year=${year + 1}&view=${view}`}
              aria-label="Next year"
              className="rounded-full border border-stone bg-white px-3 py-1.5 text-sm text-ink hover:bg-warm"
            >
              →
            </Link>
          ) : (
            <span className="rounded-full border border-stone/40 bg-white px-3 py-1.5 text-sm text-muted/50">
              →
            </span>
          )}
        </div>
      </header>

      <nav className="mt-6 flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={`/profitability?year=${year}&view=${v.key}`}
            className={
              v.key === view
                ? "rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-white"
                : "rounded-full border border-stone bg-white px-4 py-1.5 text-sm text-ink hover:bg-warm"
            }
          >
            {v.label}
          </Link>
        ))}
      </nav>

      {view === "summary" && (
        <>
          <section className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl bg-white p-6 shadow-sm">
              <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
                {year} summary
              </h2>
              <table className="mt-4 w-full text-sm">
                <tbody>
                  <tr>
                    <td className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted" colSpan={3}>
                      Revenue
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-ink">Rent collection (units)</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">
                      {fmtMoney(unitRevenueYear)}
                    </td>
                    <td className="w-8" />
                  </tr>
                  {revenueItems.map((i) => (
                    <tr key={i.id}>
                      <td className="py-1.5 text-ink">{i.label}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink">
                        {fmtMoney(Number(i.amount))}
                      </td>
                      <td className="w-8 text-right">
                        <form action={deleteLineItem}>
                          <input type="hidden" name="id" value={i.id} />
                          <button
                            type="submit"
                            aria-label={`Delete ${i.label}`}
                            title="Delete line item"
                            className="rounded-full px-1.5 text-muted hover:text-red-700"
                          >
                            ×
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-stone/40 font-semibold">
                    <td className="py-2 text-ink">Total revenue</td>
                    <td className="py-2 text-right tabular-nums text-ink">
                      {fmtMoney(totalRevenue)}
                    </td>
                    <td />
                  </tr>

                  <tr>
                    <td className="pt-4 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted" colSpan={3}>
                      Expenses
                    </td>
                  </tr>
                  {expenseSeries.map((e) => (
                    <tr key={e.key}>
                      <td className="py-1.5 text-ink">{e.label}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink">
                        {fmtMoney(e.yearly)}
                      </td>
                      <td />
                    </tr>
                  ))}
                  {expenseItems.map((i) => (
                    <tr key={i.id}>
                      <td className="py-1.5 text-ink">{i.label}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink">
                        {fmtMoney(Number(i.amount))}
                      </td>
                      <td className="w-8 text-right">
                        <form action={deleteLineItem}>
                          <input type="hidden" name="id" value={i.id} />
                          <button
                            type="submit"
                            aria-label={`Delete ${i.label}`}
                            title="Delete line item"
                            className="rounded-full px-1.5 text-muted hover:text-red-700"
                          >
                            ×
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-stone/40 font-semibold">
                    <td className="py-2 text-ink">Total expenses</td>
                    <td className="py-2 text-right tabular-nums text-ink">
                      {fmtMoney(totalExpenses)}
                    </td>
                    <td />
                  </tr>

                  <tr className="border-t-2 border-stone/60 text-base font-semibold">
                    <td className="py-3 text-ink">Net profit</td>
                    <td
                      className={`py-3 text-right tabular-nums ${
                        netTotal < -0.005 ? "text-red-700" : "text-green-800"
                      }`}
                    >
                      {fmtMoney(netTotal)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>

              <div className="mt-5 border-t border-stone/40 pt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                  Add a line item ({year})
                </p>
                <LineItemForm year={year} />
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="rounded-2xl bg-white p-6 shadow-sm">
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
                  Revenue vs expenses by month
                </h2>
                <div className="mt-4">
                  <RevenueExpenseChart
                    revenue={monthlyRevenue}
                    expenses={monthlyExpenses}
                  />
                </div>
              </div>
              <div className="rounded-2xl bg-white p-6 shadow-sm">
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
                  Net profit by month
                </h2>
                <div className="mt-4">
                  <NetProfitChart net={monthlyNet} />
                </div>
              </div>
            </div>
          </section>
          <p className="mt-4 max-w-4xl text-xs text-muted">
            Unit figures come from the metric tabs (utility months without a
            bill use similar-unit averages). Manual line items are yearly
            amounts and count toward the totals and net profit here; the
            monthly charts show unit-derived figures only.
          </p>
        </>
      )}

      {view !== "summary" && (
      <>
      <section className="mt-6 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="bg-warm/60">
              <th className="rounded-tl-2xl px-4 py-2" />
              {[1, 2, 3, 4].map((q) => (
                <th key={q} colSpan={3} className="px-3 py-2 text-center font-medium">
                  Q{q} {year}
                </th>
              ))}
              <th className="rounded-tr-2xl px-4 py-2" />
            </tr>
            <tr className="bg-warm">
              <th className="sticky left-0 z-10 bg-warm px-4 py-2.5 text-left font-medium">
                Unit
              </th>
              {MONTHS.map((mo) => (
                <th key={mo} className="px-3 py-2.5 text-right font-medium">
                  {mo}
                </th>
              ))}
              <th className="px-4 py-2.5 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {grid.map((r) => (
              <tr key={r.id} className="border-t border-stone/40">
                <td className="sticky left-0 z-10 max-w-52 truncate bg-white px-4 py-3">
                  <Link
                    href={`/properties/${r.id}`}
                    className="text-ink hover:text-accent-text"
                    title={r.label}
                  >
                    {r.label}
                  </Link>
                </td>
                {r.cells.map((c, m) => (
                  <td
                    key={m}
                    className="px-3 py-3 text-right tabular-nums"
                    title={c?.estimated ? "Estimated — average of similar units" : undefined}
                  >
                    {c === null ? (
                      <span className="text-muted/40">—</span>
                    ) : (
                      <span className={valueCls(c)}>
                        {c.estimated ? "~" : ""}
                        {fmtMoney(c.value)}
                      </span>
                    )}
                  </td>
                ))}
                <td
                  className={`px-4 py-3 text-right font-semibold tabular-nums ${
                    r.total !== null && isProfit
                      ? r.total < -0.005
                        ? "text-red-700"
                        : "text-green-800"
                      : "text-ink"
                  }`}
                >
                  {r.total !== null ? fmtMoney(r.total) : "—"}
                </td>
              </tr>
            ))}
            {grid.length === 0 && (
              <tr>
                <td colSpan={14} className="px-4 py-12 text-center text-muted">
                  No properties yet.
                </td>
              </tr>
            )}
          </tbody>
          {grid.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-stone/60 bg-warm/40 font-semibold">
                <td className="sticky left-0 z-10 rounded-bl-2xl bg-warm/40 px-4 py-3 text-ink backdrop-blur">
                  Total
                </td>
                {columnTotals.map((t, m) => (
                  <td
                    key={m}
                    className={`px-3 py-3 text-right tabular-nums ${
                      t !== null && isProfit
                        ? t < -0.005
                          ? "text-red-700"
                          : "text-green-800"
                        : "text-ink"
                    }`}
                  >
                    {t !== null ? fmtMoney(t) : ""}
                  </td>
                ))}
                <td
                  className={`rounded-br-2xl px-4 py-3 text-right tabular-nums ${
                    isProfit
                      ? grandTotal < -0.005
                        ? "text-red-700"
                        : "text-green-800"
                      : "text-ink"
                  }`}
                >
                  {fmtMoney(grandTotal)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </section>

      <p className="mt-4 max-w-4xl text-xs text-muted">
        Rent Collection is every tenant payment dated in the month (security
        deposits excluded, refunds subtracted). Rent Paid, Internet, Cleaning,
        and Insurance are the unit&apos;s flat monthly figures; Amenity and
        Misc are the yearly figures ÷ 12 — all from the property&apos;s Edit
        page, and shown only for months inside the unit&apos;s lease window.
        {anyEstimates && (
          <>
            {" "}
            <span className="text-accent-text">~ amounts</span> are estimates:
            no utility bill for that unit that month, so it uses the average
            of similar units (same bedroom count).
          </>
        )}
      </p>
      </>
      )}
    </div>
  );
}
