/**
 * Shared filter + sort logic for the inventory table and its sheet downloads.
 *
 * The two download routes (`/inventory/export-full`, `/inventory/export`) and
 * the table on `/inventory` all run rooms through {@link filterAndSortRooms}
 * with the same view state (poster filter, sort column + direction), so a
 * downloaded sheet matches exactly what the table shows at the moment of
 * download.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { one } from "@/lib/relations";

export type SortKey =
  | "unit"
  | "neighborhood"
  | "available"
  | "rent"
  | "services"
  | "total";
export type SortDir = "asc" | "desc";
export const DEFAULT_SORT: SortKey = "available";
export const DEFAULT_DIR: SortDir = "asc";

export function isSortKey(v: string | undefined): v is SortKey {
  return (
    v === "unit" ||
    v === "neighborhood" ||
    v === "available" ||
    v === "rent" ||
    v === "services" ||
    v === "total"
  );
}

export type InventoryView = {
  sort: SortKey;
  dir: SortDir;
  /** Resolved set of lowercased ad-poster keys, or null for "no poster filter". */
  posterKeys: Set<string> | null;
};

export const DEFAULT_VIEW: InventoryView = {
  sort: DEFAULT_SORT,
  dir: DEFAULT_DIR,
  posterKeys: null,
};

/**
 * Read the table's filter/sort state (minus the resolved poster keys, which
 * need a DB lookup — see {@link resolvePosterKeys}) from a URL query string.
 */
export function parseInventoryParams(sp: URLSearchParams): {
  sort: SortKey;
  dir: SortDir;
  poster: string | null;
} {
  const sortRaw = sp.get("sort") ?? undefined;
  const sort = isSortKey(sortRaw) ? sortRaw : DEFAULT_SORT;
  const dir: SortDir = sp.get("dir") === "desc" ? "desc" : "asc";
  const poster = sp.get("poster")?.trim() || null;
  return { sort, dir, poster };
}

/**
 * Resolve a selected ad-poster id (from the `poster` search param) into the set
 * of lowercased keys that an `ad_posted_by` value is matched against — mirroring
 * how the inventory page builds the poster pills. An id may be a synthetic
 * `poster:<key>` (someone who posted but isn't a configured recipient) or a
 * `notification_recipients.id` (matched by its label and email).
 */
export async function resolvePosterKeys(
  supabase: SupabaseClient,
  posterId: string | null,
): Promise<Set<string> | null> {
  if (!posterId) return null;

  const PREFIX = "poster:";
  if (posterId.startsWith(PREFIX)) {
    const key = posterId.slice(PREFIX.length);
    return key ? new Set([key]) : null;
  }

  const { data } = await supabase
    .from("notification_recipients")
    .select("email, label")
    .eq("id", posterId)
    .maybeSingle();
  if (!data) return null;

  const label = (data.label as string | null)?.trim() || null;
  const email = (data.email as string).trim();
  const keys = [label?.toLowerCase(), email.toLowerCase()].filter(
    (k): k is string => !!k,
  );
  return keys.length ? new Set(keys) : null;
}

// --- comparators ----------------------------------------------------------
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

/** Minimal property shape the filter/sort needs (a superset is fine). */
export type SortableProperty = {
  neighborhood: string | null;
  building_name: string | null;
  street_address: string;
  unit_number: string;
};

/** Minimal room shape the filter/sort needs (a superset is fine). */
export type SortableRoom = {
  available_from: string | null;
  base_rent: number | null;
  bundle_fee: number | null;
  total_rent: number | null;
  ad_posted_by: string | null;
  properties: SortableProperty | SortableProperty[] | null;
};

function unitTitleOf(r: SortableRoom): string {
  const p = one(r.properties);
  if (!p) return "";
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

function compareRooms(a: SortableRoom, b: SortableRoom, sort: SortKey): number {
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

/**
 * Apply the table's poster filter and sort to a list of rooms, returning a new
 * array. This is the single source of truth shared by the inventory table and
 * the sheet downloads.
 */
export function filterAndSortRooms<T extends SortableRoom>(
  rooms: T[],
  view: InventoryView,
): T[] {
  const { sort, dir, posterKeys } = view;
  const filtered = rooms.filter((r) => {
    if (posterKeys) {
      const key = r.ad_posted_by?.trim().toLowerCase();
      if (!(key && posterKeys.has(key))) return false;
    }
    return true;
  });
  filtered.sort((a, b) => {
    const base = compareRooms(a, b, sort);
    // Stable tiebreak on the date so equal sort keys keep a sensible order.
    const cmp = base !== 0 ? base : cmpDate(a.available_from, b.available_from);
    return dir === "desc" ? -cmp : cmp;
  });
  return filtered;
}
