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

function profileName(meta: Record<string, unknown> | undefined): string | null {
  const pick = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return pick(meta?.display_name) ?? pick(meta?.full_name);
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
  if (!email) return { error: "Email is required." };

  // Recipients must be existing portal users — not arbitrary addresses.
  const { data: usersData } = await adminClient().auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  const user = (usersData?.users ?? []).find(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!user) {
    return { error: "Recipient must be an existing portal user." };
  }

  // One row per person — a second row would double-send every email and
  // split their ad tally on /inventory. (Also enforced by a unique index on
  // lower(email).)
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("notification_recipients")
    .select("id, label")
    .ilike("email", email.replace(/[\\%_]/g, "\\$&"))
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      error: `${existing.label ?? email} is already a recipient.`,
    };
  }

  // Name defaults to the user's portal profile name — the same name their
  // ads are recorded under — so they show up as one person everywhere.
  const label =
    String(formData.get("label") ?? "").trim() ||
    profileName(user.user_metadata) ||
    null;

  const { error } = await supabase
    .from("notification_recipients")
    .insert({ email: user.email ?? email, label, enabled: true });
  if (error) {
    return {
      error:
        error.code === "23505"
          ? `${email} is already a recipient.`
          : error.message,
    };
  }

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
