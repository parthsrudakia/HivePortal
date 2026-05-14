"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { updateRoomsWithNotification } from "@/lib/notifications";

type RoomStatus = Database["public"]["Enums"]["room_status"];
const VALID_STATUSES: RoomStatus[] = [
  "occupied",
  "available",
  "reserved",
  "maintenance",
];

export type RoomFormState = { error?: string } | undefined;

type RoomValues = {
  base_rent: number | null;
  bundle_fee: number | null;
  status: RoomStatus;
  available_from: string | null;
  has_ac: boolean;
  has_private_bathroom: boolean;
  notes: string | null;
  marketing_description: string | null;
  photos_url: string | null;
};

function parseRoom(formData: FormData): RoomValues | { error: string } {
  const numOrNull = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    if (v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const status = String(formData.get("status") ?? "available") as RoomStatus;
  if (!VALID_STATUSES.includes(status)) return { error: "Invalid status." };

  const available_from =
    String(formData.get("available_from") ?? "").trim() || null;

  return {
    base_rent: numOrNull("base_rent"),
    bundle_fee: numOrNull("bundle_fee"),
    status,
    available_from,
    has_ac: formData.get("has_ac") === "on",
    has_private_bathroom: formData.get("has_private_bathroom") === "on",
    notes: String(formData.get("notes") ?? "").trim() || null,
    marketing_description:
      String(formData.get("marketing_description") ?? "").trim() || null,
    photos_url: String(formData.get("photos_url") ?? "").trim() || null,
  };
}

export async function addRoom(
  propertyId: string,
  _prev: RoomFormState,
  formData: FormData,
): Promise<RoomFormState> {
  const parsed = parseRoom(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();

  // Auto-number this room as "Room N". N = max existing N for this property
  // plus one (using max, not count, so deleting Room 2 and re-adding doesn't
  // create a duplicate Room 3).
  const { data: existing } = await supabase
    .from("rooms")
    .select("room_number")
    .eq("property_id", propertyId);
  const maxN = (existing ?? []).reduce((m, r) => {
    const match = r.room_number?.match(/Room (\d+)/);
    if (!match) return m;
    return Math.max(m, parseInt(match[1], 10));
  }, 0);
  const room_number = `Room ${maxN + 1}`;

  const { error } = await supabase
    .from("rooms")
    .insert({ ...parsed, property_id: propertyId, room_number });

  if (error) return { error: error.message };

  revalidatePath(`/properties/${propertyId}`);
  return undefined;
}

export async function updateRoom(
  propertyId: string,
  roomId: string,
  _prev: RoomFormState,
  formData: FormData,
): Promise<RoomFormState> {
  const parsed = parseRoom(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();
  const { error } = await updateRoomsWithNotification(supabase, roomId, parsed);

  if (error) return { error: error.message };

  revalidatePath(`/properties/${propertyId}`);
  return undefined;
}

export async function deleteRoom(formData: FormData) {
  const roomId = String(formData.get("room_id") ?? "");
  const propertyId = String(formData.get("property_id") ?? "");
  if (!roomId || !propertyId) return;

  const supabase = await createClient();
  await supabase.from("rooms").delete().eq("id", roomId);
  revalidatePath(`/properties/${propertyId}`);
}
