import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/date";
import { bankPayerNameDisplay } from "@/lib/reconciliation/parsers";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string; matchId: string }>;
};

type Run = {
  id: string;
  month: string;
  posted_at: string | null;
};

type Match = {
  id: string;
  run_id: string;
  tenancy_id: string | null;
  tenant_id: string | null;
  tenant_name: string;
  pays_as: string;
  property_label: string | null;
  room_label: string | null;
  expected_rent: number;
  actual_amount: number;
  difference: number;
  status: "match" | "mismatch" | "missing";
};

type DepositRow = {
  id: string;
  external_ref: string;
  payer_key: string;
  raw_description: string | null;
  amount: number;
  deposit_date: string | null;
  payment_id: string | null;
};

function fmtMoney(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function monthLabel(monthIso: string) {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function monthBounds(monthIso: string): { start: string; end: string } {
  const [y, m] = monthIso.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

const STATUS_PILL: Record<Match["status"], string> = {
  match: "bg-green-100 text-green-900",
  mismatch: "bg-orange-100 text-orange-900",
  missing: "bg-red-100 text-red-900",
};

const STATUS_LABEL: Record<Match["status"], string> = {
  match: "Match",
  mismatch: "Mismatch",
  missing: "Missing",
};

export default async function ReconciliationMatchPage({ params }: PageProps) {
  const { id, matchId } = await params;
  const supabase = await createClient();

  const [{ data: run }, { data: match }] = await Promise.all([
    supabase
      .from("reconciliation_runs")
      .select("id, month, posted_at")
      .eq("id", id)
      .maybeSingle<Run>(),
    supabase
      .from("reconciliation_matches")
      .select(
        `id, run_id, tenancy_id, tenant_id, tenant_name, pays_as,
         property_label, room_label,
         expected_rent, actual_amount, difference, status`,
      )
      .eq("id", matchId)
      .eq("run_id", id)
      .maybeSingle<Match>(),
  ]);

  if (!run || !match) notFound();

  // The tenant's real pays_as (original casing) — the match row only stores
  // the normalized key.
  let paysAs = match.pays_as;
  if (match.tenant_id) {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("pays_as, full_name")
      .eq("id", match.tenant_id)
      .maybeSingle<{ pays_as: string | null; full_name: string }>();
    if (tenant) paysAs = tenant.pays_as?.trim() || tenant.full_name;
  }

  // Bank / other-file deposits this run attributed to the tenant's tenancy.
  let deposits: DepositRow[] = [];
  if (match.tenancy_id) {
    const { data } = await supabase
      .from("reconciliation_deposits")
      .select(
        "id, external_ref, payer_key, raw_description, amount, deposit_date, payment_id",
      )
      .eq("run_id", id)
      .eq("tenancy_id", match.tenancy_id)
      .order("deposit_date", { ascending: true })
      .returns<DepositRow[]>();
    deposits = data ?? [];
  }

  // Rent recorded outside a bank posting during the month — these count
  // toward the tenant's actual too (mirrors loadMonthTenancies in actions).
  const { start, end } = monthBounds(run.month);
  let recorded: { id: string; paid_on: string; amount: number; method: string | null; notes: string | null }[] = [];
  if (match.tenancy_id) {
    const { data } = await supabase
      .from("payments")
      .select("id, paid_on, amount, method, notes")
      .eq("tenancy_id", match.tenancy_id)
      .eq("payment_type", "rent")
      .is("external_ref", null)
      .gte("paid_on", start)
      .lte("paid_on", end)
      .order("paid_on", { ascending: true });
    recorded = data ?? [];
  }

  const depositTotal = deposits.reduce((s, d) => s + Number(d.amount), 0);
  const recordedTotal = recorded.reduce((s, p) => s + Number(p.amount), 0);
  const flagged = match.status !== "match";

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="border-b border-stone/60 pb-6">
        <Link
          href={`/reconciliation/${run.id}`}
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          ← {monthLabel(run.month)} run
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl tracking-tight text-ink">
              {match.tenant_name}
            </h1>
            <p className="mt-1 text-sm text-muted">
              Pays as <span className="text-ink">{paysAs}</span>
              {match.property_label ? ` · ${match.property_label}` : ""}
              {match.room_label ? ` · ${match.room_label}` : ""}
            </p>
          </div>
          {match.tenant_id && (
            <Link
              href={`/tenants/${match.tenant_id}?from=reconciliation`}
              className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-ink shadow-sm hover:bg-warm"
            >
              View tenant profile →
            </Link>
          )}
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Expected</p>
          <p className="mt-1 text-lg tabular-nums text-ink">
            {fmtMoney(match.expected_rent)}
          </p>
        </div>
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Paid</p>
          <p className="mt-1 text-lg tabular-nums text-ink">
            {fmtMoney(match.actual_amount)}
          </p>
        </div>
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted">
            Difference
          </p>
          <p
            className={`mt-1 text-lg tabular-nums ${flagged ? "text-red-700" : "text-ink"}`}
          >
            {match.actual_amount === 0 ? "—" : fmtMoney(match.difference)}
          </p>
        </div>
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Status</p>
          <p className="mt-1.5">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATUS_PILL[match.status]}`}
            >
              {STATUS_LABEL[match.status]}
            </span>
          </p>
        </div>
      </section>

      <section className="mt-8 rounded-2xl bg-white shadow-sm">
        <div className="px-5 pt-5">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Bank transactions ({deposits.length})
          </h2>
          <p className="mt-1 text-xs text-muted">
            Deposits from the uploaded files that this run attributed to{" "}
            {match.tenant_name}.
          </p>
        </div>
        {deposits.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            No bank transactions were matched to this tenant in this run.
          </p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="bg-warm text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Date</th>
                <th className="px-5 py-2.5 font-medium">Payer</th>
                <th className="px-5 py-2.5 font-medium">Reference</th>
                <th className="px-5 py-2.5 text-right font-medium">Amount</th>
                <th className="px-5 py-2.5 font-medium">Posted</th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => (
                <tr key={d.id} className="border-t border-stone/40">
                  <td className="px-5 py-3 text-ink">
                    {formatDate(d.deposit_date)}
                  </td>
                  <td className="px-5 py-3 text-ink">
                    {d.raw_description
                      ? bankPayerNameDisplay(d.raw_description)
                      : d.payer_key}
                  </td>
                  <td className="max-w-48 truncate px-5 py-3 text-xs text-muted">
                    {d.external_ref}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-ink">
                    {fmtMoney(Number(d.amount))}
                  </td>
                  <td className="px-5 py-3 text-xs text-muted">
                    {d.payment_id ? "In ledger" : "Not posted"}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-stone/40 bg-warm/40">
                <td className="px-5 py-3 text-xs uppercase tracking-wide text-muted" colSpan={3}>
                  Total
                </td>
                <td className="px-5 py-3 text-right font-medium tabular-nums text-ink">
                  {fmtMoney(depositTotal)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {recorded.length > 0 && (
        <section className="mt-8 rounded-2xl bg-white shadow-sm">
          <div className="px-5 pt-5">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
              Recorded payments ({recorded.length})
            </h2>
            <p className="mt-1 text-xs text-muted">
              Rent recorded in the portal for {monthLabel(run.month)} outside a
              bank posting (cash, manual entry, …) — counted toward the paid
              total above.
            </p>
          </div>
          <table className="mt-3 w-full text-sm">
            <thead className="bg-warm text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Date</th>
                <th className="px-5 py-2.5 font-medium">Method</th>
                <th className="px-5 py-2.5 font-medium">Notes</th>
                <th className="px-5 py-2.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recorded.map((p) => (
                <tr key={p.id} className="border-t border-stone/40">
                  <td className="px-5 py-3 text-ink">{formatDate(p.paid_on)}</td>
                  <td className="px-5 py-3 text-ink">{p.method ?? "—"}</td>
                  <td className="px-5 py-3 text-xs text-muted">
                    {p.notes ?? ""}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-ink">
                    {fmtMoney(Number(p.amount))}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-stone/40 bg-warm/40">
                <td
                  className="px-5 py-3 text-xs uppercase tracking-wide text-muted"
                  colSpan={3}
                >
                  Total
                </td>
                <td className="px-5 py-3 text-right font-medium tabular-nums text-ink">
                  {fmtMoney(recordedTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
