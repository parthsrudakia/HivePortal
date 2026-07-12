import type { SupabaseClient } from "@supabase/supabase-js";
import { one } from "@/lib/relations";
import {
  aggregateByDescription,
  unmatchedDeposits,
  tenantKey,
  type Deposit,
} from "@/lib/reconciliation/parsers";
import { rateForMonthISO, type RentChange } from "@/lib/rent";

// The matching engine shared by the reconciliation server actions (create /
// assign) and the run page, which re-derives a run's matches on view so the
// stored snapshot never goes stale. Lives outside actions.ts because a
// "use server" module can only export public action endpoints.

export function monthBounds(monthIso: string): { start: string; end: string } {
  const [y, m] = monthIso.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

// What a tenancy owes in the reconciliation month. Mirrors the Rent Tracker's
// dueForMonth: a tenancy in its starting month with a prorated first_month_rent
// owes that, not a full month — otherwise it would falsely show as a mismatch.
// Bills the rate in effect THAT month (tenancy_rent_history), so reconciling
// an old month is unaffected by rent changes made since.
export function expectedForMonth(
  startDate: string,
  monthlyRent: number,
  firstMonthRent: number | null,
  monthStart: string,
  monthEnd: string,
  rentChanges: RentChange[],
): number {
  if (startDate > monthEnd) return 0;
  if (
    startDate >= monthStart &&
    startDate <= monthEnd &&
    firstMonthRent !== null
  ) {
    return firstMonthRent;
  }
  return rateForMonthISO(monthStart, monthlyRent, rentChanges);
}

export type TenancyInfo = {
  id: string;
  tenant_id: string | null;
  tenant_name: string;
  pays_as: string | null;
  full_name: string;
  monthly_rent: number;
  first_month_rent: number | null;
  start_date: string;
  property_label: string | null;
  room_label: string | null;
  rent_changes: RentChange[];
  /** Remembered payer keys for this tenant (tenant_payer_aliases). */
  alias_keys: string[];
  /** Rent recorded in the system for this month outside a bank posting. */
  recorded_paid: number;
};

// Every tenancy that overlapped the reconciliation month — including ones that
// ENDED mid-month (status 'ended' with a move_out_date inside the window), which
// the old active-only filter dropped, leaving their payments unattributed.
export async function loadMonthTenancies(
  supabase: SupabaseClient,
  monthStart: string,
  monthEnd: string,
): Promise<{ tenancies: TenancyInfo[]; error?: string }> {
  type TenantRel = { id: string; full_name: string; pays_as: string | null };
  type PropertyRel = {
    building_name: string | null;
    street_address: string;
    unit_number: string;
  };
  type RoomRel = {
    room_number: string | null;
    properties: PropertyRel | PropertyRel[] | null;
  };
  type TenancyRow = {
    id: string;
    tenant_id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    start_date: string;
    move_out_date: string | null;
    tenants: TenantRel | TenantRel[] | null;
    rooms: RoomRel | RoomRel[] | null;
  };
  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, monthly_rent, first_month_rent, start_date, move_out_date,
       tenants(id, full_name, pays_as),
       rooms(room_number,
             properties(building_name, street_address, unit_number))`,
    )
    .in("status", ["active", "ended"])
    .lte("start_date", monthEnd)
    .or(`move_out_date.is.null,move_out_date.gte.${monthStart}`)
    .returns<TenancyRow[]>();
  if (error) return { tenancies: [], error: error.message };

  // Rent-rate history for these tenancies, so the month bills the rate that
  // was in effect back then rather than today's monthly_rent. Accessed via
  // `as any` because the table post-dates the generated types (rent-data.ts).
  const ids = (data ?? []).map((t) => t.id);
  const changesByTenancy = new Map<string, RentChange[]>();
  if (ids.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const { data: histRows } = await sb
      .from("tenancy_rent_history")
      .select("tenancy_id, effective_month, monthly_rent")
      .in("tenancy_id", ids);
    for (const r of histRows ?? []) {
      const list = changesByTenancy.get(r.tenancy_id);
      const change = {
        effective_month: r.effective_month,
        monthly_rent: r.monthly_rent,
      };
      if (list) list.push(change);
      else changesByTenancy.set(r.tenancy_id, [change]);
    }
  }

  // Rent already recorded in the system for this month outside a bank
  // posting (manual entries, Zelle recorded on the tenant page, …). These
  // count toward a tenancy's "actual" so a tenant who paid through another
  // channel isn't shown as missing. Bank-posted payments are excluded
  // (external_ref set) — their deposits are already in the run, and counting
  // both would double the money.
  const paidByTenancy = new Map<string, number>();
  if (ids.length > 0) {
    const { data: payRows } = await supabase
      .from("payments")
      .select("tenancy_id, amount")
      .eq("payment_type", "rent")
      .is("external_ref", null)
      .gte("paid_on", monthStart)
      .lte("paid_on", monthEnd)
      .in("tenancy_id", ids);
    for (const p of payRows ?? []) {
      paidByTenancy.set(
        p.tenancy_id,
        (paidByTenancy.get(p.tenancy_id) ?? 0) + Number(p.amount),
      );
    }
  }

  // Remembered payer aliases (operator assigned a deposit to this tenant in
  // an earlier run) — those payer keys match the tenant automatically.
  const tenantIds = [
    ...new Set((data ?? []).map((t) => t.tenant_id).filter(Boolean)),
  ];
  const aliasesByTenant = new Map<string, string[]>();
  if (tenantIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const { data: aliasRows } = await sb
      .from("tenant_payer_aliases")
      .select("tenant_id, payer_key")
      .in("tenant_id", tenantIds);
    for (const r of aliasRows ?? []) {
      const list = aliasesByTenant.get(r.tenant_id);
      if (list) list.push(r.payer_key);
      else aliasesByTenant.set(r.tenant_id, [r.payer_key]);
    }
  }

  const tenancies = (data ?? [])
    .map((t): TenancyInfo | null => {
      const tenant = one(t.tenants);
      if (!tenant) return null;
      const room = one(t.rooms);
      const property = one(room?.properties ?? null);
      return {
        id: t.id,
        tenant_id: tenant.id,
        tenant_name: tenant.full_name,
        pays_as: tenant.pays_as,
        full_name: tenant.full_name,
        monthly_rent: Number(t.monthly_rent),
        first_month_rent:
          t.first_month_rent != null ? Number(t.first_month_rent) : null,
        start_date: t.start_date,
        property_label: property
          ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
          : null,
        room_label: room?.room_number ?? null,
        rent_changes: changesByTenancy.get(t.id) ?? [],
        alias_keys: aliasesByTenant.get(tenant.id) ?? [],
        recorded_paid: paidByTenancy.get(t.id) ?? 0,
      };
    })
    .filter((t): t is TenancyInfo => t !== null);
  return { tenancies };
}

export type MatchRow = {
  run_id: string;
  tenancy_id: string;
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

// Every payer key a tenancy answers to: its pays_as/full-name key plus each
// remembered alias of its tenant (operator-assigned in an earlier run).
function keysOf(t: TenancyInfo): string[] {
  return [...new Set([tenantKey(t.pays_as, t.full_name), ...t.alias_keys])];
}

// Pure matcher shared by the initial run and by recompute-after-assign. Sums
// deposits by payer key — plus rent recorded outside a bank posting — and
// lines the total up against each tenancy's expected rent.
export function buildMatches(
  deposits: Deposit[],
  tenancies: TenancyInfo[],
  monthStart: string,
  monthEnd: string,
  runId: string,
) {
  const aggregate = aggregateByDescription(deposits);
  const matches: MatchRow[] = [];
  const claimedKeys = new Set<string>();
  const tenancyByKey = new Map<string, string>();
  let totalExpected = 0;
  let totalActual = 0;
  let matchCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;

  // Two tenancies can share a payer key (a tenant who moved rooms mid-month,
  // or two tenants with identical names). The deposits are one pot of money —
  // credit it to ONE tenancy (the most recent, deterministically) instead of
  // showing the full sum on every row and double-counting the totals.
  const ordered = [...tenancies].sort((a, b) =>
    b.start_date.localeCompare(a.start_date),
  );
  const keyClaimedBy = new Map<string, string>();
  for (const t of ordered) {
    for (const k of keysOf(t)) {
      if (!keyClaimedBy.has(k)) keyClaimedBy.set(k, t.id);
    }
  }

  for (const t of tenancies) {
    const rawKey = tenantKey(t.pays_as, t.full_name);
    const expected = expectedForMonth(
      t.start_date,
      t.monthly_rent,
      t.first_month_rent,
      monthStart,
      monthEnd,
      t.rent_changes,
    );
    // Sum the deposits under every key this tenancy claims — a tenant can pay
    // under their own name one month and a remembered alias the next.
    let actual = 0;
    for (const k of keysOf(t)) {
      if (keyClaimedBy.get(k) !== t.id) continue;
      const sum = aggregate.get(k) ?? 0;
      if (sum > 0) {
        actual += sum;
        claimedKeys.add(k);
        tenancyByKey.set(k, t.id);
      }
    }
    // Plus rent already recorded in the system for this month outside a bank
    // posting — a tenant who paid through another channel isn't missing.
    actual += t.recorded_paid;

    const difference = actual - expected;
    let status: MatchRow["status"];
    if (actual <= 0) status = "missing";
    else if (Math.abs(difference) < 0.01) status = "match";
    else status = "mismatch";

    totalExpected += expected;
    totalActual += actual;
    if (status === "match") matchCount++;
    else if (status === "mismatch") mismatchCount++;
    else missingCount++;

    matches.push({
      run_id: runId,
      tenancy_id: t.id,
      tenant_id: t.tenant_id,
      tenant_name: t.tenant_name,
      pays_as: rawKey,
      property_label: t.property_label,
      room_label: t.room_label,
      expected_rent: expected,
      actual_amount: actual,
      difference,
      status,
    });
  }

  const unmatched = unmatchedDeposits(deposits, claimedKeys);
  return {
    matches,
    tenancyByKey,
    unmatched,
    totals: {
      totalExpected,
      totalActual,
      matchCount,
      mismatchCount,
      missingCount,
    },
  };
}

// A match row's identity for change detection, independent of row id and
// insertion order. Amounts are compared at cent precision.
function matchSignature(rows: MatchRow[]): string {
  const cents = (n: number) => Math.round(Number(n) * 100);
  return JSON.stringify(
    rows
      .map((m) =>
        [
          m.tenancy_id,
          m.tenant_id ?? "",
          m.tenant_name,
          m.pays_as,
          m.property_label ?? "",
          m.room_label ?? "",
          cents(m.expected_rent),
          cents(m.actual_amount),
          m.status,
        ].join("|"),
      )
      .sort(),
  );
}

/**
 * Re-derive a run's matches, totals, and unmatched list from its saved
 * deposits against CURRENT tenancy/payment data. Called after an operator
 * assigns a deposit and on every run-page view, so the stored snapshot
 * always reflects payments recorded (or removed) since the run was created.
 * When nothing changed it's read-only — no rewrite, so match row ids stay
 * stable across background refreshes.
 */
export async function recomputeRun(supabase: SupabaseClient, runId: string) {
  const { data: run } = await supabase
    .from("reconciliation_runs")
    .select("month, unmatched_deposits")
    .eq("id", runId)
    .maybeSingle<{ month: string; unmatched_deposits: unknown }>();
  if (!run) throw new Error("Run not found.");
  const { start, end } = monthBounds(run.month);

  const { data: depRows, error: depErr } = await supabase
    .from("reconciliation_deposits")
    .select(
      "payer_key, raw_description, amount, deposit_date, external_ref, tenancy_id",
    )
    .eq("run_id", runId);
  if (depErr) throw new Error(`Failed to load deposits: ${depErr.message}`);

  const deposits: Deposit[] = (depRows ?? []).map((d) => ({
    description: d.payer_key,
    raw: d.raw_description ?? "",
    amount: Number(d.amount),
    date: d.deposit_date,
    source: "bank",
    externalRef: d.external_ref,
  }));

  const { tenancies, error: tErr } = await loadMonthTenancies(
    supabase,
    start,
    end,
  );
  if (tErr) throw new Error(`Failed to load tenancies: ${tErr}`);

  const { matches, tenancyByKey, unmatched, totals } = buildMatches(
    deposits,
    tenancies,
    start,
    end,
    runId,
  );

  // Re-point deposits whose tenancy mapping changed (an assign, a pays_as
  // edit, a tenant moving rooms). Unchanged keys are left alone.
  const staleKeys = new Set<string>();
  for (const d of depRows ?? []) {
    if ((d.tenancy_id ?? null) !== (tenancyByKey.get(d.payer_key) ?? null)) {
      staleKeys.add(d.payer_key);
    }
  }
  for (const key of staleKeys) {
    await supabase
      .from("reconciliation_deposits")
      .update({ tenancy_id: tenancyByKey.get(key) ?? null })
      .eq("run_id", runId)
      .eq("payer_key", key);
  }

  // Rewrite matches and run totals only when the result actually differs from
  // what's stored.
  const { data: existing } = await supabase
    .from("reconciliation_matches")
    .select(
      `run_id, tenancy_id, tenant_id, tenant_name, pays_as,
       property_label, room_label, expected_rent, actual_amount, difference, status`,
    )
    .eq("run_id", runId)
    .returns<MatchRow[]>();
  const unchanged =
    matchSignature(existing ?? []) === matchSignature(matches) &&
    JSON.stringify(run.unmatched_deposits ?? []) ===
      JSON.stringify(unmatched ?? []);
  if (unchanged && staleKeys.size === 0) return;

  await supabase.from("reconciliation_matches").delete().eq("run_id", runId);
  if (matches.length > 0) {
    const { error: mErr } = await supabase
      .from("reconciliation_matches")
      .insert(matches);
    if (mErr) throw new Error(`Failed to rewrite matches: ${mErr.message}`);
  }

  await supabase
    .from("reconciliation_runs")
    .update({
      total_expected: totals.totalExpected,
      total_actual: totals.totalActual,
      match_count: totals.matchCount,
      mismatch_count: totals.mismatchCount,
      missing_count: totals.missingCount,
      unmatched_deposits: unmatched,
    })
    .eq("id", runId);
}
