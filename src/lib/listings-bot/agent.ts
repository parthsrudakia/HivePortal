/**
 * Listings bot conversation turn (Claude + tools) — the admin's private chat
 * only: inventory lookups plus control of the group reminders and one-off
 * posts to the group. The model never speaks in the team group: everything
 * posted there is either code-rendered (diff.ts) or text the admin approved.
 *
 * Hallucination guard: every tool that changes something pushes a receipt
 * built from the database row it wrote. The webhook appends those receipts to
 * the reply, so what the admin is told was saved is never the model's own
 * account of it — and a "done" with no receipt under it did not happen.
 *
 * Deliberately separate from the ops assistant (assistant-core/portal-tools):
 * this bot lives in a group chat and must never reach tenants, payments,
 * credentials or any write to portal data.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { APP_TIME_ZONE, todayISO } from "@/lib/date";
import { escapeHtml } from "./diff";
import { describeSchedule, nextRun, parseSchedule } from "./schedule";
import { reminderText } from "./run";
import {
  botSend,
  fetchInventory,
  getState,
  REMINDER_COLUMNS,
  type BotDb,
  type ReminderRow,
} from "./store";

export type Turn = { role: "user" | "assistant"; content: string };

const SYSTEM_PROMPT = `You are the Hive listings bot — a Telegram bot for the team that posts and maintains the rental listing ads for Hive, a co-living operator. You are talking privately with the bot's admin.

What you do:
- The bot sits in the team's group chat. The portal automatically posts every inventory change there (new room, price/date/description change, room leaving inventory) so the team can update the listing ads. You do not send those yourself; they happen on their own.
- You answer questions about the current inventory using the get_inventory tool. Never answer inventory questions from memory or from earlier messages — always call the tool, the data changes. Quote figures exactly as the tool returned them; if the tool did not return something, say you don't have it rather than estimating.
- You only know the inventory: rooms, rent, availability, amenities, photos link, description, Facebook-ads flag and the listing action flag. You have no tenant, payment or other portal data, and you cannot change anything in the portal. If asked for anything else, say it is outside what you can do.

Listing action values: no_action, update_price_or_date, delete_listing, boost_post, priority (a priority listing).

Formatting: replies are sent with Telegram HTML. You may use <b>, <i>, <code> and plain line breaks; no Markdown, no other tags. Escape &, < and > in ordinary text. Keep replies short and scannable — this is a chat, not a report. Show money as $1,450 and dates like Dec 1.

Here the admin manages what is posted to the team group:
- Reminders: recurring or one-off messages posted to the group on a schedule. Use the reminder tools. All times are US Eastern. Turn what they ask into a schedule: "every weekday at 9am" is weekly with days [1,2,3,4,5]; "every other Monday" is interval with every_days 14 and start_date on the next Monday; "twice a day" is two reminders.
- Write the reminder message as the text the team will read in the group, addressed to the team. Stay close to the admin's own words; do not add facts, figures, room details or instructions they did not give.
- After any change the system itself appends a "Confirmed by the system" block with exactly what was saved, so keep your own confirmation to one short line and do not restate ids, times or schedules yourself.
- include: "open_actions" appends the live list of rooms still flagged for a listing action; "inventory" appends the full current inventory; "none" sends just the message. Pick the one that fits the reminder.
- If the request is ambiguous about time of day or which days, ask before creating it rather than guessing.
- To change or cancel, list the reminders first to get the id.
- send_to_group posts a message to the group right now. Only use it when the admin clearly asks you to post something now, and post their wording — do not put inventory figures into it yourself.
- Only claim something was created, changed, deleted or sent after the tool call for it succeeded.`;

function ok(data: unknown) {
  return JSON.stringify({ ok: true, ...((data as object) ?? {}) });
}
function fail(error: string) {
  return JSON.stringify({ ok: false, error });
}

function reminderView(r: ReminderRow) {
  return {
    id: r.id,
    message: r.message,
    schedule: describeSchedule(r.schedule),
    include: r.include,
    enabled: r.enabled,
    next_run_at_eastern: r.next_run_at ? easternStamp(new Date(r.next_run_at)) : null,
    last_run_at_eastern: r.last_run_at ? easternStamp(new Date(r.last_run_at)) : null,
    last_error: r.last_error,
  };
}

const INCLUDE_LABELS: Record<ReminderRow["include"], string | null> = {
  none: null,
  open_actions: "the live list of rooms flagged for a listing action",
  inventory: "the full current inventory",
};

/** What was actually saved, rendered from the row — never from the model. */
function reminderReceipt(verb: string, r: ReminderRow): string {
  const adds = INCLUDE_LABELS[r.include];
  return (
    `<b>Reminder #${r.id} ${verb}</b>${r.enabled ? "" : " — paused"}\n` +
    `${escapeHtml(describeSchedule(r.schedule))}\n` +
    (r.enabled && r.next_run_at
      ? `Next: ${escapeHtml(easternStamp(new Date(r.next_run_at)))} ET\n`
      : "") +
    `Text the team will see: “${escapeHtml(r.message)}”` +
    (adds ? `\nFollowed by ${adds}.` : "")
  );
}

function easternStamp(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: APP_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const scheduleShape = {
  kind: z
    .enum(["once", "daily", "weekly", "monthly", "interval"])
    .describe(
      "once = a single date; daily; weekly = on given weekdays; monthly = on a day of the month; interval = every N days",
    ),
  time: z.string().describe('Eastern time of day, 24-hour "HH:MM"'),
  date: z.string().optional().describe('once only: "YYYY-MM-DD"'),
  days: z
    .array(z.number())
    .optional()
    .describe("weekly only: weekdays, 0 = Sunday … 6 = Saturday"),
  day_of_month: z
    .number()
    .optional()
    .describe("monthly only: 1–31 (31 fires on the last day of shorter months)"),
  every_days: z.number().optional().describe("interval only: every N days"),
  start_date: z
    .string()
    .optional()
    .describe('interval only: first firing date "YYYY-MM-DD" (default today)'),
};

const includeSchema = z
  .enum(["none", "open_actions", "inventory"])
  .describe("Live data appended to the message when it fires");

function inventoryTool(db: BotDb) {
  return betaZodTool({
    name: "get_inventory",
    description:
      "The live inventory: every room currently listable (vacant now, or occupied with a scheduled move-out), with rent, availability date (null = available now), amenities, photos link, description, facebook_ads and listing_action.",
    inputSchema: z.object({}),
    run: async () => {
      try {
        const rooms = await fetchInventory(db);
        return ok({ as_of: todayISO(), count: rooms.length, rooms });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

function adminTools(db: BotDb, adminUserId: number, receipts: string[]) {
  return [
    betaZodTool({
      name: "list_reminders",
      description: "All group reminders with their ids, schedules and next firing time.",
      inputSchema: z.object({}),
      run: async () => {
        const { data, error } = await db
          .from("listing_bot_reminders")
          .select(REMINDER_COLUMNS)
          .order("id", { ascending: true })
          .returns<ReminderRow[]>();
        if (error) return fail(error.message);
        return ok({ reminders: (data ?? []).map(reminderView) });
      },
    }),
    betaZodTool({
      name: "create_reminder",
      description: "Create a reminder that is posted to the team group on a schedule.",
      inputSchema: z.object({
        message: z.string().describe("The text the team reads in the group"),
        include: includeSchema,
        ...scheduleShape,
      }),
      run: async ({ message, include, ...sched }) => {
        if (!message.trim()) return fail("message is empty");
        const parsed = parseSchedule(sched, todayISO());
        if (!parsed.ok) return fail(parsed.error);
        const next = nextRun(parsed.schedule, new Date());
        if (!next) return fail("that date and time is already in the past");
        const { data, error } = await db
          .from("listing_bot_reminders")
          .insert({
            message: message.trim(),
            schedule: parsed.schedule,
            include,
            next_run_at: next.toISOString(),
            created_by: adminUserId,
          })
          .select(REMINDER_COLUMNS)
          .single<ReminderRow>();
        if (error || !data) return fail(error?.message ?? "insert failed");
        receipts.push(reminderReceipt("created", data));
        const state = await getState(db);
        return ok({
          reminder: reminderView(data),
          ...(state.group_chat_id
            ? {}
            : {
                warning:
                  "No team group is linked yet, so this cannot post until the admin runs /setgroup in the group.",
              }),
        });
      },
    }),
    betaZodTool({
      name: "update_reminder",
      description:
        "Change a reminder's message, schedule, include, or pause/resume it (enabled). To change the schedule pass the full new schedule (kind + time + its fields).",
      inputSchema: z.object({
        id: z.number(),
        message: z.string().optional(),
        include: includeSchema.optional(),
        enabled: z.boolean().optional(),
        ...scheduleShape,
        kind: scheduleShape.kind.optional(),
        time: scheduleShape.time.optional(),
      }),
      run: async ({ id, message, include, enabled, kind, time, ...rest }) => {
        const { data: existing, error: readErr } = await db
          .from("listing_bot_reminders")
          .select(REMINDER_COLUMNS)
          .eq("id", id)
          .maybeSingle<ReminderRow>();
        if (readErr) return fail(readErr.message);
        if (!existing) return fail(`no reminder with id ${id}`);

        const patch: Record<string, unknown> = {};
        if (message !== undefined) {
          if (!message.trim()) return fail("message is empty");
          patch.message = message.trim();
        }
        if (include !== undefined) patch.include = include;

        let schedule = existing.schedule;
        if (kind !== undefined || time !== undefined) {
          if (!kind || !time) {
            return fail("to change the schedule pass both kind and time");
          }
          const parsed = parseSchedule({ kind, time, ...rest }, todayISO());
          if (!parsed.ok) return fail(parsed.error);
          schedule = parsed.schedule;
          patch.schedule = schedule;
        }

        const willBeEnabled = enabled ?? existing.enabled;
        if (patch.schedule !== undefined || enabled !== undefined) {
          const next = willBeEnabled ? nextRun(schedule, new Date()) : null;
          if (willBeEnabled && !next) {
            return fail("that schedule has no future firing time");
          }
          patch.enabled = willBeEnabled;
          patch.next_run_at = next?.toISOString() ?? null;
          patch.fail_count = 0;
        }
        if (Object.keys(patch).length === 0) return fail("nothing to change");

        const { data, error } = await db
          .from("listing_bot_reminders")
          .update(patch)
          .eq("id", id)
          .select(REMINDER_COLUMNS)
          .single<ReminderRow>();
        if (error || !data) return fail(error?.message ?? "update failed");
        receipts.push(reminderReceipt("updated", data));
        return ok({ reminder: reminderView(data) });
      },
    }),
    betaZodTool({
      name: "delete_reminder",
      description: "Permanently delete a reminder.",
      inputSchema: z.object({ id: z.number() }),
      run: async ({ id }) => {
        const { data, error } = await db
          .from("listing_bot_reminders")
          .delete()
          .eq("id", id)
          .select("id");
        if (error) return fail(error.message);
        if (!data || data.length === 0) return fail(`no reminder with id ${id}`);
        receipts.push(`<b>Reminder #${id} deleted</b>`);
        return ok({ deleted: id });
      },
    }),
    betaZodTool({
      name: "send_to_group",
      description:
        "Post to the team group right now: either a custom message, or an existing reminder exactly as it would fire (reminder_id) — useful to test one.",
      inputSchema: z.object({
        text: z.string().optional().describe("Message to post (Telegram HTML allowed)"),
        reminder_id: z.number().optional(),
      }),
      run: async ({ text, reminder_id }) => {
        const state = await getState(db);
        if (!state.group_chat_id) {
          return fail("no team group is linked — run /setgroup in the group first");
        }
        let body = text?.trim() ?? "";
        if (reminder_id !== undefined) {
          const { data: r } = await db
            .from("listing_bot_reminders")
            .select(REMINDER_COLUMNS)
            .eq("id", reminder_id)
            .maybeSingle<ReminderRow>();
          if (!r) return fail(`no reminder with id ${reminder_id}`);
          body = await reminderText(db, r);
        }
        if (!body) return fail("pass text or reminder_id");
        const sent = await botSend(state.group_chat_id, body);
        if (!sent) return fail("Telegram refused the message");
        receipts.push(
          `<b>Posted to ${escapeHtml(state.group_title ?? "the team group")}</b>` +
            (reminder_id !== undefined
              ? `\nReminder #${reminder_id}, as it would fire.`
              : `\n“${escapeHtml(body)}”`),
        );
        return ok({ sent_to: state.group_title });
      },
    }),
  ];
}

/**
 * Runs one admin turn. `receipts` lists every change that really happened
 * this turn (empty = nothing was changed, whatever the reply says).
 */
export async function runBotTurn(opts: {
  db: BotDb;
  userId: number;
  history: Turn[];
  userText: string;
}): Promise<{ reply: string; receipts: string[] }> {
  const { db, userId, history, userText } = opts;
  const receipts: string[] = [];
  const state = await getState(db);
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 5,
  });

  const context =
    `Current Eastern time: ${easternStamp(new Date())} (today is ${todayISO()}).\n` +
    (state.group_chat_id
      ? `Team group linked: "${state.group_title ?? "unnamed group"}".`
      : "No team group is linked yet. The admin must add you to the team group and send /setgroup there before anything can be posted.");

  const message = await client.beta.messages.toolRunner({
    model: "claude-opus-5",
    max_tokens: 8000,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: context },
    ],
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    tools: [inventoryTool(db), ...adminTools(db, userId, receipts)],
    messages: [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: userText },
    ],
  });

  const reply =
    message.stop_reason === "refusal"
      ? "Sorry — I can't help with that."
      : message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n\n")
          .trim();
  return { reply, receipts };
}
