import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import {
  cleaningScheduleFor,
  todayISO,
  CLEANING_CADENCE_DAYS,
} from "@/lib/cleaning";
import { formatDate } from "@/lib/date";

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
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
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

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="border-b border-stone/60 pb-6">
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Today</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          What needs attention right now. Press{" "}
          <kbd className="rounded border border-stone/60 px-1 text-[10px]">
            ⌘K
          </kbd>{" "}
          to jump to anything.
        </p>
      </header>

      <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Properties" value={totals.properties} href="/properties" />
        <Stat label="Rooms" value={totals.rooms} href="/properties" />
        <Stat
          label="Collected this month"
          value={fmtMoney(totals.collected)}
          href="/tenants"
        />
        <Stat
          label="Outstanding rent"
          value={fmtMoney(totals.expected)}
          href="/tenants"
          accent={totals.expected > 0}
        />
      </section>

      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        <Worklist
          title="Outstanding rent"
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
              rightTone="muted"
            />
          ))}
          {adWorklist.length > 8 && (
            <ShowMore href="/inventory?filter=no_ad" label={`+${adWorklist.length - 8} more`} />
          )}
        </Worklist>

        <Worklist
          title="Cleanings due"
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
                rightTone={c.status === "due_soon" ? "muted" : "warn"}
              />
            );
          })}
          {cleaningWorklist.length > 8 && (
            <ShowMore href="/cleaning" label={`+${cleaningWorklist.length - 8} more`} />
          )}
        </Worklist>

        <Worklist
          title="Tenancies ending soon"
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
  accent,
}: {
  label: string;
  value: string | number;
  href: string;
  accent?: boolean;
}) {
  return (
    <Link
      href={href}
      className="rounded-2xl bg-white p-5 shadow-sm transition hover:shadow"
    >
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p
        className={`mt-2 text-3xl font-light ${accent ? "text-red-700" : "text-ink"}`}
      >
        {value}
      </p>
    </Link>
  );
}

function Worklist({
  title,
  emptyText,
  countLabel,
  href,
  children,
}: {
  title: string;
  emptyText: string;
  countLabel: string;
  href: string;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children)
    ? children.flat().some((c) => c)
    : Boolean(children);
  return (
    <div className="rounded-2xl bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-stone/30 px-5 py-3">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        <Link href={href} className="text-[11px] uppercase tracking-wide text-muted hover:text-ink">
          {countLabel}
        </Link>
      </header>
      {hasChildren ? (
        <ul className="divide-y divide-stone/20">{children}</ul>
      ) : (
        <p className="px-5 py-8 text-center text-sm text-muted">{emptyText}</p>
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
  rightTone?: "muted" | "warn";
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-cream/60"
      >
        <div className="min-w-0">
          <p className="truncate text-sm text-ink">{primary}</p>
          {secondary && (
            <p className="truncate text-[11px] text-muted">{secondary}</p>
          )}
        </div>
        <span
          className={`shrink-0 text-xs tabular-nums ${
            rightTone === "warn" ? "text-red-700" : "text-muted"
          }`}
        >
          {right}
        </span>
      </Link>
    </li>
  );
}

function ShowMore({ href, label }: { href: string; label: string }) {
  return (
    <li className="px-5 py-2 text-center">
      <Link href={href} className="text-xs uppercase tracking-wide text-accent-text hover:underline">
        {label}
      </Link>
    </li>
  );
}
