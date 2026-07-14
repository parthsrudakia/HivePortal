"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { canViewProfitability } from "@/lib/access";

export type LineItemFormState = { error?: string } | undefined;

const OWNER_ONLY_ERROR = "Only Parth or Vineet can edit profitability items.";

export async function addLineItem(
  _prev: LineItemFormState,
  formData: FormData,
): Promise<LineItemFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canViewProfitability(user?.email)) return { error: OWNER_ONLY_ERROR };

  const year = Number(String(formData.get("year") ?? ""));
  const side = String(formData.get("side") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const amount = Number(String(formData.get("amount") ?? "").trim());

  if (!Number.isInteger(year) || year < 2020 || year > 2100)
    return { error: "Invalid year." };
  if (side !== "revenue" && side !== "expense")
    return { error: "Pick revenue or expense." };
  if (!label) return { error: "Give the line item a name." };
  if (!Number.isFinite(amount) || amount <= 0)
    return { error: "Amount must be a positive number." };

  const { error } = await supabase.from("profitability_line_items").insert({
    year,
    side,
    label,
    amount,
    created_by: user?.email ?? null,
  });
  if (error) return { error: error.message };

  revalidatePath("/profitability");
  return undefined;
}

export async function deleteLineItem(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canViewProfitability(user?.email)) throw new Error(OWNER_ONLY_ERROR);

  await supabase.from("profitability_line_items").delete().eq("id", id);
  revalidatePath("/profitability");
}
