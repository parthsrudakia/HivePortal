/**
 * Loads the two ledger side tables (ad-hoc charges + credit allocations) and
 * groups them by tenancy id, so callers can hand each tenancy's rows to
 * {@link computeLedger}. Both tables are small (a handful of rows per tenancy),
 * so a single fetch of each is cheaper than per-tenancy round-trips.
 */

import { cache } from "react";
import type { createClient } from "@/lib/supabase/server";
import {
  computeLedger,
  computeTenantLedger,
  type Ledger,
  type LedgerAllocation,
  type LedgerCharge,
  type RentChange,
  type TenancyLedgerInput,
} from "@/lib/rent";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

/**
 * Full charge row: the extra columns beyond what {@link computeLedger} needs
 * let callers also build line-by-line ledger entries (balance-reminder
 * breakdowns) and trace a utility overcharge back to its uploaded bill.
 */
export type LedgerChargeRow = LedgerCharge & {
  id: string;
  tenancy_id: string;
  charged_on: string;
  note: string | null;
  bill_id: string | null;
};

export type LedgerSidecars = {
  charges: Map<string, LedgerChargeRow[]>;
  allocations: Map<string, LedgerAllocation[]>;
  /** Rent-rate changes per tenancy — rent edits reprice future months only. */
  rentChanges: Map<string, RentChange[]>;
};

function groupByTenancy<T extends { tenancy_id: string }>(
  rows: T[] | null | undefined,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows ?? []) {
    const list = map.get(r.tenancy_id);
    if (list) list.push(r);
    else map.set(r.tenancy_id, [r]);
  }
  return map;
}

// cache() dedupes per request+client: /tenants used to fetch all three tables
// twice per render (page + reminder-info) — now the second call is free.
/**
 * One tenancy's full ledger position as of a date. Shared by
 * settleEndedBalance (move-out write-off) and transferTenancy (balance
 * carry to the new room); returns null when the tenancy doesn't exist.
 */
export async function loadTenancyNetBalance(
  supabase: SupabaseServer,
  tenancy_id: string,
  asOf: string,
): Promise<
  | (Ledger & {
      tenancy: {
        tenant_id: string;
        status: string;
        room_id: string | null;
      };
    })
  | null
> {
  const { data: t } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, room_id, status, monthly_rent, first_month_rent,
       security_deposit, start_date, move_out_date, paused_at,
       payments(amount, paid_on, payment_type)`,
    )
    .eq("id", tenancy_id)
    .maybeSingle();
  if (!t) return null;

  const { charges, allocations, rentChanges } =
    await fetchLedgerSidecars(supabase);
  const ledger = computeLedger(
    t,
    t.payments ?? [],
    charges.get(tenancy_id) ?? [],
    allocations.get(tenancy_id) ?? [],
    asOf,
    rentChanges.get(tenancy_id) ?? [],
  );
  return {
    ...ledger,
    tenancy: { tenant_id: t.tenant_id, status: t.status, room_id: t.room_id },
  };
}

export const fetchLedgerSidecars = cache(async (
  supabase: SupabaseServer,
): Promise<LedgerSidecars> => {
  const [{ data: charges }, { data: allocations }, { data: rentChanges }] =
    await Promise.all([
      supabase
        .from("tenancy_charges")
        .select("id, tenancy_id, kind, amount, charged_on, note, bill_id"),
      supabase.from("credit_allocations").select("tenancy_id, kind, amount"),
      supabase
        .from("tenancy_rent_history")
        .select("tenancy_id, effective_month, monthly_rent"),
    ]);
  return {
    charges: groupByTenancy<LedgerChargeRow>(charges),
    allocations: groupByTenancy<LedgerAllocation & { tenancy_id: string }>(
      allocations,
    ),
    rentChanges: groupByTenancy<RentChange & { tenancy_id: string }>(
      rentChanges,
    ),
  };
});

// ---------------------------------------------------------------------------
// Tenant-wide balances. A tenant has ONE ledger: every tenancy they've had
// (past rooms included) sums into a single position, so a room change never
// strands a balance on an old tenancy. Every "what does this tenant owe"
// surface — Rent Tracker, reminders, late fees, dashboard, reconciliation,
// the Telegram bot — reads from here rather than from one tenancy's ledger.
// ---------------------------------------------------------------------------

export type TenantLedgers = {
  /** Every tenancy's ledger inputs (payments, charges, unit label), by tenant id. */
  inputs: Map<string, TenancyLedgerInput[]>;
  /** The tenant-wide position — all tenancies summed — by tenant id. */
  ledgers: Map<string, Ledger>;
  /** Tenants who currently have an active tenancy. */
  activeTenants: Set<string>;
};

type TenantLedgerRow = {
  id: string;
  tenant_id: string;
  status: string;
  start_date: string;
  move_out_date: string | null;
  monthly_rent: number;
  first_month_rent: number | null;
  security_deposit: number | null;
  paused_at: string | null;
  rooms:
    | {
        room_number: string | null;
        properties:
          | { building_name: string | null; street_address: string; unit_number: string }
          | { building_name: string | null; street_address: string; unit_number: string }[]
          | null;
      }
    | {
        room_number: string | null;
        properties:
          | { building_name: string | null; street_address: string; unit_number: string }
          | { building_name: string | null; street_address: string; unit_number: string }[]
          | null;
      }[]
    | null;
  payments: {
    id: string;
    amount: number;
    paid_on: string;
    payment_type: string;
    notes: string | null;
  }[];
};

function unitLabelOf(row: TenantLedgerRow): string {
  const room = one(row.rooms);
  const p = one(room?.properties ?? null);
  if (!p) return "—";
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number} · ${
    room?.room_number ?? "—"
  }`;
}

/**
 * Load every tenancy (all statuses) with its payments and sidecars and fold
 * them into one ledger per tenant. One fetch per request (cache()), shared by
 * every consumer on the page.
 */
export const fetchTenantLedgers = cache(async (
  supabase: SupabaseServer,
  asOf?: string,
): Promise<TenantLedgers> => {
  const today = asOf ?? todayISO();
  const [{ data: rows }, { charges, allocations, rentChanges }] =
    await Promise.all([
      supabase
        .from("tenancies")
        .select(
          `id, tenant_id, status, start_date, move_out_date, monthly_rent,
           first_month_rent, security_deposit, paused_at,
           rooms(room_number, properties(building_name, street_address, unit_number)),
           payments(id, amount, paid_on, payment_type, notes)`,
        )
        .returns<TenantLedgerRow[]>(),
      fetchLedgerSidecars(supabase),
    ]);

  const inputs = new Map<string, TenancyLedgerInput[]>();
  const activeTenants = new Set<string>();
  for (const r of rows ?? []) {
    if (r.status === "active") activeTenants.add(r.tenant_id);
    const input: TenancyLedgerInput = {
      id: r.id,
      tenancy: r,
      unitLabel: unitLabelOf(r),
      payments: r.payments ?? [],
      charges: charges.get(r.id) ?? [],
      allocations: allocations.get(r.id) ?? [],
      rentChanges: rentChanges.get(r.id) ?? [],
    };
    const list = inputs.get(r.tenant_id);
    if (list) list.push(input);
    else inputs.set(r.tenant_id, [input]);
  }
  const ledgers = new Map<string, Ledger>();
  for (const [tenantId, list] of inputs) {
    ledgers.set(tenantId, computeTenantLedger(list, today));
  }
  return { inputs, ledgers, activeTenants };
});

/**
 * The tenant-wide ledger for a tenant, or `fallback()` (typically the one
 * tenancy's own ledger) when the tenant isn't in the map — e.g. a row the
 * caller can see that the tenant-wide fetch could not.
 */
export function tenantLedger(
  tl: TenantLedgers,
  tenantId: string | null | undefined,
  fallback: () => Ledger,
): Ledger {
  return (tenantId && tl.ledgers.get(tenantId)) || fallback();
}
