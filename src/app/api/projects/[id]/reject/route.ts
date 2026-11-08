/**
 * POST /api/projects/:id/reject — { reason? }. Sends a task back to
 * "in progress", records the reason as a comment, and emails the assignee.
 * Bearer `PROJECTS_API_KEY`.
 */

import { z } from "zod";
import { rejectBoardTask } from "@/lib/board-ops";
import {
  apiActor,
  jsonError,
  opResponse,
  readJson,
  requireProjectsKey,
  resolveTaskId,
} from "../../shared";

export const dynamic = "force-dynamic";

const Body = z.object({ reason: z.string().max(10000).optional() }).strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireProjectsKey(req);
  if (denied) return denied;
  const id = await resolveTaskId((await params).id);
  if (!id) return jsonError("project not found", 404);

  // Body is optional here: an empty request means "reject without a reason".
  const parsed = Body.safeParse((await readJson(req)) ?? {});
  if (!parsed.success) {
    return jsonError(parsed.error.issues.map((i) => i.message).join("; "), 400);
  }
  return opResponse(
    await rejectBoardTask(apiActor(), id, parsed.data.reason ?? ""),
    { id },
  );
}
