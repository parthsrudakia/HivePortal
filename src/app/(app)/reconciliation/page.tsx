import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/date";
import { RunRow } from "./run-row";

export const dynamic = "force-dynamic";

type Run = {
  id: string;
  month: string;
  total_expected: number | null;
  total_actual: number | null;
  match_count: number | null;
  mismatch_count: number | null;
  missing_count: number | null;
  created_at: string;
};

function fmtMoney(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function monthLabel(monthIso: string) {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export default async function ReconciliationListPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("reconciliation_runs")
    .select(
      "id, month, total_expected, total_actual, match_count, mismatch_count, missing_count, created_at",
    )
    .order("month", { ascending: false })
    .order("created_at", { ascending: false })
    .returns<Run[]>();

  const runs = data ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-6">
        <div>
          <h1 className="text-3xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Reconciliation</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Monthly rent reconciliation.
          </p>
        </div>
        <Link
          href="/reconciliation/new"
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
        >
          New run
        </Link>
      </header>

      {error && <p className="mt-6 text-sm text-red-700">{error.message}</p>}

      {runs.length === 0 && (
        <p className="mt-10 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          No reconciliation runs yet. Click <em>New run</em> to upload a month&apos;s
          bank statement.
        </p>
      )}

      {runs.length > 0 && (
        <section className="mt-8 overflow-hidden rounded-2xl bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">Month</th>
                <th className="px-5 py-3 text-right font-medium">Expected</th>
                <th className="px-5 py-3 text-right font-medium">Collected</th>
                <th className="px-5 py-3 text-right font-medium">Match / Mismatch / Missing</th>
                <th className="px-5 py-3 font-medium">Ran on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <RunRow key={r.id} href={`/reconciliation/${r.id}`}>
                  <td className="px-5 py-4 text-ink">{monthLabel(r.month)}</td>
                  <td className="px-5 py-4 text-right text-ink">
                    {fmtMoney(r.total_expected)}
                  </td>
                  <td className="px-5 py-4 text-right text-ink">
                    {fmtMoney(r.total_actual)}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <span className="text-green-700">{r.match_count ?? 0}</span>
                    <span className="text-muted"> / </span>
                    <span className="text-orange-700">{r.mismatch_count ?? 0}</span>
                    <span className="text-muted"> / </span>
                    <span className="text-red-700">{r.missing_count ?? 0}</span>
                  </td>
                  <td className="px-5 py-4 text-xs text-muted">
                    {formatDate(r.created_at)}
                  </td>
                  <td className="px-5 py-4 text-right text-xs uppercase tracking-wide text-muted" />
                </RunRow>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
