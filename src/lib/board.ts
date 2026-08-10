/**
 * Projects board domain logic + notifications — the portal port of the
 * standalone hiveboard app. Tasks live in board_tasks/board_comments (portal
 * Supabase project, portal auth users as assignees). "Admin" is the master
 * operator (isMaster); every other portal user is a member.
 *
 * Notifications are email-only (the old app's browser push is not ported)
 * and flow through sendViaResend, so they respect the Resend quota, land in
 * email_log, and queue when over cap. Unlike the old app — which only
 * honored the pref for one event — a recipient's board_prefs
 * .email_notifications gates EVERY board email to them.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/types";
import { sendViaResend } from "./resend-quota";
import { isMaster } from "./access";
import { todayISO } from "./date";

export type BoardStatus =
  | "not started"
  | "in progress"
  | "pending_review"
  | "completed";

export type BoardTask = {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  status: BoardStatus;
  urgent: boolean;
  needs_attention: boolean;
  recurring: boolean;
  recurring_day: number | null;
  deadline: string | null;
  assigned_to: string | null;
  assigned_label: string | null;
  last_completed_month: string | null;
  missed_months: string[];
  nudge_history: string[];
  seen_by_assignee: boolean;
  created_at: string;
  updated_at: string;
};

export type BoardMember = {
  id: string;
  name: string;
  email: string | null;
  isAdmin: boolean;
};

export function boardAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** All portal users as board members (admin = master operator). */
export async function listBoardMembers(
  sb?: SupabaseClient,
): Promise<BoardMember[]> {
  const client = sb ?? boardAdmin();
  const { data, error } = await client.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error) throw new Error(error.message);
  return (data?.users ?? []).map((u) => {
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      (typeof meta.display_name === "string" && meta.display_name.trim()) ||
      (typeof meta.full_name === "string" && meta.full_name.trim()) ||
      u.email?.split("@")[0] ||
      u.id.slice(0, 8);
    return {
      id: u.id,
      name,
      email: u.email ?? null,
      isAdmin: isMaster(u.email),
    };
  });
}

// ── Recurring deadlines ──────────────────────────────────────────────────────

function lastDayOfMonth(year: number, monthIdx0: number): number {
  return new Date(Date.UTC(year, monthIdx0 + 1, 0)).getUTCDate();
}

/**
 * Next occurrence of a monthly recurring day, relative to a reference date
 * ("YYYY-MM-DD"). Clamps to shorter months (day 31 → Feb 28). When
 * includeRef is true the reference date itself qualifies.
 */
export function nextRecurringDateStr(
  day: number,
  refDateStr: string,
  includeRef: boolean,
): string {
  const [y, m, d] = refDateStr.slice(0, 10).split("-").map(Number);
  const inMonth = Math.min(day, lastDayOfMonth(y, m - 1));
  const qualifies = includeRef ? inMonth >= d : inMonth > d;
  if (qualifies) {
    return `${y}-${String(m).padStart(2, "0")}-${String(inMonth).padStart(2, "0")}`;
  }
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const nd = Math.min(day, lastDayOfMonth(ny, nm - 1));
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/**
 * Completing (or approving) a recurring task never lands on "completed":
 * the deadline rolls to next month's occurrence, the finished cycle is
 * recorded, and status returns to "not started".
 */
export function recurringRolloverPatch(task: {
  recurring_day: number | null;
  deadline: string | null;
}): { deadline: string; last_completed_month: string | null; status: BoardStatus } {
  const ref = task.deadline ?? todayISO();
  return {
    deadline: nextRecurringDateStr(task.recurring_day ?? 1, ref, false),
    last_completed_month: task.deadline ? task.deadline.slice(0, 7) : null,
    status: "not started",
  };
}

// ── Email notifications ──────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function boardHtml(badge: string, title: string, bodyHtml: string): string {
  return `
<div style="background:#f5f2ed;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#1a1a18">
  <div style="max-width:540px;margin:0 auto;background:#fefdfb;border:1px solid #e8e3db;border-radius:12px;overflow:hidden">
    <div style="padding:18px 26px;border-bottom:1px solid #e8e3db;font-size:16px;font-weight:600">
      Hive <span style="color:#9a6f08">Projects</span>
    </div>
    <div style="padding:26px">
      <div style="display:inline-block;background:#d4920b1a;color:#9a6f08;border:1px solid #d4920b40;border-radius:99px;padding:3px 12px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase">${esc(badge)}</div>
      <h2 style="margin:14px 0 6px;font-size:19px;line-height:1.3">${esc(title)}</h2>
      ${bodyHtml}
      <p style="margin-top:22px;font-size:12px;color:#8a8378">Open the Hive Portal → Projects tab to view details.</p>
    </div>
  </div>
</div>`;
}

async function boardEmailAllowed(
  sb: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data } = await sb
    .from("board_prefs")
    .select("email_notifications")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.email_notifications !== false; // default on
}

export type BoardEmail = {
  toUserId: string;
  subject: string;
  heading: string;
  badge: string;
  lines: string[]; // plain paragraphs; rendered into both text and html
  taskTitle: string;
};

/**
 * Send one board email to a portal user, honoring their board pref. Silent
 * no-op when the user has no email or has notifications off.
 */
export async function sendBoardEmail(
  sb: SupabaseClient,
  members: BoardMember[],
  mail: BoardEmail,
): Promise<void> {
  const recipient = members.find((m) => m.id === mail.toUserId);
  if (!recipient?.email) return;
  if (!(await boardEmailAllowed(sb, mail.toUserId))) return;

  const from = process.env.RESEND_FROM || "onboarding@resend.dev";
  const text = [mail.heading, "", ...mail.lines].join("\n");
  const html = boardHtml(
    mail.badge,
    mail.heading,
    mail.lines.map((l) => `<p style="font-size:14px;line-height:1.6;color:#5b564c">${esc(l)}</p>`).join(""),
  );
  await sendViaResend(
    {
      to: recipient.email,
      from,
      replyTo: process.env.RESEND_REPLY_TO,
      subject: mail.subject,
      text,
      html,
    },
    { type: "board", context: `board · ${mail.taskTitle}` },
  );
}

export function formatBoardDate(iso: string | null): string {
  if (!iso) return "None set";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── Daily cron: recurring rollover + deadline reminders ─────────────────────

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Runs once from the daily cron:
 *  1. Rolls forward recurring tasks whose deadline passed uncompleted,
 *     appending the missed "YYYY-MM" cycle (skips tasks sitting in review).
 *  2. Emails each assignee ONE digest covering all of their tasks due
 *     tomorrow or overdue — never one email per task (recurring tasks only
 *     get the "tomorrow" variant — rollover handles overdue).
 * No dedup needed: overdue reminders intentionally repeat daily, and the
 * cron runs once per day.
 */
export async function processBoardDeadlines(
  sb: SupabaseClient<Database>,
): Promise<{ rolled: number; remindersSent: number }> {
  const today = todayISO();
  const tomorrow = addDaysISO(today, 1);

  const tasksTable = () => sb.from("board_tasks");

  // 1. Roll expired recurring cycles.
  const { data: expired } = await tasksTable()
    .select("id, deadline, recurring_day, last_completed_month, missed_months")
    .eq("recurring", true)
    .lt("deadline", today)
    .neq("status", "pending_review");
  let rolled = 0;
  for (const t of expired ?? []) {
    if (!t.deadline) continue; // .lt("deadline", …) already excludes nulls
    const cycleMonth = t.deadline.slice(0, 7);
    const missed: string[] = t.missed_months ?? [];
    const wasCompleted = t.last_completed_month === cycleMonth;
    const newMissed =
      wasCompleted || missed.includes(cycleMonth)
        ? missed
        : [...missed, cycleMonth];
    await tasksTable()
      .update({
        deadline: nextRecurringDateStr(t.recurring_day ?? 1, t.deadline, false),
        status: "not started",
        missed_months: newMissed,
        updated_at: new Date().toISOString(),
      })
      .eq("id", t.id);
    rolled++;
  }

  // 2. Reminders: due tomorrow, or overdue (non-recurring only).
  const { data: due } = await tasksTable()
    .select("*")
    .neq("status", "completed")
    .not("deadline", "is", null)
    .or(`deadline.eq.${tomorrow},deadline.lt.${today}`);
  const dueTasks = (due ?? []) as BoardTask[];
  if (dueTasks.length === 0) return { rolled, remindersSent: 0 };

  const members = await listBoardMembers(sb);

  // One digest per assignee: every task due tomorrow or overdue lands in a
  // single email, never one email per task.
  const byAssignee = new Map<string, BoardTask[]>();
  for (const t of dueTasks) {
    if (!t.assigned_to) continue;
    const isOverdue = t.deadline! < today;
    if (isOverdue && t.recurring) continue; // rollover already handled these
    if (!byAssignee.has(t.assigned_to)) byAssignee.set(t.assigned_to, []);
    byAssignee.get(t.assigned_to)!.push(t);
  }

  const daysOverdue = (t: BoardTask) =>
    Math.round(
      (Date.parse(`${today}T00:00:00Z`) -
        Date.parse(`${t.deadline}T00:00:00Z`)) /
        86400000,
    );

  let remindersSent = 0;
  for (const [userId, tasks] of byAssignee) {
    const overdue = tasks
      .filter((t) => t.deadline! < today)
      .sort((a, b) => a.deadline!.localeCompare(b.deadline!));
    const dueTomorrow = tasks.filter((t) => t.deadline! >= today);

    const lines: string[] = [];
    for (const t of overdue) {
      const days = daysOverdue(t);
      lines.push(
        `Overdue — ${t.title}: was due ${formatBoardDate(t.deadline)}, ${days} day${days === 1 ? "" : "s"} past.`,
      );
    }
    for (const t of dueTomorrow) {
      lines.push(`Due tomorrow — ${t.title}: ${formatBoardDate(t.deadline)}.`);
    }
    lines.push(
      overdue.length > 0
        ? "Please complete these projects or update their status."
        : "Please update your progress.",
    );

    const parts = [
      overdue.length > 0
        ? `${overdue.length} overdue`
        : null,
      dueTomorrow.length > 0
        ? `${dueTomorrow.length} due tomorrow`
        : null,
    ].filter(Boolean);

    await sendBoardEmail(sb, members, {
      toUserId: userId,
      subject: `Project deadlines: ${parts.join(", ")}`,
      badge: "Daily reminders",
      heading: `Your project deadline${tasks.length === 1 ? "" : "s"}`,
      lines,
      taskTitle: `daily digest (${tasks.length} task${tasks.length === 1 ? "" : "s"})`,
    });
    remindersSent++;
  }
  return { rolled, remindersSent };
}
