import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canEditLedger, isMaster } from "@/lib/access";
import { formatDate, todayISO } from "@/lib/date";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { recomputeRun } from "@/lib/reconciliation/matching";
import { AutoRefresh } from "@/components/auto-refresh";
import { DeleteRunButton } from "./delete-run";
import { AddStatementForm } from "./add-statement-form";
import { LedgerQuickAdd } from "./ledger-quick-add";
import { ReversalAlerts, type ReversalAlert } from "./reversal-alerts";
import { AssignDepositForm, type AssignTenantOption } from "./assign-deposit-form";
import { one } from "@/lib/relations";
import { postPayments, unpostPayments, unignorePayer } from "../actions";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string }>;
};

type FilterKey = "match" | "mismatch" | "missing";
// "new" narrows to tenants whose deposits arrived in the run's latest
// statement batch — it composes with the status filters instead of
// replacing them (?filter=mismatch,new = new mismatches only).
type FilterToken = FilterKey | "new";
function isFilterToken(v: string): v is FilterToken {
  return v === "match" || v === "mismatch" || v === "missing" || v === "new";
}

// Filters are multi-select: `?filter=mismatch,missing` keeps both applied,
// and clicking an active card removes just that one.
function parseFilters(param: string | undefined): Set<FilterToken> {
  return new Set((param ?? "").split(",").filter(isFilterToken));
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

// Carry-forward account balance once this statement is in: red when they'd
// still owe, green when overpaid (credit) or settled.
function RunBalance({ n }: { n: number | undefined }) {
  if (n === undefined) return <span className="text-muted">—</span>;
  if (n > 0.005) return <span className="text-red-700">{fmtMoney(n)}</span>;
  if (n < -0.005) {
    return (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-green-800">
        Credit {fmtMoney(-n)}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-green-800">
      Paid
    </span>
  );
}

export default async function ReconciliationRunPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const activeFilters = parseFilters(sp.filter);
  // Toggle one token in/out of the filter set, preserving the others.
  const toggleHref = (key: FilterToken) => {
    const next = new Set(activeFilters);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next.size === 0
      ? `/reconciliation/${id}`
      : `/reconciliation/${id}?filter=${[...next].join(",")}`;
  };

  const supabase = await createClient();
  // The Expected/Collected money totals are admin-only; the run itself, the
  // match/mismatch/missing counts, and the per-tenant rows stay visible.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const admin = isMaster(user?.email);
  // Posting/unposting writes or deletes ledger payments — operator-only
  // (enforced server-side in the actions; hidden here to match).
  const canPost = canEditLedger(user?.email);

  // Freshen the stored snapshot before reading it: re-derive matches/totals
  // from the run's saved deposits against current tenancy + payment data, so
  // payments recorded (or deleted) since the run was created show up without
  // re-uploading. A no-op write-wise when nothing changed; a failure falls
  // back to displaying the stored rows.
  try {
    await recomputeRun(supabase, id);
  } catch (e) {
    console.error("[recon] recompute on view failed:", e);
  }

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

  // Known not-rent payers, shown (with undo) whenever any exist.
  const { data: ignoredData } = await supabase
    .from("ignored_payers")
    .select("payer_key, display_name")
    .order("display_name");
  const ignoredPayers = ignoredData ?? [];

  // Unresolved chargeback alerts for this run, enriched with the suspected
  // original payment's tenant and date.
  const { data: reversalRows } = await supabase
    .from("reconciliation_reversals")
    .select("id, raw_description, amount, deposit_date, suspect_payment_id")
    .eq("run_id", id)
    .is("resolved_at", null)
    .order("created_at");
  const suspectIds = (reversalRows ?? [])
    .map((r) => r.suspect_payment_id)
    .filter((x): x is string => !!x);
  const suspectById = new Map<string, { tenantName: string; paidOn: string }>();
  if (suspectIds.length > 0) {
    type SuspectRow = {
      id: string;
      paid_on: string;
      tenancies: {
        tenants: { full_name: string } | { full_name: string }[] | null;
      } | {
        tenants: { full_name: string } | { full_name: string }[] | null;
      }[] | null;
    };
    const { data: suspects } = await supabase
      .from("payments")
      .select("id, paid_on, tenancies(tenants(full_name))")
      .in("id", suspectIds)
      .returns<SuspectRow[]>();
    for (const s of suspects ?? []) {
      suspectById.set(s.id, {
        tenantName: one(one(s.tenancies)?.tenants ?? null)?.full_name ?? "tenant",
        paidOn: s.paid_on,
      });
    }
  }
  const reversalAlerts: ReversalAlert[] = (reversalRows ?? []).map((r) => ({
    id: r.id,
    raw: r.raw_description,
    amount: Number(r.amount),
    date: r.deposit_date,
    suspect: r.suspect_payment_id
      ? (suspectById.get(r.suspect_payment_id) ?? null)
      : null,
  }));

  // Balance — where each tenant stands AFTER this statement, from the same
  // carry-forward ledger math as the Rent Tracker: the running balance minus
  // this run's matched deposits that aren't posted as payments yet. Deposits
  // whose external_ref already exists in payments (this run posted, or an
  // overlapping statement did) are already inside the ledger and are not
  // subtracted again.
  const tenancyIds = Array.from(
    new Set(
      (matches ?? [])
        .map((m) => m.tenancy_id)
        .filter((x): x is string => !!x),
    ),
  );
  const balanceAfter = new Map<string, number>();
  // Tenancies whose deposits arrived in the run's LATEST statement batch —
  // rows in one insert share a created_at, so the newest distinct timestamp
  // is the last "Add statement" upload. Only meaningful once the run has
  // more than one batch; those rows get a light "new" highlight.
  const newTenancyIds = new Set<string>();
  if (tenancyIds.length > 0) {
    type LedgerTenancyRow = {
      id: string;
      start_date: string;
      move_out_date: string | null;
      monthly_rent: number;
      first_month_rent: number | null;
      security_deposit: number | null;
      payments: { amount: number; paid_on: string; payment_type: string }[];
    };
    const [{ data: tenancyRows }, sidecars, { data: runDeps }] =
      await Promise.all([
        supabase
          .from("tenancies")
          .select(
            `id, start_date, move_out_date, monthly_rent, first_month_rent, security_deposit,
             payments(amount, paid_on, payment_type)`,
          )
          .in("id", tenancyIds)
          .returns<LedgerTenancyRow[]>(),
        fetchLedgerSidecars(supabase),
        supabase
          .from("reconciliation_deposits")
          .select("tenancy_id, amount, external_ref, created_at")
          .eq("run_id", id),
      ]);

    const allDeps = (runDeps ?? []) as {
      tenancy_id: string | null;
      amount: number;
      external_ref: string;
      created_at: string;
    }[];
    const batchTimes = [...new Set(allDeps.map((d) => d.created_at))].sort();
    if (batchTimes.length > 1) {
      const latest = batchTimes[batchTimes.length - 1];
      for (const d of allDeps) {
        if (d.created_at === latest && d.tenancy_id) {
          newTenancyIds.add(d.tenancy_id);
        }
      }
    }

    const deps = allDeps.filter(
      (d): d is (typeof allDeps)[number] & { tenancy_id: string } =>
        d.tenancy_id !== null,
    );
    const postedRefs = new Set<string>();
    if (deps.length > 0) {
      const { data: postedRows } = await supabase
        .from("payments")
        .select("external_ref")
        .in(
          "external_ref",
          deps.map((d) => d.external_ref),
        );
      for (const r of postedRows ?? []) {
        if (r.external_ref) postedRefs.add(r.external_ref);
      }
    }
    const pendingByTenancy = new Map<string, number>();
    for (const d of deps) {
      if (postedRefs.has(d.external_ref)) continue;
      pendingByTenancy.set(
        d.tenancy_id,
        (pendingByTenancy.get(d.tenancy_id) ?? 0) + Number(d.amount),
      );
    }

    const cents = (n: number) => Math.round(n * 100) / 100;
    const today = todayISO();
    for (const t of tenancyRows ?? []) {
      const { netBalance } = computeLedger(
        t,
        t.payments ?? [],
        sidecars.charges.get(t.id) ?? [],
        sidecars.allocations.get(t.id) ?? [],
        today,
        sidecars.rentChanges.get(t.id) ?? [],
      );
      balanceAfter.set(t.id, cents(netBalance - (pendingByTenancy.get(t.id) ?? 0)));
    }
  }

  // Status filters OR together; "new" then narrows whatever survives.
  const statusFilters = new Set(
    [...activeFilters].filter((f): f is FilterKey => f !== "new"),
  );
  const newOnly = activeFilters.has("new");
  const isNewRow = (m: Match) =>
    !!m.tenancy_id && newTenancyIds.has(m.tenancy_id);
  const filtered = (matches ?? []).filter(
    (m) =>
      (statusFilters.size === 0 || statusFilters.has(m.status)) &&
      (!newOnly || isNewRow(m)),
  );

  // Row order: settled matches first, then matches still owing, then matches
  // in credit, then mismatches, then missing — tenant name within each group.
  const groupOf = (m: Match): number => {
    if (m.status === "mismatch") return 3;
    if (m.status === "missing") return 4;
    const b = m.tenancy_id ? balanceAfter.get(m.tenancy_id) : undefined;
    if (b === undefined) return 2;
    if (Math.abs(b) <= 0.005) return 0;
    return b > 0.005 ? 1 : 2;
  };
  const sorted = [...filtered].sort(
    (a, b) => groupOf(a) - groupOf(b) || a.tenant_name.localeCompare(b.tenant_name),
  );

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
      <AutoRefresh />
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
          {admin && (
            <>
              <a
                href={`/reconciliation/${run.id}/export`}
                className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-ink shadow-sm hover:bg-warm"
              >
                Download Excel
              </a>
              <a
                href={`/reconciliation/${run.id}/export?filter=issues`}
                title="Only mismatched and missing rows"
                className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-ink shadow-sm hover:bg-warm"
              >
                Download Missing &amp; Mismatched
              </a>
            </>
          )}
          <AddStatementForm runId={run.id} posted={!!run.posted_at} />
          {canPost &&
            (run.posted_at ? (
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
            ))}
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

      <section
        className={`mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 ${
          newTenancyIds.size > 0 ? "lg:grid-cols-6" : "lg:grid-cols-5"
        }`}
      >
        {admin && (
          <KpiCard
            label="Expected"
            value={fmtMoney(run.total_expected)}
            href={`/reconciliation/${run.id}`}
            active={activeFilters.size === 0}
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
          href={toggleHref("match")}
          active={activeFilters.has("match")}
          accent="bg-green-100 text-green-900"
        />
        <KpiCard
          label="Mismatch"
          value={run.mismatch_count ?? 0}
          href={toggleHref("mismatch")}
          active={activeFilters.has("mismatch")}
          accent="bg-orange-100 text-orange-900"
        />
        <KpiCard
          label="Missing"
          value={run.missing_count ?? 0}
          href={toggleHref("missing")}
          active={activeFilters.has("missing")}
          accent="bg-red-100 text-red-900"
        />
        {newTenancyIds.size > 0 && (
          <KpiCard
            label="New"
            value={(matches ?? []).filter(isNewRow).length}
            href={toggleHref("new")}
            active={activeFilters.has("new")}
            accent="bg-accent/15 text-accent-text"
          />
        )}
      </section>

      <section className="mt-8 rounded-2xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-warm text-left text-xs uppercase tracking-wide text-muted shadow-sm md:top-14">
            <tr>
              <th className="rounded-tl-2xl bg-warm px-5 py-3 font-medium">Tenant</th>
              <th className="bg-warm px-5 py-3 font-medium">Unit</th>
              <th className="bg-warm px-5 py-3 font-medium">Room</th>
              <th
                title="Monthly rent for this run's month"
                className="bg-warm px-5 py-3 text-right font-medium"
              >
                Rent
              </th>
              <th className="bg-warm px-5 py-3 text-right font-medium">Paid</th>
              <th
                title="Total account balance once this statement's deposits are in the ledger"
                className="bg-warm px-5 py-3 text-right font-medium"
              >
                Balance
              </th>
              <th className="bg-warm px-5 py-3 font-medium">Status</th>
              <th className="rounded-tr-2xl bg-warm px-5 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => {
              const flagged = m.status === "mismatch" || m.status === "missing";
              const isNew = isNewRow(m);
              return (
              <tr
                key={m.id}
                className={`border-t border-stone/40 ${isNew ? "bg-accent/5" : ""}`}
              >
                <td className="px-5 py-4">
                  <Link
                    href={`/reconciliation/${run.id}/match/${m.id}`}
                    className={
                      flagged
                        ? "text-red-700 hover:text-red-800"
                        : "text-ink hover:text-accent-text"
                    }
                  >
                    {m.tenant_name}
                  </Link>
                  {isNew && (
                    <span
                      title="This tenant received deposits from the most recently added statement"
                      className="ml-2 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-text"
                    >
                      New
                    </span>
                  )}
                </td>
                <td className="px-5 py-4 text-ink">{m.property_label ?? "—"}</td>
                <td className="px-5 py-4 text-ink">{m.room_label ?? "—"}</td>
                <td className="px-5 py-4 text-right tabular-nums text-ink">
                  {fmtMoney(m.expected_rent)}
                </td>
                <td className="px-5 py-4 text-right tabular-nums text-ink">
                  {fmtMoney(m.actual_amount)}
                </td>
                <td className="px-5 py-4 text-right tabular-nums">
                  <RunBalance
                    n={m.tenancy_id ? balanceAfter.get(m.tenancy_id) : undefined}
                  />
                </td>
                <td className="px-5 py-4">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATUS_PILL[m.status]}`}
                  >
                    {STATUS_LABEL[m.status]}
                  </span>
                </td>
                <td className="px-3 py-4 text-right">
                  {flagged && m.tenancy_id && m.tenant_id && (
                    <LedgerQuickAdd
                      tenancyId={m.tenancy_id}
                      tenantId={m.tenant_id}
                      tenantName={m.tenant_name}
                      suggestedAmount={Math.max(
                        0,
                        Math.round(
                          (Number(m.expected_rent) - Number(m.actual_amount)) * 100,
                        ) / 100,
                      )}
                      canCharge={canPost}
                    />
                  )}
                </td>
              </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center text-sm text-muted">
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

      <ReversalAlerts alerts={reversalAlerts} />

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
            Mark a payer <em>Not rent</em> (a personal transfer, another
            venture) and their deposits stay out of every run.
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

      {ignoredPayers.length > 0 && (
        <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Ignored payers ({ignoredPayers.length})
          </h2>
          <p className="mt-1 text-xs text-muted">
            Deposits from these payers are treated as not-rent and excluded
            from every run&apos;s unmatched list.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {ignoredPayers.map((p) => (
              <li
                key={p.payer_key}
                className="flex items-center gap-2 rounded-full bg-warm/60 py-1 pl-3 pr-1 text-sm text-ink"
              >
                {p.display_name}
                <form action={unignorePayer}>
                  <input type="hidden" name="payer_key" value={p.payer_key} />
                  <input type="hidden" name="run_id" value={run.id} />
                  <button
                    type="submit"
                    title="Un-ignore — show this payer in unmatched lists again"
                    className="rounded-full bg-white px-2 py-0.5 text-xs text-muted shadow-sm hover:text-ink"
                  >
                    Undo
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {admin && (
        <section className="mt-12 border-t border-stone/60 pt-6">
          <DeleteRunButton id={run.id} label={monthLabel(run.month)} />
        </section>
      )}
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
