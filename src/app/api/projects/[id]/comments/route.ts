/**
 * POST /api/projects/:id/comments — { text, author? }. `author` is a display
 * label (default "API", max 60 chars); the assignee gets the same
 * "New comment" email an admin comment sends. Bearer `PROJECTS_API_KEY`.
 */

import { z } from "zod";
import { addBoardComment } from "@/lib/board-ops";
import {
  apiActor,
  jsonError,
  opResponse,
  readJson,
  requireProjectsKey,
  resolveTaskId,
} from "../../shared";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    text: z.string().trim().min(1, "text is required").max(10000),
    author: z.string().max(60).optional(),
  })
  .strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireProjectsKey(req);
  if (denied) return denied;
  const id = await resolveTaskId((await params).id);
  if (!id) return jsonError("project not found", 404);

  const body = await readJson(req);
  if (!body) return jsonError("body must be a JSON object", 400);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues.map((i) => i.message).join("; "), 400);
  }

  const me = apiActor(parsed.data.author);
  const r = await addBoardComment(me, id, parsed.data.text);
  return opResponse(
    r,
    r.ok && r.data
      ? {
          comment: {
            id: r.data.id,
            author: me.name,
            text: parsed.data.text.trim(),
            created_at: r.data.created_at,
          },
        }
      : {},
    201,
  );
}
