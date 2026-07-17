import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
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
  ACTION_LABELS,
  ACTION_ORDER,
  type Action,
  type AdRow,
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
  unit_amenities: string[];
  building_amenities: string[];
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
  has_private_bathroom: boolean;
  has_ac: boolean;
  listing_action: Action;
  // Every ad posted for this room (see room_ads); attached after the query.
  ads: AdRow[];
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
       marketing_description, photos_url, has_private_bathroom, has_ac,
       listing_action,
       properties(id, building_name, street_address, unit_number, neighborhood,
                  unit_amenities, building_amenities),
       tenancies(id, status, start_date, move_out_date, tenants(id, full_name))`,
    )
    .or(
      `status.eq.available,and(status.eq.occupied,available_from.gte.${today})`,
    )
    .eq("pending_tenant", false)
    .order("available_from", { ascending: true, nullsFirst: true })
    .returns<Omit<Row, "ads">[]>();

  // All ads across every room (room_ads post-dates the generated types). Used
  // both to attach each room's ads and to tally ads-per-poster below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: adRowsData } = await (supabase as any)
    .from("room_ads")
    .select("id, room_id, url, posted_by")
    .order("created_at", { ascending: true });
  const allAds = (adRowsData ?? []) as {
    id: string;
    room_id: string;
    url: string;
    posted_by: string | null;
  }[];
  const adsByRoom = new Map<string, AdRow[]>();
  for (const a of allAds) {
    const list = adsByRoom.get(a.room_id) ?? [];
    list.push({ id: a.id, url: a.url, posted_by: a.posted_by });
    adsByRoom.set(a.room_id, list);
  }

  const rooms: Row[] = (data ?? []).map((r) => ({
    ...r,
    ads: adsByRoom.get(r.id) ?? [],
  }));

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

  // Ads-posted tally per person. Each ad's `posted_by` is a snapshot of whoever
  // saved it (display name, else email), and every ad counts — two ads by the
  // same person (even on one room) count twice. We count only ads on rooms
  // currently in inventory (the same filter the table uses), so ads left behind
  // on a since-filled/unlisted room stop counting once that room drops out of
  // the listing. The list is seeded with everyone on the notification-recipients
  // list (so configured people show even with zero ads) and then unioned with
  // anyone who has posted an ad but isn't on that list — matching a recipient to
  // their posts by either their label or email.
  const { data: recipientData } = await supabase
    .from("notification_recipients")
    .select("id, email, label")
    .returns<{ id: string; email: string; label: string | null }[]>();

  // Only rooms currently listed count toward the tally.
  const inventoryRoomIds = new Set(rooms.map((r) => r.id));

  // key (lowercased poster string) -> { display name, count }
  const adCountByPoster = new Map<string, { name: string; count: number }>();
  for (const a of allAds) {
    if (!inventoryRoomIds.has(a.room_id)) continue;
    const raw = a.posted_by?.trim();
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
            up.{" "}
            <Link
              href="/inventory/api-docs"
              className="text-accent-text underline decoration-accent/40 underline-offset-2 hover:text-accent-dark"
            >
              API docs
            </Link>
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
        <span className="text-xs uppercase tracking-wide text-muted">
          Listing action
        </span>
        {ACTION_ORDER.map((a) => (
          <span key={a} className="inline-flex items-center gap-1.5 text-xs text-ink">
            <span
              className={`h-3 w-3 shrink-0 rounded-sm ring-1 ring-stone/40 ${ACTION_TINT[a]}`}
              aria-hidden
            />
            {ACTION_LABELS[a]}
          </span>
        ))}
      </div>

      {recipientAdCounts.length > 0 && (
        <section className="mt-4 rounded-xl bg-white p-3 shadow-sm ring-1 ring-stone/40">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm uppercase tracking-wide text-muted">
              Ads posted by user
            </h2>
            {selectedPoster && (
              <Link
                href={inventoryHref(sortKey, sortDir, null)}
                scroll={false}
                className="text-xs uppercase tracking-wide text-accent-text hover:text-accent-dark"
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
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition ${
                      active
                        ? "border-accent bg-accent/15 text-ink"
                        : "border-stone bg-cream/60 text-ink hover:border-accent"
                    }`}
                  >
                    <span className="font-medium">{r.name}</span>
                    <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold text-white">
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
            <thead className="sticky top-0 z-10 bg-warm/60 text-center text-xs uppercase tracking-wide text-muted">
              <tr className="divide-x divide-stone/40">
                <th className="w-10 px-2 py-2 font-medium">#</th>
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
                <InventoryRow
                  key={r.id}
                  room={r}
                  index={i + 1}
                  striped={i % 2 === 1}
                />
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
          className={`text-xs ${isActive ? "text-accent-text" : "text-stone group-hover:text-muted"}`}
        >
          {arrow}
        </span>
      </Link>
    </th>
  );
}

function InventoryRow({
  room,
  index,
  striped,
}: {
  room: Row;
  index: number;
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
      <td className="px-2 py-2.5 text-center align-middle tabular-nums text-xs text-muted">
        {index}
      </td>
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
      <td className="px-3 py-2.5 text-xs text-ink">
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
            has_ac: room.has_ac,
            unit_amenities: p?.unit_amenities ?? [],
            building_amenities: p?.building_amenities ?? [],
          }}
        >
          <Amenities room={room} property={p} />
        </InlineAmenitiesEdit>
      </td>
      <td className="px-3 py-1.5">
        <InlinePhotosEdit roomId={room.id} url={room.photos_url} />
      </td>
      <td className="px-3 py-2.5 text-xs">
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
        <InlineAdEdit roomId={room.id} ads={room.ads} />
      </td>
      <td className="px-3 py-2.5 text-xs text-ink">
        {(() => {
          // Distinct posters across this room's ads, in first-posted order.
          const posters = Array.from(
            new Set(
              room.ads
                .map((a) => a.posted_by?.trim())
                .filter((n): n is string => !!n),
            ),
          );
          return posters.length ? (
            posters.join(", ")
          ) : (
            <span className="text-muted">-</span>
          );
        })()}
      </td>
      <td className="px-3 py-2.5">
        {p ? (
          <Link
            href={`/properties/${p.id}#residents`}
            className="whitespace-nowrap text-xs text-purple-700 underline underline-offset-2 hover:text-purple-900"
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
  room: Pick<Row, "has_private_bathroom" | "has_ac">;
  property: PropertyRel | null;
}) {
  const tags: string[] = [];
  if (room.has_private_bathroom) tags.push("Private bath");
  if (room.has_ac) tags.push("AC");
  tags.push(...(property?.unit_amenities ?? []));
  tags.push(...(property?.building_amenities ?? []));

  if (tags.length === 0) {
    return <span className="text-xs text-muted">—</span>;
  }
  return (
    <span className="text-xs text-ink">{tags.join(", ")}</span>
  );
}
