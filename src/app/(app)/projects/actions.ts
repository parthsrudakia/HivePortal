"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/session";
import { isMaster } from "@/lib/access";
import { todayISO } from "@/lib/date";
import {
  boardAdmin,
  listBoardMembers,
  nextRecurringDateStr,
  recurringRolloverPatch,
  sendBoardEmail,
  formatBoardDate,
  type BoardStatus,
  type BoardTask,
} from "@/lib/board";
import { assertSection } from "@/lib/section-access";

export type BoardActionState = { error?: string; success?: string } | undefined;

async function caller() {
  const user = await getSessionUser();
  if (!user) throw new Error("Not signed in.");
  const meta = user.user_metadata;
  const name =
    (typeof meta.display_name === "string" && meta.display_name.trim()) ||
    (typeof meta.full_name === "string" && meta.full_name.trim()) ||
    user.email?.split("@")[0] ||
    "Someone";
  return { id: user.id, email: user.email ?? null, name, admin: isMaster(user.email) };
}

const tasks = () => boardAdmin().from("board_tasks");
const comments = () => boardAdmin().from("board_comments");

async function getTask(id: string): Promise<BoardTask> {
  const { data, error } = await tasks().select("*").eq("id", id).single();
  if (error || !data) throw new Error(error?.message ?? "Project not found.");
  return data as BoardTask;
}

const touch = () => ({ updated_at: new Date().toISOString() });

// ── Create ───────────────────────────────────────────────────────────────────

export async function createTask(
  _prev: BoardActionState,
  formData: FormData,
): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    const title = String(formData.get("title") ?? "").trim();
    if (!title) return { error: "Project title is required." };
    const description = String(formData.get("description") ?? "").trim() || null;
    const urgent = formData.get("urgent") === "on";
    const recurring = formData.get("recurring") === "on";
    const recurring_day = recurring
      ? Math.min(31, Math.max(1, Number(formData.get("recurring_day") || 1)))
      : null;
    // Members can only assign to themselves; the admin can assign anyone.
    const requested = String(formData.get("assigned_to") ?? "").trim();
    const assigned_to = me.admin && requested ? requested : me.id;
    const deadline = recurring
      ? nextRecurringDateStr(recurring_day!, todayISO(), true)
      : String(formData.get("deadline") ?? "").trim() || null;

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
    if (error) return { error: error.message };

    // Email the assignee when the admin created it for someone else.
    if (me.admin && assigned_to !== me.id) {
      const sb = boardAdmin();
      const members = await listBoardMembers(sb);
      await sendBoardEmail(sb, members, {
        toUserId: assigned_to,
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

    revalidatePath("/projects");
    return { success: "Project created." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create." };
  }
}

// ── Status flow ──────────────────────────────────────────────────────────────

export async function updateStatus(
  taskId: string,
  status: BoardStatus,
): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    const task = await getTask(taskId);

    if (!me.admin) {
      if (task.assigned_to !== me.id)
        return { error: "Not your project." };
      // Submitted tasks are locked until the admin reviews them.
      if (task.status === "pending_review")
        return { error: "Awaiting admin review." };
      const allowed: BoardStatus[] = task.recurring
        ? ["not started", "in progress", "completed"]
        : ["not started", "in progress", "pending_review"];
      if (!allowed.includes(status)) return { error: "Not allowed." };
    }

    if (status === "completed" && task.recurring) {
      // Recurring completion rolls to next month — no "completed" state.
      await tasks().update({ ...recurringRolloverPatch(task), ...touch() }).eq("id", taskId);
      revalidatePath("/projects");
      return { success: "Cycle complete! Rolled to next month." };
    }

    const { error } = await tasks().update({ status, ...touch() }).eq("id", taskId);
    if (error) return { error: error.message };

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

    revalidatePath("/projects");
    return undefined;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update." };
  }
}

export async function approveTask(taskId: string): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    if (!me.admin) return { error: "Admin only." };
    const task = await getTask(taskId);

    const patch = task.recurring
      ? recurringRolloverPatch(task)
      : { status: "completed" as BoardStatus };
    const { error } = await tasks().update({ ...patch, ...touch() }).eq("id", taskId);
    if (error) return { error: error.message };

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
    revalidatePath("/projects");
    return {
      success: task.recurring ? "Approved! Rolled to next month." : "Project approved!",
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to approve." };
  }
}

export async function rejectTask(
  taskId: string,
  reason: string,
): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    if (!me.admin) return { error: "Admin only." };
    const task = await getTask(taskId);

    const { error } = await tasks()
      .update({ status: "in progress", ...touch() })
      .eq("id", taskId);
    if (error) return { error: error.message };

    const trimmed = reason.trim();
    if (trimmed) {
      await comments().insert({
        task_id: taskId,
        author: me.id,
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
    revalidatePath("/projects");
    return { success: "Project sent back for revision." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reject." };
  }
}

// ── Flags, deadline, comments ────────────────────────────────────────────────

export async function toggleAttention(
  taskId: string,
  value: boolean,
): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    const task = await getTask(taskId);
    if (!me.admin && task.assigned_to !== me.id)
      return { error: "Not your project." };

    const { error } = await tasks()
      .update({ needs_attention: value, ...touch() })
      .eq("id", taskId);
    if (error) return { error: error.message };

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
    revalidatePath("/projects");
    return undefined;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update." };
  }
}

export async function updateDeadline(
  taskId: string,
  deadline: string | null,
): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    if (!me.admin) return { error: "Admin only." };
    const task = await getTask(taskId);
    if (task.recurring)
      return { error: "Recurring deadlines are managed automatically." };

    const { error } = await tasks()
      .update({ deadline, ...touch() })
      .eq("id", taskId);
    if (error) return { error: error.message };

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
    revalidatePath("/projects");
    return { success: deadline ? "Deadline updated." : "Deadline removed." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update." };
  }
}

export async function addComment(
  taskId: string,
  text: string,
): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    const trimmed = text.trim();
    if (!trimmed) return { error: "Comment is empty." };
    const task = await getTask(taskId);

    const { error } = await comments().insert({
      task_id: taskId,
      author: me.id,
      text: trimmed,
    });
    if (error) return { error: error.message };

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
    revalidatePath("/projects");
    return undefined;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to comment." };
  }
}

// ── Nudge / delete / bulk ────────────────────────────────────────────────────

export async function sendNudge(taskId: string): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    if (!me.admin) return { error: "Admin only." };
    const task = await getTask(taskId);
    if (task.status === "completed" || task.status === "pending_review")
      return { error: "Nothing to nudge — project isn't active." };
    if (!task.assigned_to) return { error: "No assignee to nudge." };

    // Max 2 nudges per project per day (ET).
    const today = todayISO();
    const todays = (task.nudge_history ?? []).filter(
      (ts) => ts.slice(0, 10) === today,
    );
    if (todays.length >= 2)
      return { error: "Already nudged twice today. Try again tomorrow." };

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

    revalidatePath("/projects");
    const member = members.find((m) => m.id === task.assigned_to);
    return { success: member ? `Nudge sent to ${member.name}!` : "Nudge sent!" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to nudge." };
  }
}

export async function deleteTask(taskId: string): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    if (!me.admin) return { error: "Admin only." };
    const { error } = await tasks().delete().eq("id", taskId);
    if (error) return { error: error.message };
    revalidatePath("/projects");
    return { success: "Project deleted." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to delete." };
  }
}

export async function clearCompleted(): Promise<BoardActionState> {
  await assertSection("projects");
  try {
    const me = await caller();
    if (!me.admin) return { error: "Admin only." };
    const { error } = await tasks().delete().eq("status", "completed");
    if (error) return { error: error.message };
    revalidatePath("/projects");
    return { success: "Completed projects cleared." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to clear." };
  }
}

export async function markSeen(taskId: string): Promise<void> {
  await assertSection("projects");
  try {
    const me = await caller();
    await tasks()
      .update({ seen_by_assignee: true })
      .eq("id", taskId)
      .eq("assigned_to", me.id);
  } catch {
    // best-effort
  }
}

// ── Settings: board email pref (lives on /settings) ────────────────────────

export async function setBoardEmailPref(enabled: boolean): Promise<BoardActionState> {
  try {
    const me = await caller();
    const { error } = await boardAdmin()
      .from("board_prefs")
      .upsert({ user_id: me.id, email_notifications: enabled }, { onConflict: "user_id" });
    if (error) return { error: error.message };
    revalidatePath("/settings");
    return { success: `Project email notifications ${enabled ? "enabled" : "disabled"}.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save." };
  }
}
