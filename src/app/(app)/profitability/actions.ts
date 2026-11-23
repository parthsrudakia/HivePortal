"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/section-access";

export type LineItemFormState = { error?: string } | undefined;

const OWNER_ONLY_ERROR = "You don't have Profitability access. Ask Vineet to grant it.";

export async function addLineItem(
  _prev: LineItemFormState,
  formData: FormData,
): Promise<LineItemFormState> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!(await hasPermission("profitability"))) return { error: OWNER_ONLY_ERROR };

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
  if (!(await hasPermission("profitability"))) throw new Error(OWNER_ONLY_ERROR);

  await supabase.from("profitability_line_items").delete().eq("id", id);
  revalidatePath("/profitability");
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Add one company-wide cost for a month (e.g. that month's Upwork total).
 * Stored in profit_costs with source 'manual', so the costs agent's re-sends
 * never touch it.
 */
export async function addMonthlyCompanyCost(
  _prev: LineItemFormState,
  formData: FormData,
): Promise<LineItemFormState> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!(await hasPermission("profitability"))) return { error: OWNER_ONLY_ERROR };

  const month = String(formData.get("month") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const amount = Number(String(formData.get("amount") ?? "").trim());

  if (!MONTH_RE.test(month)) return { error: "Pick a month." };
  if (!label) return { error: "Name the cost, e.g. Upwork." };
  if (label.length > 200) return { error: "Keep the name under 200 characters." };
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1_000_000)
    return { error: "Amount must be a positive number." };

  const { error } = await supabase.from("profit_costs").insert({
    property_id: null,
    month,
    cost_type: "company",
    amount: Math.round(amount * 100) / 100,
    label,
    source: "manual",
    ref: crypto.randomUUID(),
    created_by: user?.email ?? null,
  });
  if (error) return { error: error.message };

  revalidatePath("/profitability");
  return undefined;
}

export async function deleteMonthlyCompanyCost(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  if (!(await hasPermission("profitability"))) throw new Error(OWNER_ONLY_ERROR);

  await supabase
    .from("profit_costs")
    .delete()
    .eq("id", id)
    .eq("cost_type", "company")
    .eq("source", "manual");
  revalidatePath("/profitability");
}
