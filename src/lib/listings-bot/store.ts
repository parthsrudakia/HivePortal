/**
 * Listings bot: config + database access. Service-role only — the bot runs
 * from its webhook and from cron, never with a user session.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { todayISO } from "@/lib/date";
import { sendMessage } from "@/lib/telegram";
import { filterAndSortRooms } from "@/lib/inventory-filter";
import {
  ROOM_SELECT,
  serializeRoom,
  type RoomRow,
} from "@/app/api/inventory/shared";
import type { InvRoom } from "./diff";
import type { Schedule } from "./schedule";

export type BotDb = SupabaseClient;

export function botDb(): BotDb {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export function botToken(): string | null {
  return process.env.LISTINGS_BOT_TOKEN?.trim() || null;
}

/** Telegram user ids allowed to configure the bot (DM + /setgroup). */
export function adminIds(): Set<number> {
  return new Set(
    (process.env.LISTINGS_BOT_ADMIN_IDS ?? "")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  );
}

/** Send as the listings bot. False when unconfigured or Telegram refused. */
export async function botSend(
  chatId: number,
  text: string,
  opts: { reply_to_message_id?: number } = {},
): Promise<boolean> {
  const token = botToken();
  if (!token) return false;
  try {
    return await sendMessage(chatId, text, {
      ...opts,
      parse_mode: "HTML",
      token,
    });
  } catch (e) {
    console.error("Listings bot send failed:", e);
    return false;
  }
}

export type BotState = {
  group_chat_id: number | null;
  group_title: string | null;
  dirty_at: string | null;
  processing_at: string | null;
  seeded_at: string | null;
};

export async function getState(db: BotDb): Promise<BotState> {
  const { data, error } = await db
    .from("listing_bot_state")
    .select("group_chat_id, group_title, dirty_at, processing_at, seeded_at")
    .eq("id", true)
    .single<BotState>();
  if (error || !data) {
    throw new Error(`listing_bot_state unreadable: ${error?.message ?? "no row"}`);
  }
  return data;
}

export async function setGroup(
  db: BotDb,
  chatId: number | null,
  title: string | null,
): Promise<void> {
  const { error } = await db
    .from("listing_bot_state")
    .update({
      group_chat_id: chatId,
      group_title: title,
      updated_at: new Date().toISOString(),
    })
    .eq("id", true);
  if (error) throw new Error(error.message);
}

/**
 * The live inventory, exactly as GET /api/inventory serves it (same query,
 * same serializer, default sort) — the bot sees what API consumers see.
 */
export async function fetchInventory(db: BotDb): Promise<InvRoom[]> {
  const today = todayISO();
  const { data, error } = await db
    .from("rooms")
    .select(ROOM_SELECT)
    .or(`status.eq.available,and(status.eq.occupied,available_from.gte.${today})`)
    .eq("pending_tenant", false)
    .is("properties.archived_at", null)
    .returns<RoomRow[]>();
  if (error) throw new Error(`inventory read failed: ${error.message}`);
  return filterAndSortRooms(
    (data ?? []).map((r) => ({ ...r, ads: [] })),
    { sort: "available", dir: "asc", posterKeys: null },
  ).map(serializeRoom);
}

export type ReminderInclude = "none" | "open_actions" | "inventory";

export type ReminderRow = {
  id: number;
  message: string;
  schedule: Schedule;
  include: ReminderInclude;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  fail_count: number;
};

export const REMINDER_COLUMNS =
  "id, message, schedule, include, enabled, next_run_at, last_run_at, last_error, fail_count";
