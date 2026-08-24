"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";

// One shared note per portal tab — every user reads and writes the same
// note (last write wins). Keys must match the tab_notes CHECK constraint.
const TABS = ["tenants", "utilities", "inventory"] as const;
export type NotepadTab = (typeof TABS)[number];

const MAX_NOTE_CHARS = 20000;

export type SaveNoteResult = {
  error?: string;
  updatedAt?: string;
  updatedBy?: string | null;
};

export async function saveTabNote(
  tab: string,
  content: string,
): Promise<SaveNoteResult> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!(TABS as readonly string[]).includes(tab))
    return { error: "Unknown notepad." };
  if (typeof content !== "string")
    return { error: "Invalid note content." };
  if (content.length > MAX_NOTE_CHARS)
    return {
      error: `Notes must be ${MAX_NOTE_CHARS.toLocaleString()} characters or fewer.`,
    };

  const updated_at = new Date().toISOString();
  const updated_by = user.email;
  const { error } = await supabase
    .from("tab_notes")
    .upsert({ tab, content, updated_at, updated_by });
  if (error) return { error: error.message };

  revalidatePath(`/${tab}`);
  return { updatedAt: updated_at, updatedBy: updated_by };
}
