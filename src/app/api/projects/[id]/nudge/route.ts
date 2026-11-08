/**
 * POST /api/projects/:id/nudge — email the assignee a reminder. Same cap as
 * the board: at most 2 nudges per task per (ET) day → 429 after that.
 * Bearer `PROJECTS_API_KEY`.
 */

import { nudgeBoardTask } from "@/lib/board-ops";
import { apiActor, jsonError, opResponse, requireProjectsKey, resolveTaskId } from "../../shared";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireProjectsKey(req);
  if (denied) return denied;
  const id = await resolveTaskId((await params).id);
  if (!id) return jsonError("project not found", 404);
  return opResponse(await nudgeBoardTask(apiActor(), id), { id });
}
