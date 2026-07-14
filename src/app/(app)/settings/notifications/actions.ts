"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";

export type RecipientFormState = { error?: string } | undefined;

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Managing notification recipients is master-only (the page already redirects
// non-masters; this closes the direct server-action invocation path).
async function assertMaster(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isMaster(user?.email);
}

export async function addRecipient(
  _prev: RecipientFormState,
  formData: FormData,
): Promise<RecipientFormState> {
  if (!(await assertMaster())) return { error: "Forbidden." };

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("notification_recipients")
    .insert({ email, label, enabled: true });
  if (error) return { error: error.message };

  revalidatePath("/settings/notifications");
  return undefined;
}

export async function toggleRecipient(formData: FormData) {
  if (!(await assertMaster())) return;
  const id = String(formData.get("id") ?? "");
  const enabled = formData.get("enabled") === "true";
  if (!id) return;

  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from("notification_recipients")
    .update({ enabled: !enabled })
    .eq("id", id);

  revalidatePath("/settings/notifications");
}

export async function deleteRecipient(formData: FormData) {
  if (!(await assertMaster())) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from("notification_recipients")
    .delete()
    .eq("id", id);

  revalidatePath("/settings/notifications");
}
