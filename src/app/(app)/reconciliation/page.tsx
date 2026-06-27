import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatDate, todayISO, currentRentCycle } from "@/lib/date";
import { one } from "@/lib/relations";
import { RunRow } from "./run-row";
import { BulkPaymentForm, type BulkTenant } from "./bulk-payment-form";
import { isMaster } from "@/lib/access";

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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Runs stay visible to everyone; the Expected/Collected totals within them
  // and the per-tenant "paid this month" hint are admin-only.
  const admin = isMaster(user?.email);
  const { data, error } = await supabase
    .from("reconciliation_runs")
    .select(
      "id, month, total_expected, total_actual, match_count, mismatch_count, missing_count, created_at",
    )
    .order("month", { ascending: false })
    .order("created_at", { ascending: false })
    .returns<Run[]>();

  const runs = data ?? [];

  // Active tenancies for the bulk "Record payments" form, with how much rent
  // they've already paid this cycle (27th → 26th, by transaction date).
  const cycle = currentRentCycle();
  type PropRel = {
    building_name: string | null;
    street_address: string;
    unit_number: string;
  };
  type TenancyRow = {
    id: string;
    monthly_rent: number;
    tenants: { full_name: string } | { full_name: string }[] | null;
    rooms:
      | { room_number: string | null; properties: PropRel | PropRel[] | null }
      | { room_number: string | null; properties: PropRel | PropRel[] | null }[]
      | null;
    payments: { amount: number; paid_on: string; payment_type: string }[];
  };
  const { data: tenancyData } = await supabase
    .from("tenancies")
    .select(
      `id, monthly_rent,
       tenants(full_name),
       rooms(room_number, properties(building_name, street_address, unit_number)),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "active")
    .returns<TenancyRow[]>();

  const bulkTenants: BulkTenant[] = (tenancyData ?? [])
    .map((t) => {
      const tenant = one(t.tenants);
      const room = one(t.rooms);
      const property = one(room?.properties ?? null);
      const unit = property
        ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
        : "—";
      const paid = (t.payments ?? [])
        .filter(
          (p) =>
            p.payment_type === "rent" &&
            p.paid_on >= cycle.start &&
            p.paid_on <= cycle.end,
        )
        .reduce((s, p) => s + Number(p.amount), 0);
      return {
        tenancy_id: t.id,
        name: tenant?.full_name ?? "—",
        unit,
        room: room?.room_number ?? null,
        monthly_rent: Number(t.monthly_rent),
        paid_this_month: paid,
      };
    })
    .sort(
      (a, b) =>
        a.unit.localeCompare(b.unit, undefined, { numeric: true }) ||
        a.name.localeCompare(b.name),
    );

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

      <BulkPaymentForm
        tenants={bulkTenants}
        defaultDate={todayISO()}
        admin={admin}
      />

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
                {admin && (
                  <th className="px-5 py-3 text-right font-medium">Expected</th>
                )}
                {admin && (
                  <th className="px-5 py-3 text-right font-medium">Collected</th>
                )}
                <th className="px-5 py-3 text-right font-medium">Match / Mismatch / Missing</th>
                <th className="px-5 py-3 font-medium">Ran on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <RunRow key={r.id} href={`/reconciliation/${r.id}`}>
                  <td className="px-5 py-4 text-ink">{monthLabel(r.month)}</td>
                  {admin && (
                    <td className="px-5 py-4 text-right text-ink">
                      {fmtMoney(r.total_expected)}
                    </td>
                  )}
                  {admin && (
                    <td className="px-5 py-4 text-right text-ink">
                      {fmtMoney(r.total_actual)}
                    </td>
                  )}
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
