/**
 * Projects API — `GET /api/projects` (list) and `POST /api/projects`
 * (create). Bearer `PROJECTS_API_KEY`; acts as the board admin. See
 * ./shared.ts for the model and /developers#projects for the docs.
 *
 * GET query params (combine freely):
 *   ?status=       not started | in progress | pending_review | completed
 *                  (comma-separate several)
 *   ?assigned_to=  portal user id
 *   ?urgent=true / ?needs_attention=true / ?overdue=true
 *   ?q=            case-insensitive substring over title and description
 *   ?include=comments  embed each task's comments
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { boardAdmin, type BoardStatus } from "@/lib/board";
import { BOARD_STATUSES, createBoardTask } from "@/lib/board-ops";
import { todayISO } from "@/lib/date";
import {
  apiActor,
  DATE_RE,
  jsonError,
  membersById,
  opResponse,
  readJson,
  requireProjectsKey,
  serializeTask,
  TASK_SELECT_WITH_COMMENTS,
  UUID_RE,
  type TaskRow,
} from "./shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireProjectsKey(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const p = url.searchParams;
  const statuses = (p.get("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = statuses.find((s) => !BOARD_STATUSES.includes(s as BoardStatus));
  if (bad) {
    return jsonError(
      `status must be one of: ${BOARD_STATUSES.join(", ")}`,
      400,
    );
  }
  const assignedTo = p.get("assigned_to");
  if (assignedTo && !UUID_RE.test(assignedTo)) {
    return jsonError("assigned_to must be a user id (uuid)", 400);
  }
  const withComments = (p.get("include") ?? "").split(",").includes("comments");
  const q = (p.get("q") ?? "").trim().toLowerCase();
  const flag = (k: string) => p.get(k) === "true";

  let query = boardAdmin()
    .from("board_tasks")
    .select(withComments ? TASK_SELECT_WITH_COMMENTS : "*")
    .order("created_at", { ascending: false });
  if (statuses.length) query = query.in("status", statuses);
  if (assignedTo) query = query.eq("assigned_to", assignedTo);
  if (flag("urgent")) query = query.eq("urgent", true);
  if (flag("needs_attention")) query = query.eq("needs_attention", true);

  const [{ data, error }, members] = await Promise.all([
    query.returns<TaskRow[]>(),
    membersById(),
  ]);
  if (error) return jsonError(error.message, 500);

  const today = todayISO();
  const tasks = (data ?? [])
    .map((t) => serializeTask(t, members, today))
    .filter((t) => !flag("overdue") || t.overdue)
    .filter(
      (t) =>
        !q ||
        t.title.toLowerCase().includes(q) ||
        (t.description ?? "").toLowerCase().includes(q),
    );

  return NextResponse.json({ as_of: today, count: tasks.length, tasks });
}

const CreateBody = z
  .object({
    title: z.string().trim().min(1, "title is required").max(300),
    description: z.string().max(10000).nullish(),
    urgent: z.boolean().optional(),
    recurring: z.boolean().optional(),
    recurring_day: z.number().int().min(1).max(31).nullish(),
    deadline: z.string().regex(DATE_RE, "deadline must be YYYY-MM-DD").nullish(),
    assigned_to: z.string().regex(UUID_RE, "assigned_to must be a user id (uuid)").nullish(),
  })
  .strict()
  .refine((b) => !b.recurring || b.recurring_day != null, {
    message: "recurring_day (1–31) is required when recurring is true",
  });

export async function POST(req: Request) {
  const denied = requireProjectsKey(req);
  if (denied) return denied;

  const body = await readJson(req);
  if (!body) return jsonError("body must be a JSON object", 400);
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues.map((i) => i.message).join("; "), 400);
  }

  const r = await createBoardTask(apiActor(), parsed.data);
  if (!r.ok || !r.data) return opResponse(r);
  const members = await membersById();
  return opResponse(
    r,
    { task: serializeTask(r.data, members, todayISO()) },
    201,
  );
}
