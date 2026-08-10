"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/access";

export type RecipientFormState = { error?: string } | undefined;

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Managing notification recipients is operator-only — Vineet and Parth (the
// page already redirects everyone else; this closes the direct server-action
// invocation path).
async function assertOperator(): Promise<boolean> {
  const user = await getSessionUser();
  return isOperator(user?.email);
}

export async function addRecipient(
  _prev: RecipientFormState,
  formData: FormData,
): Promise<RecipientFormState> {
  if (!(await assertOperator())) return { error: "Forbidden." };

  const email = String(formData.get("email") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim() || null;
  if (!email) return { error: "Email is required." };
  if (!label) return { error: "Name is required." };

  // Recipients must be existing portal users — not arbitrary addresses.
  const { data: usersData } = await adminClient().auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  const isSystemUser = (usersData?.users ?? []).some(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!isSystemUser) {
    return { error: "Recipient must be an existing portal user." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("notification_recipients")
    .insert({ email, label, enabled: true });
  if (error) return { error: error.message };

  revalidatePath("/settings/notifications");
  return undefined;
}

export async function toggleRecipient(formData: FormData) {
  if (!(await assertOperator())) return;
  const id = String(formData.get("id") ?? "");
  const enabled = formData.get("enabled") === "true";
  if (!id) return;

  const supabase = await createClient();
  await supabase
    .from("notification_recipients")
    .update({ enabled: !enabled })
    .eq("id", id);

  revalidatePath("/settings/notifications");
}

export async function deleteRecipient(formData: FormData) {
  if (!(await assertOperator())) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  await supabase
    .from("notification_recipients")
    .delete()
    .eq("id", id);

  revalidatePath("/settings/notifications");
}
