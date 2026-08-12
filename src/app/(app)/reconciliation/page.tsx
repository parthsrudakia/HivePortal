import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { canEditLedger } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { todayISO, addDaysISO, currentRentCycle } from "@/lib/date";
import { computeLedger, rateForMonthISO } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { AutoRefresh } from "@/components/auto-refresh";
import { ServerSearchInput } from "@/components/server-search-input";
import { AddStatementForm } from "./add-statement-form";
import { LedgerQuickAdd } from "./ledger-quick-add";
import { ReversalAlerts, type ReversalAlert } from "./reversal-alerts";
import { UnassignedSection, type UnassignedRow } from "./unassigned-section";
import type { AssignTenantOption } from "./assign-deposit-form";
import { BulkPaymentForm, type BulkTenant } from "./bulk-payment-form";
import { one } from "@/lib/relations";
import {
  monthBounds,
  loadMonthTenancies,
  computeMonthMatches,
  type MatchRow,
} from "@/lib/reconciliation/matching";

export const dynamic = "force-dynamic";
// addStatement (spreadsheet parse + storage upload + per-deposit posting)
// scales with statement size. Give its Server Action the same 60s ceiling the
// crons use so a large bank file can't outrun Vercel's default timeout.
export const maxDuration = 60;

type PageProps = {
  searchParams: Promise<{ filter?: string; q?: string; new?: string }>;
};

type FilterKey = "match" | "mismatch" | "missing";
function isFilterKey(v: string): v is FilterKey {
  return v === "match" || v === "mismatch" || v === "missing";
}

// Filters are multi-select: `?filter=mismatch,missing` keeps both applied,
// and clicking an active card removes just that one.
function parseFilters(param: string | undefined): Set<FilterKey> {
  return new Set((param ?? "").split(",").filter(isFilterKey));
}

function fmtMoney(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// KPI cards show whole dollars; the table rows keep their cents.
function fmtMoneyRounded(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `$${Math.round(Number(n)).toLocaleString()}`;
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

// Carry-forward account balance: red when they still owe, green when overpaid
// (credit) or settled. Posting is immediate, so this is the plain ledger
// balance — nothing pending to subtract.
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

export default async function ReconciliationPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const activeFilters = parseFilters(sp.filter);
  const query = (sp.q ?? "").trim().toLowerCase();
  // "New" filter: only transactions from the most recent statement upload.
  const newActive = sp.new === "1";
  const buildHref = (filters: Set<FilterKey>, newFlag: boolean) => {
    const params = new URLSearchParams();
    if (filters.size > 0) params.set("filter", [...filters].join(","));
    if (query) params.set("q", (sp.q ?? "").trim());
    if (newFlag) params.set("new", "1");
    const qs = params.toString();
    return qs ? `/reconciliation?${qs}` : "/reconciliation";
  };
  const hrefWith = (filters: Set<FilterKey>) => buildHref(filters, newActive);
  const toggleHref = (key: FilterKey) => {
    const next = new Set(activeFilters);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return hrefWith(next);
  };
  const toggleNewHref = buildHref(activeFilters, !newActive);

  const supabase = await createClient();
  const user = await getSessionUser();
  const admin = canEditLedger(user?.email);
  if (!admin) {
    return (
      <div className="mx-auto w-full max-w-3xl rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
        Bank reconciliation is restricted to the financial operators.
      </div>
    );
  }

  // The continuous recon always reconciles the month in progress. History
  // lives in the ledger and /reports.
  const today = todayISO();
  const month = today.slice(0, 7);
  const { start, end } = monthBounds(month);
  // Rent for month M is routinely paid in the last days of M−1 — same 6-day
  // early window the per-month runs used.
  const windowStart = addDaysISO(start, -6);
  const cycle = currentRentCycle();

  type PropRel = {
    building_name: string | null;
    street_address: string;
    unit_number: string;
  };
  type ActiveTenancyRow = {
    id: string;
    status: "active" | "ended";
    monthly_rent: number;
    tenants: { full_name: string } | { full_name: string }[] | null;
    rooms:
      | { room_number: string | null; properties: PropRel | PropRel[] | null }
      | { room_number: string | null; properties: PropRel | PropRel[] | null }[]
      | null;
    payments: { amount: number; paid_on: string; payment_type: string }[];
  };
  type DepositRow = {
    id: string;
    payer_key: string;
    raw_description: string | null;
    amount: number;
    deposit_date: string | null;
    dismissed_at: string | null;
  };

  const [
    { tenancies: monthTenancies, error: tErr },
    { data: bankPayRows },
    { data: depositRows },
    { data: latestStatement },
    { data: latestStatementAny },
    { data: ignoredData },
    { data: reversalRows },
    { data: activeTenancyData },
    sidecars,
  ] = await Promise.all([
    loadMonthTenancies(supabase, start, end),
    supabase
      .from("payments")
      .select("tenancy_id, amount")
      .eq("payment_type", "rent")
      .not("external_ref", "is", null)
      .gte("paid_on", windowStart)
      .lte("paid_on", end),
    // Every deposit not yet in the ledger: the unassigned list (dismissed
    // ones included — they render in the collapsed sub-list).
    supabase
      .from("reconciliation_deposits")
      .select("id, payer_key, raw_description, amount, deposit_date, dismissed_at")
      .is("payment_id", null)
      .order("deposit_date", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("reconciliation_statements")
      .select("max_deposit_date, created_at")
      .eq("source", "bank")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // The most recent statement of ANY source, to power the "New" filter.
    supabase
      .from("reconciliation_statements")
      .select("id")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("ignored_payers")
      .select("payer_key, display_name")
      .order("display_name"),
    supabase
      .from("reconciliation_reversals")
      .select("id, raw_description, amount, deposit_date, suspect_payment_id")
      .is("resolved_at", null)
      .order("created_at"),
    // Ended tenancies stay assignable — a late payment or a prepayment can
    // belong to a past tenant. The bulk form below filters back to active.
    supabase
      .from("tenancies")
      .select(
        `id, status, monthly_rent,
         tenants(full_name),
         rooms(room_number, properties(building_name, street_address, unit_number)),
         payments(amount, paid_on, payment_type)`,
      )
      .in("status", ["active", "ended"])
      .returns<ActiveTenancyRow[]>(),
    fetchLedgerSidecars(supabase),
  ]);

  // Current-month match table, computed live: expected rent per tenancy vs
  // what the bank actually delivered (posted external_ref payments) plus
  // manually recorded rent.
  const bankPaid = new Map<string, number>();
  for (const p of bankPayRows ?? []) {
    if (!p.tenancy_id) continue;
    bankPaid.set(p.tenancy_id, (bankPaid.get(p.tenancy_id) ?? 0) + Number(p.amount));
  }
  const { matches, totals } = computeMonthMatches(
    monthTenancies,
    bankPaid,
    start,
    end,
  );

  // Balance — where each tenant stands, from the same carry-forward ledger
  // math as the Rent Tracker. Posting is immediate, so the ledger already
  // contains every assigned deposit.
  const tenancyIds = matches.map((m) => m.tenancy_id);
  const balanceByTenancy = new Map<string, number>();
  if (tenancyIds.length > 0) {
    type LedgerTenancyRow = {
      id: string;
      start_date: string;
      move_out_date: string | null;
      monthly_rent: number;
      first_month_rent: number | null;
      security_deposit: number | null;
      paused_at: string | null;
      payments: { amount: number; paid_on: string; payment_type: string }[];
    };
    const { data: ledgerRows } = await supabase
      .from("tenancies")
      .select(
        `id, start_date, move_out_date, monthly_rent, first_month_rent, security_deposit, paused_at,
         payments(amount, paid_on, payment_type)`,
      )
      .in("id", tenancyIds)
      .returns<LedgerTenancyRow[]>();
    const cents = (n: number) => Math.round(n * 100) / 100;
    for (const t of ledgerRows ?? []) {
      const { netBalance } = computeLedger(
        t,
        t.payments ?? [],
        sidecars.charges.get(t.id) ?? [],
        sidecars.allocations.get(t.id) ?? [],
        today,
        sidecars.rentChanges.get(t.id) ?? [],
      );
      balanceByTenancy.set(t.id, cents(netBalance));
    }
  }

  // Tenancies that received a posted payment from the most recent statement —
  // powers the "New" filter and the per-row NEW badge.
  const newTenancyIds = new Set<string>();
  if (latestStatementAny?.id) {
    const { data: newDeps } = await supabase
      .from("reconciliation_deposits")
      .select("tenancy_id")
      .eq("statement_id", latestStatementAny.id)
      .not("payment_id", "is", null)
      .not("tenancy_id", "is", null);
    for (const d of newDeps ?? []) {
      if (d.tenancy_id) newTenancyIds.add(d.tenancy_id);
    }
  }

  const matchesQuery = (m: MatchRow) =>
    !query ||
    [m.tenant_name, m.pays_as, m.property_label, m.room_label]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  const filtered = matches.filter(
    (m) =>
      (activeFilters.size === 0 || activeFilters.has(m.status)) &&
      (!newActive || newTenancyIds.has(m.tenancy_id)) &&
      matchesQuery(m),
  );
  // Count of current-month rows the latest statement touched (drives the pill).
  const newCount = matches.filter((m) =>
    newTenancyIds.has(m.tenancy_id),
  ).length;

  // Row order: problems first, worst first.
  //   0 missing money AND the tenant still owes — chase these
  //   1 amount mismatches — investigate
  //   2 matched but a balance remains (partial) — follow up
  //   3 ending in credit — double-check (overpayment or a ledger error)
  //   4 all clear: settled, incl. "missing" rows whose rent simply arrived in
  //     an earlier month
  // Groups 0–3 sort by the money at stake (biggest first); group 4 by name.
  const balanceOf = (m: MatchRow): number | undefined =>
    balanceByTenancy.get(m.tenancy_id);
  const groupOf = (m: MatchRow): number => {
    const b = balanceOf(m);
    const owes = b === undefined || b > 0.005; // unknown ledger → treat as open
    if (m.status === "missing") return owes ? 0 : 4;
    if (m.status === "mismatch") return 1;
    if (owes) return 2;
    return b < -0.005 ? 3 : 4;
  };
  const sorted = [...filtered].sort((a, b) => {
    const ga = groupOf(a);
    const gb = groupOf(b);
    if (ga !== gb) return ga - gb;
    if (ga <= 3) {
      const ba = Math.abs(balanceOf(a) ?? 0);
      const bb = Math.abs(balanceOf(b) ?? 0);
      if (Math.abs(ba - bb) > 0.005) return bb - ba;
    }
    return a.tenant_name.localeCompare(b.tenant_name);
  });

  // Reversal alerts, enriched with the suspected original payment's tenant.
  const suspectIds = (reversalRows ?? [])
    .map((r) => r.suspect_payment_id)
    .filter((x): x is string => !!x);
  const suspectById = new Map<string, { tenantName: string; paidOn: string }>();
  if (suspectIds.length > 0) {
    type SuspectRow = {
      id: string;
      paid_on: string;
      tenancies:
        | { tenants: { full_name: string } | { full_name: string }[] | null }
        | { tenants: { full_name: string } | { full_name: string }[] | null }[]
        | null;
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

  // Assign options + bulk-payment tenants share the tenancies query. Current
  // tenants list first; past tenants follow, flagged "ended".
  const assignTenants: AssignTenantOption[] = (activeTenancyData ?? [])
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
      return {
        tenancyId: t.id,
        label: t.status === "ended" ? `${parts} · ended` : parts,
        ended: t.status === "ended",
      };
    })
    .sort(
      (a, b) =>
        Number(a.ended) - Number(b.ended) || a.label.localeCompare(b.label),
    );

  const bulkTenants: BulkTenant[] = (activeTenancyData ?? [])
    .filter((t) => t.status === "active")
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
            (p.payment_type === "rent" || p.payment_type === "refund") &&
            p.paid_on >= cycle.start &&
            p.paid_on <= cycle.end &&
            p.paid_on <= today,
        )
        .reduce(
          (s, p) => s + (p.payment_type === "refund" ? -1 : 1) * Number(p.amount),
          0,
        );
      return {
        tenancy_id: t.id,
        name: tenant?.full_name ?? "—",
        unit,
        room: room?.room_number ?? null,
        monthly_rent: rateForMonthISO(
          cycle.end,
          t.monthly_rent,
          sidecars.rentChanges.get(t.id) ?? [],
        ),
        paid_this_month: paid,
      };
    })
    .sort(
      (a, b) =>
        a.unit.localeCompare(b.unit, undefined, { numeric: true }) ||
        a.name.localeCompare(b.name),
    );

  // Unassigned transactions: every deposit not in the ledger, newest first.
  // Dismissed rows (and rows from not-rent payers) group into the collapsed
  // sub-list but stay searchable.
  const ignoredPayers = ignoredData ?? [];
  const ignoredKeySet = new Set(ignoredPayers.map((p) => p.payer_key));
  const unassignedRows: UnassignedRow[] = ((depositRows ?? []) as DepositRow[]).map(
    (d) => ({
      id: d.id,
      payerKey: d.payer_key,
      label: d.raw_description ?? d.payer_key,
      amount: Number(d.amount),
      date: d.deposit_date,
      dismissed: d.dismissed_at !== null,
      ignored: ignoredKeySet.has(d.payer_key),
    }),
  );
  const activeUnassignedCount = unassignedRows.filter(
    (r) => !r.dismissed && !r.ignored,
  ).length;

  const coversThrough: string | null = latestStatement?.max_deposit_date ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AutoRefresh />
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-6">
        <div>
          <h1 className="text-3xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Reconciliation</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Continuous rent reconciliation — {monthLabel(month)}. Statements
            post to tenant ledgers the moment they match.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/reconciliation/export"
            className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-ink shadow-sm hover:bg-warm"
          >
            Download Excel
          </a>
          <a
            href="/reconciliation/export?filter=issues"
            title="Only mismatched and missing rows"
            className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-ink shadow-sm hover:bg-warm"
          >
            Download Missing &amp; Mismatched
          </a>
          <AddStatementForm coversThrough={coversThrough} />
        </div>
      </header>

      {tErr && <p className="mt-6 text-sm text-red-700">{tErr}</p>}

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard
          label="Expected"
          value={fmtMoneyRounded(totals.totalExpected)}
          href={hrefWith(new Set())}
          active={activeFilters.size === 0}
        />
        <KpiCard
          label="Collected"
          value={fmtMoneyRounded(totals.totalActual)}
          href={hrefWith(new Set())}
          active={false}
        />
        <KpiCard
          label="Match"
          value={totals.matchCount}
          href={toggleHref("match")}
          active={activeFilters.has("match")}
          accent="bg-green-100 text-green-900"
        />
        <KpiCard
          label="Mismatch"
          value={totals.mismatchCount}
          href={toggleHref("mismatch")}
          active={activeFilters.has("mismatch")}
          accent="bg-orange-100 text-orange-900"
        />
        <KpiCard
          label="Missing"
          value={totals.missingCount}
          href={toggleHref("missing")}
          active={activeFilters.has("missing")}
          accent="bg-red-100 text-red-900"
        />
        <KpiCard
          label="Unassigned"
          value={activeUnassignedCount}
          href="#unassigned"
          active={false}
          accent="bg-accent/15 text-accent-text"
        />
      </section>

      <BulkPaymentForm tenants={bulkTenants} defaultDate={today} admin={admin} />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <ServerSearchInput
          placeholder="Search by tenant, payer, unit, or room…"
          ariaLabel="Search reconciliation rows"
        />
        {newCount > 0 && (
          <Link
            href={toggleNewHref}
            title="Transactions posted from the most recent statement"
            className={`rounded-full border px-4 py-2 text-sm shadow-sm transition ${
              newActive
                ? "border-accent bg-accent text-white hover:bg-accent-dark"
                : "border-stone bg-white text-ink hover:bg-warm"
            }`}
          >
            {newActive ? "✓ " : ""}New ({newCount})
          </Link>
        )}
      </div>

      <section className="mt-4 rounded-2xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-warm text-left text-xs uppercase tracking-wide text-muted shadow-sm md:top-14">
            <tr>
              <th className="rounded-tl-2xl bg-warm px-5 py-3 font-medium">Tenant</th>
              <th className="bg-warm px-5 py-3 font-medium">Unit</th>
              <th className="bg-warm px-5 py-3 font-medium">Room</th>
              <th
                title="Monthly rent for the current month"
                className="bg-warm px-5 py-3 text-right font-medium"
              >
                Rent
              </th>
              <th className="bg-warm px-5 py-3 text-right font-medium">Paid</th>
              <th
                title="Total account balance from the running ledger"
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
              // Quick-ledger is offered to anyone who still owes, not only the
              // mismatch/missing rows.
              const owes = (balanceByTenancy.get(m.tenancy_id) ?? 0) > 0.005;
              return (
                <tr key={m.tenancy_id} className="h-16 border-t border-stone/40">
                  <td className="px-5 py-2">
                    {m.tenant_id ? (
                      <Link
                        href={`/tenants/${m.tenant_id}?from=reconciliation`}
                        className={
                          flagged
                            ? "text-red-700 hover:text-red-800"
                            : "text-ink hover:text-accent-text"
                        }
                      >
                        {m.tenant_name}
                      </Link>
                    ) : (
                      <span className="text-ink">{m.tenant_name}</span>
                    )}
                    {newTenancyIds.has(m.tenancy_id) && (
                      <span
                        className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-green-800"
                        title="Posted from the most recent statement"
                      >
                        New
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2 text-ink">{m.property_label ?? "—"}</td>
                  <td className="px-5 py-2 text-ink">{m.room_label ?? "—"}</td>
                  <td className="px-5 py-2 text-right tabular-nums text-ink">
                    {fmtMoney(m.expected_rent)}
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums text-ink">
                    {fmtMoney(m.actual_amount)}
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums">
                    <RunBalance n={balanceByTenancy.get(m.tenancy_id)} />
                  </td>
                  <td className="px-5 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATUS_PILL[m.status]}`}
                    >
                      {STATUS_LABEL[m.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(flagged || owes) && m.tenant_id && (
                      <LedgerQuickAdd
                        tenancyId={m.tenancy_id}
                        tenantId={m.tenant_id}
                        tenantName={m.tenant_name}
                        suggestedAmount={
                          // Prefill the current-month shortfall for flagged
                          // rows; for a matched-but-owing tenant, their
                          // outstanding balance is the more useful default.
                          flagged
                            ? Math.max(
                                0,
                                Math.round(
                                  (Number(m.expected_rent) -
                                    Number(m.actual_amount)) *
                                    100,
                                ) / 100,
                              )
                            : Math.max(
                                0,
                                Math.round(
                                  (balanceByTenancy.get(m.tenancy_id) ?? 0) * 100,
                                ) / 100,
                              )
                        }
                        canCharge={admin}
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
                  <Link href="/reconciliation" className="text-accent-text">
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

      <UnassignedSection
        rows={unassignedRows}
        tenants={assignTenants}
        ignoredPayers={ignoredPayers.map((p) => ({
          payerKey: p.payer_key,
          displayName: p.display_name,
        }))}
      />
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
