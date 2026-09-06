import Link from "next/link";
import { cache, Suspense } from "react";
import { getCachedClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { SearchInput } from "@/components/search-input";
import { TableSkeleton } from "@/components/section-skeletons";
import { isMaster, canEditLedger } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars, fetchTenantLedgers, tenantLedger } from "@/lib/rent-data";
import { todayISO } from "@/lib/date";
import {
  BalanceToggle,
  HistoryExplorer,
  type HistoryRow,
} from "./history-explorer";

export const dynamic = "force-dynamic";

type TenantRel = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
};
type PropertyRel = {
  id: string;
  building_name: string | null;
  street_address: string;
  unit_number: string;
  archived_at: string | null;
};
type RoomRel = {
  room_number: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};
type PaymentRel = {
  amount: number | string;
  paid_on: string;
  payment_type: string;
};

type Row = {
  id: string;
  tenant_id: string;
  monthly_rent: number;
  first_month_rent: number | null;
  security_deposit: number | null;
  start_date: string;
  move_out_date: string | null;
  paused_at: string | null;
  balance_dismissed_at: string | null;
  tenants: TenantRel | TenantRel[] | null;
  rooms: RoomRel | RoomRel[] | null;
  payments: PaymentRel[];
};

function monthsBetween(startISO: string, endISO: string | null) {
  if (!endISO) return null;
  const a = new Date(startISO + "T00:00:00Z");
  const b = new Date(endISO + "T00:00:00Z");
  const years = b.getUTCFullYear() - a.getUTCFullYear();
  const months = b.getUTCMonth() - a.getUTCMonth();
  const days = b.getUTCDate() - a.getUTCDate();
  let total = years * 12 + months;
  if (days < 0) total -= 1;
  return Math.max(0, total);
}

// One request-cached load shared by the header KPI card, the balance toggle,
// and the table section — each streams in as soon as this settles, without
// re-running the queries.
const loadHistory = cache(async () => {
  const supabase = await getCachedClient();
  // Moved-out tenants keep their running ledger balance here — money owed
  // at move-out must stay visible (dismissed from the Rent Tracker or not)
  // and gets resolved from the tenant's page.
  const [user, { data, error }, { charges, allocations, rentChanges }, tl] =
    await Promise.all([
      getSessionUser(),
      supabase
        .from("tenancies")
        .select(
          `id, tenant_id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at,
           balance_dismissed_at,
           tenants(id, full_name, email, phone),
           rooms(room_number,
                 properties(id, building_name, street_address, unit_number, archived_at)),
           payments(amount, paid_on, payment_type)`,
        )
        .eq("status", "ended")
        .order("move_out_date", { ascending: false, nullsFirst: false })
        .returns<Row[]>(),
      fetchLedgerSidecars(supabase),
      fetchTenantLedgers(supabase),
    ]);
  const today = todayISO();

  const rows: HistoryRow[] = (data ?? []).map((r) => {
    const tenant = one(r.tenants);
    const room = one(r.rooms);
    const property = one(room?.properties ?? null);
    const totalPaid = (r.payments ?? [])
      .filter(
        (p) =>
          (p.payment_type === "rent" || p.payment_type === "refund") &&
          p.paid_on <= today,
      )
      .reduce(
        (sum, p) =>
          sum + (p.payment_type === "refund" ? -1 : 1) * Number(p.amount),
        0,
      );
    const unit = property
      ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
      : "—";
    const tenantName = tenant?.full_name ?? "—";
    const roomNumber = room?.room_number ?? "—";
    return {
      groupLabel: property ? unit : "Unassigned",
      propertyId: property?.id ?? null,
      archived: !!property?.archived_at,
      id: r.id,
      tenant_id: r.tenant_id,
      tenant_name: tenantName,
      email: tenant?.email ?? null,
      unit,
      room: roomNumber,
      start_date: r.start_date,
      move_out_date: r.move_out_date,
      months: monthsBetween(r.start_date, r.move_out_date),
      monthly_rent: Number(r.monthly_rent),
      total_paid: totalPaid,
      dismissed: !!r.balance_dismissed_at,
      // One ledger per tenant: a former tenant's balance is their tenant-wide
      // position. If they moved to another room the balance lives on that
      // active tenancy, so their old room shows nothing owed here.
      balance: tl.activeTenants.has(r.tenant_id)
        ? 0
        : tenantLedger(tl, r.tenant_id, () =>
            computeLedger(
              r,
              r.payments ?? [],
              charges.get(r.id) ?? [],
              allocations.get(r.id) ?? [],
              today,
              rentChanges.get(r.id) ?? [],
            ),
          ).netBalance,
      haystack: [tenantName, tenant?.email, unit, roomNumber]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });

  const owing = rows.filter((r) => r.balance > 0.005);

  return {
    error,
    rows,
    owing,
    admin: isMaster(user?.email), // "Total paid" is admin-only
    canUndismiss: canEditLedger(user?.email),
  };
});

async function OutstandingCard() {
  const { owing } = await loadHistory();
  if (owing.length === 0) return null;
  const totalOutstanding = owing.reduce((s, r) => s + r.balance, 0);
  const dismissedOwing = owing.filter((r) => r.dismissed).length;
  return (
    <div className="rounded-2xl bg-white px-5 py-3 text-right shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">
        Outstanding balances
      </p>
      <p className="text-xl font-medium tabular-nums text-red-700">
        $
        {totalOutstanding.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })}
      </p>
      <p className="text-xs text-muted">
        {owing.length} past tenant{owing.length === 1 ? "" : "s"}
        {dismissedOwing > 0 ? ` · ${dismissedOwing} dismissed` : ""}
      </p>
    </div>
  );
}

async function BalanceToggleSlot() {
  const { owing } = await loadHistory();
  return <BalanceToggle owingCount={owing.length} />;
}

async function HistorySection() {
  const { error, rows, admin, canUndismiss } = await loadHistory();
  if (error) {
    return <p className="mt-6 text-sm text-red-700">{error.message}</p>;
  }
  return (
    <HistoryExplorer rows={rows} admin={admin} canUndismiss={canUndismiss} />
  );
}

export default function TenantHistoryPage() {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-6">
        <div>
          <Link
            href="/tenants"
            className="text-xs uppercase tracking-wide text-muted hover:text-ink"
          >
            ← Rent Tracker
          </Link>
          <h1 className="mt-2 text-3xl tracking-tight text-ink">
            Tenant <span className="font-display text-accent-text">history</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every tenant who has moved out, grouped by property — including
            properties since deleted from the portfolio.
          </p>
        </div>
        <Suspense fallback={null}>
          <OutstandingCard />
        </Suspense>
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <SearchInput
            placeholder="Search by name, email, unit, or room…"
            ariaLabel="Search tenant history"
          />
        </div>
        <Suspense fallback={null}>
          <BalanceToggleSlot />
        </Suspense>
      </div>

      <Suspense
        fallback={
          <div className="mt-6">
            <TableSkeleton rows={8} />
          </div>
        }
      >
        <HistorySection />
      </Suspense>
    </div>
  );
}
