import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { formatDate, todayISO } from "@/lib/date";
import { processExpiredTenancies } from "../tenants/actions";
import { CopyListing } from "./copy-listing";
import { ListingActionSelector } from "./listing-action";
import {
  InlineAdEdit,
  InlineBaseRentEdit,
  InlineServicesEdit,
  InlineDateEdit,
  InlinePhotosEdit,
} from "./inline-edit";
import { InlineAmenitiesEdit } from "./amenities-edit";
import { AddInventory, type AddableRoom } from "./add-inventory";
import { DeleteListingButton } from "./delete-listing";
import { NeighborhoodFilter } from "./filters";
import {
  ACTION_BORDER,
  ACTION_LABELS,
  ACTION_ORDER,
  ACTION_SWATCH,
  ACTION_TINT,
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
  has_lounge: boolean;
  laundry_in_building: boolean;
  in_unit_laundry: boolean;
};

type TenantRel = { id: string; full_name: string };
type TenancyRel = {
  id: string;
  status: "active" | "ended" | "upcoming";
  start_date: string;
  move_out_date: string | null;
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
  ad_posted_by: string | null;
  properties: PropertyRel | PropertyRel[] | null;
  tenancies: TenancyRel[] | null;
};

function fmtMoney(n: number | null) {
  if (n === null) return "—";
  return `$${n.toLocaleString()}`;
}

const todayStr = () => todayISO();

type FilterKey =
  | "now"
  | "upcoming"
  | "no_ad"
  | "boosted"
  | "no_action"
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
    v === "no_action" ||
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

type SortKey =
  | "unit"
  | "neighborhood"
  | "available"
  | "rent"
  | "services"
  | "total";

const DEFAULT_SORT: SortKey = "available";
const DEFAULT_DIR: "asc" | "desc" = "asc";

function isSortKey(v: string | undefined): v is SortKey {
  return (
    v === "unit" ||
    v === "neighborhood" ||
    v === "available" ||
    v === "rent" ||
    v === "services" ||
    v === "total"
  );
}

function unitTitleOf(r: Row): string {
  const p = one(r.properties);
  if (!p) return "";
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

// Numbers: nulls sort last (ascending). Dates: a null `available_from` means
// "available now", so it sorts earliest. Strings: natural/numeric compare.
function cmpNum(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function cmpDate(a: string | null, b: string | null): number {
  const av = a ?? "";
  const bv = b ?? "";
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function cmpStr(a: string | null, b: string | null): number {
  return (a ?? "").localeCompare(b ?? "", undefined, { numeric: true });
}

function compareRooms(a: Row, b: Row, sort: SortKey): number {
  switch (sort) {
    case "unit":
      return cmpStr(unitTitleOf(a), unitTitleOf(b));
    case "neighborhood":
      return cmpStr(
        one(a.properties)?.neighborhood ?? null,
        one(b.properties)?.neighborhood ?? null,
      );
    case "rent":
      return cmpNum(a.base_rent, b.base_rent);
    case "services":
      return cmpNum(a.bundle_fee, b.bundle_fee);
    case "total":
      return cmpNum(a.total_rent, b.total_rent);
    case "available":
    default:
      return cmpDate(a.available_from, b.available_from);
  }
}

type PageProps = {
  searchParams: Promise<{
    filter?: string;
    sort?: string;
    dir?: string;
    hood?: string;
  }>;
};

export default async function InventoryPage({ searchParams }: PageProps) {
  await processExpiredTenancies();

  const params = await searchParams;
  const activeFilter = isFilterKey(params.filter) ? params.filter : null;
  const sortKey = isSortKey(params.sort) ? params.sort : DEFAULT_SORT;
  const sortDir = params.dir === "desc" ? "desc" : "asc";
  const hood = params.hood?.trim() || null;

  const supabase = await createClient();
  const today = todayStr();
  const { data, error } = await supabase
    .from("rooms")
    .select(
      `id, room_number, base_rent, bundle_fee, total_rent, available_from, status,
       marketing_description, photos_url, has_ac, has_private_bathroom,
       listing_action, ad_url, ad_boosted, ad_posted_by,
       properties(id, building_name, street_address, unit_number, neighborhood,
                  has_gym, has_elevator, has_parking, has_doorman, has_rooftop, has_lounge,
                  laundry_in_building, in_unit_laundry),
       tenancies(id, status, start_date, move_out_date, tenants(id, full_name))`,
    )
    .or(
      `status.eq.available,and(status.eq.occupied,available_from.gte.${today})`,
    )
    .eq("pending_tenant", false)
    .order("available_from", { ascending: true, nullsFirst: true })
    .returns<Row[]>();

  const rooms = data ?? [];

  // Rooms that aren't currently listed — candidates for "+ Add Inventory".
  // Anything not matching the inventory filter above: reserved/maintenance, or
  // occupied with no scheduled move-out (a "filled" room).
  type AddableRow = {
    id: string;
    room_number: string | null;
    status: "occupied" | "available" | "reserved" | "maintenance";
    available_from: string | null;
    pending_tenant: boolean;
    properties:
      | { building_name: string | null; street_address: string; unit_number: string }
      | { building_name: string | null; street_address: string; unit_number: string }[]
      | null;
    tenancies:
      | {
          id: string;
          status: "active" | "ended" | "upcoming";
          tenant_id: string | null;
          tenants: { full_name: string } | { full_name: string }[] | null;
        }[]
      | null;
  };
  const { data: allRoomsData } = await supabase
    .from("rooms")
    .select(
      `id, room_number, status, available_from, pending_tenant,
       properties(building_name, street_address, unit_number),
       tenancies(id, status, tenant_id, tenants(full_name))`,
    )
    .order("room_number", { ascending: true })
    .returns<AddableRow[]>();

  const inInventory = (status: string, af: string | null) =>
    status === "available" ||
    (status === "occupied" && af !== null && af >= today);

  const addableRooms: AddableRoom[] = (allRoomsData ?? [])
    .filter((r) => !r.pending_tenant && !inInventory(r.status, r.available_from))
    .map((r) => {
      const pr = one(r.properties);
      const unit = pr
        ? `${pr.building_name?.trim() || pr.street_address} Apt ${pr.unit_number}`
        : "—";
      const roomNum = r.room_number?.replace(/^room\s+/i, "") ?? "";
      const active = (r.tenancies ?? []).find((t) => t.status === "active");
      return {
        id: r.id,
        label: roomNum ? `${unit} · Room ${roomNum}` : unit,
        status: r.status,
        tenancyId: active?.id ?? null,
        tenantId: active?.tenant_id ?? null,
        tenantName: active ? one(active.tenants)?.full_name ?? null : null,
      };
    })
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    );

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

  // Neighborhood options come from the full inventory, so the dropdown stays
  // stable regardless of the active filter.
  const neighborhoods = Array.from(
    new Set(
      rooms
        .map((r) => one(r.properties)?.neighborhood)
        .filter((n): n is string => !!n),
    ),
  ).sort((a, b) => a.localeCompare(b));

  let filtered = activeFilter
    ? rooms.filter((r) => matchesFilter(r, activeFilter, today))
    : rooms.slice();
  if (hood) {
    filtered = filtered.filter((r) => one(r.properties)?.neighborhood === hood);
  }
  filtered.sort((a, b) => {
    const base = compareRooms(a, b, sortKey);
    // Stable tiebreak on the date so equal sort keys keep a sensible order.
    const cmp = base !== 0 ? base : cmpDate(a.available_from, b.available_from);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <div className="mx-auto w-full max-w-7xl">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone/60 pb-4">
        <div>
          <h1 className="text-3xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Inventory</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Rooms you can list right now — available today, and scheduled to open
            up.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <a
            href="/inventory/export-full"
            download
            className="rounded-full border border-stone bg-white px-4 py-2 text-sm font-medium text-ink shadow-sm transition hover:border-accent hover:text-accent-text"
          >
            ↓ Download Sheet
          </a>
          <a
            href="/inventory/export"
            download
            className="rounded-full border border-stone bg-white px-4 py-2 text-sm font-medium text-ink shadow-sm transition hover:border-accent hover:text-accent-text"
          >
            ↓ Download Shareable Sheet
          </a>
        </div>
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

      {neighborhoods.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <NeighborhoodFilter neighborhoods={neighborhoods} />
          <p className="text-[12px] text-muted">
            {filtered.length} of {rooms.length} rooms
            {hood ? ` · ${hood}` : ""}
          </p>
        </div>
      )}

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
              <tr className="divide-x divide-stone/40">
                <th className="w-10" />
                <th className="w-1.5" />
                <SortHeader
                  label="Unit"
                  sortKey="unit"
                  activeSort={sortKey}
                  dir={sortDir}
                  filter={activeFilter}
                  hood={hood}
                />
                <SortHeader
                  label="Neighborhood"
                  sortKey="neighborhood"
                  activeSort={sortKey}
                  dir={sortDir}
                  filter={activeFilter}
                  hood={hood}
                />
                <th className="px-3 py-2 font-medium">Room</th>
                <SortHeader
                  label="Available"
                  sortKey="available"
                  activeSort={sortKey}
                  dir={sortDir}
                  filter={activeFilter}
                  hood={hood}
                />
                <SortHeader
                  label="Rent"
                  sortKey="rent"
                  activeSort={sortKey}
                  dir={sortDir}
                  filter={activeFilter}
                  hood={hood}
                  align="right"
                />
                <SortHeader
                  label="Services"
                  sortKey="services"
                  activeSort={sortKey}
                  dir={sortDir}
                  filter={activeFilter}
                  hood={hood}
                  align="right"
                />
                <SortHeader
                  label="Total"
                  sortKey="total"
                  activeSort={sortKey}
                  dir={sortDir}
                  filter={activeFilter}
                  hood={hood}
                  align="right"
                />
                <th className="px-3 py-2 font-medium">Amenities</th>
                <th className="px-3 py-2 font-medium">Photos</th>
                <th className="px-3 py-2 font-medium">Tenant</th>
                <th className="px-3 py-2 font-medium">Listing action</th>
                <th className="px-3 py-2 font-medium">Ad</th>
                <th className="px-3 py-2 font-medium">Ad Posted</th>
                <th className="px-3 py-2 font-medium">Roommates</th>
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

      <div className="mt-6 flex justify-center">
        <AddInventory rooms={addableRooms} today={today} />
      </div>
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

function SortHeader({
  label,
  sortKey,
  activeSort,
  dir,
  filter,
  hood,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  activeSort: SortKey;
  dir: "asc" | "desc";
  filter: FilterKey | null;
  hood: string | null;
  align?: "left" | "right";
}) {
  const isActive = activeSort === sortKey;
  // Clicking the active column flips direction; a fresh column starts ascending.
  const nextDir = isActive && dir === "asc" ? "desc" : "asc";

  const qs = new URLSearchParams();
  if (filter) qs.set("filter", filter);
  if (hood) qs.set("hood", hood);
  // Keep the URL clean when it lands on the default sort.
  if (!(sortKey === DEFAULT_SORT && nextDir === DEFAULT_DIR)) {
    qs.set("sort", sortKey);
    qs.set("dir", nextDir);
  }
  const href = qs.toString() ? `/inventory?${qs.toString()}` : "/inventory";
  const arrow = isActive ? (dir === "asc" ? "↑" : "↓") : "↕";

  return (
    <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : ""}`}>
      <Link
        href={href}
        scroll={false}
        className={`group inline-flex items-center gap-1 ${
          align === "right" ? "flex-row-reverse" : ""
        } ${isActive ? "text-ink" : "hover:text-ink"}`}
      >
        {label}
        <span
          className={`text-[10px] ${isActive ? "text-accent-text" : "text-stone group-hover:text-muted"}`}
        >
          {arrow}
        </span>
      </Link>
    </th>
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
    (t) => t.status === "active" && t.move_out_date,
  );
  const previous = tenancies.find((t) => t.status === "ended");
  const featured = activeOutgoing ?? previous;
  const featuredTenant = featured ? one(featured.tenants) : null;

  return (
    <tr
      className={`divide-x divide-stone/30 border-t border-stone/30 ${
        room.listing_action === "no_action"
          ? striped
            ? "bg-cream/40"
            : "bg-white"
          : ACTION_TINT[room.listing_action]
      } hover:bg-warm/30`}
    >
      <td className="px-2 py-2.5 text-center align-middle">
        <DeleteListingButton
          roomId={room.id}
          label={unitTitle}
          tenancyId={activeOutgoing?.id ?? null}
        />
      </td>
      <td className={`w-1.5 p-0 ${ACTION_BORDER[room.listing_action].replace("border-l-", "bg-")}`} />
      <td className="px-3 py-2.5">
        <Link
          href={`/inventory/${room.id}`}
          className="font-medium text-accent-text underline decoration-accent/40 underline-offset-2 hover:text-accent-dark hover:decoration-accent-dark"
        >
          {unitTitle}
        </Link>
      </td>
      <td className="px-3 py-2.5 text-[12px] text-ink">
        {p?.neighborhood || <span className="text-muted">—</span>}
      </td>
      <td className="px-3 py-2.5 text-ink">
        {room.room_number?.replace(/^room\s+/i, "") || "—"}
      </td>
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
      <td className="px-3 py-1.5">
        <InlineAmenitiesEdit
          roomId={room.id}
          propertyId={p?.id ?? null}
          values={{
            has_private_bathroom: room.has_private_bathroom,
            has_gym: p?.has_gym ?? false,
            has_elevator: p?.has_elevator ?? false,
            has_parking: p?.has_parking ?? false,
            has_doorman: p?.has_doorman ?? false,
            has_rooftop: p?.has_rooftop ?? false,
            has_lounge: p?.has_lounge ?? false,
            laundry_in_building: p?.laundry_in_building ?? false,
            in_unit_laundry: p?.in_unit_laundry ?? false,
          }}
        >
          <Amenities room={room} property={p} />
        </InlineAmenitiesEdit>
      </td>
      <td className="px-3 py-1.5">
        <InlinePhotosEdit roomId={room.id} url={room.photos_url} />
      </td>
      <td className="px-3 py-2.5 text-[12px]">
        {featuredTenant ? (
          <Link
            href={`/tenants/${featuredTenant.id}`}
            className="font-medium text-accent-text underline decoration-accent/40 underline-offset-2 hover:text-accent-dark hover:decoration-accent-dark"
          >
            {featuredTenant.full_name}
          </Link>
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
          <InlineAdEdit roomId={room.id} url={room.ad_url} />
          {room.ad_boosted && (
            <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-900">
              ✓ Boost
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-[12px] text-ink">
        {room.ad_posted_by?.trim() || (
          <span className="text-muted">-</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {p ? (
          <Link
            href={`/properties/${p.id}#residents`}
            className="inline-block whitespace-nowrap rounded-full border border-stone bg-white px-2.5 py-0.5 text-[11px] uppercase tracking-wide text-ink hover:bg-warm"
          >
            Roommates
          </Link>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right">
        <div className="flex items-center justify-end gap-2">
          {room.marketing_description && (
            <CopyListing text={room.marketing_description} />
          )}
        </div>
      </td>
    </tr>
  );
}

function Amenities({
  room,
  property,
}: {
  room: Pick<Row, "has_private_bathroom">;
  property: PropertyRel | null;
}) {
  const tags: string[] = [];
  if (room.has_private_bathroom) tags.push("Private bath");
  if (property?.has_gym) tags.push("Gym");
  if (property?.has_elevator) tags.push("Elevator");
  if (property?.has_doorman) tags.push("Doorman");
  if (property?.has_parking) tags.push("Parking");
  if (property?.has_rooftop) tags.push("Rooftop");
  if (property?.has_lounge) tags.push("Lounge");
  if (property?.in_unit_laundry) tags.push("In-unit laundry");
  else if (property?.laundry_in_building) tags.push("Laundry");

  if (tags.length === 0) {
    return <span className="text-[11px] text-muted">—</span>;
  }
  return (
    <span className="text-[12px] text-ink">{tags.join(", ")}</span>
  );
}

