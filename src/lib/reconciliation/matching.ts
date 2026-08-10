import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";
import { tenantKey, type Deposit } from "@/lib/reconciliation/parsers";
import { rateForMonthISO, type RentChange } from "@/lib/rent";

// The matching engine behind the continuous reconciliation: payer-key
// auto-matching happens once at statement-ingest time (buildPayerIndex /
// autoAssign), and the /reconciliation page derives the current month's
// match table live from tenancies + posted payments (computeMonthMatches).
// Lives outside actions.ts because a "use server" module can only export
// public action endpoints.

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
  pausedAt: string | null = null,
): number {
  if (startDate > monthEnd) return 0;
  // Paused tenancies expect nothing for months that begin after the pause —
  // mirrors rentDue's freeze so recon and the ledger agree.
  if (pausedAt && monthStart >= pausedAt.slice(0, 10)) return 0;
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
  paused_at: string | null;
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
  supabase: SupabaseClient<Database>,
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
    paused_at: string | null;
    tenants: TenantRel | TenantRel[] | null;
    rooms: RoomRel | RoomRel[] | null;
  };
  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, monthly_rent, first_month_rent, start_date, move_out_date, paused_at,
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
  // was in effect back then rather than today's monthly_rent (rent-data.ts).
  const ids = (data ?? []).map((t) => t.id);
  const changesByTenancy = new Map<string, RentChange[]>();
  if (ids.length > 0) {
    const { data: histRows } = await supabase
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
    const { data: aliasRows } = await supabase
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
        paused_at: t.paused_at,
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

/** Payer keys marked "not rent" (personal transfers, other ventures) —
 *  excluded from every run's unmatched list. */
export async function loadIgnoredPayerKeys(
  supabase: SupabaseClient<Database>,
): Promise<Set<string>> {
  const { data } = await supabase.from("ignored_payers").select("payer_key");
  return new Set(
    ((data ?? []) as { payer_key: string }[]).map((r) => r.payer_key),
  );
}


// ---------------------------------------------------------------------------
// Ingest-time auto-matching. Runs once per uploaded statement: each deposit's
// payer key is resolved to a tenancy (or left null for the unassigned list),
// and matched deposits post to the ledger immediately. There is deliberately
// NO month filter here — a tenancy that starts after the deposit's month is a
// legitimate target (prepayment), which the old per-month runs excluded.
// ---------------------------------------------------------------------------

export type PayerTenancy = {
  tenancy_id: string;
  status: "active" | "ended";
  start_date: string;
  /** Every payer key this tenancy answers to: tenantKey(pays_as, full_name)
   *  plus each remembered tenant_payer_aliases key. */
  keys: string[];
};

/** All tenancies a payer key could resolve to, with their match keys. */
export async function loadPayerTenancies(
  supabase: SupabaseClient<Database>,
): Promise<{ rows: PayerTenancy[]; error?: string }> {
  type TenantRel = { id: string; full_name: string; pays_as: string | null };
  const { data, error } = await supabase
    .from("tenancies")
    .select("id, tenant_id, status, start_date, tenants(id, full_name, pays_as)")
    .in("status", ["active", "ended"])
    .returns<
      {
        id: string;
        tenant_id: string;
        status: "active" | "ended";
        start_date: string;
        tenants: TenantRel | TenantRel[] | null;
      }[]
    >();
  if (error) return { rows: [], error: error.message };

  const tenantIds = [...new Set((data ?? []).map((t) => t.tenant_id))];
  const aliasesByTenant = new Map<string, string[]>();
  if (tenantIds.length > 0) {
    const { data: aliasRows } = await supabase
      .from("tenant_payer_aliases")
      .select("tenant_id, payer_key")
      .in("tenant_id", tenantIds);
    for (const r of aliasRows ?? []) {
      const list = aliasesByTenant.get(r.tenant_id);
      if (list) list.push(r.payer_key);
      else aliasesByTenant.set(r.tenant_id, [r.payer_key]);
    }
  }

  const rows = (data ?? []).flatMap((t): PayerTenancy[] => {
    const tenant = one(t.tenants);
    if (!tenant) return [];
    return [
      {
        tenancy_id: t.id,
        status: t.status,
        start_date: t.start_date,
        keys: [
          ...new Set([
            tenantKey(tenant.pays_as, tenant.full_name),
            ...(aliasesByTenant.get(t.tenant_id) ?? []),
          ]),
        ],
      },
    ];
  });
  return { rows };
}

/** payer key → tenancy id. Contested keys (a tenant who moved rooms, two
 *  tenants with identical names) go to one tenancy deterministically:
 *  active beats ended, then the latest start_date. */
export function buildPayerIndex(rows: PayerTenancy[]): Map<string, string> {
  const ordered = [...rows].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return b.start_date.localeCompare(a.start_date);
  });
  const index = new Map<string, string>();
  for (const t of ordered) {
    for (const k of t.keys) {
      if (!index.has(k)) index.set(k, t.tenancy_id);
    }
  }
  return index;
}

/** Resolve each deposit to a tenancy (null = lands in the unassigned list).
 *  Ignored payers never auto-assign — their money isn't rent until an
 *  operator explicitly says otherwise. */
export function autoAssign(
  deposits: Deposit[],
  index: Map<string, string>,
  ignoredKeys: Set<string> = new Set(),
): (Deposit & { tenancyId: string | null })[] {
  return deposits.map((d) => ({
    ...d,
    tenancyId: ignoredKeys.has(d.description)
      ? null
      : (index.get(d.description) ?? null),
  }));
}

// ---------------------------------------------------------------------------
// Current-month match table. Posting is immediate, so the payments table is
// the source of truth for "collected" — no stored snapshot to go stale.
// ---------------------------------------------------------------------------

export type MonthTotals = {
  totalExpected: number;
  totalActual: number;
  matchCount: number;
  mismatchCount: number;
  missingCount: number;
};

/** Line the month's tenancies up against what the bank actually delivered
 *  (bankPaidByTenancy = posted external_ref payments in the month window,
 *  summed per tenancy). recorded_paid (manual entries) counts too, exactly
 *  as the per-month runs did. */
export function computeMonthMatches(
  tenancies: TenancyInfo[],
  bankPaidByTenancy: Map<string, number>,
  monthStart: string,
  monthEnd: string,
): { matches: MatchRow[]; totals: MonthTotals } {
  const matches: MatchRow[] = [];
  let totalExpected = 0;
  let totalActual = 0;
  let matchCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;

  for (const t of tenancies) {
    const expected = expectedForMonth(
      t.start_date,
      t.monthly_rent,
      t.first_month_rent,
      monthStart,
      monthEnd,
      t.rent_changes,
      t.paused_at,
    );
    const actual = (bankPaidByTenancy.get(t.id) ?? 0) + t.recorded_paid;
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
      tenancy_id: t.id,
      tenant_id: t.tenant_id,
      tenant_name: t.tenant_name,
      pays_as: tenantKey(t.pays_as, t.full_name),
      property_label: t.property_label,
      room_label: t.room_label,
      expected_rent: expected,
      actual_amount: actual,
      difference,
      status,
    });
  }

  return {
    matches,
    totals: {
      totalExpected,
      totalActual,
      matchCount,
      mismatchCount,
      missingCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Fingerprint hygiene for rows without a Conf#. Identical rows (same date,
// raw text, amount) are distinguished by an occurrence ordinal so two real
// same-day cash rows both survive, while a re-uploaded copy of an already-
// stored row is recognised as a duplicate. Historical refs used a
// `:{month}:{ordinal}` suffix; new refs use plain `:{ordinal}` — both formats
// are consulted so a re-upload can't sneak past the dedupe in either era.
// ---------------------------------------------------------------------------

const LEGACY_ORDINAL_RE = /^(.*):(\d{4}-\d{2}-\d{2}):(\d+)$/;
const ORDINAL_RE = /^(.*):(\d+)$/;

function existingOrdinals(existingRefs: Iterable<string>): Map<string, Set<number>> {
  const byBase = new Map<string, Set<number>>();
  const add = (base: string, n: number) => {
    const set = byBase.get(base);
    if (set) set.add(n);
    else byBase.set(base, new Set([n]));
  };
  for (const ref of existingRefs) {
    const legacy = ref.match(LEGACY_ORDINAL_RE);
    if (legacy) {
      add(legacy[1], Number(legacy[3]));
      continue;
    }
    const plain = ref.match(ORDINAL_RE);
    if (plain) add(plain[1], Number(plain[2]));
  }
  return byBase;
}

/** Prepare an upload's deposits for ingest: drop repeated Conf# rows within
 *  the file, and give synthetic-fingerprint rows their occurrence ordinal —
 *  skipping occurrences already stored (in either ref format) so overlapping
 *  exports never double-post a dateless-format row. Conf# rows already in the
 *  database are left in place for the ingest RPC's ON CONFLICT to count. */
export function assignSyntheticOrdinals(
  deposits: Deposit[],
  existingRefs: Iterable<string>,
): { deposits: Deposit[]; duplicates: number } {
  const taken = existingOrdinals(existingRefs);
  const seenConf = new Set<string>();
  const occurrence = new Map<string, number>();
  const out: Deposit[] = [];
  let duplicates = 0;

  for (const d of deposits) {
    if (d.externalRef.startsWith("zelle:")) {
      if (seenConf.has(d.externalRef)) {
        duplicates++;
        continue;
      }
      seenConf.add(d.externalRef);
      out.push(d);
      continue;
    }
    const n = (occurrence.get(d.externalRef) ?? 0) + 1;
    occurrence.set(d.externalRef, n);
    if (taken.get(d.externalRef)?.has(n)) {
      duplicates++;
      continue;
    }
    out.push({ ...d, externalRef: `${d.externalRef}:${n}` });
  }
  return { deposits: out, duplicates };
}
