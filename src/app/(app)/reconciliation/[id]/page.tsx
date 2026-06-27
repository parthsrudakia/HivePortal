import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import { formatDate } from "@/lib/date";
import { DeleteRunButton } from "./delete-run";
import { AssignDepositForm, type AssignTenantOption } from "./assign-deposit-form";
import { one } from "@/lib/relations";
import { postPayments, unpostPayments } from "../actions";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string }>;
};

type FilterKey = "match" | "mismatch" | "missing";
function isFilterKey(v: string | undefined): v is FilterKey {
  return v === "match" || v === "mismatch" || v === "missing";
}

type Run = {
  id: string;
  month: string;
  bank_statement_path: string | null;
  other_payments_path: string | null;
  total_expected: number | null;
  total_actual: number | null;
  match_count: number | null;
  mismatch_count: number | null;
  missing_count: number | null;
  unmatched_deposits:
    | { description: string; raw?: string; amount: number; date?: string | null }[]
    | null;
  notes: string | null;
  posted_at: string | null;
  created_at: string;
};

type Match = {
  id: string;
  tenancy_id: string | null;
  tenant_id: string | null;
  tenant_name: string;
  pays_as: string;
  property_label: string | null;
  room_label: string | null;
  expected_rent: number;
  actual_amount: number;
  difference: number;
  status: FilterKey;
};

function fmtMoney(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function monthLabel(monthIso: string) {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

const STATUS_PILL: Record<FilterKey, string> = {
  match: "bg-green-100 text-green-900",
  mismatch: "bg-orange-100 text-orange-900",
  missing: "bg-red-100 text-red-900",
};

const STATUS_LABEL: Record<FilterKey, string> = {
  match: "Match",
  mismatch: "Mismatch",
  missing: "Missing",
};

export default async function ReconciliationRunPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const activeFilter = isFilterKey(sp.filter) ? sp.filter : null;

  const supabase = await createClient();
  // The Expected/Collected money totals are admin-only; the run itself, the
  // match/mismatch/missing counts, and the per-tenant rows stay visible.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const admin = isMaster(user?.email);

  const [{ data: run }, { data: matches }] = await Promise.all([
    supabase
      .from("reconciliation_runs")
      .select(
        `id, month, bank_statement_path, other_payments_path,
         total_expected, total_actual,
         match_count, mismatch_count, missing_count,
         unmatched_deposits, notes, posted_at, created_at`,
      )
      .eq("id", id)
      .maybeSingle<Run>(),
    supabase
      .from("reconciliation_matches")
      .select(
        `id, tenancy_id, tenant_id, tenant_name, pays_as,
         property_label, room_label,
         expected_rent, actual_amount, difference, status`,
      )
      .eq("run_id", id)
      .order("status", { ascending: true })
      .order("tenant_name", { ascending: true })
      .returns<Match[]>(),
  ]);

  if (!run) notFound();

  const filtered = activeFilter
    ? (matches ?? []).filter((m) => m.status === activeFilter)
    : matches ?? [];

  // Active tenancies to choose from when assigning an unmatched deposit.
  const hasUnmatched =
    !!run.unmatched_deposits && run.unmatched_deposits.length > 0;
  let assignTenants: AssignTenantOption[] = [];
  if (hasUnmatched) {
    type PropRel = {
      building_name: string | null;
      street_address: string;
      unit_number: string;
    };
    type Row = {
      id: string;
      tenants: { full_name: string } | { full_name: string }[] | null;
      rooms:
        | { room_number: string | null; properties: PropRel | PropRel[] | null }
        | {
            room_number: string | null;
            properties: PropRel | PropRel[] | null;
          }[]
        | null;
    };
    const { data: ten } = await supabase
      .from("tenancies")
      .select(
        `id, tenants(full_name),
         rooms(room_number, properties(building_name, street_address, unit_number))`,
      )
      .eq("status", "active")
      .returns<Row[]>();
    assignTenants = (ten ?? [])
      .map((t) => {
        const tenant = one(t.tenants);
        const room = one(t.rooms);
        const property = one(room?.properties ?? null);
        const unit = property
          ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
          : "";
        const parts = [tenant?.full_name ?? "—", unit, room?.room_number ?? ""]
          .filter(Boolean)
          .join(" · ");
        return { tenancyId: t.id, label: parts };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-6">
        <div>
          <Link
            href="/reconciliation"
            className="text-xs uppercase tracking-wide text-muted hover:text-ink"
          >
            ← Reconciliation
          </Link>
          <h1 className="mt-2 text-3xl tracking-tight text-ink">
            {monthLabel(run.month)}{" "}
            <span className="font-display text-accent-text">run</span>
          </h1>
          <p className="mt-1 text-xs text-muted">
            Ran {formatDate(run.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={`/reconciliation/${run.id}/export`}
            className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-ink shadow-sm hover:bg-warm"
          >
            Download Excel
          </a>
          {run.posted_at ? (
            <form action={unpostPayments}>
              <input type="hidden" name="run_id" value={run.id} />
              <button
                type="submit"
                className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-red-700 hover:bg-red-50"
              >
                Unpost from Ledger
              </button>
            </form>
          ) : (
            <form action={postPayments}>
              <input type="hidden" name="run_id" value={run.id} />
              <button
                type="submit"
                className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark"
              >
                Post to Ledger
              </button>
            </form>
          )}
        </div>
      </header>

      <section
        className={`mt-6 rounded-2xl p-4 text-sm ${
          run.posted_at
            ? "bg-accent/10 text-accent-text"
            : "bg-warm/60 text-ink/80"
        }`}
      >
        {run.posted_at ? (
          <p>
            <strong>Posted</strong> on {formatDate(run.posted_at)}.
          </p>
        ) : (
          <p>
            <strong>Preview</strong> — payments are <em>not</em> recorded yet.
          </p>
        )}
      </section>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {admin && (
          <KpiCard
            label="Expected"
            value={fmtMoney(run.total_expected)}
            href={`/reconciliation/${run.id}`}
            active={activeFilter === null}
          />
        )}
        {admin && (
          <KpiCard
            label="Collected"
            value={fmtMoney(run.total_actual)}
            href={`/reconciliation/${run.id}`}
            active={false}
          />
        )}
        <KpiCard
          label="Match"
          value={run.match_count ?? 0}
          href={
            activeFilter === "match"
              ? `/reconciliation/${run.id}`
              : `/reconciliation/${run.id}?filter=match`
          }
          active={activeFilter === "match"}
          accent="bg-green-100 text-green-900"
        />
        <KpiCard
          label="Mismatch"
          value={run.mismatch_count ?? 0}
          href={
            activeFilter === "mismatch"
              ? `/reconciliation/${run.id}`
              : `/reconciliation/${run.id}?filter=mismatch`
          }
          active={activeFilter === "mismatch"}
          accent="bg-orange-100 text-orange-900"
        />
        <KpiCard
          label="Missing"
          value={run.missing_count ?? 0}
          href={
            activeFilter === "missing"
              ? `/reconciliation/${run.id}`
              : `/reconciliation/${run.id}?filter=missing`
          }
          active={activeFilter === "missing"}
          accent="bg-red-100 text-red-900"
        />
      </section>

      <section className="mt-8 overflow-hidden rounded-2xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-3 font-medium">Tenant</th>
              <th className="px-5 py-3 font-medium">Unit</th>
              <th className="px-5 py-3 text-right font-medium">Expected</th>
              <th className="px-5 py-3 text-right font-medium">Paid</th>
              <th className="px-5 py-3 text-right font-medium">Difference</th>
              <th className="px-5 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id} className="border-t border-stone/40">
                <td className="px-5 py-4">
                  {m.tenant_id ? (
                    <Link
                      href={`/tenants/${m.tenant_id}`}
                      className="text-ink hover:text-accent-text"
                    >
                      {m.tenant_name}
                    </Link>
                  ) : (
                    <span className="text-ink">{m.tenant_name}</span>
                  )}
                  <p className="text-xs text-muted">{m.pays_as}</p>
                </td>
                <td className="px-5 py-4 text-ink">
                  {m.property_label ?? "—"}
                  <p className="text-xs text-muted">{m.room_label ?? ""}</p>
                </td>
                <td className="px-5 py-4 text-right text-ink">
                  {fmtMoney(m.expected_rent)}
                </td>
                <td className="px-5 py-4 text-right text-ink">
                  {fmtMoney(m.actual_amount)}
                </td>
                <td className="px-5 py-4 text-right text-ink">
                  {m.actual_amount === 0
                    ? "—"
                    : fmtMoney(m.difference)}
                </td>
                <td className="px-5 py-4">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATUS_PILL[m.status]}`}
                  >
                    {STATUS_LABEL[m.status]}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-sm text-muted">
                  No matches in this filter.{" "}
                  <Link
                    href={`/reconciliation/${run.id}`}
                    className="text-accent-text"
                  >
                    Clear filter
                  </Link>
                  .
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {run.unmatched_deposits && run.unmatched_deposits.length > 0 && (
        <section className="mt-8 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Unmatched deposits ({run.unmatched_deposits.length})
          </h2>
          <p className="mt-1 text-xs text-muted">
            Payments in the bank statement / other-payments file that didn&apos;t
            match any tenant&apos;s <code>pays as</code>. Assign one to a tenant and
            we&apos;ll save the bank&apos;s payer name as their <code>pays as</code>{" "}
            alias — crediting it now and matching it automatically next time.
          </p>
          <ul className="mt-4 flex flex-col gap-1.5">
            {run.unmatched_deposits.map((d, i) => (
              <AssignDepositForm
                key={i}
                runId={run.id}
                payerKey={d.description}
                label={d.raw ?? d.description}
                amount={d.amount}
                date={d.date ?? null}
                tenants={assignTenants}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="mt-12 border-t border-stone/60 pt-6">
        <DeleteRunButton id={run.id} label={monthLabel(run.month)} />
      </section>
    </div>
  );
}

function KpiCard({
  label,
  value,
  href,
  active,
  accent,
}: {
  label: string;
  value: number | string;
  href: string;
  active: boolean;
  accent?: string;
}) {
  return (
    <Link
      href={href}
      className={`rounded-2xl p-4 shadow-sm transition ${
        active ? "bg-ink text-white ring-2 ring-ink" : "bg-white hover:shadow"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className={`text-xs uppercase tracking-wide ${active ? "text-white/70" : "text-muted"}`}
        >
          {label}
        </p>
        {accent && !active && (
          <span className={`h-2 w-2 rounded-full ${accent.split(" ")[0]}`} />
        )}
      </div>
      <p
        className={`mt-2 text-3xl font-light ${active ? "text-white" : "text-ink"}`}
      >
        {value}
      </p>
    </Link>
  );
}
