import { isMaster } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { boardAdmin, listBoardMembers, type BoardTask } from "@/lib/board";
import { ProjectsBoard, type BoardComment } from "./board";

export const dynamic = "force-dynamic";

export type TaskWithComments = BoardTask & { board_comments: BoardComment[] };

export default async function ProjectsPage() {
  const sb = boardAdmin();
  const [user, { data }, members] = await Promise.all([
    getSessionUser(),
    sb
      .from("board_tasks")
      .select(
        "*, board_comments(id, author, author_label, text, created_at)",
      )
      .order("created_at", { ascending: false })
      .order("created_at", {
        referencedTable: "board_comments",
        ascending: true,
      }),
    listBoardMembers(sb),
  ]);
  const admin = isMaster(user?.email);

  const tasks = (data ?? []) as TaskWithComments[];
  // Emails stay server-side; the client only needs names for display.
  const safeMembers = members.map((m) => ({
    id: m.id,
    name: m.name,
    isAdmin: m.isAdmin,
  }));

  return (
    <ProjectsBoard
      tasks={tasks}
      members={safeMembers}
      meId={user?.id ?? ""}
      admin={admin}
    />
  );
}
