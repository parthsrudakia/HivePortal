import { createClient } from "@/lib/supabase/server";
import { TabNotepadEditor } from "./tab-notepad-editor";
import type { NotepadTab } from "./notepad-actions";

/**
 * Shared per-tab notepad (Rent Tracker / Utilities / Inventory): one note
 * per tab, the same for every user. Server half — loads the note under the
 * session's RLS; the client editor handles collapse/edit/save.
 */
export async function TabNotepad({ tab }: { tab: NotepadTab }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tab_notes")
    .select("content, updated_at, updated_by")
    .eq("tab", tab)
    .maybeSingle();

  return (
    <TabNotepadEditor
      tab={tab}
      initialContent={data?.content ?? ""}
      initialUpdatedAt={data?.updated_at ?? null}
      initialUpdatedBy={data?.updated_by ?? null}
    />
  );
}
