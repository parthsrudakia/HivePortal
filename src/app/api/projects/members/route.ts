/**
 * GET /api/projects/members — portal users who can be assigned projects
 * (id, name, is_admin). Use an id as `assigned_to` when creating a task.
 * Emails are deliberately not returned. Bearer `PROJECTS_API_KEY`.
 */

import { NextResponse } from "next/server";
import { listBoardMembers } from "@/lib/board";
import { requireProjectsKey } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireProjectsKey(req);
  if (denied) return denied;
  const members = (await listBoardMembers())
    .map((m) => ({ id: m.id, name: m.name, is_admin: m.isAdmin }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ count: members.length, members });
}
