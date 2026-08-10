import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { todayISO } from "@/lib/date";
import { updateRoomsWithNotification } from "@/lib/notifications";
import type { Database } from "@/lib/supabase/types";
import { admin, one, propertyLabel } from "./helpers";

export async function listInventory() {
  const supabase = admin();
  const today = todayISO();
  const { data, error } = await supabase
    .from("rooms")
    .select(
      `id, room_number, total_rent, available_from, status, listing_action,
       has_private_bathroom, has_ac,
       marketing_description, photos_url,
       properties(id, building_name, street_address, unit_number, neighborhood)`,
    )
    .or(`status.eq.available,and(status.eq.occupied,available_from.gte.${today})`)
    .order("available_from", { ascending: true, nullsFirst: true });
  if (error) throw new Error(error.message);

  // Each room can carry several ads.
  const { data: adRowsData } = await supabase
    .from("room_ads")
    .select("room_id, url, posted_by")
    .order("created_at", { ascending: true });
  const adsByRoom = new Map<string, { url: string; posted_by: string | null }[]>();
  for (const a of adRowsData ?? []) {
    const list = adsByRoom.get(a.room_id) ?? [];
    list.push({ url: a.url, posted_by: a.posted_by });
    adsByRoom.set(a.room_id, list);
  }

  return (data ?? []).map((r) => {
    const p = one(r.properties);
    return {
      id: r.id,
      room_number: r.room_number,
      unit: p ? propertyLabel(p) : null,
      property_id: p?.id ?? null,
      neighborhood: p?.neighborhood,
      total_rent: r.total_rent,
      available_from: r.available_from,
      status: r.status,
      listing_action: r.listing_action,
      ads: adsByRoom.get(r.id) ?? [],
      has_private_bathroom: r.has_private_bathroom,
      has_ac: r.has_ac,
      description: r.marketing_description,
      photos_url: r.photos_url,
    };
  });
}

export async function setListingAction(args: {
  room_id: string;
  action:
    | "no_action"
    | "update_price_or_date"
    | "delete_listing"
    | "boost_post"
    | "priority";
}) {
  const supabase = admin();
  const { error } = await updateRoomsWithNotification(supabase, args.room_id, {
    listing_action: args.action,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function updateRoomRent(args: {
  room_id: string;
  base_rent: number;
  bundle_fee?: number;
}) {
  const supabase = admin();
  const update: Database["public"]["Tables"]["rooms"]["Update"] = {
    base_rent: args.base_rent,
  };
  if (args.bundle_fee !== undefined) update.bundle_fee = args.bundle_fee;
  const { error } = await supabase
    .from("rooms")
    .update(update)
    .eq("id", args.room_id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function setRoomStatus(args: {
  room_id: string;
  status: "occupied" | "available" | "reserved" | "maintenance";
  available_from?: string;
}) {
  const supabase = admin();
  const update: Record<string, unknown> = { status: args.status };
  if (args.available_from !== undefined)
    update.available_from = args.available_from;
  const { error } = await updateRoomsWithNotification(
    supabase,
    args.room_id,
    update,
  );
  if (error) throw new Error(error.message);
  return { ok: true };
}

export const roomsTools = [
  betaZodTool({
    name: "list_inventory",
    description:
      "Listable rooms (the inventory queue) — currently vacant or with a scheduled future move-out.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await listInventory()),
  }),
  betaZodTool({
    name: "set_listing_action",
    description: "Update a room's VA priority flag.",
    inputSchema: z.object({
      room_id: z.string(),
      action: z.enum([
        "no_action",
        "update_price_or_date",
        "delete_listing",
        "boost_post",
        "priority",
      ]),
    }),
    run: async (args) => JSON.stringify(await setListingAction(args)),
  }),
  betaZodTool({
    name: "set_room_status",
    description:
      "Manually flip a room status (occupied / available / reserved / maintenance). " +
      "Use end_tenancy instead when there's an active tenancy.",
    inputSchema: z.object({
      room_id: z.string(),
      status: z.enum(["occupied", "available", "reserved", "maintenance"]),
      available_from: z.string().optional(),
    }),
    run: async (args) => JSON.stringify(await setRoomStatus(args)),
  }),
  betaZodTool({
    name: "update_room_rent",
    description: "Change a room's base rent and (optionally) bundle fee.",
    inputSchema: z.object({
      room_id: z.string(),
      base_rent: z.number().nonnegative(),
      bundle_fee: z.number().nonnegative().optional(),
    }),
    run: async (args) => JSON.stringify(await updateRoomRent(args)),
  }),
];
