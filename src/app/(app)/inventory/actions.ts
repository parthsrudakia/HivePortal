"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import type { Database } from "@/lib/supabase/types";
import { updateRoomsWithNotification } from "@/lib/notifications";
import {
  normalizeUnitAmenities,
  normalizeBuildingAmenities,
} from "@/lib/amenities";
import { todayISO } from "@/lib/date";

// Accept only http(s) web links for ad / photo URLs: a scheme, a host with a
// dot (or localhost), and no spaces. Guards against pasted plain text or
// half-typed values getting stored as a "URL".
const URL_RE = /^https?:\/\/(localhost[^\s]*|[^\s/$.?#]+\.[^\s]*)$/i;
function isValidUrl(value: string): boolean {
  return URL_RE.test(value.trim());
}

type Action = Database["public"]["Enums"]["listing_action"];
const VALID: Action[] = [
  "no_action",
  "update_price_or_date",
  "delete_listing",
  "boost_post",
  "priority",
];

export async function setListingAction(roomId: string, action: Action) {
  if (!roomId || !VALID.includes(action)) return;

  const supabase = await createClient();
  await updateRoomsWithNotification(supabase, roomId, {
    listing_action: action,
  });

  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
}

export type AdFormState = { error?: string } | undefined;

// A room can carry several ads, each posted by a different person. Every ad is
// its own room_ads row, snapshotting who saved it (display name, else email), so
// the inventory poster tally counts each ad independently.
async function currentPosterName(): Promise<string | null> {
  const user = await getSessionUser();
  const meta = user?.user_metadata ?? {};
  const name =
    typeof meta.display_name === "string" && meta.display_name.trim()
      ? meta.display_name.trim()
      : typeof meta.full_name === "string" && meta.full_name.trim()
        ? meta.full_name.trim()
        : null;
  return name ?? user?.email ?? null;
}

/** Add an ad URL to a room (form version — used on the room detail page). */
export async function setRoomAd(
  roomId: string,
  _prev: AdFormState,
  formData: FormData,
): Promise<AdFormState> {
  const url = String(formData.get("ad_url") ?? "").trim();
  if (!url) return { error: "Enter an ad URL." };
  return addRoomAd(roomId, url);
}

/** Add an ad URL to a room. Multiple people can each add their own. */
export async function addRoomAd(
  roomId: string,
  url: string,
): Promise<{ error?: string } | undefined> {
  const ad_url = url.trim();
  if (!ad_url) return { error: "Enter an ad URL." };
  if (!isValidUrl(ad_url))
    return { error: "That doesn't look like a URL (must start with http:// or https://)." };

  const supabase = await createClient();
  const posted_by = await currentPosterName();

  const { error } = await supabase
    .from("room_ads")
    .insert({ room_id: roomId, url: ad_url, posted_by });

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return undefined;
}

/** Remove a single ad from a room. */
export async function deleteRoomAd(
  adId: string,
  roomId: string,
): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("room_ads")
    .delete()
    .eq("id", adId);

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return { ok: true };
}

export type RentFormState = { error?: string } | undefined;

export async function setRoomRent(
  roomId: string,
  _prev: RentFormState,
  formData: FormData,
): Promise<RentFormState> {
  const baseStr = String(formData.get("base_rent") ?? "").trim();
  const bundleStr = String(formData.get("bundle_fee") ?? "").trim();

  if (!baseStr) return { error: "Base rent is required." };
  const base_rent = Number(baseStr);
  if (!Number.isFinite(base_rent) || base_rent < 0)
    return { error: "Base rent must be a non-negative number." };

  const bundle_fee =
    bundleStr === "" ? null : Number(bundleStr);
  if (bundle_fee !== null && (!Number.isFinite(bundle_fee) || bundle_fee < 0))
    return { error: "Bundle fee must be a non-negative number." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("rooms")
    .update({ base_rent, bundle_fee })
    .eq("id", roomId);

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return undefined;
}

/** Edit the photos folder URL inline from the inventory table. */
export async function setRoomPhotosUrl(
  roomId: string,
  url: string | null,
): Promise<{ ok: true } | { error: string }> {
  const value = url && url.trim() ? url.trim() : null;
  if (value && !isValidUrl(value))
    return { error: "That doesn't look like a URL (must start with http:// or https://)." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("rooms")
    .update({ photos_url: value })
    .eq("id", roomId);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return { ok: true };
}

export type AmenityValues = {
  // Room-level (rooms table)
  has_private_bathroom: boolean;
  has_ac: boolean;
  // Unit + building amenities (properties table — apply to every room in the unit)
  unit_amenities: string[];
  building_amenities: string[];
};

/**
 * Edit a room's amenities inline. The private-bath flag saves to the room;
 * unit/building amenities save to the parent property (and thus apply to all
 * of its rooms).
 */
export async function setRoomAmenities(
  roomId: string,
  propertyId: string | null,
  a: AmenityValues,
): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();

  const { error: roomErr } = await supabase
    .from("rooms")
    .update({
      has_private_bathroom: a.has_private_bathroom,
      has_ac: a.has_ac,
    })
    .eq("id", roomId);
  if (roomErr) return { error: roomErr.message };

  if (propertyId) {
    const { error: propErr } = await supabase
      .from("properties")
      .update({
        unit_amenities: normalizeUnitAmenities(a.unit_amenities),
        building_amenities: normalizeBuildingAmenities(a.building_amenities),
      })
      .eq("id", propertyId);
    if (propErr) return { error: propErr.message };
    revalidatePath(`/properties/${propertyId}`);
  }

  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return { ok: true };
}

/** Edit base_rent inline from the inventory table. */
export async function setRoomBaseRent(
  roomId: string,
  value: number,
): Promise<{ ok: true } | { error: string }> {
  if (!Number.isFinite(value) || value < 0) {
    return { error: "Base rent must be a non-negative number." };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("rooms")
    .update({ base_rent: value })
    .eq("id", roomId);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return { ok: true };
}

/** Edit services / bundle fee inline from the inventory table. */
export async function setRoomServicesFee(
  roomId: string,
  value: number,
): Promise<{ ok: true } | { error: string }> {
  if (!Number.isFinite(value) || value < 0) {
    return { error: "Services fee must be a non-negative number." };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("rooms")
    .update({ bundle_fee: value })
    .eq("id", roomId);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return { ok: true };
}

/**
 * Bring a room that isn't currently listed (reserved / maintenance, or
 * occupied without an active tenancy) into the inventory by marking it
 * available. Optionally schedule a future availability date.
 */
export async function makeRoomAvailable(
  roomId: string,
  availableFrom: string | null,
): Promise<{ ok: true } | { error: string }> {
  const value =
    availableFrom && availableFrom.trim() ? availableFrom.trim() : null;
  const supabase = await createClient();
  const { error } = await supabase
    .from("rooms")
    .update({ status: "available", available_from: value })
    .eq("id", roomId);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return { ok: true };
}

/**
 * "Delete" a listing from inventory: flag the room pending_tenant so it drops
 * off the Inventory table and surfaces on the Add Tenant page as a listing to
 * fill. Reversible via restoreListing.
 */
export async function deleteListing(
  roomId: string,
): Promise<{ ok: true } | { error: string }> {
  if (!roomId) return { error: "Missing room." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("rooms")
    .update({ pending_tenant: true })
    .eq("id", roomId);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath("/tenants/new");
  return { ok: true };
}

/** Undo a deleted listing — put the room back into the Inventory table. */
export async function restoreListing(
  roomId: string,
): Promise<{ ok: true } | { error: string }> {
  if (!roomId) return { error: "Missing room." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("rooms")
    .update({ pending_tenant: false })
    .eq("id", roomId);
  if (error) return { error: error.message };

  // Clearing the flag alone isn't always enough to re-enter Inventory: an
  // occupied room qualifies only with a FUTURE available_from, and the date
  // can go stale while the listing sits deleted. Bump it to today (through
  // the notification wrapper, since availability changes are watched) so
  // Restore always lands the room back on the Inventory table.
  const today = todayISO();
  const { data: room } = await supabase
    .from("rooms")
    .select("status, available_from")
    .eq("id", roomId)
    .maybeSingle();
  if (
    room &&
    room.status !== "available" &&
    (!room.available_from || room.available_from < today)
  ) {
    const { error: bumpError } = await updateRoomsWithNotification(
      supabase,
      roomId,
      { available_from: today },
    );
    if (bumpError) return { error: bumpError.message };
  }

  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  return { ok: true };
}

/**
 * Cancel a scheduled move-out: the outgoing tenant is staying. Clears the
 * tenancy's move_out_date (keeps it active) and returns the room to occupied
 * with no available_from, so the listing drops off Inventory. Mirror-image of
 * endTenancy.
 */
export async function cancelMoveOut(
  tenancyId: string,
  roomId: string,
): Promise<{ ok: true } | { error: string }> {
  if (!tenancyId || !roomId) return { error: "Missing tenancy or room." };
  const supabase = await createClient();

  const { error: tenancyErr } = await supabase
    .from("tenancies")
    .update({ move_out_date: null, status: "active" })
    .eq("id", tenancyId);
  if (tenancyErr) return { error: tenancyErr.message };

  const { error: roomErr } = await updateRoomsWithNotification(
    supabase,
    roomId,
    {
      status: "occupied",
      available_from: null,
      listing_action: "no_action",
    },
  );
  if (roomErr) return { error: roomErr.message };

  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return { ok: true };
}

/** Set rooms.available_from. Pass null/empty to clear. */
export async function setRoomAvailableFrom(
  roomId: string,
  date: string | null,
): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();
  const value = date === null || date.trim() === "" ? null : date;
  // Route through updateRoomsWithNotification so changing the move-out date
  // reschedules the move-out cleaning and emails the unit's cleaners.
  const { error } = await updateRoomsWithNotification(supabase, roomId, {
    available_from: value,
  });
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath(`/inventory/${roomId}`);
  return { ok: true };
}
