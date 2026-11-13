/**
 * Webhook for the listings bot — the Telegram bot in the team's group chat
 * (its own BotFather token; unrelated to the ops bot at /api/telegram).
 *
 *   Private chat, admin only (LISTINGS_BOT_ADMIN_IDS): manage group reminders
 *     in plain language, ask about inventory. The only place Claude runs;
 *     every change is confirmed by a code-built receipt (see agent.ts).
 *   Team group (linked by the admin sending /setgroup in it): the bot posts
 *     inventory changes + reminders there (see src/lib/listings-bot/run.ts).
 *     No model output ever reaches the group unprompted: /inventory there is
 *     rendered by code straight from the database.
 *
 * Register once (allowed_updates keeps Telegram from sending anything else):
 *   curl "https://api.telegram.org/bot$LISTINGS_BOT_TOKEN/setWebhook" \
 *     -d url=https://<portal host>/api/telegram/listings \
 *     -d secret_token=$LISTINGS_BOT_WEBHOOK_SECRET \
 *     -d 'allowed_updates=["message"]'
 */

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { sendChatAction } from "@/lib/telegram";
import { todayISO } from "@/lib/date";
import { runBotTurn, type Turn } from "@/lib/listings-bot/agent";
import { describeSchedule } from "@/lib/listings-bot/schedule";
import {
  adminIds,
  botDb,
  botSend,
  botToken,
  fetchInventory,
  getState,
  setGroup,
  REMINDER_COLUMNS,
  type BotDb,
  type ReminderRow,
} from "@/lib/listings-bot/store";
import {
  escapeHtml,
  formatInventoryList,
  formatOpenActions,
} from "@/lib/listings-bot/diff";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type TgMessage = {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string; is_bot?: boolean };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
  text?: string;
  migrate_to_chat_id?: number;
};

const HISTORY_LIMIT = 30;

async function loadHistory(db: BotDb, chatId: number): Promise<Turn[]> {
  const { data } = await db
    .from("listing_bot_messages")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("id", { ascending: false })
    .limit(HISTORY_LIMIT)
    .returns<Turn[]>();
  const turns = (data ?? []).reverse();
  // The window can open mid-exchange; the API needs a user turn first.
  while (turns.length > 0 && turns[0].role !== "user") turns.shift();
  return turns;
}

const ADMIN_HELP =
  "Hi — I'm the Hive listings bot.\n\n" +
  "In the team group I post every inventory change so the listing ads get updated, plus any reminders you set up here.\n\n" +
  "<b>Setup:</b> add me to the team group, then send /setgroup there.\n\n" +
  "<b>Then just tell me what you want, e.g.</b>\n" +
  "• Remind the team every Monday at 10am to refresh the Facebook listings\n" +
  "• Every weekday at 9, post the rooms still flagged for a listing action\n" +
  "• Move the Monday reminder to 11am\n" +
  "• Pause the daily reminder\n" +
  "• Tell the team now that the Journal Square prices changed\n" +
  "• What's available under $1,500?\n\n" +
  "After any change I add a <b>Confirmed by the system</b> block showing exactly what was saved. If that block isn't there, nothing was changed.\n\n" +
  "/reminders — list reminders\n" +
  "/inventory — current inventory, straight from the portal\n" +
  "/status — which group I post to\n" +
  "/reset — clear this chat's history";

/** Current inventory rendered by code — no model involved. */
async function inventoryMessage(db: BotDb): Promise<string> {
  const rooms = await fetchInventory(db);
  return (
    `${formatInventoryList(rooms)}\n\n${formatOpenActions(rooms)}\n\n` +
    `<i>Live from the portal, ${todayISO()}.</i>`
  );
}

async function replyWithAgent(
  db: BotDb,
  msg: TgMessage,
  userText: string,
  history: Turn[],
): Promise<string | null> {
  await sendChatAction(msg.chat.id, "typing", botToken()!);
  try {
    const { reply, receipts } = await runBotTurn({
      db,
      userId: msg.from!.id,
      history,
      userText,
    });
    // Receipts come from the rows the tools wrote, not from the model.
    const full =
      (reply || "(Nothing to add.)") +
      (receipts.length > 0
        ? `\n\n✅ <b>Confirmed by the system</b>\n${receipts.join("\n\n")}`
        : "");
    await botSend(msg.chat.id, full, { reply_to_message_id: msg.message_id });
    return full;
  } catch (e) {
    console.error("Listings bot turn failed:", e);
    const transient =
      e instanceof Anthropic.APIError &&
      (e.status === 429 || e.status === 529 || (e.status ?? 0) >= 500);
    await botSend(
      msg.chat.id,
      transient
        ? "Claude is temporarily overloaded — please resend that in a minute."
        : "Sorry — something went wrong on my side. Please try again, and check /reminders to see what is saved.",
      { reply_to_message_id: msg.message_id },
    );
    return null;
  }
}

async function handlePrivate(db: BotDb, msg: TgMessage, text: string) {
  const chatId = msg.chat.id;
  const userId = msg.from!.id;

  // Open to anyone: it is how the admin finds the id to put in the env var.
  if (text === "/id") {
    await botSend(chatId, `Your Telegram user id is <code>${userId}</code>.`);
    return;
  }
  if (!adminIds().has(userId)) {
    await botSend(
      chatId,
      "This bot is private to the Hive team. I post updates in the team group.",
    );
    return;
  }

  if (text === "/start" || text === "/help") {
    await botSend(chatId, ADMIN_HELP);
    return;
  }
  if (text === "/reset") {
    await db.from("listing_bot_messages").delete().eq("chat_id", chatId);
    await botSend(chatId, "Chat history cleared. Your reminders are untouched.");
    return;
  }
  if (text === "/status") {
    const state = await getState(db);
    await botSend(
      chatId,
      state.group_chat_id
        ? `I post to <b>${escapeHtml(state.group_title ?? "the team group")}</b>.`
        : "No team group is linked yet. Add me to the group and send /setgroup there.",
    );
    return;
  }
  if (text === "/inventory") {
    await botSend(chatId, await inventoryMessage(db));
    return;
  }
  if (text === "/reminders") {
    const { data } = await db
      .from("listing_bot_reminders")
      .select(REMINDER_COLUMNS)
      .order("id", { ascending: true })
      .returns<ReminderRow[]>();
    const rows = data ?? [];
    await botSend(
      chatId,
      rows.length === 0
        ? "No reminders yet. Tell me what to remind the team about and when."
        : rows
            .map(
              (r) =>
                `<b>#${r.id}</b>${r.enabled ? "" : " (paused)"} — ${escapeHtml(describeSchedule(r.schedule))}\n${escapeHtml(r.message)}`,
            )
            .join("\n\n"),
    );
    return;
  }

  const history = await loadHistory(db, chatId);
  const reply = await replyWithAgent(db, msg, text, history);
  if (reply) {
    await db.from("listing_bot_messages").insert([
      { chat_id: chatId, role: "user", content: text },
      { chat_id: chatId, role: "assistant", content: reply },
    ]);
  }
}

async function handleGroup(db: BotDb, msg: TgMessage, text: string) {
  const chatId = msg.chat.id;
  // The group gets commands only — no model replies. "/inventory@bot" → "/inventory"
  if (!text.startsWith("/")) return;
  const command = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();

  if (command === "/setgroup") {
    if (!adminIds().has(msg.from!.id)) return; // only the admin may link a group
    await setGroup(db, chatId, msg.chat.title ?? null);
    await botSend(
      chatId,
      "👋 I'm set up for this group. I'll post here whenever the inventory changes — a new room, a price or date change, a room coming off the market — so the listing ads can be updated, along with scheduled reminders.\n\nSend /inventory any time for the current list.",
    );
    return;
  }

  const state = await getState(db);
  if (state.group_chat_id !== chatId) return; // not the team group — stay silent

  if (command === "/inventory") {
    await botSend(chatId, await inventoryMessage(db));
  } else if (command === "/help" || command === "/start") {
    await botSend(
      chatId,
      "I post inventory changes and reminders here. Send /inventory for the current list, straight from the portal.",
    );
  }
}

export async function POST(req: Request) {
  // Fail closed: without a secret anyone could forge updates as the admin.
  const expected = process.env.LISTINGS_BOT_WEBHOOK_SECRET;
  if (!expected || !botToken()) {
    return NextResponse.json(
      { error: "listings bot is not configured" },
      { status: 503 },
    );
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let update: { update_id?: number; message?: TgMessage };
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const msg = update.message;
  if (!msg) return NextResponse.json({ ok: true });

  const db = botDb();

  // Telegram re-delivers until it gets a 200 — claim the update first so a
  // slow turn can never run (or post to the group) twice.
  if (typeof update.update_id === "number") {
    const { error } = await db
      .from("listing_bot_updates")
      .insert({ update_id: update.update_id });
    if (error?.code === "23505") return NextResponse.json({ ok: true });
  }

  try {
    // A group upgraded to a supergroup gets a new chat id — follow it.
    if (msg.migrate_to_chat_id) {
      const state = await getState(db);
      if (state.group_chat_id === msg.chat.id) {
        await setGroup(db, msg.migrate_to_chat_id, state.group_title);
      }
      return NextResponse.json({ ok: true });
    }

    const text = msg.text?.trim();
    if (!text || !msg.from || msg.from.is_bot) {
      return NextResponse.json({ ok: true });
    }

    if (msg.chat.type === "private") await handlePrivate(db, msg, text);
    else if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
      await handleGroup(db, msg, text);
    }
  } catch (e) {
    // Always 200 — a retry would hit the dedup row and be dropped anyway.
    console.error("Listings bot webhook failed:", e);
  }
  return NextResponse.json({ ok: true });
}
