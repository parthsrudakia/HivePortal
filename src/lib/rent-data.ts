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
  type Ledger,
  type LedgerAllocation,
  type LedgerCharge,
  type RentChange,
} from "@/lib/rent";

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
