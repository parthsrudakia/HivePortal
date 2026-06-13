import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import {
  cleaningScheduleFor,
  todayISO,
  CLEANING_CADENCE_DAYS,
} from "@/lib/cleaning";
import { formatDate } from "@/lib/date";
import { NavIcon } from "./nav-icons";

export const dynamic = "force-dynamic";

type PropertyRel = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
};

function unitLabel(p: PropertyRel | null | undefined) {
  if (!p) return "—";
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

function fmtMoney(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

function monthBounds(monthIso: string): { start: string; end: string } {
  const [y, m] = monthIso.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function dueForMonth(
  t: {
    start_date: string;
    end_date: string | null;
    monthly_rent: number;
    first_month_rent: number | null;
  },
  monthStart: string,
  monthEnd: string,
): number {
  if (t.start_date > monthEnd) return 0;
  if (t.end_date && t.end_date < monthStart) return 0;
  const isStart = t.start_date >= monthStart && t.start_date <= monthEnd;
  if (isStart && t.first_month_rent !== null) return Number(t.first_month_rent);
  return Number(t.monthly_rent);
}

export default async function Dashboard() {
  const supabase = await createClient();
  const today = todayISO();
  const thisMonth = today.slice(0, 7);
  const tm = monthBounds(thisMonth);

  const [
    propertyCountRes,
    roomCountRes,
    properties,
    rooms,
    cleanings,
    tenancies,
    payments,
  ] = await Promise.all([
    supabase.from("properties").select("*", { count: "exact", head: true }),
    supabase.from("rooms").select("*", { count: "exact", head: true }),
    supabase
      .from("properties")
      .select("id, building_name, street_address, unit_number, neighborhood"),
    supabase
      .from("rooms")
      .select(
        `id, room_number, status, available_from, ad_url, listing_action,
         properties(building_name, street_address, unit_number)`,
      ),
    supabase
      .from("cleaning_records")
      .select("property_id, cleaning_date, kind")
      .order("cleaning_date", { ascending: false }),
    supabase
      .from("tenancies")
      .select(
        `id, tenant_id, monthly_rent, first_month_rent, start_date, end_date, status,
         rooms(room_number, properties(building_name, street_address, unit_number)),
         tenants(full_name)`,
      )
      .eq("status", "active"),
    supabase
      .from("payments")
      .select("tenancy_id, amount, paid_on")
      .eq("payment_type", "rent")
      .gte("paid_on", tm.start)
      .lte("paid_on", tm.end),
  ]);

  // Last past cleaning per property (skip future-dated move-out rows).
  const lastByProperty = new Map<string, string>();
  for (const c of cleanings.data ?? []) {
    if (c.cleaning_date > today) continue;
    if (!lastByProperty.has(c.property_id)) {
      lastByProperty.set(c.property_id, c.cleaning_date);
    }
  }

  type CleaningEntry = {
    property_id: string;
    label: string;
    days: number | null;
    status: "never" | "overdue" | "due_soon";
  };
  const cleaningWorklist: CleaningEntry[] = [];
  for (const p of properties.data ?? []) {
    const s = cleaningScheduleFor(lastByProperty.get(p.id) ?? null, today);
    if (s.status === "never" || s.status === "overdue" || s.status === "due_soon") {
      cleaningWorklist.push({
        property_id: p.id,
        label: unitLabel(p),
        days: s.daysUntil,
        status: s.status,
      });
    }
  }
  cleaningWorklist.sort((a, b) => {
    const order = { never: 0, overdue: 1, due_soon: 2 } as const;
    return order[a.status] - order[b.status];
  });

  // Rent worklist: active tenancies with this-month due > paid so far.
  const paidByTenancy = new Map<string, number>();
  for (const pmt of payments.data ?? []) {
    paidByTenancy.set(
      pmt.tenancy_id,
      (paidByTenancy.get(pmt.tenancy_id) ?? 0) + Number(pmt.amount),
    );
  }

  type RentEntry = {
    tenant_id: string;
    tenant_name: string;
    unit: string;
    room: string;
    due: number;
    paid: number;
    outstanding: number;
  };
  type TenancyRow = {
    id: string;
    tenant_id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    start_date: string;
    end_date: string | null;
    rooms:
      | {
          room_number: string | null;
          properties: PropertyRel | PropertyRel[] | null;
        }
      | {
          room_number: string | null;
          properties: PropertyRel | PropertyRel[] | null;
        }[]
      | null;
    tenants: { full_name: string } | { full_name: string }[] | null;
  };
  const rentWorklist: RentEntry[] = [];
  for (const t of (tenancies.data ?? []) as TenancyRow[]) {
    const due = dueForMonth(
      {
        start_date: t.start_date,
        end_date: t.end_date,
        monthly_rent: t.monthly_rent,
        first_month_rent: t.first_month_rent,
      },
      tm.start,
      tm.end,
    );
    const paid = paidByTenancy.get(t.id) ?? 0;
    const outstanding = due - paid;
    if (outstanding <= 0.01) continue;
    const room = one(t.rooms);
    const tenant = one(t.tenants);
    rentWorklist.push({
      tenant_id: t.tenant_id,
      tenant_name: tenant?.full_name ?? "—",
      unit: unitLabel(one(room?.properties ?? null)),
      room: room?.room_number ?? "Room",
      due,
      paid,
      outstanding,
    });
  }
  rentWorklist.sort((a, b) => b.outstanding - a.outstanding);

  // Rooms with no ad (available now + listed status).
  type RoomRow = {
    id: string;
    room_number: string | null;
    status: string;
    available_from: string | null;
    ad_url: string | null;
    listing_action: string;
    properties: PropertyRel | PropertyRel[] | null;
  };
  const adWorklist = ((rooms.data ?? []) as RoomRow[])
    .filter((r) => {
      const inInv =
        r.status === "available" ||
        (r.status === "occupied" && r.available_from && r.available_from >= today);
      return inInv && !r.ad_url;
    })
    .map((r) => ({
      id: r.id,
      unit: unitLabel(one(r.properties)),
      room: r.room_number ?? "Room",
      available_from: r.available_from,
    }));

  // Tenancies ending soon (within 30 days).
  const in30Date = new Date(today + "T00:00:00");
  in30Date.setDate(in30Date.getDate() + 30);
  const in30 = in30Date.toISOString().slice(0, 10);
  const endingSoon = ((tenancies.data ?? []) as TenancyRow[])
    .filter((t) => t.end_date && t.end_date >= today && t.end_date <= in30)
    .map((t) => {
      const room = one(t.rooms);
      const tenant = one(t.tenants);
      return {
        tenant_id: t.tenant_id,
        name: tenant?.full_name ?? "—",
        unit: unitLabel(one(room?.properties ?? null)),
        room: room?.room_number ?? "Room",
        end_date: t.end_date!,
      };
    })
    .sort((a, b) => a.end_date.localeCompare(b.end_date));

  const totals = {
    properties: propertyCountRes.count ?? 0,
    rooms: roomCountRes.count ?? 0,
    expected: rentWorklist.reduce((s, r) => s + r.due, 0),
    collected:
      (payments.data ?? []).reduce((s, p) => s + Number(p.amount), 0),
  };

  const dateLabel = new Date(today + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="relative overflow-hidden rounded-3xl bg-ink px-6 py-8 text-cream shadow-sm md:px-9 md:py-10">
        <div
          className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-accent/25 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-accent">
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
            <kbd className="rounded border border-cream/30 px-1 text-[10px] text-cream/80">
              ⌘K
            </kbd>{" "}
            to jump to anything.
          </p>
        </div>
      </header>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Properties"
          value={totals.properties}
          href="/properties"
          icon={<NavIcon name="properties" />}
        />
        <Stat
          label="Rooms"
          value={totals.rooms}
          href="/properties"
          icon={<NavIcon name="inventory" />}
        />
        <Stat
          label="Collected this month"
          value={fmtMoney(totals.collected)}
          href="/tenants"
          icon={<IconMoney />}
        />
        <Stat
          label="Outstanding rent"
          value={fmtMoney(totals.expected)}
          href="/tenants"
          icon={<IconAlert />}
          tone={totals.expected > 0 ? "warn" : "default"}
        />
      </section>

      <section className="mt-8 grid gap-5 lg:grid-cols-2">
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

        <Worklist
          title="Rooms with no ad"
          icon={<NavIcon name="inventory" />}
          emptyText="Every listable room has an ad live."
          countLabel={`${adWorklist.length} rooms`}
          href="/inventory?filter=no_ad"
        >
          {adWorklist.slice(0, 8).map((r) => (
            <WorklistRow
              key={r.id}
              href={`/inventory/${r.id}`}
              primary={`${r.unit} · ${r.room}`}
              secondary={
                r.available_from ? `Opens ${formatDate(r.available_from)}` : "Available now"
              }
              right="Post ad"
              rightTone="accent"
            />
          ))}
          {adWorklist.length > 8 && (
            <ShowMore href="/inventory?filter=no_ad" label={`+${adWorklist.length - 8} more`} />
          )}
        </Worklist>

        <Worklist
          title="Cleanings due"
          icon={<NavIcon name="cleaning" />}
          emptyText={`All units are on the ${CLEANING_CADENCE_DAYS}-day cadence.`}
          countLabel={`${cleaningWorklist.length} units`}
          href="/cleaning"
        >
          {cleaningWorklist.slice(0, 8).map((c) => {
            const right =
              c.status === "never"
                ? "Never"
                : c.status === "overdue"
                  ? `Overdue ${Math.abs(c.days ?? 0)}d`
                  : `In ${c.days}d`;
            return (
              <WorklistRow
                key={c.property_id}
                href={`/properties/${c.property_id}`}
                primary={c.label}
                right={right}
                rightTone={c.status === "due_soon" ? "accent" : "warn"}
              />
            );
          })}
          {cleaningWorklist.length > 8 && (
            <ShowMore href="/cleaning" label={`+${cleaningWorklist.length - 8} more`} />
          )}
        </Worklist>

        <Worklist
          title="Tenancies ending soon"
          icon={<IconCalendar />}
          emptyText="No moves planned in the next 30 days."
          countLabel={`${endingSoon.length} moves`}
          href="/tenants"
        >
          {endingSoon.slice(0, 8).map((t, i) => (
            <WorklistRow
              key={`${t.tenant_id}-${i}`}
              href={`/tenants/${t.tenant_id}`}
              primary={t.name}
              secondary={`${t.unit} · ${t.room}`}
              right={formatDate(t.end_date)}
              rightTone="muted"
            />
          ))}
          {endingSoon.length > 8 && (
            <ShowMore href="/tenants" label={`+${endingSoon.length - 8} more`} />
          )}
        </Worklist>
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
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
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
          className="shrink-0 rounded-full bg-warm px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted transition hover:bg-stone/40 hover:text-ink"
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
            <p className="truncate text-[11px] text-muted">{secondary}</p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium tabular-nums ${pill}`}
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
