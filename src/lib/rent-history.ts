/**
 * Recording rent-rate changes in `tenancy_rent_history` — the mechanism that
 * makes a monthly-rent edit apply to FUTURE months only. Every code path that
 * writes `tenancies.monthly_rent` must use {@link updateTenancyRent}, or the
 * ledger (and everything downstream) can retroactively reprice past months.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Accepts either the user-scoped server client or the service-role admin
// client — both expose the same query builder surface.
type AnySupabase = SupabaseClient<Database>;

/**
 * Atomically records the effective rate and updates the tenancy's current
 * lease terms. Use this for every monthly-rent edit; unlike the legacy helper,
 * it cannot leave rent history and `tenancies.monthly_rent` out of sync.
 */
export async function updateTenancyRent(
  supabase: AnySupabase,
  tenancyId: string,
  newRate: number,
  effectiveFrom: string,
  leaseStart: string,
  leaseEnd: string,
): Promise<{ error?: string }> {
  const { error } = await supabase.rpc("update_tenancy_rent", {
    p_tenancy_id: tenancyId,
    p_new_rate: newRate,
    p_effective_from: effectiveFrom,
    p_lease_start: leaseStart,
    p_lease_end: leaseEnd,
  });
  return error ? { error: error.message } : {};
}
