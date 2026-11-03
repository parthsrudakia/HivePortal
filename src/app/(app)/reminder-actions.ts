"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { isValid, zUuidArray } from "@/lib/validation";

export async function dismissLoginReminders(
  ids: string[],
): Promise<{ error?: string } | undefined> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!isValid(zUuidArray, ids) || ids.length === 0)
    return { error: "Invalid reminder ids." };

  // RLS also restricts to the caller's own rows; the filter keeps intent
  // explicit and the update a no-op for anyone else's ids.
  const { data: shown, error: readError } = await supabase
    .from("login_reminders")
    .select("id, created_by")
    .in("id", ids)
    .eq("user_id", user.id);
  if (readError) return { error: readError.message };

  // Mailbox warnings (src/lib/mailbox-health.ts) stay until the mailbox
  // check passes and clears them; "Got it" only closes the popup.
  const dismissible = (shown ?? [])
    .filter((r) => !r.created_by?.startsWith("mailbox-check:"))
    .map((r) => r.id);
  if (dismissible.length === 0) return undefined;

  const { error } = await supabase
    .from("login_reminders")
    .update({ dismissed_at: new Date().toISOString() })
    .in("id", dismissible)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return undefined;
}
