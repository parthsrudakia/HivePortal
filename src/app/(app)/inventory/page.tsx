import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { formatDate } from "@/lib/date";
import { processExpiredTenancies } from "../tenants/actions";
import { CopyListing } from "./copy-listing";
import { ListingActionSelector } from "./listing-action";
import {
  InlineBaseRentEdit,
  InlineServicesEdit,
  InlineDateEdit,
} from "./inline-edit";
import {
  ACTION_BORDER,
  ACTION_LABELS,
  ACTION_ORDER,
  ACTION_SWATCH,
  type Action,
} from "./constants";

export const dynamic = "force-dynamic";

type PropertyRel = {
  id: string;
  building_name: string | null;
  street_address: string;
  unit_number: string;
  neighborhood: string | null;
  has_gym: boolean;
  has_elevator: boolean;
  has_parking: boolean;
  has_doorman: boolean;
  has_rooftop: boolean;
  laundry_in_building: boolean;
  in_unit_laundry: boolean;
};

type TenantRel = { full_name: string };
type TenancyRel = {
  status: "active" | "ended" | "upcoming";
  start_date: string;
  end_date: string | null;
  tenants: TenantRel | TenantRel[] | null;
};

type Row = {
  id: string;
  room_number: string | null;
  base_rent: number | null;
  bundle_fee: number | null;
  total_rent: number | null;
  available_from: string | null;
  status: "occupied" | "available" | "reserved" | "maintenance";
  marketing_description: string | null;
  photos_url: string | null;
  has_ac: boolean;
  has_private_bathroom: boolean;
  listing_action: Action;
  ad_url: string | null;
  ad_boosted: boolean;
  properties: PropertyRel | PropertyRel[] | null;
  tenancies: TenancyRel[] | null;
};

function fmtMoney(n: number | null) {
  if (n === null) return "—";
  return `$${n.toLocaleString()}`;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

type FilterKey =
  | "now"
  | "upcoming"
  | "no_ad"
  | "boosted"
  | "new_ad"
  | "update_price_or_date"
  | "delete_listing"
  | "boost_post"
  | "priority";

function isFilterKey(v: string | undefined): v is FilterKey {
  return (
    v === "now" ||
    v === "upcoming" ||
    v === "no_ad" ||
    v === "boosted" ||
    v === "new_ad" ||
    v === "update_price_or_date" ||
    v === "delete_listing" ||
    v === "boost_post" ||
    v === "priority"
  );
}

function matchesFilter(r: Row, filter: FilterKey, today: string) {
  switch (filter) {
    case "now":
      return (
        r.status === "available" &&
        (!r.available_from || r.available_from <= today)
      );
    case "upcoming":
      return (
        r.status === "occupied" ||
        (r.available_from !== null && r.available_from > today)
      );
    case "no_ad":
      return !r.ad_url;
    case "boosted":
      return r.ad_boosted;
    default:
      return r.listing_action === filter;
  }
}

type PageProps = {
  searchParams: Promise<{ filter?: string }>;
};

export default async function InventoryPage({ searchParams }: PageProps) {
  await processExpiredTenancies();

  const params = await searchParams;
  const activeFilter = isFilterKey(params.filter) ? params.filter : null;

  const supabase = await createClient();
  const today = todayStr();
  const { data, error } = await supabase
    .from("rooms")
    .select(
      `id, room_number, base_rent, bundle_fee, total_rent, available_from, status,
       marketing_description, photos_url, has_ac, has_private_bathroom,
       listing_action, ad_url, ad_boosted,
       properties(id, building_name, street_address, unit_number, neighborhood,
                  has_gym, has_elevator, has_parking, has_doorman, has_rooftop,
                  laundry_in_building, in_unit_laundry),
       tenancies(status, start_date, end_date, tenants(full_name))`,
    )
    .or(
      `status.eq.available,and(status.eq.occupied,available_from.gte.${today})`,
    )
    .order("available_from", { ascending: true, nullsFirst: true })
    .returns<Row[]>();

  const rooms = data ?? [];

  const counts = {
    total: rooms.length,
    now: rooms.filter((r) => matchesFilter(r, "now", today)).length,
    upcoming: rooms.filter((r) => matchesFilter(r, "upcoming", today)).length,
    no_ad: rooms.filter((r) => !r.ad_url).length,
    boosted: rooms.filter((r) => r.ad_boosted).length,
    by_action: Object.fromEntries(
      ACTION_ORDER.map((a) => [
        a,
        rooms.filter((r) => r.listing_action === a).length,
      ]),
    ) as Record<Action, number>,
  };

  const filtered = activeFilter
    ? rooms.filter((r) => matchesFilter(r, activeFilter, today))
    : rooms;

  return (
    <div className="mx-auto w-full max-w-7xl">
      <header className="border-b border-stone/60 pb-4">
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Inventory</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Rooms you can list right now — available today, and scheduled to open
          up.
        </p>
      </header>

      <section className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Total"
          value={counts.total}
          href="/inventory"
          active={activeFilter === null}
        />
        <KpiTile
          label="Available now"
          value={counts.now}
          href={activeFilter === "now" ? "/inventory" : "/inventory?filter=now"}
          active={activeFilter === "now"}
          dot="bg-accent"
        />
        <KpiTile
          label="Scheduled"
          value={counts.upcoming}
          href={
            activeFilter === "upcoming"
              ? "/inventory"
              : "/inventory?filter=upcoming"
          }
          active={activeFilter === "upcoming"}
          dot="bg-ink"
        />
        <KpiTile
          label="No ad yet"
          value={counts.no_ad}
          href={
            activeFilter === "no_ad" ? "/inventory" : "/inventory?filter=no_ad"
          }
          active={activeFilter === "no_ad"}
          dot="bg-red-500"
        />
        <KpiTile
          label="Boosted"
          value={counts.boosted}
          href={
            activeFilter === "boosted"
              ? "/inventory"
              : "/inventory?filter=boosted"
          }
          active={activeFilter === "boosted"}
          dot="bg-orange-500"
        />
      </section>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {ACTION_ORDER.map((a) => {
          const isActive = activeFilter === a;
          return (
            <li key={a}>
              <Link
                href={isActive ? "/inventory" : `/inventory?filter=${a}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition ${
                  isActive
                    ? "border-ink bg-ink text-white"
                    : "border-stone bg-white text-ink hover:bg-warm"
                }`}
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${ACTION_SWATCH[a]}`}
                />
                {ACTION_LABELS[a]} ({counts.by_action[a]})
              </Link>
            </li>
          );
        })}
      </ul>

      {error && <p className="mt-6 text-sm text-red-700">{error.message}</p>}

      {rooms.length === 0 && (
        <p className="mt-10 rounded-xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
          No rooms to list right now. A room appears here when its status is
          <em> Available </em>or when an active tenancy is scheduled to end.
        </p>
      )}

      {rooms.length > 0 && filtered.length === 0 && (
        <p className="mt-10 rounded-xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
          No rooms match this filter.{" "}
          <Link href="/inventory" className="text-accent-text">
            Clear filter
          </Link>
          .
        </p>
      )}

      {filtered.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
          <table className="w-full min-w-[1400px] text-sm">
            <thead className="sticky top-0 z-10 bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="w-1.5" />
                <th className="px-3 py-2 font-medium">Unit</th>
                <th className="px-3 py-2 font-medium">Room</th>
                <th className="px-3 py-2 font-medium">Available</th>
                <th className="px-3 py-2 text-right font-medium">Rent</th>
                <th className="px-3 py-2 text-right font-medium">Services</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Amenities</th>
                <th className="px-3 py-2 font-medium">Photos</th>
                <th className="px-3 py-2 font-medium">Tenant</th>
                <th className="px-3 py-2 font-medium">Listing action</th>
                <th className="px-3 py-2 font-medium">Ad</th>
                <th className="px-3 py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <InventoryRow key={r.id} room={r} striped={i % 2 === 1} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function KpiTile({
  label,
  value,
  href,
  active,
  dot,
}: {
  label: string;
  value: number;
  href: string;
  active: boolean;
  dot?: string;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 shadow-sm transition ${
        active ? "bg-ink text-white" : "bg-white hover:shadow"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {dot && !active && (
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        )}
        <p
          className={`truncate text-[11px] uppercase tracking-wide ${active ? "text-white/70" : "text-muted"}`}
        >
          {label}
        </p>
      </div>
      <p
        className={`text-2xl font-light ${active ? "text-white" : "text-ink"}`}
      >
        {value}
      </p>
    </Link>
  );
}

function InventoryRow({
  room,
  striped,
}: {
  room: Row;
  striped: boolean;
}) {
  const p = one(room.properties);
  const unitTitle = p
    ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
    : "—";

  const tenancies = (room.tenancies ?? [])
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  const activeOutgoing = tenancies.find(
    (t) => t.status === "active" && t.end_date,
  );
  const previous = tenancies.find((t) => t.status === "ended");
  const featured = activeOutgoing ?? previous;
  const featuredTenantName = featured
    ? one(featured.tenants)?.full_name ?? null
    : null;
  const featuredLabel = activeOutgoing ? "Out" : "Prev";

  return (
    <tr
      className={`border-t border-stone/30 ${striped ? "bg-cream/40" : "bg-white"} hover:bg-warm/30`}
    >
      <td className={`w-1.5 p-0 ${ACTION_BORDER[room.listing_action].replace("border-l-", "bg-")}`} />
      <td className="px-3 py-2.5">
        <Link
          href={`/inventory/${room.id}`}
          className="text-ink hover:text-accent-text"
        >
          {unitTitle}
        </Link>
        {p?.neighborhood && (
          <div className="text-[11px] text-muted">{p.neighborhood}</div>
        )}
      </td>
      <td className="px-3 py-2.5 text-ink">{room.room_number ?? "—"}</td>
      <td className="px-2 py-1.5">
        <InlineDateEdit roomId={room.id} date={room.available_from} />
      </td>
      <td className="px-2 py-1.5 text-right">
        <InlineBaseRentEdit roomId={room.id} value={room.base_rent} />
      </td>
      <td className="px-2 py-1.5 text-right">
        <InlineServicesEdit roomId={room.id} value={room.bundle_fee} />
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums font-medium text-ink">
        {fmtMoney(room.total_rent)}
      </td>
      <td className="px-3 py-2.5">
        <Amenities room={room} property={p} />
      </td>
      <td className="px-3 py-2.5">
        {room.photos_url ? (
          <a
            href={room.photos_url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-stone bg-white px-2 py-0.5 text-[11px] uppercase tracking-wide text-ink hover:bg-warm"
          >
            Open ↗
          </a>
        ) : (
          <span className="text-[11px] text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-[12px]">
        {featuredTenantName ? (
          <>
            <span className="text-muted">{featuredLabel}: </span>
            <span className="text-ink">{featuredTenantName}</span>
          </>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <ListingActionSelector
          roomId={room.id}
          current={room.listing_action}
        />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {room.ad_url ? (
            <a
              href={room.ad_url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-900 hover:bg-green-200"
            >
              Live ↗
            </a>
          ) : (
            <span className="rounded-full border border-stone bg-white px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted">
              None
            </span>
          )}
          {room.ad_boosted && (
            <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-900">
              ✓ Boost
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-right">
        <div className="flex items-center justify-end gap-2">
          {room.marketing_description && (
            <CopyListing text={room.marketing_description} />
          )}
          <Link
            href={`/tenants/new?room_id=${room.id}`}
            className="rounded-full bg-ink px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-white hover:bg-accent-dark"
          >
            + Tenant
          </Link>
          <Link
            href={`/inventory/${room.id}`}
            className="text-[11px] uppercase tracking-wide text-muted hover:text-accent-text"
          >
            Open →
          </Link>
        </div>
      </td>
    </tr>
  );
}

function Amenities({
  room,
  property,
}: {
  room: Pick<Row, "has_ac" | "has_private_bathroom">;
  property: PropertyRel | null;
}) {
  const tags: string[] = [];
  if (room.has_ac) tags.push("AC");
  if (room.has_private_bathroom) tags.push("Private bath");
  if (property?.has_gym) tags.push("Gym");
  if (property?.has_elevator) tags.push("Elevator");
  if (property?.has_doorman) tags.push("Doorman");
  if (property?.has_parking) tags.push("Parking");
  if (property?.has_rooftop) tags.push("Rooftop");
  if (property?.in_unit_laundry) tags.push("In-unit laundry");
  else if (property?.laundry_in_building) tags.push("Laundry");

  if (tags.length === 0) {
    return <span className="text-[11px] text-muted">—</span>;
  }
  return (
    <div className="flex max-w-[220px] flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full bg-warm px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink/70"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

