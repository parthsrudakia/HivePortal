import { createClient as createServiceClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { canEditLedger } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { one } from "@/lib/relations";
import { isOverThreshold } from "@/lib/utility-bills";
import { UtilitiesView } from "./utilities-view";
import { TabNotepad } from "../tab-notepad";
import type { BillRow, UnitOpt } from "./bill-utils";

export const dynamic = "force-dynamic";
// Extraction calls Claude with the full statement; give it breathing room.
export const maxDuration = 60;

export default async function UtilitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ bill?: string }>;
}) {
  const { bill: focusBillId } = await searchParams;
  const sb = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const [user, { data: props }, billsRes] = await Promise.all([
    getSessionUser(),
    sb
      .from("properties")
      .select("id, building_name, street_address, unit_number")
      .order("street_address"),
    sb
      .from("utility_bills")
      .select(
        "*, utility_bill_charges(id, kind, description, amount), utility_bill_files(id, file_name, sort_order), tenancy_charges(id, kind, amount, tenancies(tenants(id, full_name)))",
      )
      .order("statement_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
  ]);

  // Charging the over-$200 overage writes to tenant ledgers — operator-only.
  const canCharge = canEditLedger(user?.email);

  const units: UnitOpt[] = (props ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
  }));
  const bills = (billsRes.data ?? []) as BillRow[];

  // First names of the tenants who share (or shared) each over-$200 bill's
  // overage — the occupants of the unit's AC rooms during the billing
  // period, mirroring the eligibility in chargeOverageCore. Shown in the
  // overage banner so the operator sees who a charge lands on.
  const flaggedPropIds = [
    ...new Set(
      bills
        .filter((b) => b.property_id && isOverThreshold(b))
        .map((b) => b.property_id!),
    ),
  ];
  const billTenants: Record<string, string[]> = {};
  if (flaggedPropIds.length > 0) {
    const { data: rooms } = await sb
      .from("rooms")
      .select("id, property_id, has_ac")
      .in("property_id", flaggedPropIds);
    const acRooms = (rooms ?? []).filter((r) => r.has_ac);
    const roomProp = new Map(acRooms.map((r) => [r.id, r.property_id]));
    const { data: tenancies } =
      acRooms.length > 0
        ? await sb
            .from("tenancies")
            .select("room_id, start_date, move_out_date, tenants(full_name)")
            .in(
              "room_id",
              acRooms.map((r) => r.id),
            )
        : { data: [] };
    for (const b of bills) {
      if (!b.property_id || !isOverThreshold(b)) continue;
      // Charging walks the period with an exclusive end (period_end is the
      // next cycle's start); the last billed day matches that here. Bills
      // without a period fall back to the statement date.
      const start =
        b.period_start?.slice(0, 10) ?? b.statement_date?.slice(0, 10);
      if (!start) continue;
      let last = start;
      const endEx = b.period_end?.slice(0, 10);
      if (endEx && endEx > start) {
        const d = new Date(`${endEx}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        last = d.toISOString().slice(0, 10);
      }
      const names = (tenancies ?? [])
        .filter(
          (t) =>
            roomProp.get(t.room_id) === b.property_id &&
            t.start_date <= last &&
            (!t.move_out_date || t.move_out_date >= start),
        )
        .map(
          (t) => (one(t.tenants)?.full_name ?? "").trim().split(/\s+/)[0],
        )
        .filter(Boolean);
      billTenants[b.id] = [...new Set(names)].sort();
    }
  }

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

      <TabNotepad tab="utilities" />

      <UtilitiesView
        bills={bills}
        units={units}
        canCharge={canCharge}
        billTenants={billTenants}
        focusBillId={focusBillId}
      />
    </div>
  );
}
