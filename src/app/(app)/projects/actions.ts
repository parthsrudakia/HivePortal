"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/session";
import { isMaster } from "@/lib/access";
import { boardAdmin, type BoardStatus } from "@/lib/board";
import {
  addBoardComment,
  approveBoardTask,
  clearCompletedBoardTasks,
  createBoardTask,
  deleteBoardTask,
  nudgeBoardTask,
  rejectBoardTask,
  setBoardAttention,
  setBoardDeadline,
  setBoardStatus,
  type BoardActor,
  type BoardOpResult,
} from "@/lib/board-ops";
import { assertSection } from "@/lib/section-access";

// Rules and notification emails live in @/lib/board-ops, shared with the
// Projects API (src/app/api/projects/**). These actions only resolve the
// signed-in caller and adapt results to the board UI's state shape.

export type BoardActionState = { error?: string; success?: string } | undefined;

async function caller(): Promise<BoardActor & { id: string }> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not signed in.");
  const meta = user.user_metadata;
  const name =
    (typeof meta.display_name === "string" && meta.display_name.trim()) ||
    (typeof meta.full_name === "string" && meta.full_name.trim()) ||
    user.email?.split("@")[0] ||
    "Someone";
  return { id: user.id, name, admin: isMaster(user.email) };
}

/** Run an op as the signed-in user and map it to BoardActionState. */
async function run(
  op: (me: BoardActor) => Promise<BoardOpResult<unknown>>,
  fallback: string,
): Promise<BoardActionState> {
  try {
    const r = await op(await caller());
    if (!r.ok) return { error: r.error };
    return r.message ? { success: r.message } : undefined;
  } catch (e) {
    return { error: e instanceof Error ? e.message : fallback };
  }
}

export async function createTask(
  _prev: BoardActionState,
  formData: FormData,
): Promise<BoardActionState> {
  await assertSection("projects");
  return run(
    (me) =>
      createBoardTask(me, {
        title: String(formData.get("title") ?? ""),
        description: String(formData.get("description") ?? ""),
        urgent: formData.get("urgent") === "on",
        recurring: formData.get("recurring") === "on",
        recurring_day: Number(formData.get("recurring_day") || 1),
        deadline: String(formData.get("deadline") ?? ""),
        assigned_to: String(formData.get("assigned_to") ?? ""),
      }),
    "Failed to create.",
  );
}

export async function updateStatus(
  taskId: string,
  status: BoardStatus,
): Promise<BoardActionState> {
  await assertSection("projects");
  return run((me) => setBoardStatus(me, taskId, status), "Failed to update.");
}

export async function approveTask(taskId: string): Promise<BoardActionState> {
  await assertSection("projects");
  return run((me) => approveBoardTask(me, taskId), "Failed to approve.");
}

export async function rejectTask(
  taskId: string,
  reason: string,
): Promise<BoardActionState> {
  await assertSection("projects");
  return run((me) => rejectBoardTask(me, taskId, reason), "Failed to reject.");
}

export async function toggleAttention(
  taskId: string,
  value: boolean,
): Promise<BoardActionState> {
  await assertSection("projects");
  return run((me) => setBoardAttention(me, taskId, value), "Failed to update.");
}

export async function updateDeadline(
  taskId: string,
  deadline: string | null,
): Promise<BoardActionState> {
  await assertSection("projects");
  return run((me) => setBoardDeadline(me, taskId, deadline), "Failed to update.");
}

export async function addComment(
  taskId: string,
  text: string,
): Promise<BoardActionState> {
  await assertSection("projects");
  return run((me) => addBoardComment(me, taskId, text), "Failed to comment.");
}

export async function sendNudge(taskId: string): Promise<BoardActionState> {
  await assertSection("projects");
  return run((me) => nudgeBoardTask(me, taskId), "Failed to nudge.");
}

export async function deleteTask(taskId: string): Promise<BoardActionState> {
  await assertSection("projects");
  return run((me) => deleteBoardTask(me, taskId), "Failed to delete.");
}

export async function clearCompleted(): Promise<BoardActionState> {
  await assertSection("projects");
  return run((me) => clearCompletedBoardTasks(me), "Failed to clear.");
}

export async function markSeen(taskId: string): Promise<void> {
  await assertSection("projects");
  try {
    const me = await caller();
    await boardAdmin()
      .from("board_tasks")
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
