/**
 * POST /api/projects/:id/approve — approve a task (normally one in
 * pending_review). Non-recurring → completed; recurring → rolls to next
 * month. Emails the assignee. Bearer `PROJECTS_API_KEY`.
 */

import { approveBoardTask } from "@/lib/board-ops";
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
  return opResponse(await approveBoardTask(apiActor(), id), { id });
}
