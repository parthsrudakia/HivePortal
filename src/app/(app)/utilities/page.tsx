import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { canEditLedger } from "@/lib/access";
import { UtilitiesView } from "./utilities-view";
import type { BillRow, UnitOpt } from "./bill-utils";

export const dynamic = "force-dynamic";
// Extraction calls Claude with the full statement; give it breathing room.
export const maxDuration = 60;

export default async function UtilitiesPage() {
  // Charging the over-$200 overage writes to tenant ledgers — operator-only.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const canCharge = canEditLedger(user?.email);

  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const [{ data: props }, billsRes] = await Promise.all([
    sb
      .from("properties")
      .select("id, building_name, street_address, unit_number")
      .order("street_address"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sb as any)
      .from("utility_bills")
      .select("*, utility_bill_charges(id, kind, description, amount)")
      .order("statement_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
  ]);

  const units: UnitOpt[] = (props ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
  }));
  const bills = (billsRes.data ?? []) as BillRow[];

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="border-b border-stone/60 pb-6">
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Utilities</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Drop a statement — the unit, dates, and charges are extracted
          automatically. Previous-balance amounts are ignored; late fees are
          tracked separately.
        </p>
      </header>

      <UtilitiesView bills={bills} units={units} canCharge={canCharge} />
    </div>
  );
}
