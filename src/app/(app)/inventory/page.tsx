import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
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
import {
  ACTION_BORDER,
  ACTION_TINT,
  ACTION_SWATCH,
  ACTION_LABELS,
  ACTION_ORDER,
  type Action,
} from "./constants";
import {
  DEFAULT_SORT,
  DEFAULT_DIR,
  isSortKey,
  filterAndSortRooms,
  type SortKey,
} from "@/lib/inventory-filter";

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

type PageProps = {
  searchParams: Promise<{
    sort?: string;
    dir?: string;
    poster?: string;
  }>;
};

// Build an /inventory URL preserving the current sort while toggling the
// ad-poster filter. Keeps the URL clean when everything is at its default.
function inventoryHref(
  sortKey: SortKey,
  sortDir: "asc" | "desc",
  poster: string | null,
): string {
  const qs = new URLSearchParams();
  if (!(sortKey === DEFAULT_SORT && sortDir === DEFAULT_DIR)) {
    qs.set("sort", sortKey);
    qs.set("dir", sortDir);
  }
  if (poster) qs.set("poster", poster);
  return qs.toString() ? `/inventory?${qs.toString()}` : "/inventory";
}

export default async function InventoryPage({ searchParams }: PageProps) {
  await processExpiredTenancies();

  const params = await searchParams;
  const sortKey = isSortKey(params.sort) ? params.sort : DEFAULT_SORT;
  const sortDir = params.dir === "desc" ? "desc" : "asc";
  const posterFilter = params.poster?.trim() || null;

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

  // Ads-posted tally per person. `ad_posted_by` is a snapshot of whoever saved
  // the URL (display name, else email). We count across all rooms (not just the
  // currently-listed inventory) so the numbers reflect total ads each person
  // has posted. The list is seeded with everyone on the notification-recipients
  // list (so configured people show even with zero ads) and then unioned with
  // anyone who has posted an ad but isn't on that list — matching a recipient
  // to their posts by either their label or email.
  const { data: adPosterData } = await supabase
    .from("rooms")
    .select("ad_posted_by")
    .not("ad_posted_by", "is", null)
    .returns<{ ad_posted_by: string | null }[]>();

  const { data: recipientData } = await supabase
    .from("notification_recipients")
    .select("id, email, label")
    .returns<{ id: string; email: string; label: string | null }[]>();

  // key (lowercased poster string) -> { display name, count }
  const adCountByPoster = new Map<string, { name: string; count: number }>();
  for (const a of adPosterData ?? []) {
    const raw = a.ad_posted_by?.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const cur = adCountByPoster.get(key);
    if (cur) cur.count += 1;
    else adCountByPoster.set(key, { name: raw, count: 1 });
  }

  const recipientAdCounts: {
    id: string;
    name: string;
    count: number;
    keys: string[];
  }[] = [];
  const usedKeys = new Set<string>();
  for (const rec of recipientData ?? []) {
    const label = rec.label?.trim() || null;
    const email = rec.email.trim();
    const keys = [label?.toLowerCase(), email.toLowerCase()].filter(
      (k): k is string => !!k,
    );
    let count = 0;
    for (const k of keys) {
      count += adCountByPoster.get(k)?.count ?? 0;
      usedKeys.add(k);
    }
    recipientAdCounts.push({ id: rec.id, name: label ?? email, count, keys });
  }
  // Anyone who posted an ad but isn't on the recipients list.
  for (const [key, { name, count }] of adCountByPoster) {
    if (usedKeys.has(key)) continue;
    recipientAdCounts.push({ id: `poster:${key}`, name, count, keys: [key] });
  }
  recipientAdCounts.sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );

  // When a poster pill is selected, narrow the table to that person's ads.
  const selectedPoster = posterFilter
    ? recipientAdCounts.find((r) => r.id === posterFilter) ?? null
    : null;
  const posterKeys = selectedPoster ? new Set(selectedPoster.keys) : null;

  const filtered = filterAndSortRooms(rooms, {
    sort: sortKey,
    dir: sortDir,
    posterKeys,
  });

  // Query string that mirrors the current table view, so the sheet downloads
  // export exactly what's on screen (same filters + sort) at click time.
  const exportQuery = (() => {
    const qs = new URLSearchParams();
    if (!(sortKey === DEFAULT_SORT && sortDir === DEFAULT_DIR)) {
      qs.set("sort", sortKey);
      qs.set("dir", sortDir);
    }
    if (posterFilter) qs.set("poster", posterFilter);
    const s = qs.toString();
    return s ? `?${s}` : "";
  })();

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
            href={`/inventory/export-full${exportQuery}`}
            download
            className="rounded-full border border-stone bg-white px-4 py-2 text-sm font-medium text-ink shadow-sm transition hover:border-accent hover:text-accent-text"
          >
            ↓ Download Sheet
          </a>
          <a
            href={`/inventory/export${exportQuery}`}
            download
            className="rounded-full border border-stone bg-white px-4 py-2 text-sm font-medium text-ink shadow-sm transition hover:border-accent hover:text-accent-text"
          >
            ↓ Download Shareable Sheet
          </a>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-stone/40">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Listing action
        </span>
        {ACTION_ORDER.map((a) => (
          <span key={a} className="inline-flex items-center gap-1.5 text-xs text-ink">
            <span
              className={`h-3 w-3 shrink-0 rounded-sm ${ACTION_SWATCH[a]}`}
              aria-hidden
            />
            {ACTION_LABELS[a]}
          </span>
        ))}
      </div>

      {recipientAdCounts.length > 0 && (
        <section className="mt-4 rounded-xl bg-white p-3 shadow-sm ring-1 ring-stone/40">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[11px] uppercase tracking-wide text-muted">
              Ads posted by user
            </h2>
            {selectedPoster && (
              <Link
                href={inventoryHref(sortKey, sortDir, null)}
                scroll={false}
                className="text-[11px] uppercase tracking-wide text-accent-text hover:text-accent-dark"
              >
                Clear filter
              </Link>
            )}
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
            {recipientAdCounts.map((r) => {
              const active = selectedPoster?.id === r.id;
              return (
                <li key={r.id}>
                  <Link
                    href={inventoryHref(
                      sortKey,
                      sortDir,
                      active ? null : r.id,
                    )}
                    scroll={false}
                    aria-pressed={active}
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] transition ${
                      active
                        ? "border-accent bg-accent/15 text-ink"
                        : "border-stone bg-cream/60 text-ink hover:border-accent"
                    }`}
                  >
                    <span className="font-medium">{r.name}</span>
                    <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">
                      {r.count}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {error && <p className="mt-6 text-sm text-red-700">{error.message}</p>}

      {rooms.length === 0 && (
        <p className="mt-10 rounded-xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
          No rooms to list right now. A room appears here when its status is
          <em> Available </em>or when an active tenancy is scheduled to end.
        </p>
      )}

      {rooms.length > 0 && filtered.length === 0 && selectedPoster && (
        <p className="mt-10 rounded-xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
          No currently-listed rooms were posted by{" "}
          <span className="font-medium text-ink">{selectedPoster.name}</span>.{" "}
          <Link
            href={inventoryHref(sortKey, sortDir, null)}
            scroll={false}
            className="text-accent-text underline hover:text-accent-dark"
          >
            Clear filter
          </Link>
        </p>
      )}

      {filtered.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
          <table className="w-full min-w-[1400px] text-sm">
            <thead className="sticky top-0 z-10 bg-warm/60 text-center text-[11px] uppercase tracking-wide text-muted">
              <tr className="divide-x divide-stone/40">
                <th className="w-10" />
                <th className="w-1.5" />
                <SortHeader
                  label="Unit"
                  sortKey="unit"
                  activeSort={sortKey}
                  dir={sortDir}
                  poster={posterFilter}
                />
                <SortHeader
                  label="Neighborhood"
                  sortKey="neighborhood"
                  activeSort={sortKey}
                  dir={sortDir}
                  poster={posterFilter}
                />
                <th className="px-3 py-2 font-medium">Room</th>
                <SortHeader
                  label="Available"
                  sortKey="available"
                  activeSort={sortKey}
                  dir={sortDir}
                  poster={posterFilter}
                />
                <SortHeader
                  label="Rent"
                  sortKey="rent"
                  activeSort={sortKey}
                  dir={sortDir}
                  poster={posterFilter}
                />
                <SortHeader
                  label="Services"
                  sortKey="services"
                  activeSort={sortKey}
                  dir={sortDir}
                  poster={posterFilter}
                />
                <SortHeader
                  label="Total"
                  sortKey="total"
                  activeSort={sortKey}
                  dir={sortDir}
                  poster={posterFilter}
                />
                <th className="px-3 py-2 font-medium">Amenities</th>
                <th className="px-3 py-2 font-medium">Photos</th>
                <th className="px-3 py-2 font-medium">Tenant</th>
                <th className="px-3 py-2 font-medium">Listing action</th>
                <th className="px-3 py-2 font-medium">Ad</th>
                <th className="px-3 py-2 font-medium">Ad Posted</th>
                <th className="px-3 py-2 font-medium">Roommates</th>
                <th className="px-3 py-2 font-medium" />
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

function SortHeader({
  label,
  sortKey,
  activeSort,
  dir,
  poster,
}: {
  label: string;
  sortKey: SortKey;
  activeSort: SortKey;
  dir: "asc" | "desc";
  poster: string | null;
}) {
  const isActive = activeSort === sortKey;
  // Clicking the active column flips direction; a fresh column starts ascending.
  const nextDir = isActive && dir === "asc" ? "desc" : "asc";

  const href = inventoryHref(sortKey, nextDir, poster);
  const arrow = isActive ? (dir === "asc" ? "↑" : "↓") : "↕";

  return (
    <th className="px-3 py-2 font-medium text-center">
      <Link
        href={href}
        scroll={false}
        className={`group inline-flex items-center gap-1 ${
          isActive ? "text-ink" : "hover:text-ink"
        }`}
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

