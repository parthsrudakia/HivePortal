/**
 * Inventory diffing + Telegram message text for the listings bot. Compares
 * the last announced inventory-API payload per room with the live one and
 * renders what the team has to change on the listing ads. Pure — no model
 * call, so an update can never be misreported.
 */

import type { serializeRoom } from "@/app/api/inventory/shared";

/** One room exactly as GET /api/inventory serves it. */
export type InvRoom = ReturnType<typeof serializeRoom>;

export type InventoryDiff = {
  added: InvRoom[];
  removed: InvRoom[];
  changed: { room: InvRoom; changes: string[] }[];
};

const STATUS_LABELS: Record<string, string> = {
  available: "Available",
  occupied: "Occupied",
  reserved: "Reserved",
  maintenance: "Maintenance",
};

export const LISTING_ACTION_LABELS: Record<string, string> = {
  no_action: "No action",
  update_price_or_date: "Update price/date",
  delete_listing: "Delete listing",
  boost_post: "Boost post",
  priority: "Priority listing",
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(n: number | null): string {
  return n == null ? "—" : `$${Number(n).toLocaleString("en-US")}`;
}

/** A null availability date on an in-inventory room means it is vacant now. */
function availability(iso: string | null): string {
  if (!iso) return "Now";
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

const yesNo = (b: boolean) => (b ? "Yes" : "No");
const onOff = (b: boolean) => (b ? "On" : "Off");

export function roomTitle(r: InvRoom): string {
  const unit = r.unit ?? "Unknown unit";
  return r.room_number ? `${unit} · Room ${r.room_number}` : unit;
}

function listChange(label: string, before: string[], after: string[]) {
  const added = after.filter((a) => !before.includes(a));
  const dropped = before.filter((b) => !after.includes(b));
  if (added.length === 0 && dropped.length === 0) return null;
  const parts: string[] = [];
  if (added.length) parts.push(`added ${added.map(escapeHtml).join(", ")}`);
  if (dropped.length) parts.push(`removed ${dropped.map(escapeHtml).join(", ")}`);
  return `${label}: ${parts.join("; ")}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

/** Human-readable lines for every field that differs (HTML-escaped). */
export function describeChanges(prev: InvRoom, curr: InvRoom): string[] {
  const out: string[] = [];
  const arrow = (label: string, from: string, to: string) =>
    out.push(`${label}: ${escapeHtml(from)} → <b>${escapeHtml(to)}</b>`);

  if (roomTitle(prev) !== roomTitle(curr)) {
    arrow("Unit/room name", roomTitle(prev), roomTitle(curr));
  }
  if (prev.neighborhood !== curr.neighborhood) {
    arrow("Neighborhood", prev.neighborhood ?? "—", curr.neighborhood ?? "—");
  }
  if (prev.status !== curr.status) {
    arrow(
      "Status",
      STATUS_LABELS[prev.status] ?? prev.status,
      STATUS_LABELS[curr.status] ?? curr.status,
    );
  }
  if (prev.available_from !== curr.available_from) {
    arrow(
      "Available from",
      availability(prev.available_from),
      availability(curr.available_from),
    );
  }
  if (prev.rent.total !== curr.rent.total) {
    arrow("Total rent", money(prev.rent.total), money(curr.rent.total));
  }
  if (prev.rent.base !== curr.rent.base) {
    arrow("Base rent", money(prev.rent.base), money(curr.rent.base));
  }
  if (prev.rent.services !== curr.rent.services) {
    arrow("Services fee", money(prev.rent.services), money(curr.rent.services));
  }
  if (prev.amenities.has_private_bathroom !== curr.amenities.has_private_bathroom) {
    arrow(
      "Private bathroom",
      yesNo(prev.amenities.has_private_bathroom),
      yesNo(curr.amenities.has_private_bathroom),
    );
  }
  if (prev.amenities.has_ac !== curr.amenities.has_ac) {
    arrow("A/C", yesNo(prev.amenities.has_ac), yesNo(curr.amenities.has_ac));
  }
  const unitAm = listChange(
    "Unit amenities",
    prev.amenities.unit ?? [],
    curr.amenities.unit ?? [],
  );
  if (unitAm) out.push(unitAm);
  const bldgAm = listChange(
    "Building amenities",
    prev.amenities.building ?? [],
    curr.amenities.building ?? [],
  );
  if (bldgAm) out.push(bldgAm);
  if ((prev.photos_url ?? "") !== (curr.photos_url ?? "")) {
    out.push(
      curr.photos_url
        ? `Photos link ${prev.photos_url ? "changed" : "added"}: ${escapeHtml(curr.photos_url)}`
        : "Photos link removed",
    );
  }
  if ((prev.marketing_description ?? "") !== (curr.marketing_description ?? "")) {
    out.push(
      curr.marketing_description
        ? `Description updated:\n<blockquote>${escapeHtml(truncate(curr.marketing_description, 600))}</blockquote>`
        : "Description removed",
    );
  }
  if (prev.facebook_ads !== curr.facebook_ads) {
    arrow("Facebook ads", onOff(prev.facebook_ads), onOff(curr.facebook_ads));
  }
  if (prev.listing_action !== curr.listing_action) {
    arrow(
      "Listing action",
      LISTING_ACTION_LABELS[prev.listing_action] ?? prev.listing_action,
      LISTING_ACTION_LABELS[curr.listing_action] ?? curr.listing_action,
    );
  }
  return out;
}

export function diffInventory(
  prev: Map<string, InvRoom>,
  curr: InvRoom[],
): InventoryDiff {
  const diff: InventoryDiff = { added: [], removed: [], changed: [] };
  const seen = new Set<string>();
  for (const room of curr) {
    seen.add(room.id);
    const before = prev.get(room.id);
    if (!before) {
      diff.added.push(room);
      continue;
    }
    const changes = describeChanges(before, room);
    if (changes.length > 0) diff.changed.push({ room, changes });
  }
  for (const [id, room] of prev) if (!seen.has(id)) diff.removed.push(room);
  return diff;
}

export function isEmptyDiff(d: InventoryDiff): boolean {
  return d.added.length + d.removed.length + d.changed.length === 0;
}

/** One-line summary of a room, used for new rooms and reminder digests. */
export function roomSummary(r: InvRoom): string {
  const bits = [
    `${money(r.rent.total)}/mo`,
    `available ${availability(r.available_from)}`,
  ];
  if (r.neighborhood) bits.push(r.neighborhood);
  if (r.amenities.has_private_bathroom) bits.push("private bath");
  return bits.map(escapeHtml).join(" · ");
}

function flagged(r: InvRoom): string {
  return r.listing_action !== "no_action"
    ? `\nFlagged: <b>${escapeHtml(LISTING_ACTION_LABELS[r.listing_action] ?? r.listing_action)}</b>`
    : "";
}

/**
 * The group message for a diff. `removedReasons` maps a removed room's id to
 * why it left inventory (e.g. "now Occupied"), when known.
 */
export function formatDiffMessage(
  d: InventoryDiff,
  removedReasons: Map<string, string> = new Map(),
): string {
  const blocks: string[] = [];
  for (const r of d.added) {
    blocks.push(
      `🆕 <b>New in inventory — ${escapeHtml(roomTitle(r))}</b>\n` +
        roomSummary(r) +
        (r.photos_url ? `\nPhotos: ${escapeHtml(r.photos_url)}` : "") +
        flagged(r) +
        "\n→ Please post a listing for it.",
    );
  }
  for (const { room, changes } of d.changed) {
    blocks.push(
      `✏️ <b>Updated — ${escapeHtml(roomTitle(room))}</b>\n` +
        changes.map((c) => `• ${c}`).join("\n") +
        "\n→ Please update its listing ads to match.",
    );
  }
  for (const r of d.removed) {
    const why = removedReasons.get(r.id);
    blocks.push(
      `❌ <b>Out of inventory — ${escapeHtml(roomTitle(r))}</b>` +
        (why ? `\n${escapeHtml(why)}` : "") +
        "\n→ Please take its listing ads down.",
    );
  }
  return `📋 <b>Inventory update</b>\n\n${blocks.join("\n\n")}`;
}

/** Rooms whose listing action is still flagged (reminder digest). */
export function formatOpenActions(rooms: InvRoom[]): string {
  const open = rooms.filter((r) => r.listing_action !== "no_action");
  if (open.length === 0) return "No rooms are flagged for a listing action.";
  return (
    "<b>Rooms flagged for a listing action:</b>\n" +
    open
      .map(
        (r) =>
          `• ${escapeHtml(roomTitle(r))} — ${escapeHtml(LISTING_ACTION_LABELS[r.listing_action] ?? r.listing_action)}`,
      )
      .join("\n")
  );
}

/** The whole current inventory, one line per room (reminder digest). */
export function formatInventoryList(rooms: InvRoom[]): string {
  if (rooms.length === 0) return "Inventory is empty right now.";
  return (
    `<b>Current inventory (${rooms.length}):</b>\n` +
    rooms
      .map((r) => `• ${escapeHtml(roomTitle(r))} — ${roomSummary(r)}`)
      .join("\n")
  );
}
