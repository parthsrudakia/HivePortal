"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type RecipientFormState = { error?: string } | undefined;

export async function addRecipient(
  _prev: RecipientFormState,
  formData: FormData,
): Promise<RecipientFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim() || null;
  if (!email) return { error: "Email is required." };
  // Cheap shape check; Resend will reject anything truly broken.
  if (!email.includes("@")) return { error: "That doesn't look like an email." };

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
