import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { SearchInput } from "@/components/search-input";
import { BalanceFilter } from "./balance-filter";
import { RentReminderButton } from "./rent-reminder-button";
import { getReminderInfo } from "./reminder-info";
import { processExpiredTenancies } from "./actions";
import {
  TenantGroups,
  type DisplayGroup,
  type DisplayRow,
} from "./tenant-groups";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { todayISO, currentRentCycle } from "@/lib/date";
import { isMaster } from "@/lib/access";
import { OverageAlertsPopup, type OverageAlert } from "./overage-alerts";

export const dynamic = "force-dynamic";
// sendBalanceReminders (see actions.ts) sends an email + SMS per owing tenant,
// strictly serial (~2s each), so a full roster can outrun Vercel's default
// timeout and get hard-killed mid-send. Match the rent-reminder cron's 60s
// ceiling so the whole book can go out in one invocation. Per the Next docs,
// maxDuration set at the page level covers all Server Actions used on it.
export const maxDuration = 60;

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

/**
 * What's owed for a single tenancy in the given rent cycle.
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Only admins see the aggregate collection totals and per-tenant "paid"
  // amounts. Everyone else still sees each tenant's rent and pending balance.
  const admin = isMaster(user?.email);
  // Rent is collected on a 27th→26th cycle (tenants pay from the 27th), so
  // "this month" runs from the 27th of the prior month to the 26th.
  const { start: monthStart, end: monthEnd } = currentRentCycle();

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

  // The full portfolio — vacant properties still get a (empty) group below.
  const { data: allProps } = await supabase
    .from("properties")
    .select("id, building_name, street_address, unit_number");

  // Ad-hoc charges + credit allocations feed the running ledger balance.
  const { charges, allocations, rentChanges } =
    await fetchLedgerSidecars(supabase);
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
      rentChanges.get(row.id) ?? [],
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
      tenant_phone: tenant?.phone ?? null,
      move_out_date: r.move_out_date,
      room_number: room?.room_number ?? null,
      due: r.due,
      paid: r.paidThisMonth,
      balance: r.balance,
    });
  }
  // Properties with no active tenancy still show up as empty groups, so the
  // tracker always lists the whole portfolio. They're omitted when the
  // owing-only filter is on (nothing owed on a vacant unit) and when a search
  // query doesn't match the unit itself.
  const seenPropertyIds = new Set(
    Array.from(groupsMap.values(), (g) => g.propertyId),
  );
  if (!owingOnly) {
    for (const p of allProps ?? []) {
      if (seenPropertyIds.has(p.id)) continue;
      const label = `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
      if (groupsMap.has(label)) continue;
      if (query) {
        const haystack = [p.building_name, p.street_address, p.unit_number]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      groupsMap.set(label, { propertyId: p.id, rows: [] });
    }
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

  // Balance-reminder button state (outstanding count + per-channel last-sent).
  const {
    outstandingCount,
    lastBalanceText,
    lastBalanceEmailText,
    lastBalanceSmsText,
  } = await getReminderInfo(supabase);

  // Utility-overage shares that hit already-moved-out tenants pop up for the
  // admin until acknowledged (their share was not posted to any ledger).
  let overageAlerts: OverageAlert[] = [];
  if (admin) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: alertRows } = await (supabase as any)
      .from("utility_overage_alerts")
      .select("id, tenant_name, unit_label, amount, period_label")
      .is("acknowledged_at", null)
      .order("created_at", { ascending: true });
    overageAlerts = (alertRows ?? []) as OverageAlert[];
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      {overageAlerts.length > 0 && (
        <OverageAlertsPopup alerts={overageAlerts} />
      )}
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
        <section className="mt-6 grid items-start gap-4 sm:grid-cols-3">
          {admin && (
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone/30 transition hover:-translate-y-0.5 hover:shadow-md hover:ring-accent/40">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  Expected this month:
                </span>
                <span className="text-lg font-semibold tabular-nums text-ink">
                  {fmtMoney(expectedTotal)}
                </span>
              </p>
            </div>
          )}
          {admin && (
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone/30 transition hover:-translate-y-0.5 hover:shadow-md hover:ring-accent/40">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  Collected:
                </span>
                <span className="text-lg font-semibold tabular-nums text-ink">
                  {fmtMoney(paidTotal)}
                </span>
              </p>
            </div>
          )}
          {/* Outstanding card: the total is admin-only, but the balance
              reminders + last-sent stay visible to everyone. */}
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone/30 transition hover:-translate-y-0.5 hover:shadow-md hover:ring-accent/40">
            {admin ? (
              <>
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted">
                    Total outstanding:
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-ink">
                    {fmtMoney(outstandingTotal)}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  Running balance, all months
                </p>
              </>
            ) : (
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Balance reminders
              </p>
            )}
            <RentReminderButton
              minimal
              outstandingCount={outstandingCount}
              lastGeneralText={null}
              lastBalanceText={lastBalanceText}
              lastBalanceEmailText={lastBalanceEmailText}
              lastBalanceSmsText={lastBalanceSmsText}
            />
          </div>
        </section>
      )}

      {admin && rows.length > 0 && (() => {
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

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <SearchInput
          placeholder="Search by tenant, email, phone, or unit…"
          ariaLabel="Search tenants"
        />
        <BalanceFilter />
      </div>

      {error && <p className="mt-6 text-sm text-red-700">{error.message}</p>}

      {groups.length === 0 && (
        <p className="mt-10 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          {owingOnly && !query
            ? "No tenants have an outstanding balance."
            : owingOnly
              ? `No tenants with a balance match “${query}”.`
              : query
                ? `No tenants or units match “${query}”.`
                : (
                    <>
                      No properties yet. Click <em>Add property</em> to start.
                    </>
                  )}
        </p>
      )}

      {groups.length > 0 && (
        // key forces a remount when the filter toggles so the expand/collapse
        // state re-initializes (collapsed by default, expanded when owing-only).
        <TenantGroups
          key={owingOnly ? "owing" : "all"}
          groups={groups}
          defaultExpanded={owingOnly}
          admin={admin}
        />
      )}
    </div>
  );
}
