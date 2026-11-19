/**
 * Ad-update acknowledgements for the listings bot.
 *
 * Every inventory-change post in the team group is a task. Each team member
 * on the reminder list (`remind`, added by @username; admins never) acknowledges it by reacting — any emoji — to the change
 * post, or to a reminder that covers it. Until everyone has, the bot posts
 * ONE combined reminder for all open tasks every 2 hours, only between 8 AM
 * and 6 PM Eastern (picking up again at 8 AM the next day), tagging just the
 * people who haven't reacted yet.
 *
 * Telegram gives bots no "list members" call, so the roster is learned from
 * group activity: messages, reactions, joins and leaves (see the webhook).
 * Reaction updates only reach a bot that is an admin of the group.
 *
 * Every message here is code-built from the database — no model involved.
 */

import { adminIds, type BotDb } from "./store";
import { escapeHtml, roomTitle, type InventoryDiff } from "./diff";
import { etDate, etToUtc } from "./schedule";
import type { TgUser } from "@/lib/telegram";
import { APP_TIME_ZONE, addDaysISO } from "@/lib/date";

export const NAG_EVERY_MS = 2 * 60 * 60 * 1000;
/** A change this fresh waits for the next round instead of a quick re-ping. */
const NAG_MIN_AGE_MS = 60 * 60 * 1000;
const NAG_RETRY_MS = 5 * 60 * 1000;
export const NAG_WINDOW = { start: "08:00", end: "18:00" } as const;

// ---------------------------------------------------------------- pure ----

export type Member = {
  id: number;
  /** Null until a listed @username first posts or reacts in the group. */
  user_id: number | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  remind: boolean;
  active: boolean;
  joined_at: string | null;
};

export const MEMBER_COLUMNS =
  "id, user_id, first_name, last_name, username, remind, active, joined_at";

/** Eastern wall-clock "HH:MM" of an instant. */
export function etClock(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

/**
 * The first moment at or after `at` that falls inside the reminder window
 * (8:00 AM – 6:00 PM Eastern, every day).
 */
export function inNagWindow(at: Date): Date {
  const clock = etClock(at);
  const day = etDate(at);
  if (clock < NAG_WINDOW.start) return etToUtc(day, NAG_WINDOW.start);
  if (clock > NAG_WINDOW.end) {
    return etToUtc(addDaysISO(day, 1), NAG_WINDOW.start);
  }
  return at;
}

export function displayName(m: Pick<Member, "first_name" | "last_name" | "username">): string {
  const name = [m.first_name, m.last_name].filter(Boolean).join(" ").trim();
  return name || (m.username ? `@${m.username}` : "Someone");
}

/** A Telegram mention that pings the person (HTML parse mode). */
export function mention(m: Pick<Member, "user_id" | "first_name" | "last_name" | "username">): string {
  if (m.username) return `@${escapeHtml(m.username)}`;
  return `<a href="tg://user?id=${m.user_id}">${escapeHtml(displayName(m))}</a>`;
}

/** Brief one-line-per-room summary of a diff, kept on the task. */
export function taskLines(d: InventoryDiff): string[] {
  const lines: string[] = [];
  for (const r of d.added) {
    lines.push(`🆕 ${escapeHtml(roomTitle(r))} — post a listing`);
  }
  for (const { room, changes } of d.changed) {
    // describeChanges lines start with "Label: …"; keep just the labels.
    const labels = [
      ...new Set(
        changes.map((c) =>
          c
            .split(/[:\n]/)[0]
            .replace(/<[^>]+>/g, "")
            .replace(/\s+(changed|added|updated|removed)$/i, "")
            .trim(),
        ),
      ),
    ].filter(Boolean);
    lines.push(
      `✏️ ${escapeHtml(roomTitle(room))} — update ${labels.join(", ").toLowerCase()}`,
    );
  }
  for (const r of d.removed) {
    lines.push(`❌ ${escapeHtml(roomTitle(r))} — take ads down`);
  }
  return lines;
}

/** The portal's inventory page, when the site URL is configured. */
export function portalInventoryUrl(): string | null {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/$/, "");
  return base ? `${base}/inventory` : null;
}

function portalLine(): string {
  const url = portalInventoryUrl();
  return url
    ? `Check the <a href="${escapeHtml(url)}">portal</a> for what changed and update your ads to match.`
    : "Check the portal for what changed and update your ads to match.";
}

/**
 * The group post for an inventory change. Deliberately says only THAT the
 * inventory changed — the details live in the portal — and tags everyone
 * being asked to act.
 */
export function formatChangeNotice(members: Member[]): string {
  return (
    `📋 <b>Inventory updated</b>\n${portalLine()}\n\n` +
    confirmCallout(members, "once your ads are updated")
  );
}

/** The "tag + react or reply done" line that asks for a confirmation. */
export function confirmCallout(members: Member[], when = "once done"): string {
  const who = members.map(mention).join(" ");
  return who
    ? `👉 ${who} — react or reply “done” ${when}.`
    : `👉 React or reply “done” ${when}.`;
}

export type TaskKind = "inventory" | "reminder";

export type OpenTask = {
  id: number;
  kind: TaskKind;
  lines: string[];
  created_at: string;
  pending: Member[];
};

const MAX_REMINDER_LINE = 120;

/**
 * The combined follow-up for everything still open, tagging who is missing.
 * Inventory changes are only counted (details live in the portal); a
 * scheduled reminder that needs confirmation is repeated by its own text.
 */
export function formatNag(tasks: OpenTask[]): string {
  const everyone = new Map<number, Member>();
  for (const t of tasks) for (const m of t.pending) everyone.set(m.id, m);
  const changes = tasks.filter((t) => t.kind === "inventory").length;
  const reminders = tasks.filter((t) => t.kind === "reminder");

  const what: string[] = [];
  if (changes > 0) {
    what.push(
      (changes === 1
        ? "An inventory change still needs your ads updated."
        : `${changes} inventory changes still need your ads updated.`) +
        ` ${portalLine()}`,
    );
  }
  for (const r of reminders) {
    // Lines are stored escaped; cut on the raw text so no entity is split.
    const raw = (r.lines[0] ?? "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const cut =
      raw.length > MAX_REMINDER_LINE ? `${raw.slice(0, MAX_REMINDER_LINE).trimEnd()}…` : raw;
    what.push(`“${escapeHtml(cut)}”`);
  }
  const body =
    what.length === 1 ? what[0] : what.map((w) => `• ${w}`).join("\n");
  return (
    `🔔 <b>Reminder</b>\n${body}\n\n` +
    confirmCallout([...everyone.values()])
  );
}

/** Who still owes a reaction on a task. */
export function pendingFor(
  task: { id: number; created_at: string },
  members: Member[],
  acked: Set<string>,
): Member[] {
  return members.filter(
    (m) =>
      // Joined after the change was posted: not asked about it.
      !(m.joined_at && m.joined_at > task.created_at) &&
      !(m.user_id !== null && acked.has(`${task.id}:${m.user_id}`)),
  );
}

// ------------------------------------------------------------- database ----

/**
 * Learn (or refresh) a group member. Matches by Telegram user id, then by
 * @username — which is how a listed teammate gets their user id filled in.
 * `joined` = we just saw them join.
 */
export async function upsertMember(
  db: BotDb,
  user: TgUser,
  opts: { joined?: boolean } = {},
): Promise<void> {
  if (user.is_bot) return;
  const now = new Date().toISOString();
  const fields = {
    user_id: user.id,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    username: user.username ?? null,
    active: true,
    updated_at: now,
    ...(opts.joined ? { joined_at: now } : {}),
  };
  try {
    const { data: byId, error } = await db
      .from("listing_bot_members")
      .select("id")
      .eq("user_id", user.id)
      .limit(1)
      .returns<{ id: number }[]>();
    if (error) throw error;
    let rowId = byId?.[0]?.id;
    if (!rowId && user.username) {
      const { data: byName, error: nameErr } = await db
        .from("listing_bot_members")
        .select("id")
        .ilike("username", user.username)
        .is("user_id", null)
        .limit(1)
        .returns<{ id: number }[]>();
      if (nameErr) throw nameErr;
      rowId = byName?.[0]?.id;
    }
    if (rowId) {
      const { error: upErr } = await db
        .from("listing_bot_members")
        .update(fields)
        .eq("id", rowId);
      if (upErr) throw upErr;
    } else {
      const { error: insErr } = await db.from("listing_bot_members").insert(fields);
      if (insErr) throw insErr;
    }
  } catch (e) {
    console.error(
      "Listings bot member upsert failed:",
      e instanceof Error ? e.message : (e as { message?: string }).message ?? e,
    );
  }
}

export async function markLeft(db: BotDb, userId: number): Promise<void> {
  const { error } = await db
    .from("listing_bot_members")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) console.error("Listings bot member leave failed:", error.message);
}

export async function allMembers(db: BotDb): Promise<Member[]> {
  const { data, error } = await db
    .from("listing_bot_members")
    .select(MEMBER_COLUMNS)
    .order("id", { ascending: true })
    .returns<Member[]>();
  if (error) throw new Error(`members read failed: ${error.message}`);
  return data ?? [];
}

/** Everyone asked to acknowledge: on the reminder list, in the group, not an admin. */
export async function trackedMembers(db: BotDb): Promise<Member[]> {
  const admins = adminIds();
  return (await allMembers(db)).filter(
    (m) => m.remind && m.active && !(m.user_id !== null && admins.has(Number(m.user_id))),
  );
}

export function normalizeUsername(raw: string): string | null {
  const u = raw.trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{4,32}$/.test(u) ? u : null;
}

/** Put an @username on (or take it off) the reminder list. */
export async function setRemind(
  db: BotDb,
  username: string,
  remind: boolean,
): Promise<"added" | "removed" | "not_found"> {
  const { data, error } = await db
    .from("listing_bot_members")
    .select("id")
    .ilike("username", username)
    .limit(1)
    .returns<{ id: number }[]>();
  if (error) throw new Error(`member lookup failed: ${error.message}`);
  const now = new Date().toISOString();
  if (data && data.length > 0) {
    const { error: upErr } = await db
      .from("listing_bot_members")
      .update({ remind, updated_at: now })
      .eq("id", data[0].id);
    if (upErr) throw new Error(upErr.message);
    return remind ? "added" : "removed";
  }
  if (!remind) return "not_found";
  const { error: insErr } = await db
    .from("listing_bot_members")
    .insert({ username, remind: true, updated_at: now });
  if (insErr) throw new Error(insErr.message);
  return "added";
}

async function nagNextAt(db: BotDb): Promise<string | null> {
  const { data, error } = await db
    .from("listing_bot_state")
    .select("nag_next_at")
    .eq("id", true)
    .single<{ nag_next_at: string | null }>();
  if (error) throw new Error(`nag state unreadable: ${error.message}`);
  return data.nag_next_at;
}

/**
 * Record a post that needs confirmation (an inventory change, or a firing of
 * a reminder set to need it) as a task, and make sure a follow-up is
 * scheduled. A reminder's new firing replaces its previous unconfirmed one.
 */
export async function recordTask(
  db: BotDb,
  chatId: number,
  lines: string[],
  messageIds: number[],
  opts: { kind?: TaskKind; reminderId?: number } = {},
): Promise<void> {
  const now = new Date();
  const kind = opts.kind ?? "inventory";
  if (opts.reminderId !== undefined) {
    await db
      .from("listing_bot_tasks")
      .update({ done_at: now.toISOString() })
      .eq("reminder_id", opts.reminderId)
      .is("done_at", null);
  }
  const { data: task, error } = await db
    .from("listing_bot_tasks")
    .insert({
      chat_id: chatId,
      lines,
      kind,
      reminder_id: opts.reminderId ?? null,
      created_at: now.toISOString(),
    })
    .select("id")
    .single<{ id: number }>();
  if (error || !task) throw new Error(`task insert failed: ${error?.message}`);

  if (messageIds.length > 0) {
    const { error: postErr } = await db.from("listing_bot_posts").insert(
      messageIds.map((message_id) => ({
        chat_id: chatId,
        message_id,
        kind: kind === "inventory" ? "change" : "reminder",
        task_ids: [task.id],
      })),
    );
    if (postErr) throw new Error(`post insert failed: ${postErr.message}`);
  }

  // Start the cycle if none is running; otherwise this change joins it.
  await db
    .from("listing_bot_state")
    .update({ nag_next_at: inNagWindow(new Date(now.getTime() + NAG_EVERY_MS)).toISOString() })
    .eq("id", true)
    .is("nag_next_at", null);
}

/** Record a reminder post and the tasks a reaction to it acknowledges. */
export async function recordPost(
  db: BotDb,
  chatId: number,
  messageIds: number[],
  kind: "reminder",
  taskIds: number[] = [],
): Promise<void> {
  if (messageIds.length === 0) return;
  const { error } = await db.from("listing_bot_posts").upsert(
    messageIds.map((message_id) => ({
      chat_id: chatId,
      message_id,
      kind,
      task_ids: taskIds,
    })),
  );
  if (error) throw new Error(`post insert failed: ${error.message}`);
}

const CONFIRM_WORDS =
  /\b(done|updated|changed|fixed|posted|reposted|completed?|finished|removed|deleted|taken down|took (it |them |the ads? )?down|all set|good to go|taken care of|ads? (are |is )?(up|live))\b/i;
const CONFIRM_EMOJI = /^[\s✅👍✔☑️👌🙌💯]+$/u;
/** Anything that makes it a question, a promise or a "not yet". */
const NOT_A_CONFIRMATION =
  /\?|n['’]t\b|\b(not|never|yet|will|gonna|going to|later|soon|tomorrow|tonight|working on|need|needs|should|can you|could you|when|which|what|how|why|if)\b/i;

/**
 * Whether a group message reads as "I've updated my ads". Deliberately strict
 * and rule-based (no model): a miss just means one more reminder, while a
 * false "done" would silence reminders for ads nobody updated.
 */
export function isConfirmation(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 160 || t.startsWith("/")) return false;
  if (CONFIRM_EMOJI.test(t)) return true;
  return CONFIRM_WORDS.test(t) && !NOT_A_CONFIRMATION.test(t);
}

/**
 * A confirmation text from someone on the reminder list. A reply to a change
 * post or reminder acknowledges what that message covered; a standalone
 * message acknowledges every change posted before it that they still owe.
 * Returns how many changes it acknowledged (0 = not counted).
 */
export async function recordTextConfirmation(
  db: BotDb,
  chatId: number,
  msg: { message_id: number; date: number; text: string; reply_to_message_id?: number },
  user: TgUser,
): Promise<number> {
  if (!isConfirmation(msg.text)) return 0;
  const me = (await trackedMembers(db)).find((m) => Number(m.user_id) === user.id);
  if (!me) return 0;

  let taskIds: number[] = [];
  if (msg.reply_to_message_id) {
    const { data: post } = await db
      .from("listing_bot_posts")
      .select("task_ids")
      .eq("chat_id", chatId)
      .eq("message_id", msg.reply_to_message_id)
      .maybeSingle<{ task_ids: number[] }>();
    taskIds = post?.task_ids ?? [];
  }
  if (taskIds.length === 0) {
    // Standalone (or a reply to something else): every open change posted
    // before this message.
    const sentAt = new Date(msg.date * 1000).toISOString();
    const { data, error } = await db
      .from("listing_bot_tasks")
      .select("id")
      .eq("chat_id", chatId)
      .is("done_at", null)
      .lte("created_at", sentAt)
      .returns<{ id: number }[]>();
    if (error) throw new Error(`tasks read failed: ${error.message}`);
    taskIds = (data ?? []).map((t) => t.id);
  }
  if (taskIds.length === 0) return 0;

  const { data: already } = await db
    .from("listing_bot_acks")
    .select("task_id")
    .eq("user_id", user.id)
    .in("task_id", taskIds)
    .returns<{ task_id: number }[]>();
  const have = new Set((already ?? []).map((a) => Number(a.task_id)));
  const fresh = taskIds.filter((id) => !have.has(Number(id)));
  if (fresh.length === 0) return 0;

  const { error } = await db.from("listing_bot_acks").upsert(
    fresh.map((task_id) => ({ task_id, user_id: user.id, message_id: msg.message_id })),
    { onConflict: "task_id,user_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`ack insert failed: ${error.message}`);
  return fresh.length;
}

/**
 * A reaction in the team group. Any reaction (added, not removed) to a change
 * post or reminder acknowledges every task that message covers.
 */
export async function recordReaction(
  db: BotDb,
  chatId: number,
  messageId: number,
  user: TgUser,
  added: boolean,
): Promise<number> {
  await upsertMember(db, user);
  if (!added) return 0;
  const { data: post } = await db
    .from("listing_bot_posts")
    .select("task_ids")
    .eq("chat_id", chatId)
    .eq("message_id", messageId)
    .maybeSingle<{ task_ids: number[] }>();
  const taskIds = post?.task_ids ?? [];
  if (taskIds.length === 0) return 0;
  const { error } = await db.from("listing_bot_acks").upsert(
    taskIds.map((task_id) => ({
      task_id,
      user_id: user.id,
      message_id: messageId,
    })),
    { onConflict: "task_id,user_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`ack insert failed: ${error.message}`);
  return taskIds.length;
}

/**
 * Open tasks for the group with who still owes a reaction. Tasks nobody owes
 * anything on any more are closed as a side effect.
 */
export async function openTasks(db: BotDb, chatId: number): Promise<OpenTask[]> {
  const { data: tasks, error } = await db
    .from("listing_bot_tasks")
    .select("id, kind, lines, created_at")
    .eq("chat_id", chatId)
    .is("done_at", null)
    .order("created_at", { ascending: true })
    .returns<{ id: number; kind: TaskKind; lines: string[]; created_at: string }[]>();
  if (error) throw new Error(`tasks read failed: ${error.message}`);
  if (!tasks || tasks.length === 0) return [];

  const members = await trackedMembers(db);
  const { data: acks, error: ackErr } = await db
    .from("listing_bot_acks")
    .select("task_id, user_id")
    .in(
      "task_id",
      tasks.map((t) => t.id),
    )
    .returns<{ task_id: number; user_id: number }[]>();
  if (ackErr) throw new Error(`acks read failed: ${ackErr.message}`);
  const acked = new Set((acks ?? []).map((a) => `${a.task_id}:${a.user_id}`));

  const open: OpenTask[] = [];
  const done: number[] = [];
  for (const t of tasks) {
    const pending = pendingFor(t, members, acked);
    if (pending.length === 0) done.push(t.id);
    else open.push({ ...t, pending });
  }
  if (done.length > 0) {
    await db
      .from("listing_bot_tasks")
      .update({ done_at: new Date().toISOString() })
      .in("id", done);
  }
  return open;
}

export type NagResult =
  | { status: "idle" | "not_due" | "no_group" | "busy" | "all_done" | "waiting" | "send_failed" }
  | { status: "sent"; tasks: number; tagged: number };

/** Post the combined reminder if one is due. */
export async function processAdNags(
  db: BotDb,
  groupChatId: number | null,
  send: (chatId: number, text: string) => Promise<number[] | null>,
  now = new Date(),
): Promise<NagResult> {
  const dueAt = await nagNextAt(db);
  if (!dueAt) return { status: "idle" };
  if (new Date(dueAt) > now) return { status: "not_due" };
  if (!groupChatId) return { status: "no_group" };

  const reschedule = async (to: Date | null) => {
    const { data } = await db
      .from("listing_bot_state")
      .update({ nag_next_at: to?.toISOString() ?? null })
      .eq("id", true)
      .eq("nag_next_at", dueAt)
      .select("id");
    return !!data && data.length > 0;
  };

  const open = await openTasks(db, groupChatId);
  if (open.length === 0) {
    await reschedule(null);
    return { status: "all_done" };
  }

  // Changes posted under an hour ago wait for the next round.
  const due = open.filter(
    (t) => now.getTime() - new Date(t.created_at).getTime() >= NAG_MIN_AGE_MS,
  );
  if (due.length === 0) {
    const oldest = new Date(open[0].created_at).getTime();
    await reschedule(inNagWindow(new Date(oldest + NAG_EVERY_MS)));
    return { status: "waiting" };
  }

  // Claim the slot first so overlapping runs never post twice.
  if (!(await reschedule(inNagWindow(new Date(now.getTime() + NAG_EVERY_MS))))) {
    return { status: "busy" };
  }

  const ids = await send(groupChatId, formatNag(due));
  if (!ids) {
    await db
      .from("listing_bot_state")
      .update({
        nag_next_at: inNagWindow(new Date(now.getTime() + NAG_RETRY_MS)).toISOString(),
      })
      .eq("id", true);
    return { status: "send_failed" };
  }

  const taskIds = due.map((t) => t.id);
  await recordPost(db, groupChatId, ids, "reminder", taskIds);
  await db
    .from("listing_bot_tasks")
    .update({ last_reminded_at: now.toISOString() })
    .in("id", taskIds);
  return {
    status: "sent",
    tasks: due.length,
    tagged: new Set(due.flatMap((t) => t.pending.map((m) => m.id))).size,
  };
}
