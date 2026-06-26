import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { SearchInput } from "@/components/search-input";
import { BalanceFilter } from "./balance-filter";
import { processExpiredTenancies } from "./actions";
import {
  TenantGroups,
  type DisplayGroup,
  type DisplayRow,
} from "./tenant-groups";
import { RentReminderButton } from "./rent-reminder-button";
import { getReminderInfo } from "./reminder-info";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { todayISO } from "@/lib/date";

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
};
type RoomRel = {
  id: string;
  room_number: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};

type Row = {
  id: string;
  monthly_rent: number;
  first_month_rent: number | null;
  security_deposit: number | null;
  start_date: string;
  move_out_date: string | null;
  tenant_id: string;
  tenants: TenantRel | TenantRel[] | null;
  rooms: RoomRel | RoomRel[] | null;
  payments: {
    id: string;
    amount: number;
    paid_on: string;
    payment_type: string;
  }[];
};


function fmtMoney(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function endOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
    .toISOString()
    .slice(0, 10);
}

/**
 * What's owed for a single tenancy in the given calendar month.
 *  • Tenancy starts after this month → 0 (shouldn't happen here since we
 *    only fetch active tenancies, but defensive).
 *  • Starting month AND tenancy has first_month_rent set → use that.
 *  • Otherwise → monthly_rent (full month).
 */
function dueForMonth(
  startDate: string,
  monthlyRent: number,
  firstMonthRent: number | null,
  monthStart: string,
  monthEnd: string,
): number {
  if (startDate > monthEnd) return 0;
  const isStartingMonth = startDate >= monthStart && startDate <= monthEnd;
  if (isStartingMonth && firstMonthRent !== null) {
    return firstMonthRent;
  }
  return monthlyRent;
}

type PageProps = { searchParams: Promise<{ q?: string; owing?: string }> };

export default async function TenantsPage({ searchParams }: PageProps) {
  const { q, owing } = await searchParams;
  const query = (q ?? "").trim().toLowerCase();
  const owingOnly = owing === "1";

  // Finalize any tenancies whose move_out_date has passed since the last visit.
  await processExpiredTenancies();

  const supabase = await createClient();
  const monthStart = startOfMonth();
  const monthEnd = endOfMonth();

  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, tenant_id,
       tenants(id, full_name, email, phone),
       rooms(id, room_number,
             properties(id, building_name, street_address, unit_number)),
       payments(id, amount, paid_on, payment_type)`,
    )
    .eq("status", "active")
    .order("start_date", { ascending: false })
    .returns<Row[]>();

  const rows = data ?? [];

  // Ad-hoc charges + credit allocations feed the running ledger balance.
  const { charges, allocations } = await fetchLedgerSidecars(supabase);
  const today = todayISO();

  // Per row we keep the *this-month* operational figures (Due / Paid, mirrored
  // by the portfolio KPIs and progress bar) but the Balance column now shows
  // the running net ledger balance, which carries arrears/credit across months.
  const rowsWithStatus = rows.map((row) => {
    const paidThisMonth = (row.payments ?? [])
      .filter(
        (p) =>
          p.payment_type === "rent" &&
          p.paid_on >= monthStart &&
          p.paid_on <= monthEnd,
      )
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const due = dueForMonth(
      row.start_date,
      Number(row.monthly_rent),
      row.first_month_rent !== null ? Number(row.first_month_rent) : null,
      monthStart,
      monthEnd,
    );
    const ledger = computeLedger(
      row,
      row.payments ?? [],
      charges.get(row.id) ?? [],
      allocations.get(row.id) ?? [],
      today,
    );
    return { ...row, paidThisMonth, balance: ledger.netBalance, due };
  });
  const expectedTotal = rowsWithStatus.reduce((s, r) => s + r.due, 0);
  const paidTotal = rowsWithStatus.reduce((s, r) => s + r.paidThisMonth, 0);
  const outstandingTotal = rowsWithStatus.reduce(
    (s, r) => s + Math.max(0, r.balance),
    0,
  );

  const visibleRows = rowsWithStatus.filter((r) => {
    if (owingOnly && r.balance <= 0) return false;
    if (!query) return true;
    const tenant = one(r.tenants);
    const room = one(r.rooms);
    const property = one(room?.properties ?? null);
    const haystack = [
      tenant?.full_name,
      tenant?.email,
      tenant?.phone,
      room?.room_number,
      property?.building_name,
      property?.street_address,
      property?.unit_number,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  // Group active tenancies by property for the collapsible list. Capture the
  // property id so the group header can link to that property's page.
  const groupsMap = new Map<
    string,
    { propertyId: string | null; rows: DisplayRow[] }
  >();
  for (const r of visibleRows) {
    const tenant = one(r.tenants);
    const room = one(r.rooms);
    const p = one(room?.properties ?? null);
    const key = p
      ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
      : "Unassigned";
    if (!groupsMap.has(key))
      groupsMap.set(key, { propertyId: p?.id ?? null, rows: [] });
    groupsMap.get(key)!.rows.push({
      id: r.id,
      tenant_id: r.tenant_id,
      tenant_name: tenant?.full_name ?? "—",
      tenant_email: tenant?.email ?? null,
      move_out_date: r.move_out_date,
      room_number: room?.room_number ?? null,
      due: r.due,
      paid: r.paidThisMonth,
      balance: r.balance,
    });
  }
  const groups: DisplayGroup[] = Array.from(groupsMap.entries())
    .sort(([a], [b]) =>
      a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b),
    )
    .map(([label, g]) => {
      // Order rooms within a unit by room number (numeric-aware so "10" sorts
      // after "2"); rows missing a room number fall to the bottom.
      g.rows.sort((a, b) => {
        if (a.room_number == null) return b.room_number == null ? 0 : 1;
        if (b.room_number == null) return -1;
        return a.room_number.localeCompare(b.room_number, undefined, {
          numeric: true,
        });
      });
      const subDue = g.rows.reduce((s, r) => s + r.due, 0);
      const subPaid = g.rows.reduce((s, r) => s + r.paid, 0);
      const subBalance = g.rows.reduce((s, r) => s + r.balance, 0);
      return {
        label,
        propertyId: g.propertyId,
        rows: g.rows,
        subDue,
        subPaid,
        subBalance,
      };
    });

  // Reminder button state (outstanding count + last-sent note), shared with
  // the reconciliation run page.
  const { outstandingCount, lastGeneralText, lastBalanceText } =
    await getReminderInfo(supabase);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-6">
        <div>
          <h1 className="text-3xl tracking-tight text-ink">
            Rent <span className="font-display text-accent-text">Tracker</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Active tenancies and their rent status for the current month.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/tenants/history"
            className="text-xs uppercase tracking-wide text-ink hover:text-accent-text"
          >
            Past tenants
          </Link>
          <Link
            href="/properties/new"
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
          >
            Add property
          </Link>
          <Link
            href="/tenants/new"
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
          >
            Add tenant
          </Link>
        </div>
      </header>

      {rows.length > 0 && (
        <section className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-muted">
              Expected this month
            </p>
            <p className="mt-2 text-2xl font-light text-ink">
              {fmtMoney(expectedTotal)}
            </p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-muted">Collected</p>
            <p className="mt-2 text-2xl font-light text-ink">
              {fmtMoney(paidTotal)}
            </p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-muted">
              Total outstanding
            </p>
            <p className="mt-2 text-2xl font-light text-ink">
              {fmtMoney(outstandingTotal)}
            </p>
            <p className="mt-1 text-xs text-muted">Running balance, all months</p>
          </div>
        </section>
      )}

      {rows.length > 0 && (() => {
        const pct =
          expectedTotal > 0
            ? Math.min(100, Math.round((paidTotal / expectedTotal) * 100))
            : 0;
        const fullyPaid = paidTotal >= expectedTotal && expectedTotal > 0;
        return (
          <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="uppercase tracking-wide text-muted">
                  Collected this month
                </span>
                <span
                  className={`tabular-nums ${fullyPaid ? "text-green-700" : "text-ink"}`}
                >
                  {fmtMoney(paidTotal)}
                  <span className="text-muted">
                    {" "}
                    / {fmtMoney(expectedTotal)}
                  </span>
                </span>
              </span>
              <span className="tabular-nums text-muted">{pct}%</span>
            </div>
            <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-full bg-warm/60">
              <div
                className={`absolute inset-y-0 left-0 rounded-full ${fullyPaid ? "bg-green-600" : "bg-accent"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </section>
        );
      })()}

      {rows.length > 0 && (
        <RentReminderButton
          outstandingCount={outstandingCount}
          lastGeneralText={lastGeneralText}
          lastBalanceText={lastBalanceText}
        />
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <SearchInput
          placeholder="Search by tenant, email, phone, or unit…"
          ariaLabel="Search tenants"
        />
        <BalanceFilter />
      </div>

      {error && <p className="mt-6 text-sm text-red-700">{error.message}</p>}

      {rows.length === 0 && (
        <p className="mt-10 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          No active tenants yet. Click <em>Add tenant</em> to assign someone to a
          room.
        </p>
      )}

      {rows.length > 0 && visibleRows.length === 0 && (
        <p className="mt-10 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          {owingOnly && !query
            ? "No tenants have an outstanding balance."
            : owingOnly
              ? `No tenants with a balance match “${query}”.`
              : `No tenants match “${query}”.`}
        </p>
      )}

      {visibleRows.length > 0 && (
        // key forces a remount when the filter toggles so the expand/collapse
        // state re-initializes (collapsed by default, expanded when owing-only).
        <TenantGroups
          key={owingOnly ? "owing" : "all"}
          groups={groups}
          defaultExpanded={owingOnly}
        />
      )}
    </div>
  );
}
