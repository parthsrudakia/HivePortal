/**
 * Projects API — one task, by uuid or seq.
 *   GET    /api/projects/:id   task + comments
 *   PATCH  /api/projects/:id   { status?, needs_attention?, deadline? }
 *   DELETE /api/projects/:id
 * Bearer `PROJECTS_API_KEY`; acts as the board admin (see ../shared.ts).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { boardAdmin } from "@/lib/board";
import {
  BOARD_STATUSES,
  deleteBoardTask,
  getBoardTask,
  setBoardAttention,
  setBoardDeadline,
  setBoardStatus,
} from "@/lib/board-ops";
import { todayISO } from "@/lib/date";
import {
  apiActor,
  DATE_RE,
  jsonError,
  membersById,
  readJson,
  requireProjectsKey,
  resolveTaskId,
  serializeTask,
  TASK_SELECT_WITH_COMMENTS,
  type TaskRow,
} from "../shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function respondWithTask(id: string, extra: Record<string, unknown> = {}) {
  const [{ data, error }, members] = await Promise.all([
    boardAdmin()
      .from("board_tasks")
      .select(TASK_SELECT_WITH_COMMENTS)
      .eq("id", id)
      .maybeSingle<TaskRow>(),
    membersById(),
  ]);
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("project not found", 404);
  return NextResponse.json({ ...extra, task: serializeTask(data, members, todayISO()) });
}

export async function GET(req: Request, { params }: Ctx) {
  const denied = requireProjectsKey(req);
  if (denied) return denied;
  const id = await resolveTaskId((await params).id);
  if (!id) return jsonError("project not found", 404);
  return respondWithTask(id);
}

const PatchBody = z
  .object({
    status: z.enum(BOARD_STATUSES as [string, ...string[]]).optional(),
    needs_attention: z.boolean().optional(),
    deadline: z.string().regex(DATE_RE, "deadline must be YYYY-MM-DD").nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: "send at least one of: status, needs_attention, deadline",
  });

export async function PATCH(req: Request, { params }: Ctx) {
  const denied = requireProjectsKey(req);
  if (denied) return denied;
  const id = await resolveTaskId((await params).id);
  if (!id) return jsonError("project not found", 404);

  const body = await readJson(req);
  if (!body) return jsonError("body must be a JSON object", 400);
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues.map((i) => i.message).join("; "), 400);
  }
  const patch = parsed.data;

  // Reject up front what would fail midway, so a PATCH never half-applies
  // on a rule violation.
  if (patch.deadline !== undefined && (await getBoardTask(id)).recurring) {
    return jsonError("Recurring deadlines are managed automatically.", 409);
  }

  const me = apiActor();
  const messages: string[] = [];
  // Deadline first: a status of "completed" on a recurring task rolls the
  // deadline itself, and status goes last so it wins.
  if (patch.deadline !== undefined) {
    const r = await setBoardDeadline(me, id, patch.deadline);
    if (!r.ok) return jsonError(r.error, r.status);
    if (r.message) messages.push(r.message);
  }
  if (patch.needs_attention !== undefined) {
    const r = await setBoardAttention(me, id, patch.needs_attention);
    if (!r.ok) return jsonError(r.error, r.status);
  }
  if (patch.status !== undefined) {
    const r = await setBoardStatus(me, id, patch.status as (typeof BOARD_STATUSES)[number]);
    if (!r.ok) return jsonError(r.error, r.status);
    if (r.message) messages.push(r.message);
  }

  return respondWithTask(id, {
    ok: true,
    ...(messages.length ? { message: messages.join(" ") } : {}),
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const denied = requireProjectsKey(req);
  if (denied) return denied;
  const id = await resolveTaskId((await params).id);
  if (!id) return jsonError("project not found", 404);
  const r = await deleteBoardTask(apiActor(), id);
  if (!r.ok) return jsonError(r.error, r.status);
  return NextResponse.json({ ok: true, message: r.message, id });
}
