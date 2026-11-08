/**
 * Shared plumbing for the Projects API (`/api/projects/**`): bearer auth
 * (`PROJECTS_API_KEY`), the API actor, task lookup by uuid or `seq`, and
 * the JSON shape tasks are returned in.
 *
 * The API acts as the board ADMIN: it can create/assign, approve/reject,
 * nudge, set deadlines and delete. All rules and notification emails come
 * from @/lib/board-ops — the same code the portal's board UI runs — so an
 * API call behaves exactly like the admin doing it by hand. Comments it
 * writes carry author null + author_label (default "API").
 *
 * Docs: /developers#projects — keep in sync when this changes.
 */

import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import {
  boardAdmin,
  listBoardMembers,
  type BoardMember,
  type BoardTask,
} from "@/lib/board";
import type { BoardActor, BoardOpResult } from "@/lib/board-ops";

export const requireProjectsKey = (req: Request) =>
  requireBearer(req, "PROJECTS_API_KEY");

export function apiActor(label?: string | null): BoardActor {
  const name = label?.trim().slice(0, 60) || "API";
  return { id: null, name, admin: true };
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const jsonError = (error: string, status: number) =>
  NextResponse.json({ error }, { status });

/** Map a board-ops result to a response; `ok` bodies get `extra` merged in. */
export function opResponse(
  r: BoardOpResult<unknown>,
  extra: Record<string, unknown> = {},
  okStatus = 200,
) {
  if (!r.ok) return jsonError(r.error, r.status);
  return NextResponse.json(
    { ok: true, ...(r.message ? { message: r.message } : {}), ...extra },
    { status: okStatus },
  );
}

/** Parse a JSON body; null when it isn't a JSON object. */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Resolve `[id]` to a task uuid. Accepts the uuid itself or the task's
 * numeric `seq` (the "#12" shown on the board). Null when not found.
 */
export async function resolveTaskId(raw: string): Promise<string | null> {
  const sb = boardAdmin();
  if (UUID_RE.test(raw)) {
    const { data, error } = await sb.from("board_tasks").select("id").eq("id", raw).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.id ?? null;
  }
  const seq = raw.replace(/^#/, "");
  if (!/^\d+$/.test(seq)) return null;
  const { data, error } = await sb.from("board_tasks").select("id").eq("seq", Number(seq)).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}

type CommentRow = {
  id: string;
  author: string | null;
  author_label: string | null;
  text: string;
  created_at: string;
};

export type TaskRow = BoardTask & { board_comments?: CommentRow[] };

export const TASK_SELECT_WITH_COMMENTS =
  "*, board_comments(id, author, author_label, text, created_at)";

export async function membersById(): Promise<Map<string, BoardMember>> {
  return new Map((await listBoardMembers()).map((m) => [m.id, m]));
}

/** Public JSON shape of a task. Member emails are never exposed. */
export function serializeTask(
  t: TaskRow,
  members: Map<string, BoardMember>,
  today: string,
) {
  const who = (id: string | null, label: string | null) =>
    id ? (members.get(id)?.name ?? label ?? "Former user") : (label ?? null);
  return {
    id: t.id,
    seq: t.seq,
    title: t.title,
    description: t.description,
    status: t.status,
    urgent: t.urgent,
    needs_attention: t.needs_attention,
    recurring: t.recurring,
    recurring_day: t.recurring_day,
    deadline: t.deadline,
    overdue:
      !!t.deadline && t.deadline < today && t.status !== "completed",
    assignee: t.assigned_to
      ? { id: t.assigned_to, name: who(t.assigned_to, t.assigned_label) }
      : null,
    last_completed_month: t.last_completed_month,
    missed_months: t.missed_months ?? [],
    created_at: t.created_at,
    updated_at: t.updated_at,
    ...(t.board_comments
      ? {
          comments: [...t.board_comments]
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map((c) => ({
              id: c.id,
              author: who(c.author, c.author_label),
              text: c.text,
              created_at: c.created_at,
            })),
        }
      : {}),
  };
}
