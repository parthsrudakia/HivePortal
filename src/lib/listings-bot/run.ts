/**
 * Listings bot background pass: post inventory changes to the team group and
 * fire due reminders. Called by /api/cron/listings-bot (pinged by pg_cron
 * when something is due) and by the daily ops cron as a safety net — a room
 * can also enter/leave inventory just because the date rolled over.
 */

import { todayISO } from "@/lib/date";
import {
  diffInventory,
  formatInventoryList,
  formatOpenActions,
  escapeHtml,
  isEmptyDiff,
  type InvRoom,
} from "./diff";
import { nextRun } from "./schedule";
import {
  formatChangeNotice,
  processAdNags,
  recordChangeTask,
  taskLines,
  trackedMembers,
  type Member,
} from "./acks";
import {
  botDb,
  botPost,
  botSend,
  botToken,
  fetchInventory,
  getState,
  REMINDER_COLUMNS,
  type BotDb,
  type ReminderRow,
} from "./store";

const LOCK_STALE_MS = 5 * 60 * 1000;
/** A failed post is retried ~15 min later (the cron fires 2 min after dirty_at). */
const SEND_RETRY_MS = 13 * 60 * 1000;

export type ChangeResult =
  | { status: "busy" | "seeded" | "no_changes" | "no_group" | "send_failed" }
  | { status: "posted"; added: number; changed: number; removed: number };

async function saveSnapshot(db: BotDb, rooms: InvRoom[], removedIds: string[]) {
  const now = new Date().toISOString();
  if (rooms.length > 0) {
    const { error } = await db.from("listing_bot_snapshots").upsert(
      rooms.map((r) => ({ room_id: r.id, data: r, updated_at: now })),
    );
    if (error) throw new Error(`snapshot save failed: ${error.message}`);
  }
  if (removedIds.length > 0) {
    const { error } = await db
      .from("listing_bot_snapshots")
      .delete()
      .in("room_id", removedIds);
    if (error) throw new Error(`snapshot prune failed: ${error.message}`);
  }
}

/** Clears the dirty flag unless a newer edit landed while we were working. */
async function clearDirty(db: BotDb, seenDirtyAt: string | null) {
  if (!seenDirtyAt) return;
  await db
    .from("listing_bot_state")
    .update({ dirty_at: null })
    .eq("id", true)
    .eq("dirty_at", seenDirtyAt);
}

export async function processInventoryChanges(db: BotDb): Promise<ChangeResult> {
  // Run lock: only one pass at a time may diff + post.
  const lockedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS).toISOString();
  const { data: lock } = await db
    .from("listing_bot_state")
    .update({ processing_at: lockedAt })
    .eq("id", true)
    .or(`processing_at.is.null,processing_at.lt."${staleBefore}"`)
    .select("id");
  if (!lock || lock.length === 0) return { status: "busy" };

  try {
    const state = await getState(db);
    const curr = await fetchInventory(db);
    const { data: snapRows, error: snapErr } = await db
      .from("listing_bot_snapshots")
      .select("room_id, data")
      .returns<{ room_id: string; data: InvRoom }[]>();
    if (snapErr) throw new Error(`snapshot read failed: ${snapErr.message}`);
    const prev = new Map((snapRows ?? []).map((s) => [s.room_id, s.data]));

    // First run: record the baseline silently instead of announcing every
    // room as "new".
    if (!state.seeded_at) {
      await saveSnapshot(db, curr, []);
      await db
        .from("listing_bot_state")
        .update({ seeded_at: new Date().toISOString() })
        .eq("id", true);
      await clearDirty(db, state.dirty_at);
      return { status: "seeded" };
    }

    const diff = diffInventory(prev, curr);
    if (isEmptyDiff(diff)) {
      await clearDirty(db, state.dirty_at);
      return { status: "no_changes" };
    }
    const removedIds = diff.removed.map((r) => r.id);

    // No group linked yet: keep the baseline current so linking one later
    // doesn't dump a backlog of old changes into it.
    if (!state.group_chat_id) {
      await saveSnapshot(db, curr, removedIds);
      await clearDirty(db, state.dirty_at);
      return { status: "no_group" };
    }

    // Tag everyone who must react once their ads match. A roster failure
    // must never hold up the change post itself.
    let team: Member[] = [];
    try {
      team = await trackedMembers(db);
    } catch (e) {
      console.error("Listings bot roster read failed:", e);
    }
    // The post only says that something changed; details are in the portal.
    const messageIds = await botPost(state.group_chat_id, formatChangeNotice(team));
    if (!messageIds) {
      // Keep the old snapshot so the same diff is retried, but back off.
      await db
        .from("listing_bot_state")
        .update({ dirty_at: new Date(Date.now() + SEND_RETRY_MS).toISOString() })
        .eq("id", true);
      return { status: "send_failed" };
    }

    await saveSnapshot(db, curr, removedIds);
    await clearDirty(db, state.dirty_at);
    try {
      await recordChangeTask(db, state.group_chat_id, taskLines(diff), messageIds);
    } catch (e) {
      console.error("Listings bot task record failed:", e);
    }
    return {
      status: "posted",
      added: diff.added.length,
      changed: diff.changed.length,
      removed: diff.removed.length,
    };
  } finally {
    await db
      .from("listing_bot_state")
      .update({ processing_at: null })
      .eq("id", true)
      .eq("processing_at", lockedAt);
  }
}

export async function reminderText(
  db: BotDb,
  r: Pick<ReminderRow, "message" | "include">,
): Promise<string> {
  let text = `⏰ <b>Reminder</b>\n${escapeHtml(r.message)}`;
  if (r.include !== "none") {
    const rooms = await fetchInventory(db);
    text +=
      "\n\n" +
      (r.include === "open_actions"
        ? formatOpenActions(rooms)
        : formatInventoryList(rooms));
  }
  return text;
}

const MAX_REMINDER_RETRIES = 3;
const REMINDER_RETRY_MS = 5 * 60 * 1000;

export async function processDueReminders(
  db: BotDb,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = new Date();
  const { data: due, error } = await db
    .from("listing_bot_reminders")
    .select(REMINDER_COLUMNS)
    .eq("enabled", true)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .returns<ReminderRow[]>();
  if (error) throw new Error(`reminders read failed: ${error.message}`);

  const state = await getState(db);
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of due ?? []) {
    const next = nextRun(r.schedule, now);
    // Claim by advancing next_run_at; an overlapping run loses the race on
    // the old value and skips, so a reminder never posts twice.
    const { data: claimed } = await db
      .from("listing_bot_reminders")
      .update({
        next_run_at: next?.toISOString() ?? null,
        enabled: next !== null,
      })
      .eq("id", r.id)
      .eq("next_run_at", r.next_run_at)
      .select("id");
    if (!claimed || claimed.length === 0) {
      skipped++;
      continue;
    }

    let problem: string | null = null;
    if (!state.group_chat_id) {
      problem = "no group linked — run /setgroup in the team group";
    } else {
      try {
        const ok = await botSend(state.group_chat_id, await reminderText(db, r));
        if (!ok) problem = "Telegram refused the message";
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e);
      }
    }

    if (!problem) {
      await db
        .from("listing_bot_reminders")
        .update({
          last_run_at: now.toISOString(),
          last_error: null,
          fail_count: 0,
        })
        .eq("id", r.id);
      sent++;
      continue;
    }

    failed++;
    // Retry a few times 5 minutes apart, then give up until its next slot.
    const retry = state.group_chat_id && r.fail_count + 1 < MAX_REMINDER_RETRIES;
    await db
      .from("listing_bot_reminders")
      .update(
        retry
          ? {
              last_error: problem,
              fail_count: r.fail_count + 1,
              enabled: true,
              next_run_at: new Date(Date.now() + REMINDER_RETRY_MS).toISOString(),
            }
          : { last_error: problem, fail_count: 0 },
      )
      .eq("id", r.id);
  }
  return { sent, failed, skipped };
}

/** One full pass. Never throws — each half reports its own error. */
export async function runListingsBot(db: BotDb = botDb()) {
  if (!botToken()) return { skipped: "LISTINGS_BOT_TOKEN is not configured" };
  const changes = await processInventoryChanges(db).catch((e) => ({
    status: "error" as const,
    error: e instanceof Error ? e.message : String(e),
  }));
  const reminders = await processDueReminders(db).catch((e) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  const adReminders = await getState(db)
    .then((s) => processAdNags(db, s.group_chat_id, botPost))
    .catch((e) => ({
      status: "error" as const,
      error: e instanceof Error ? e.message : String(e),
    }));
  return { as_of: todayISO(), changes, reminders, ad_reminders: adReminders };
}
