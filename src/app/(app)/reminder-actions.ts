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
  const { error } = await supabase
    .from("login_reminders")
    .update({ dismissed_at: new Date().toISOString() })
    .in("id", ids)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return undefined;
}
