/**
 * Webhook for the listings bot — the Telegram bot in the team's group chat
 * (its own BotFather token; unrelated to the ops bot at /api/telegram).
 *
 *   Private chat, admin only (LISTINGS_BOT_ADMIN_IDS): manage group reminders
 *     in plain language, ask about inventory. The only place Claude runs;
 *     every change is confirmed by a code-built receipt (see agent.ts).
 *   Team group (linked by the admin sending /setgroup in it): the bot posts
 *     inventory changes + reminders there (see src/lib/listings-bot/run.ts).
 *     No model output ever reaches the group: everything posted there is
 *     rendered by code straight from the database.
 *
 * Register once (allowed_updates keeps Telegram from sending anything else):
 *   curl "https://api.telegram.org/bot$LISTINGS_BOT_TOKEN/setWebhook" \
 *     -d url=https://<portal host>/api/telegram/listings \
 *     -d secret_token=$LISTINGS_BOT_WEBHOOK_SECRET \
 *     -d 'allowed_updates=["message","message_reaction","chat_member"]'
 *
 * The bot must be an ADMIN of the team group: Telegram only sends reaction
 * and member updates (and non-command messages) to admin bots. Reactions are
 * how the team acknowledges an inventory change — see src/lib/listings-bot/acks.ts.
 */

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  sendChatAction,
  setMessageReaction,
  type TgUser,
} from "@/lib/telegram";
import {
  allMembers,
  displayName,
  markLeft,
  normalizeUsername,
  openTasks,
  recordReaction,
  recordTextConfirmation,
  setRemind,
  upsertMember,
} from "@/lib/listings-bot/acks";
import { runBotTurn, type Turn } from "@/lib/listings-bot/agent";
import { describeSchedule } from "@/lib/listings-bot/schedule";
import {
  adminIds,
  botDb,
  botSend,
  botToken,
  getState,
  setGroup,
  REMINDER_COLUMNS,
  type BotDb,
  type ReminderRow,
} from "@/lib/listings-bot/store";
import { escapeHtml } from "@/lib/listings-bot/diff";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type TgChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
};

type TgMessage = {
  message_id: number;
  /** Unix seconds. */
  date: number;
  from?: TgUser;
  reply_to_message?: { message_id: number; from?: TgUser };
  chat: TgChat;
  text?: string;
  migrate_to_chat_id?: number;
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
};

type TgReactionUpdate = {
  chat: TgChat;
  message_id: number;
  /** Absent when someone reacts anonymously as the group. */
  user?: TgUser;
  old_reaction: unknown[];
  new_reaction: unknown[];
};

type TgChatMemberUpdate = {
  chat: TgChat;
  from: TgUser;
  old_chat_member: { status: string; user: TgUser; is_member?: boolean };
  new_chat_member: { status: string; user: TgUser; is_member?: boolean };
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
  "• Remind the team every Monday at 10am to refresh the Facebook listings, and make them confirm\n" +
  "• Every weekday at 9, post the rooms still flagged for a listing action\n" +
  "• Move the Monday reminder to 11am\n" +
  "• Pause the daily reminder\n" +
  "• Tell the team now that the Journal Square prices changed\n" +
  "• What's available under $1,500?\n\n" +
  "After any change I add a <b>Confirmed by the system</b> block showing exactly what was saved. If that block isn't there, nothing was changed.\n\n" +
  "<b>Ad-update reactions:</b> every inventory change I post tags the people on the reminder list and asks them to react once their ads are updated; I re-tag whoever hasn't every 2 hours (8 AM – 6 PM ET).\n" +
  "/team — who is on the reminder list\n" +
  "/add @username · /remove @username — change the reminder list\n" +
  "/pending — changes still waiting on reactions, and who from\n\n" +
  "/reminders — list reminders\n" +
  "/status — which group I post to\n" +
  "/reset — clear this chat's history";

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

async function teamMessage(db: BotDb): Promise<string> {
  const admins = adminIds();
  const listed = (await allMembers(db)).filter((m) => m.remind);
  if (listed.length === 0) {
    return "Nobody is on the reminder list. Add someone with /add @username.";
  }
  const rows = listed.map((m) => {
    const note =
      m.user_id !== null && admins.has(Number(m.user_id))
        ? " — admin, not asked"
        : !m.active
          ? " — left the group, not asked"
          : m.user_id === null
            ? " — <i>reactions count once they post or react in the group</i>"
            : "";
    const who = m.username ? `@${escapeHtml(m.username)}` : escapeHtml(displayName(m));
    return `• ${who}${note}`;
  });
  return (
    `<b>Reminder list (${listed.length})</b>\n${rows.join("\n")}\n\n` +
    "/add @username · /remove @username"
  );
}

async function pendingMessage(db: BotDb): Promise<string> {
  const state = await getState(db);
  if (!state.group_chat_id) return "No team group is linked yet.";
  const open = await openTasks(db, state.group_chat_id);
  if (open.length === 0) return "✅ Everyone has reacted to every inventory change.";
  return open
    .map(
      (t) =>
        `${t.lines.join("\n")}\n<i>Waiting on: ${t.pending.map((m) => escapeHtml(displayName(m))).join(", ")}</i>`,
    )
    .join("\n\n");
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
  if (text === "/team") {
    await botSend(chatId, await teamMessage(db));
    return;
  }
  const listCmd = text.match(/^\/(add|remove)(?:@\w+)?\s+(.+)$/i);
  if (listCmd) {
    const add = listCmd[1].toLowerCase() === "add";
    const names = listCmd[2].split(/[\s,]+/).filter(Boolean);
    const lines: string[] = [];
    for (const raw of names) {
      const username = normalizeUsername(raw);
      if (!username) {
        lines.push(`${escapeHtml(raw)} — not a valid @username`);
        continue;
      }
      const result = await setRemind(db, username, add);
      lines.push(
        result === "not_found"
          ? `@${escapeHtml(username)} wasn't on the list`
          : `@${escapeHtml(username)} ${result === "added" ? "will be reminded" : "removed from the reminder list"}`,
      );
    }
    await botSend(chatId, lines.join("\n") || "Usage: /add @username");
    return;
  }
  if (text === "/pending") {
    await botSend(chatId, await pendingMessage(db));
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
                `<b>#${r.id}</b>${r.enabled ? "" : " (paused)"}${r.needs_confirmation ? " · needs confirmation" : ""} — ${escapeHtml(describeSchedule(r.schedule))}\n${escapeHtml(r.message)}`,
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
  // The group gets no model replies. Plain text is only checked for "ads
  // updated" confirmations; commands follow. "/help@bot" → "/help"
  if (!text.startsWith("/")) {
    await handleConfirmation(db, msg, text);
    return;
  }
  const command = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();

  if (command === "/setgroup") {
    if (!adminIds().has(msg.from!.id)) return; // only the admin may link a group
    await setGroup(db, chatId, msg.chat.title ?? null);
    await botSend(
      chatId,
      "👋 I'm set up for this group. I'll post here whenever the inventory changes — a new room, a price or date change, a room coming off the market — so the listing ads can be updated, along with scheduled reminders.",
    );
    return;
  }

  const state = await getState(db);
  if (state.group_chat_id !== chatId) return; // not the team group — stay silent

  if (command === "/help" || command === "/start") {
    await botSend(
      chatId,
      "I post inventory changes and reminders here. Once your ads match a change, react to that post.",
    );
  }
}

/** Count "done"-style texts from the reminder list; 👍 the ones counted. */
async function handleConfirmation(db: BotDb, msg: TgMessage, text: string) {
  if (!(await isTeamGroup(db, msg.chat.id))) return;
  const counted = await recordTextConfirmation(
    db,
    msg.chat.id,
    {
      message_id: msg.message_id,
      date: msg.date,
      text,
      reply_to_message_id: msg.reply_to_message?.from?.is_bot
        ? msg.reply_to_message.message_id
        : undefined,
    },
    msg.from!,
  );
  if (counted > 0) {
    await setMessageReaction(msg.chat.id, msg.message_id, "👍", botToken()!);
  }
}

async function isTeamGroup(db: BotDb, chatId: number): Promise<boolean> {
  return (await getState(db)).group_chat_id === chatId;
}

/** Keep the roster current from what happens in the team group. */
async function learnFromGroupMessage(db: BotDb, msg: TgMessage) {
  const joined = msg.new_chat_members ?? [];
  const left = msg.left_chat_member;
  const author = msg.from && !msg.from.is_bot ? msg.from : null;
  if (!author && joined.length === 0 && !left) return;
  if (!(await isTeamGroup(db, msg.chat.id))) return;
  for (const u of joined) await upsertMember(db, u, { joined: true });
  if (left && !left.is_bot) await markLeft(db, left.id);
  else if (author && joined.length === 0) await upsertMember(db, author);
}

async function handleReaction(db: BotDb, r: TgReactionUpdate) {
  if (!r.user || r.user.is_bot) return;
  if (!(await isTeamGroup(db, r.chat.id))) return;
  await recordReaction(
    db,
    r.chat.id,
    r.message_id,
    r.user,
    (r.new_reaction ?? []).length > 0,
  );
}

const GONE = new Set(["left", "kicked"]);

async function handleMemberChange(db: BotDb, u: TgChatMemberUpdate) {
  const user = u.new_chat_member.user;
  if (user.is_bot) return;
  if (!(await isTeamGroup(db, u.chat.id))) return;
  const gone = (s: { status: string; is_member?: boolean }) =>
    GONE.has(s.status) || (s.status === "restricted" && s.is_member === false);
  if (gone(u.new_chat_member)) await markLeft(db, user.id);
  else await upsertMember(db, user, { joined: gone(u.old_chat_member) });
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

  let update: {
    update_id?: number;
    message?: TgMessage;
    message_reaction?: TgReactionUpdate;
    chat_member?: TgChatMemberUpdate;
  };
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const msg = update.message;
  if (!msg && !update.message_reaction && !update.chat_member) {
    return NextResponse.json({ ok: true });
  }

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
    if (update.message_reaction) {
      await handleReaction(db, update.message_reaction);
      return NextResponse.json({ ok: true });
    }
    if (update.chat_member) {
      await handleMemberChange(db, update.chat_member);
      return NextResponse.json({ ok: true });
    }
    if (!msg) return NextResponse.json({ ok: true });

    // A group upgraded to a supergroup gets a new chat id — follow it.
    if (msg.migrate_to_chat_id) {
      const state = await getState(db);
      if (state.group_chat_id === msg.chat.id) {
        await setGroup(db, msg.migrate_to_chat_id, state.group_title);
      }
      return NextResponse.json({ ok: true });
    }

    if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
      await learnFromGroupMessage(db, msg);
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
