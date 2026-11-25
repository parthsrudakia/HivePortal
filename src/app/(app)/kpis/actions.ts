"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/section-access";
import { normalizeFilters } from "@/lib/sales-kpis";

/**
 * Save the KPI page's current filters as this user's default — applied
 * whenever /kpis loads without KPI filters in the URL. KPIs is gated by the
 * 'sales_kpis' permission (not a section), so that is the guard here.
 */
export async function saveSalesKpiDefaults(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await hasPermission("sales_kpis")))
    return { ok: false, error: "You don't have access to KPIs. Ask Vineet to grant it." };
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const filters = normalizeFilters(raw);
  const supabase = await createClient();
  const { error } = await supabase
    .from("sales_kpi_prefs")
    .upsert(
      { user_id: user.id, filters, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) return { ok: false, error: `Couldn't save default: ${error.message}` };
  revalidatePath("/kpis");
  return { ok: true };
}
