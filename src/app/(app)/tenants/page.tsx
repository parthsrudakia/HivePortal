import Link from "next/link";
import { Suspense } from "react";
import { getSessionUser } from "@/lib/session";
import { one } from "@/lib/relations";
import { SearchInput } from "@/components/search-input";
import { KpiRowSkeleton, TableSkeleton } from "@/components/section-skeletons";
import { BalanceFilter } from "./balance-filter";
import { BalanceSort } from "./balance-sort";
import { RentReminderButton } from "./rent-reminder-button";
import { computeLedger } from "@/lib/rent";
import { todayISO } from "@/lib/date";
import { canEditLedger, isMaster } from "@/lib/access";
import { OverageAlertsPopup, type OverageAlert } from "./overage-alerts";
import { FormerTenants, type FormerTenantRow } from "./former-tenants";
import { UpcomingTenants, type UpcomingTenantRow } from "./upcoming-tenants";
import {
  TenantsExplorer,
  type TrackerRow,
  type VacantProperty,
} from "./tenants-explorer";
import {
  getAllProperties,
  getEndedTenancies,
  getUpcomingTenancies,
  getOverageAlerts,
  getSidecars,
  getRowsWithStatus,
  getTenantsReminderInfo,
} from "./data";

export const dynamic = "force-dynamic";
// sendBalanceReminders (see actions.ts) sends an email + SMS per owing tenant,
// strictly serial (~2s each), so a full roster can outrun Vercel's default
// timeout and get hard-killed mid-send. Match the rent-reminder cron's 60s
// ceiling so the whole book can go out in one invocation. Per the Next docs,
// maxDuration set at the page level covers all Server Actions used on it.
export const maxDuration = 60;

function fmtMoney(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function unitLabel(p: {
  building_name: string | null;
  street_address: string;
  unit_number: string;
}) {
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

// Utility-overage shares that hit already-moved-out tenants pop up for the
// admin until acknowledged (their share was not posted to any ledger).
async function OverageAlertsSlot() {
  const [user, { data: overageAlertRows }] = await Promise.all([
    getSessionUser(),
    getOverageAlerts(),
  ]);
  if (!isMaster(user?.email)) return null;
  const alerts = (overageAlertRows ?? []) as OverageAlert[];
  if (alerts.length === 0) return null;
  return <OverageAlertsPopup alerts={alerts} />;
}

async function RentKpisSection() {
  const [user, { rows }, reminderInfo] = await Promise.all([
    getSessionUser(),
    getRowsWithStatus(),
    getTenantsReminderInfo(),
  ]);
  if (rows.length === 0) return null;

  // Only admins see the aggregate collection totals and per-tenant "paid"
  // amounts. Everyone else still sees each tenant's rent and pending balance.
  const admin = isMaster(user?.email);
  const expectedTotal = rows.reduce((s, r) => s + r.due, 0);
  const paidTotal = rows.reduce((s, r) => s + r.paidThisMonth, 0);
  const outstandingTotal = rows.reduce(
    (s, r) => s + Math.max(0, r.balance),
    0,
  );
  const {
    outstandingCount,
    lastBalanceText,
    lastBalanceEmailText,
    lastBalanceSmsText,
  } = reminderInfo;

  const pct =
    expectedTotal > 0
      ? Math.min(100, Math.round((paidTotal / expectedTotal) * 100))
      : 0;
  const fullyPaid = paidTotal >= expectedTotal && expectedTotal > 0;

  return (
    <>
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

      {admin && (
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
                <span className="text-muted"> / {fmtMoney(expectedTotal)}</span>
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
      )}
    </>
  );
}

async function SideListsSection() {
  const [user, { data: endedData }, { data: upcomingData }, sidecars] =
    await Promise.all([
      getSessionUser(),
      getEndedTenancies(),
      getUpcomingTenancies(),
      getSidecars(),
    ]);
  const { charges, allocations, rentChanges } = sidecars;
  const today = todayISO();

  // Departed tenants who still owe: same ledger math as the active rows.
  type EndedRow = {
    id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    security_deposit: number | null;
    start_date: string;
    move_out_date: string | null;
    paused_at: string | null;
    balance_dismissed_at: string | null;
    tenants:
      | { id: string; full_name: string }
      | { id: string; full_name: string }[]
      | null;
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
    payments: { amount: number; paid_on: string; payment_type: string }[];
  };
  const formerRows: FormerTenantRow[] = ((endedData ?? []) as EndedRow[])
    .map((t) => {
      const { netBalance } = computeLedger(
        t,
        t.payments ?? [],
        charges.get(t.id) ?? [],
        allocations.get(t.id) ?? [],
        today,
        rentChanges.get(t.id) ?? [],
      );
      const tenant = one(t.tenants);
      const room = one(t.rooms);
      const property = one(room?.properties ?? null);
      return {
        tenancyId: t.id,
        tenantId: tenant?.id ?? "",
        name: tenant?.full_name ?? "—",
        unitLabel: property ? unitLabel(property) : null,
        roomLabel: room?.room_number ?? null,
        movedOut: t.move_out_date,
        balance: netBalance,
        dismissed: !!t.balance_dismissed_at,
      };
    })
    .filter((r) => r.tenantId && r.balance > 0.005)
    .sort((a, b) => b.balance - a.balance);

  type UpcomingQueryRow = {
    id: string;
    start_date: string;
    monthly_rent: number;
    tenants:
      | { id: string; full_name: string }
      | { id: string; full_name: string }[]
      | null;
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
  };
  const upcomingRows: UpcomingTenantRow[] = (
    (upcomingData ?? []) as UpcomingQueryRow[]
  )
    .map((t) => {
      const tenant = one(t.tenants);
      const room = one(t.rooms);
      const property = one(room?.properties ?? null);
      return {
        tenancyId: t.id,
        tenantId: tenant?.id ?? "",
        name: tenant?.full_name ?? "—",
        unitLabel: property ? unitLabel(property) : null,
        roomLabel: room?.room_number ?? null,
        startDate: t.start_date,
        monthlyRent: Number(t.monthly_rent),
      };
    })
    .filter((r) => r.tenantId);

  return (
    <>
      <UpcomingTenants rows={upcomingRows} />
      <FormerTenants
        rows={formerRows}
        canDismiss={canEditLedger(user?.email)}
      />
    </>
  );
}

async function TenantTrackerSection() {
  const [user, { rows, error }, { data: allProps }] = await Promise.all([
    getSessionUser(),
    getRowsWithStatus(),
    getAllProperties(),
  ]);

  if (error) {
    return <p className="mt-6 text-sm text-red-700">{error.message}</p>;
  }

  const admin = isMaster(user?.email);

  const trackerRows: TrackerRow[] = rows.map((r) => {
    const tenant = one(r.tenants);
    const room = one(r.rooms);
    const p = one(room?.properties ?? null);
    return {
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
      paused: !!r.paused_at,
      groupLabel: p ? unitLabel(p) : "Unassigned",
      propertyId: p?.id ?? null,
      haystack: [
        tenant?.full_name,
        tenant?.email,
        tenant?.phone,
        room?.room_number,
        p?.building_name,
        p?.street_address,
        p?.unit_number,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });

  const vacantProperties: VacantProperty[] = (allProps ?? []).map((p) => ({
    id: p.id,
    label: unitLabel(p),
    haystack: [p.building_name, p.street_address, p.unit_number]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  }));

  return (
    <TenantsExplorer
      rows={trackerRows}
      vacantProperties={vacantProperties}
      admin={admin}
    />
  );
}

export default function TenantsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <Suspense fallback={null}>
        <OverageAlertsSlot />
      </Suspense>

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

      <Suspense
        fallback={
          <div className="mt-6">
            <KpiRowSkeleton />
          </div>
        }
      >
        <RentKpisSection />
      </Suspense>

      <Suspense fallback={null}>
        <SideListsSection />
      </Suspense>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <SearchInput
          placeholder="Search by tenant, email, phone, or unit…"
          ariaLabel="Search tenants"
        />
        <BalanceFilter />
        <BalanceSort />
      </div>

      <Suspense
        fallback={
          <div className="mt-6">
            <TableSkeleton rows={8} />
          </div>
        }
      >
        <TenantTrackerSection />
      </Suspense>
    </div>
  );
}
