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

// ---------------------------------------------------------------------------
// Money integrity: a ledger is only ever computed from COMPLETE inputs.
//
// A failed or partial fetch of any ledger table used to degrade silently —
// `data ?? []` turned a transient 504 on the charges query into "this tenant
// has no charges", and every balance on the page understated what was owed.
// Every ledger read now goes through `ledgerRows`/`allLedgerRows`: a failed
// query is retried once (reads are idempotent), and if it still fails the
// whole render throws a LedgerDataError so the page shows an error instead
// of a wrong number. Full-table reads page through with an exact count so a
// PostgREST row cap can never truncate the ledger either.
// ---------------------------------------------------------------------------

export class LedgerDataError extends Error {
  constructor(what: string, reason: string) {
    super(`Ledger data unavailable (${what}): ${reason}`);
    this.name = "LedgerDataError";
  }
}

type RowsResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
};

/** Retry once after a short pause; ledger reads are idempotent GETs. */
const LEDGER_FETCH_ATTEMPTS = 2;
const LEDGER_RETRY_DELAY_MS = 300;
/** Page size for full-table ledger reads (PostgREST default max-rows). */
const LEDGER_PAGE_SIZE = 1000;

async function attemptRows<T>(
  run: () => PromiseLike<RowsResult<T>>,
): Promise<{ rows: T[]; count: number | null } | { failure: string }> {
  try {
    const { data, error, count } = await run();
    if (error) return { failure: error.message };
    if (!data) return { failure: "empty response" };
    return { rows: data, count: count ?? null };
  } catch (e) {
    return { failure: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Run a ledger read that must succeed. Returns the rows, or throws a
 * LedgerDataError after one retry — never an empty array in place of data.
 */
export async function ledgerRows<T>(
  what: string,
  run: () => PromiseLike<RowsResult<T>>,
): Promise<T[]> {
  return (await ledgerRowsCounted(what, run)).rows;
}

async function ledgerRowsCounted<T>(
  what: string,
  run: () => PromiseLike<RowsResult<T>>,
): Promise<{ rows: T[]; count: number | null }> {
  let failure = "unknown error";
  for (let attempt = 1; attempt <= LEDGER_FETCH_ATTEMPTS; attempt++) {
    const result = await attemptRows(run);
    if ("rows" in result) return result;
    failure = result.failure;
    if (attempt < LEDGER_FETCH_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, LEDGER_RETRY_DELAY_MS));
    }
  }
  throw new LedgerDataError(what, failure);
}

/**
 * Read an ENTIRE table (or filtered set) for the ledger, paging with an
 * exact count so a server-side row cap can never silently truncate it.
 * `build` must select with `{ count: "exact" }`, apply a stable order, and
 * use the `range(from, to)` it is handed.
 */
export async function allLedgerRows<T>(
  what: string,
  build: (from: number, to: number) => PromiseLike<RowsResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  let expected: number | null = null;
  for (let from = 0; ; from += LEDGER_PAGE_SIZE) {
    const { rows, count } = await ledgerRowsCounted(what, () =>
      build(from, from + LEDGER_PAGE_SIZE - 1),
    );
    if (expected === null) {
      if (count === null) {
        throw new LedgerDataError(what, "server returned no row count");
      }
      expected = count;
    }
    out.push(...rows);
    if (out.length >= expected) break;
    if (rows.length === 0) {
      throw new LedgerDataError(
        what,
        `only ${out.length} of ${expected} rows were returned`,
      );
    }
  }
  if (out.length !== expected) {
    throw new LedgerDataError(
      what,
      `expected ${expected} rows, received ${out.length}`,
    );
  }
  return out;
}

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
  // A missing tenancy is a legitimate null; a failed query is not.
  const [t] = await ledgerRows("tenancy", () =>
    supabase
      .from("tenancies")
      .select(
        `id, tenant_id, room_id, status, monthly_rent, first_month_rent,
         security_deposit, start_date, move_out_date, paused_at,
         payments(amount, paid_on, payment_type)`,
      )
      .eq("id", tenancy_id)
      .limit(1),
  );
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
  const [charges, allocations, rentChanges] = await Promise.all([
    allLedgerRows("charges", (from, to) =>
      supabase
        .from("tenancy_charges")
        .select("id, tenancy_id, kind, amount, charged_on, note, bill_id", {
          count: "exact",
        })
        .order("id")
        .range(from, to),
    ),
    allLedgerRows("credit allocations", (from, to) =>
      supabase
        .from("credit_allocations")
        .select("tenancy_id, kind, amount", { count: "exact" })
        .order("id")
        .range(from, to),
    ),
    allLedgerRows("rent history", (from, to) =>
      supabase
        .from("tenancy_rent_history")
        .select("tenancy_id, effective_month, monthly_rent", {
          count: "exact",
        })
        .order("id")
        .range(from, to),
    ),
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
  const [rows, { charges, allocations, rentChanges }] = await Promise.all([
    allLedgerRows("tenancies", (from, to) =>
      supabase
        .from("tenancies")
        .select(
          `id, tenant_id, status, start_date, move_out_date, monthly_rent,
           first_month_rent, security_deposit, paused_at,
           rooms(room_number, properties(building_name, street_address, unit_number)),
           payments(id, amount, paid_on, payment_type, notes)`,
          { count: "exact" },
        )
        .order("id")
        .range(from, to)
        .returns<TenantLedgerRow[]>(),
    ),
    fetchLedgerSidecars(supabase),
  ]);

  const inputs = new Map<string, TenancyLedgerInput[]>();
  const activeTenants = new Set<string>();
  for (const r of rows) {
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
