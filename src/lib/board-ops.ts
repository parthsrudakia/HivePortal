/**
 * Projects board mutations — the single implementation behind both the
 * portal's server actions (src/app/(app)/projects/actions.ts) and the
 * Projects API (src/app/api/projects/**). Every rule (member vs admin
 * permissions, recurring rollover, review lock, nudge cap) and every
 * notification email lives here, so the two entry points can't drift.
 *
 * The caller is a BoardActor: a signed-in portal user, or the API (id null,
 * admin rights, comments labelled "API").
 */

import { revalidatePath } from "next/cache";
import { todayISO } from "./date";
import {
  boardAdmin,
  listBoardMembers,
  nextRecurringDateStr,
  recurringRolloverPatch,
  sendBoardEmail,
  formatBoardDate,
  type BoardStatus,
  type BoardTask,
} from "./board";

export type BoardActor = {
  /** Portal auth user id; null for the API. */
  id: string | null;
  name: string;
  admin: boolean;
};

export type BoardOpResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string; status: number };

const fail = (error: string, status = 400) =>
  ({ ok: false, error, status }) as const;

export const BOARD_STATUSES: BoardStatus[] = [
  "not started",
  "in progress",
  "pending_review",
  "completed",
];

const tasks = () => boardAdmin().from("board_tasks");
const comments = () => boardAdmin().from("board_comments");
const touch = () => ({ updated_at: new Date().toISOString() });
const refresh = () => revalidatePath("/projects");

export class BoardTaskNotFound extends Error {}

export async function getBoardTask(id: string): Promise<BoardTask> {
  const { data, error } = await tasks().select("*").eq("id", id).maybeSingle();
  if (error) {
    // 22P02: not a uuid — same as not found.
    if (error.code === "22P02") throw new BoardTaskNotFound("Project not found.");
    throw new Error(error.message);
  }
  if (!data) throw new BoardTaskNotFound("Project not found.");
  return data as BoardTask;
}

/** Load a task, turning not-found into a 404 result. */
async function load(
  id: string,
): Promise<{ task: BoardTask } | { ok: false; error: string; status: number }> {
  try {
    return { task: await getBoardTask(id) };
  } catch (e) {
    if (e instanceof BoardTaskNotFound) return fail(e.message, 404);
    throw e;
  }
}

// ── Create ───────────────────────────────────────────────────────────────────

export type CreateBoardTaskInput = {
  title: string;
  description?: string | null;
  urgent?: boolean;
  recurring?: boolean;
  recurring_day?: number | null;
  deadline?: string | null;
  assigned_to?: string | null;
};

export async function createBoardTask(
  me: BoardActor,
  input: CreateBoardTaskInput,
): Promise<BoardOpResult<BoardTask>> {
  const title = input.title.trim();
  if (!title) return fail("Project title is required.");
  const description = input.description?.trim() || null;
  const urgent = !!input.urgent;
  const recurring = !!input.recurring;
  const recurring_day = recurring
    ? Math.min(31, Math.max(1, Math.trunc(Number(input.recurring_day || 1))))
    : null;
  // Members can only assign to themselves; the admin can assign anyone.
  const requested = input.assigned_to?.trim() || null;
  const assigned_to = me.admin && requested ? requested : me.id;
  const deadline = recurring
    ? nextRecurringDateStr(recurring_day!, todayISO(), true)
    : input.deadline?.trim() || null;

  const needsEmail = !!assigned_to && assigned_to !== me.id && me.admin;
  const sb = boardAdmin();
  const members = needsEmail ? await listBoardMembers(sb) : [];
  if (needsEmail && !members.some((m) => m.id === assigned_to)) {
    return fail("assigned_to is not a portal user.");
  }

  const { data: created, error } = await tasks()
    .insert({
      title,
      description,
      status: "not started",
      urgent,
      recurring,
      recurring_day,
      deadline,
      assigned_to,
      seen_by_assignee: assigned_to === me.id,
    })
    .select("*")
    .single();
  if (error) return fail(error.message, 500);

  // Email the assignee when the admin created it for someone else.
  if (needsEmail) {
    await sendBoardEmail(sb, members, {
      toUserId: assigned_to!,
      subject: `New Project: ${title}`,
      badge: "New project",
      heading: title,
      lines: [
        ...(description ? [description] : []),
        `Status: Not Started · Deadline: ${formatBoardDate(created.deadline)}`,
      ],
      taskTitle: title,
    });
  }

  refresh();
  return { ok: true, message: "Project created.", data: created as BoardTask };
}

// ── Status flow ──────────────────────────────────────────────────────────────

export async function setBoardStatus(
  me: BoardActor,
  taskId: string,
  status: BoardStatus,
): Promise<BoardOpResult> {
  if (!BOARD_STATUSES.includes(status)) return fail("Unknown status.");
  const loaded = await load(taskId);
  if (!("task" in loaded)) return loaded;
  const { task } = loaded;

  if (!me.admin) {
    if (task.assigned_to !== me.id) return fail("Not your project.", 403);
    // Submitted tasks are locked until the admin reviews them.
    if (task.status === "pending_review")
      return fail("Awaiting admin review.", 409);
    const allowed: BoardStatus[] = task.recurring
      ? ["not started", "in progress", "completed"]
      : ["not started", "in progress", "pending_review"];
    if (!allowed.includes(status)) return fail("Not allowed.", 403);
  }

  if (status === "completed" && task.recurring) {
    // Recurring completion rolls to next month — no "completed" state.
    const { error } = await tasks()
      .update({ ...recurringRolloverPatch(task), ...touch() })
      .eq("id", taskId);
    if (error) return fail(error.message, 500);
    refresh();
    return { ok: true, message: "Cycle complete! Rolled to next month." };
  }

  const { error } = await tasks().update({ status, ...touch() }).eq("id", taskId);
  if (error) return fail(error.message, 500);

  // Member submitted for review → email the admin.
  if (status === "pending_review" && !me.admin) {
    const sb = boardAdmin();
    const members = await listBoardMembers(sb);
    const admin = members.find((m) => m.isAdmin);
    if (admin) {
      await sendBoardEmail(sb, members, {
        toUserId: admin.id,
        subject: `Pending Review: ${task.title}`,
        badge: "Pending review",
        heading: task.title,
        lines: [`${me.name} has submitted this project for your review.`],
        taskTitle: task.title,
      });
    }
  }

  refresh();
  return { ok: true };
}

export async function approveBoardTask(
  me: BoardActor,
  taskId: string,
): Promise<BoardOpResult> {
  if (!me.admin) return fail("Admin only.", 403);
  const loaded = await load(taskId);
  if (!("task" in loaded)) return loaded;
  const { task } = loaded;

  const patch = task.recurring
    ? recurringRolloverPatch(task)
    : { status: "completed" as BoardStatus };
  const { error } = await tasks().update({ ...patch, ...touch() }).eq("id", taskId);
  if (error) return fail(error.message, 500);

  if (task.assigned_to) {
    const sb = boardAdmin();
    await sendBoardEmail(sb, await listBoardMembers(sb), {
      toUserId: task.assigned_to,
      subject: `Project Approved: ${task.title}`,
      badge: "Approved",
      heading: task.title,
      lines: ["Great work! The project has been marked as completed."],
      taskTitle: task.title,
    });
  }
  refresh();
  return {
    ok: true,
    message: task.recurring ? "Approved! Rolled to next month." : "Project approved!",
  };
}

export async function rejectBoardTask(
  me: BoardActor,
  taskId: string,
  reason: string,
): Promise<BoardOpResult> {
  if (!me.admin) return fail("Admin only.", 403);
  const loaded = await load(taskId);
  if (!("task" in loaded)) return loaded;
  const { task } = loaded;

  const { error } = await tasks()
    .update({ status: "in progress", ...touch() })
    .eq("id", taskId);
  if (error) return fail(error.message, 500);

  const trimmed = reason.trim();
  if (trimmed) {
    await comments().insert({
      task_id: taskId,
      author: me.id,
      author_label: me.id ? null : me.name,
      text: `Review rejected: ${trimmed}`,
    });
  }
  if (task.assigned_to) {
    const sb = boardAdmin();
    await sendBoardEmail(sb, await listBoardMembers(sb), {
      toUserId: task.assigned_to,
      subject: `Revision Needed: ${task.title}`,
      badge: "Revision needed",
      heading: task.title,
      lines: [
        "This project was sent back for revision.",
        ...(trimmed ? [`Reason: ${trimmed}`] : []),
        "Please review the feedback and update your project.",
      ],
      taskTitle: task.title,
    });
  }
  refresh();
  return { ok: true, message: "Project sent back for revision." };
}

// ── Flags, deadline, comments ────────────────────────────────────────────────

export async function setBoardAttention(
  me: BoardActor,
  taskId: string,
  value: boolean,
): Promise<BoardOpResult> {
  const loaded = await load(taskId);
  if (!("task" in loaded)) return loaded;
  const { task } = loaded;
  if (!me.admin && task.assigned_to !== me.id)
    return fail("Not your project.", 403);

  const { error } = await tasks()
    .update({ needs_attention: value, ...touch() })
    .eq("id", taskId);
  if (error) return fail(error.message, 500);

  // Admin dismissing/flagging notifies the assignee; a member flagging is
  // surfaced by the badge and the Needs Attention view (matches hiveboard).
  if (me.admin && task.assigned_to && task.assigned_to !== me.id) {
    const sb = boardAdmin();
    await sendBoardEmail(sb, await listBoardMembers(sb), {
      toUserId: task.assigned_to,
      subject: `Project Updated: ${task.title}`,
      badge: "Updated",
      heading: task.title,
      lines: [
        value
          ? "Needs Attention: flagged for admin."
          : "Needs Attention: dismissed by admin.",
      ],
      taskTitle: task.title,
    });
  }
  refresh();
  return { ok: true };
}

export async function setBoardDeadline(
  me: BoardActor,
  taskId: string,
  deadline: string | null,
): Promise<BoardOpResult> {
  if (!me.admin) return fail("Admin only.", 403);
  const loaded = await load(taskId);
  if (!("task" in loaded)) return loaded;
  const { task } = loaded;
  if (task.recurring)
    return fail("Recurring deadlines are managed automatically.", 409);

  const { error } = await tasks()
    .update({ deadline, ...touch() })
    .eq("id", taskId);
  if (error) return fail(error.message, 500);

  if (task.assigned_to && task.assigned_to !== me.id) {
    const sb = boardAdmin();
    await sendBoardEmail(sb, await listBoardMembers(sb), {
      toUserId: task.assigned_to,
      subject: `Project Updated: ${task.title}`,
      badge: "Updated",
      heading: task.title,
      lines: [
        `Deadline: ${formatBoardDate(task.deadline)} → ${formatBoardDate(deadline)}`,
      ],
      taskTitle: task.title,
    });
  }
  refresh();
  return { ok: true, message: deadline ? "Deadline updated." : "Deadline removed." };
}

export async function addBoardComment(
  me: BoardActor,
  taskId: string,
  text: string,
): Promise<BoardOpResult<{ id: string; created_at: string }>> {
  const trimmed = text.trim();
  if (!trimmed) return fail("Comment is empty.");
  const loaded = await load(taskId);
  if (!("task" in loaded)) return loaded;
  const { task } = loaded;

  const { data, error } = await comments()
    .insert({
      task_id: taskId,
      author: me.id,
      author_label: me.id ? null : me.name,
      text: trimmed,
    })
    .select("id, created_at")
    .single();
  if (error) return fail(error.message, 500);

  // Admin comments notify the assignee (member comments notify no one).
  if (me.admin && task.assigned_to && task.assigned_to !== me.id) {
    const sb = boardAdmin();
    await sendBoardEmail(sb, await listBoardMembers(sb), {
      toUserId: task.assigned_to,
      subject: `New Comment on: ${task.title}`,
      badge: "New comment",
      heading: task.title,
      lines: [`${me.name} wrote:`, trimmed],
      taskTitle: task.title,
    });
  }
  refresh();
  return { ok: true, data };
}

// ── Nudge / delete / bulk ────────────────────────────────────────────────────

export async function nudgeBoardTask(
  me: BoardActor,
  taskId: string,
): Promise<BoardOpResult> {
  if (!me.admin) return fail("Admin only.", 403);
  const loaded = await load(taskId);
  if (!("task" in loaded)) return loaded;
  const { task } = loaded;
  if (task.status === "completed" || task.status === "pending_review")
    return fail("Nothing to nudge — project isn't active.", 409);
  if (!task.assigned_to) return fail("No assignee to nudge.", 409);

  // Max 2 nudges per project per day (ET).
  const today = todayISO();
  const todays = (task.nudge_history ?? []).filter(
    (ts) => ts.slice(0, 10) === today,
  );
  if (todays.length >= 2)
    return fail("Already nudged twice today. Try again tomorrow.", 429);

  const sb = boardAdmin();
  const members = await listBoardMembers(sb);
  await sendBoardEmail(sb, members, {
    toUserId: task.assigned_to,
    subject: `Reminder: ${task.title}`,
    badge: "Reminder",
    heading: task.title,
    lines: [
      "A friendly reminder from your admin to update the status of this project.",
      ...(task.deadline ? [`Deadline: ${formatBoardDate(task.deadline)}`] : []),
    ],
    taskTitle: task.title,
  });
  await tasks()
    .update({
      nudge_history: [...todays, new Date().toISOString()],
      ...touch(),
    })
    .eq("id", taskId);

  refresh();
  const member = members.find((m) => m.id === task.assigned_to);
  return { ok: true, message: member ? `Nudge sent to ${member.name}!` : "Nudge sent!" };
}

export async function deleteBoardTask(
  me: BoardActor,
  taskId: string,
): Promise<BoardOpResult> {
  if (!me.admin) return fail("Admin only.", 403);
  const { data, error } = await tasks().delete().eq("id", taskId).select("id");
  if (error) {
    if (error.code === "22P02") return fail("Project not found.", 404);
    return fail(error.message, 500);
  }
  if (!data?.length) return fail("Project not found.", 404);
  refresh();
  return { ok: true, message: "Project deleted." };
}

export async function clearCompletedBoardTasks(
  me: BoardActor,
): Promise<BoardOpResult> {
  if (!me.admin) return fail("Admin only.", 403);
  const { error } = await tasks().delete().eq("status", "completed");
  if (error) return fail(error.message, 500);
  refresh();
  return { ok: true, message: "Completed projects cleared." };
}
