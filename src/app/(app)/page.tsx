import Link from "next/link";
import { Suspense } from "react";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/cleaning";
import { EditableDate } from "./cleaning/editable-date";
import { formatDate } from "@/lib/date";
import { isMaster } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { EndingSoonTable } from "./ending-soon-table";
import { NavIcon } from "./nav-icons";
import { CardSkeleton } from "@/components/section-skeletons";
import {
  getPropertyCount,
  getRoomCount,
  getDashProperties,
  getDashRooms,
  getDashCleanings,
  getDashTenancies,
  getRoomAds,
  getPaymentsThisCycle,
  getRentWorklist,
  unitLabel,
  type TenancyRow,
} from "./dashboard-data";

export const dynamic = "force-dynamic";

function fmtMoney(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

async function StatsSection() {
  const [user, propertyCountRes, roomCountRes, { collectedThisMonth }, rentWorklist] =
    await Promise.all([
      getSessionUser(),
      getPropertyCount(),
      getRoomCount(),
      getPaymentsThisCycle(),
      getRentWorklist(),
    ]);

  // Aggregate collection totals are admin-only; per-tenant outstanding amounts
  // (pending balances) stay visible to everyone.
  const admin = isMaster(user?.email);
  const outstanding = rentWorklist.reduce((s, r) => s + r.outstanding, 0);

  return (
    <>
      <Stat
        label="Properties"
        value={propertyCountRes.count ?? 0}
        href="/properties"
        icon={<NavIcon name="properties" />}
      />
      <Stat
        label="Rooms"
        value={roomCountRes.count ?? 0}
        href="/properties"
        icon={<NavIcon name="inventory" />}
      />
      {admin && (
        <Stat
          label="Collected this month"
          value={fmtMoney(collectedThisMonth)}
          href="/tenants"
          icon={<IconMoney />}
        />
      )}
      {admin && (
        <Stat
          label="Outstanding rent"
          value={fmtMoney(outstanding)}
          href="/tenants"
          icon={<IconAlert />}
          tone={outstanding > 0 ? "warn" : "default"}
        />
      )}
    </>
  );
}

async function RentWorklistSection() {
  const rentWorklist = await getRentWorklist();
  return (
    <Worklist
      title="Outstanding rent"
      icon={<NavIcon name="tenants" />}
      emptyText="Every tenant is paid up for this month."
      countLabel={`${rentWorklist.length} unpaid`}
      href="/tenants"
    >
      {rentWorklist.slice(0, 8).map((r) => (
        <WorklistRow
          key={r.tenant_id}
          href={`/tenants/${r.tenant_id}`}
          primary={r.tenant_name}
          secondary={`${r.unit} · ${r.room}`}
          right={fmtMoney(r.outstanding)}
          rightTone="warn"
        />
      ))}
      {rentWorklist.length > 8 && (
        <ShowMore href="/tenants" label={`+${rentWorklist.length - 8} more`} />
      )}
    </Worklist>
  );
}

async function InventorySection() {
  const [rooms, roomAds] = await Promise.all([getDashRooms(), getRoomAds()]);
  const today = todayISO();

  // Distinct ad posters per room (a room can have several ads).
  const adPostersByRoom = new Map<string, string[]>();
  for (const a of (roomAds.data ?? []) as {
    room_id: string;
    posted_by: string | null;
  }[]) {
    const name = a.posted_by?.trim();
    if (!name) continue;
    const list = adPostersByRoom.get(a.room_id) ?? [];
    if (!list.includes(name)) list.push(name);
    adPostersByRoom.set(a.room_id, list);
  }

  // Inventory list — rooms listable on /inventory (available now or scheduled).
  type RoomRow = {
    id: string;
    room_number: string | null;
    status: string;
    available_from: string | null;
    total_rent: number | null;
    pending_tenant: boolean;
    listing_action: string;
    properties:
      | { building_name: string | null; street_address: string; unit_number: string }
      | { building_name: string | null; street_address: string; unit_number: string }[]
      | null;
  };
  const inventoryList = ((rooms.data ?? []) as RoomRow[])
    .filter((r) => {
      const inInv =
        r.status === "available" ||
        (r.status === "occupied" && r.available_from && r.available_from >= today);
      return inInv && !r.pending_tenant;
    })
    .map((r) => ({
      id: r.id,
      unit: unitLabel(one(r.properties)),
      room: (r.room_number ?? "").replace(/^room\s+/i, ""),
      available_from: r.available_from,
      total_rent: r.total_rent,
      ad_posted_by: adPostersByRoom.get(r.id)?.join(", ") ?? null,
    }))
    .sort((a, b) => {
      if (!a.available_from && !b.available_from) return 0;
      if (!a.available_from) return -1;
      if (!b.available_from) return 1;
      return a.available_from < b.available_from ? -1 : 1;
    });

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
          <NavIcon name="inventory" />
          Inventory
        </h2>
        <Link
          href="/inventory"
          className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
        >
          View all →
        </Link>
      </div>
      {inventoryList.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No listable rooms right now.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-center text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-stone/40">
                <th className="px-3 py-2 text-left font-medium">Unit</th>
                <th className="px-3 py-2 font-medium">Room</th>
                <th className="px-3 py-2 font-medium">Availability</th>
                <th className="px-3 py-2 font-medium">Total Rent</th>
                <th className="px-3 py-2 font-medium">Who Posted</th>
              </tr>
            </thead>
            <tbody className="text-center">
              {inventoryList.slice(0, 12).map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-stone/20 last:border-0 hover:bg-warm/30"
                >
                  <td className="px-3 py-2 text-left">
                    <Link
                      href={`/inventory/${r.id}`}
                      className="text-accent-text hover:text-accent-dark"
                    >
                      {r.unit}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-ink">{r.room || "—"}</td>
                  <td className="px-3 py-2 text-ink">
                    {r.available_from
                      ? formatDate(r.available_from)
                      : "Available now"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-ink">
                    {r.total_rent === null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      fmtMoney(r.total_rent)
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink">
                    {r.ad_posted_by?.trim() || (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {inventoryList.length > 12 && (
            <Link
              href="/inventory"
              className="mt-3 inline-block px-3 text-xs uppercase tracking-wide text-accent-text hover:text-accent-dark"
            >
              +{inventoryList.length - 12} more
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

async function CleaningSection() {
  const [properties, cleanings] = await Promise.all([
    getDashProperties(),
    getDashCleanings(),
  ]);
  const today = todayISO();

  // Last past cleaning + soonest upcoming (editable) per property. Cleanings are
  // ordered newest-first, so the first past row per unit is the most recent,
  // and the last future row iterated is the soonest upcoming.
  const lastByProperty = new Map<string, string>();
  const nextByProperty = new Map<string, { id: string; date: string }>();
  for (const c of cleanings.data ?? []) {
    if (c.cleaning_date >= today) {
      nextByProperty.set(c.property_id, { id: c.id, date: c.cleaning_date });
    } else if (!lastByProperty.has(c.property_id)) {
      lastByProperty.set(c.property_id, c.cleaning_date);
    }
  }

  type CleaningEntry = {
    property_id: string;
    label: string;
    last: string | null;
    next: { id: string; date: string } | null;
    daysUntilNext: number | null; // days between today and the next cleaning
  };
  const todayMs = new Date(today + "T00:00:00").getTime();
  const cleaningWorklist: CleaningEntry[] = (properties.data ?? []).map((p) => {
    const next = nextByProperty.get(p.id) ?? null;
    const daysUntilNext = next
      ? Math.round(
          (new Date(next.date + "T00:00:00").getTime() - todayMs) / 86400000,
        )
      : null;
    return {
      property_id: p.id,
      label: unitLabel(p),
      last: lastByProperty.get(p.id) ?? null,
      next,
      daysUntilNext,
    };
  });
  // Unscheduled first, then soonest upcoming; alphabetical within ties.
  cleaningWorklist.sort((a, b) => {
    const ad = a.next?.date ?? "0000";
    const bd = b.next?.date ?? "0000";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { numeric: true });
  });

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
          <NavIcon name="cleaning" />
          Upcoming cleaning
        </h2>
        <Link
          href="/cleaning"
          className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
        >
          View all →
        </Link>
      </div>
      {cleaningWorklist.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No units yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-center text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-stone/40">
                <th className="px-3 py-2 text-left font-medium">Unit</th>
                <th className="px-3 py-2 font-medium">Last Cleaned</th>
                <th className="px-3 py-2 font-medium">Next Cleaning</th>
                <th className="px-3 py-2 font-medium">Counter</th>
              </tr>
            </thead>
            <tbody className="text-center">
              {cleaningWorklist.slice(0, 12).map((c) => {
                const overdue = c.next !== null && c.next.date < today;
                return (
                  <tr
                    key={c.property_id}
                    className="border-b border-stone/20 last:border-0 hover:bg-warm/30"
                  >
                    <td className="px-3 py-2 text-left">
                      <Link
                        href={`/properties/${c.property_id}`}
                        className="text-accent-text hover:text-accent-dark"
                      >
                        {c.label}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-ink">
                      {c.last ? (
                        formatDate(c.last)
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <EditableDate
                        propertyId={c.property_id}
                        recordId={c.next?.id ?? null}
                        date={c.next?.date ?? null}
                        assignedTo={null}
                      />
                    </td>
                    <td
                      className={`px-3 py-2 tabular-nums ${overdue ? "text-red-700" : "text-ink"}`}
                    >
                      {c.daysUntilNext === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        `${c.daysUntilNext}d`
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {cleaningWorklist.length > 12 && (
            <Link
              href="/cleaning"
              className="mt-3 inline-block px-3 text-xs uppercase tracking-wide text-accent-text hover:text-accent-dark"
            >
              +{cleaningWorklist.length - 12} more
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

async function LeaseEndingSection() {
  const tenancies = await getDashTenancies();
  const today = todayISO();

  // Tenancies ending soon (within 30 days).
  const in30Date = new Date(today + "T00:00:00");
  in30Date.setDate(in30Date.getDate() + 30);
  const in30 = in30Date.toISOString().slice(0, 10);
  const endingSoon = ((tenancies.data ?? []) as TenancyRow[])
    .filter(
      (t) =>
        // Once the end is confirmed (a move-out date is set), the room is
        // already listed on Inventory, so drop it from this heads-up list.
        !t.move_out_date &&
        t.lease_end_date &&
        t.lease_end_date >= today &&
        t.lease_end_date <= in30,
    )
    .map((t) => {
      const room = one(t.rooms);
      const tenant = one(t.tenants);
      return {
        tenant_id: t.tenant_id,
        name: tenant?.full_name ?? "—",
        email: tenant?.email ?? null,
        phone: tenant?.phone ?? null,
        unit: unitLabel(one(room?.properties ?? null)),
        room: (room?.room_number ?? "").replace(/^room\s+/i, ""),
        lease_end_date: t.lease_end_date!,
      };
    })
    .sort((a, b) => a.lease_end_date.localeCompare(b.lease_end_date));

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <IconCalendar />
        Lease ending soon
      </h2>
      <EndingSoonTable rows={endingSoon} />
    </div>
  );
}

function StatTileSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone/30">
      <div className="h-3 w-24 rounded bg-warm/70" />
      <div className="mt-3 h-8 w-20 rounded-lg bg-warm" />
    </div>
  );
}

export default function Dashboard() {
  const today = todayISO();
  const dateLabel = new Date(today + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mx-auto w-full max-w-7xl">
      <header className="relative overflow-hidden rounded-3xl bg-ink px-6 py-8 text-cream shadow-sm md:px-9 md:py-10">
        <div
          className="hero-spotlight pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-accent/25 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative">
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-accent">
            {dateLabel}
          </p>
          <h1 className="mt-2 text-3xl font-medium tracking-tight md:text-4xl">
            What needs{" "}
            <span className="font-display font-light italic text-accent">
              attention
            </span>{" "}
            today
          </h1>
          <p className="mt-2 text-sm text-cream/60">
            Press{" "}
            <kbd className="rounded border border-cream/30 px-1 text-xs text-cream/80">
              ⌘K
            </kbd>{" "}
            to jump to anything.
          </p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Suspense
          fallback={
            <>
              <StatTileSkeleton />
              <StatTileSkeleton />
              <StatTileSkeleton />
              <StatTileSkeleton />
            </>
          }
        >
          <StatsSection />
        </Suspense>
      </section>

      <section className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Suspense fallback={<CardSkeleton lines={6} />}>
          <RentWorklistSection />
        </Suspense>
        <Suspense fallback={<CardSkeleton lines={6} />}>
          <InventorySection />
        </Suspense>
        <Suspense fallback={<CardSkeleton lines={6} />}>
          <CleaningSection />
        </Suspense>
        <Suspense fallback={<CardSkeleton lines={6} />}>
          <LeaseEndingSection />
        </Suspense>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  href: string;
  icon: React.ReactNode;
  tone?: "default" | "warn";
}) {
  return (
    <Link
      href={href}
      className="group rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone/30 transition hover:-translate-y-0.5 hover:shadow-md hover:ring-accent/40"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {label}
        </p>
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition ${
            tone === "warn"
              ? "bg-red-50 text-red-600"
              : "bg-accent/10 text-accent group-hover:bg-accent/20"
          }`}
        >
          {icon}
        </span>
      </div>
      <p
        className={`mt-3 text-3xl font-semibold tabular-nums ${
          tone === "warn" ? "text-red-700" : "text-ink"
        }`}
      >
        {value}
      </p>
    </Link>
  );
}

function Worklist({
  title,
  icon,
  emptyText,
  countLabel,
  href,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  emptyText: string;
  countLabel: string;
  href: string;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children)
    ? children.flat().some((c) => c)
    : Boolean(children);
  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-stone/30">
      <header className="flex items-center justify-between gap-3 border-b border-stone/20 px-5 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
            {icon}
          </span>
          <h2 className="truncate text-sm font-medium text-ink">{title}</h2>
        </div>
        <Link
          href={href}
          className="shrink-0 rounded-full bg-warm px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted transition hover:bg-stone/40 hover:text-ink"
        >
          {countLabel}
        </Link>
      </header>
      {hasChildren ? (
        <ul className="divide-y divide-stone/15">{children}</ul>
      ) : (
        <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
          <span className="text-accent/70">
            <IconCheck />
          </span>
          <p className="text-sm text-muted">{emptyText}</p>
        </div>
      )}
    </div>
  );
}

function WorklistRow({
  href,
  primary,
  secondary,
  right,
  rightTone = "muted",
}: {
  href: string;
  primary: string;
  secondary?: string;
  right: string;
  rightTone?: "muted" | "warn" | "accent";
}) {
  const pill =
    rightTone === "warn"
      ? "bg-red-50 text-red-700 ring-1 ring-red-100"
      : rightTone === "accent"
        ? "bg-accent/10 text-accent-text ring-1 ring-accent/20"
        : "bg-warm text-muted ring-1 ring-stone/30";
  return (
    <li>
      <Link
        href={href}
        className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-cream/70"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{primary}</p>
          {secondary && (
            <p className="truncate text-xs text-muted">{secondary}</p>
          )}
        </div>
        <span
          className={`inline-block shrink-0 min-w-20 rounded-full px-2.5 py-1 text-center text-xs font-medium tabular-nums ${pill}`}
        >
          {right}
        </span>
      </Link>
    </li>
  );
}

function ShowMore({ href, label }: { href: string; label: string }) {
  return (
    <li className="px-5 py-2.5 text-center">
      <Link
        href={href}
        className="text-xs font-medium uppercase tracking-wide text-accent-text hover:underline"
      >
        {label}
      </Link>
    </li>
  );
}

function Svg({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function IconMoney() {
  return (
    <Svg>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </Svg>
  );
}

function IconAlert() {
  return (
    <Svg>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  );
}

function IconCalendar() {
  return (
    <Svg>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </Svg>
  );
}

function IconCheck() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}
