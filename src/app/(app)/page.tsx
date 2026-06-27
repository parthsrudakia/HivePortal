import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { cleaningScheduleFor, todayISO } from "@/lib/cleaning";
import { formatDate, currentRentCycle } from "@/lib/date";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { isMaster } from "@/lib/access";
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


export default async function Dashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Aggregate collection totals are admin-only; per-tenant outstanding amounts
  // (pending balances) stay visible to everyone.
  const admin = isMaster(user?.email);
  const today = todayISO();
  // "Collected this month" follows the rent cycle (27th → 26th), since tenants
  // pay from the 27th.
  const tm = currentRentCycle();

  const [
    propertyCountRes,
    roomCountRes,
    properties,
    rooms,
    cleanings,
    tenancies,
    payments,
    roomAds,
  ] = await Promise.all([
    supabase.from("properties").select("*", { count: "exact", head: true }),
    supabase.from("rooms").select("*", { count: "exact", head: true }),
    supabase
      .from("properties")
      .select("id, building_name, street_address, unit_number, neighborhood"),
    supabase
      .from("rooms")
      .select(
        `id, room_number, status, available_from,
         total_rent, pending_tenant, listing_action,
         properties(building_name, street_address, unit_number)`,
      ),
    supabase
      .from("cleaning_records")
      .select("property_id, cleaning_date, kind")
      .order("cleaning_date", { ascending: false }),
    supabase
      .from("tenancies")
      .select(
        `id, tenant_id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, lease_end_date, status,
         rooms(room_number, properties(building_name, street_address, unit_number)),
         tenants(full_name, email, phone)`,
      )
      .eq("status", "active"),
    supabase
      .from("payments")
      .select("tenancy_id, amount, paid_on, payment_type"),
    // room_ads post-dates the generated types — query it untyped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("room_ads").select("room_id, posted_by"),
  ]);

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
    last: string | null;
    next: string | null;
    daysUntilNext: number | null; // days between today and the next cleaning
  };
  const todayMs = new Date(today + "T00:00:00").getTime();
  const cleaningWorklist: CleaningEntry[] = (properties.data ?? []).map((p) => {
    const last = lastByProperty.get(p.id) ?? null;
    const s = cleaningScheduleFor(last, today);
    const daysUntilNext = s.nextDue
      ? Math.round((new Date(s.nextDue + "T00:00:00").getTime() - todayMs) / 86400000)
      : null;
    return {
      property_id: p.id,
      label: unitLabel(p),
      last,
      next: s.nextDue,
      daysUntilNext,
    };
  });
  // Soonest next cleaning first; never-cleaned units (no next date) last.
  cleaningWorklist.sort((a, b) => {
    if (a.next === b.next) return 0;
    if (!a.next) return 1;
    if (!b.next) return -1;
    return a.next < b.next ? -1 : 1;
  });

  // Group all payments by tenancy for the running ledger, and tally this
  // month's rent collection for the KPI.
  const paymentsByTenancy = new Map<
    string,
    { amount: number; paid_on: string; payment_type: string }[]
  >();
  let collectedThisMonth = 0;
  for (const pmt of payments.data ?? []) {
    const list = paymentsByTenancy.get(pmt.tenancy_id);
    if (list) list.push(pmt);
    else paymentsByTenancy.set(pmt.tenancy_id, [pmt]);
    if (
      pmt.payment_type === "rent" &&
      pmt.paid_on >= tm.start &&
      pmt.paid_on <= tm.end
    ) {
      collectedThisMonth += Number(pmt.amount);
    }
  }

  const { charges, allocations } = await fetchLedgerSidecars(supabase);

  // Rent worklist: active tenancies whose running net balance is positive.
  type RentEntry = {
    tenant_id: string;
    tenant_name: string;
    unit: string;
    room: string;
    outstanding: number;
  };
  type TenancyRow = {
    id: string;
    tenant_id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    security_deposit: number | null;
    start_date: string;
    move_out_date: string | null;
    lease_end_date: string | null;
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
    tenants:
      | { full_name: string; email: string | null; phone: string | null }
      | { full_name: string; email: string | null; phone: string | null }[]
      | null;
  };
  const rentWorklist: RentEntry[] = [];
  for (const t of (tenancies.data ?? []) as TenancyRow[]) {
    const { netBalance } = computeLedger(
      t,
      paymentsByTenancy.get(t.id) ?? [],
      charges.get(t.id) ?? [],
      allocations.get(t.id) ?? [],
      today,
    );
    if (netBalance <= 0.01) continue;
    const room = one(t.rooms);
    const tenant = one(t.tenants);
    rentWorklist.push({
      tenant_id: t.tenant_id,
      tenant_name: tenant?.full_name ?? "—",
      unit: unitLabel(one(room?.properties ?? null)),
      room: room?.room_number ?? "Room",
      outstanding: netBalance,
    });
  }
  rentWorklist.sort((a, b) => b.outstanding - a.outstanding);

  // Inventory list — rooms listable on /inventory (available now or scheduled).
  type RoomRow = {
    id: string;
    room_number: string | null;
    status: string;
    available_from: string | null;
    total_rent: number | null;
    pending_tenant: boolean;
    listing_action: string;
    properties: PropertyRel | PropertyRel[] | null;
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

  const totals = {
    properties: propertyCountRes.count ?? 0,
    rooms: roomCountRes.count ?? 0,
    outstanding: rentWorklist.reduce((s, r) => s + r.outstanding, 0),
    collected: collectedThisMonth,
  };

  const dateLabel = new Date(today + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mx-auto w-full max-w-7xl">
      <header className="relative overflow-hidden rounded-3xl bg-ink px-6 py-8 text-cream shadow-sm md:px-9 md:py-10">
        <div
          className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-accent/25 blur-3xl"
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
        {admin && (
          <Stat
            label="Collected this month"
            value={fmtMoney(totals.collected)}
            href="/tenants"
            icon={<IconMoney />}
          />
        )}
        {admin && (
          <Stat
            label="Outstanding rent"
            value={fmtMoney(totals.outstanding)}
            href="/tenants"
            icon={<IconAlert />}
            tone={totals.outstanding > 0 ? "warn" : "default"}
          />
        )}
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
            <p className="mt-4 text-sm text-muted">
              No listable rooms right now.
            </p>
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
                  className="mt-3 inline-block text-xs uppercase tracking-wide text-accent-text hover:text-accent-dark"
                >
                  +{inventoryList.length - 12} more
                </Link>
              )}
            </div>
          )}
        </div>

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
                    const overdue = c.next !== null && c.next < today;
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
                          {c.last ? formatDate(c.last) : <span className="text-muted">—</span>}
                        </td>
                        <td className={`px-3 py-2 ${overdue ? "text-red-700" : "text-ink"}`}>
                          {c.next ? formatDate(c.next) : <span className="text-muted">—</span>}
                        </td>
                        <td className={`px-3 py-2 tabular-nums ${overdue ? "text-red-700" : "text-ink"}`}>
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
                  className="mt-3 inline-block text-xs uppercase tracking-wide text-accent-text hover:text-accent-dark"
                >
                  +{cleaningWorklist.length - 12} more
                </Link>
              )}
            </div>
          )}
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
              <IconCalendar />
              Lease ending soon
            </h2>
            <Link
              href="/tenants"
              className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
            >
              View all →
            </Link>
          </div>
          {endingSoon.length === 0 ? (
            <p className="mt-4 text-sm text-muted">
              No moves planned in the next 30 days.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-center text-xs uppercase tracking-wide text-muted">
                  <tr className="border-b border-stone/40">
                    <th className="px-3 py-2 text-left font-medium">Unit</th>
                    <th className="px-3 py-2 font-medium">Room</th>
                    <th className="px-3 py-2 font-medium">Tenant</th>
                    <th className="px-3 py-2 font-medium">Lease end</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Phone</th>
                  </tr>
                </thead>
                <tbody className="text-center">
                  {endingSoon.slice(0, 12).map((t, i) => (
                    <tr
                      key={`${t.tenant_id}-${i}`}
                      className="border-b border-stone/20 last:border-0 hover:bg-warm/30"
                    >
                      <td className="px-3 py-2 text-left">
                        <Link
                          href={`/tenants/${t.tenant_id}`}
                          className="text-accent-text hover:text-accent-dark"
                        >
                          {t.unit}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-ink">{t.room || "—"}</td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/tenants/${t.tenant_id}`}
                          className="text-accent-text hover:text-accent-dark"
                        >
                          {t.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-ink">
                        {formatDate(t.lease_end_date)}
                      </td>
                      <td className="px-3 py-2">
                        {t.email ? (
                          <a
                            href={`mailto:${t.email}`}
                            className="text-accent-text hover:text-accent-dark"
                          >
                            {t.email}
                          </a>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {t.phone ? (
                          <a
                            href={`tel:${t.phone}`}
                            className="text-accent-text hover:text-accent-dark"
                          >
                            {t.phone}
                          </a>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {endingSoon.length > 12 && (
                <Link
                  href="/tenants"
                  className="mt-3 inline-block text-xs uppercase tracking-wide text-accent-text hover:text-accent-dark"
                >
                  +{endingSoon.length - 12} more
                </Link>
              )}
            </div>
          )}
        </div>
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
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium tabular-nums ${pill}`}
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
