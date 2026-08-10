import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { todayISO, currentRentCycle, rentCycleForMonth } from "@/lib/date";
import { updateRoomsWithNotification } from "@/lib/notifications";
import { computeLedger, rateForMonthISO } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import type { Database } from "@/lib/supabase/types";
import { admin, one, propertyLabel } from "./helpers";

export async function listActiveTenants(args: {
  month?: string;
  only_overdue?: boolean;
  unpaid_only?: boolean;
}) {
  const supabase = admin();
  // Rent is collected on a 27th→26th cycle. With an explicit month, use that
  // month's cycle; otherwise the cycle containing today (rolls on the 27th).
  const { start, end } = args.month
    ? rentCycleForMonth(args.month)
    : currentRentCycle();
  const yyyymm = end.slice(0, 7); // rent month (the cycle's 26th)

  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, first_month_rent, security_deposit, start_date,
       move_out_date, paused_at, tenant_id,
       tenants(id, full_name, email, phone),
       rooms(room_number,
             properties(id, building_name, street_address, unit_number)),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "active");
  if (error) throw new Error(error.message);

  // Ledger sidecars (ad-hoc charges, credit allocations, rent-rate history).
  // The history also reprices a past cycle's due figure to the rate in effect
  // that month, not today's monthly_rent.
  const { charges, allocations, rentChanges } =
    await fetchLedgerSidecars(supabase);
  const rentMonth = `${yyyymm}-01`;
  const today = todayISO();

  const rows = (data ?? []).map((t) => {
    const paid = (t.payments ?? [])
      .filter(
        (p) =>
          (p.payment_type === "rent" || p.payment_type === "refund") &&
          p.paid_on >= start &&
          p.paid_on <= end &&
          p.paid_on <= today,
      )
      .reduce(
        (sum, p) =>
          sum + (p.payment_type === "refund" ? -1 : 1) * Number(p.amount),
        0,
      );
    const tenant = one(t.tenants);
    const room = one(t.rooms);
    const property = one(room?.properties ?? null);
    const tenancyChanges = rentChanges.get(t.id) ?? [];
    const rate = rateForMonthISO(rentMonth, t.monthly_rent, tenancyChanges);
    // Carry-forward ledger balance — what the tenant owes overall right now,
    // prior months and non-rent charges included. This is the number to quote
    // when asked for someone's balance; cycle_balance is this cycle only.
    const { netBalance } = computeLedger(
      t,
      t.payments ?? [],
      charges.get(t.id) ?? [],
      allocations.get(t.id) ?? [],
      today,
      tenancyChanges,
    );
    const due =
      t.start_date > today || t.start_date > end
        ? 0
        : t.start_date >= start && t.first_month_rent !== null
          ? Number(t.first_month_rent)
          : rate;
    return {
      tenancy_id: t.id,
      tenant_id: tenant?.id ?? null,
      full_name: tenant?.full_name ?? null,
      email: tenant?.email ?? null,
      phone: tenant?.phone ?? null,
      unit: property ? propertyLabel(property) : null,
      room: room?.room_number ?? null,
      monthly_rent: rate,
      paid_this_cycle: paid,
      cycle_balance: due - paid,
      net_balance: netBalance,
    };
  });

  // unpaid_only: no rent payment dated in this cycle (by transaction date),
  // regardless of whether they're paid ahead. only_overdue: still owes on the
  // running ledger. unpaid_only takes precedence when both are set.
  let tenants = rows;
  if (args.unpaid_only) tenants = tenants.filter((r) => r.paid_this_cycle === 0);
  else if (args.only_overdue) tenants = tenants.filter((r) => r.net_balance > 0);

  return { month: yyyymm, tenants };
}

// Create a tenant and place them in a room (an active tenancy) in one shot —
// the Telegram counterpart of the /tenants/new form. Mirrors createTenant():
// inserts the tenant, opens the tenancy, then flips the room to occupied. The
// tenant insert is rolled back if the tenancy fails so we never leave an
// orphaned, room-less tenant behind.
export async function addTenant(args: {
  full_name: string;
  email: string;
  phone: string;
  room_id: string;
  monthly_rent: number;
  start_date: string;
  lease_end_date: string;
  first_month_rent?: number;
  pays_as?: string;
  notes?: string;
}) {
  const supabase = admin();

  const full_name = args.full_name.trim();
  const email = args.email.trim();
  const phone = args.phone.trim();
  if (!full_name) throw new Error("Tenant name is required.");
  if (!email) throw new Error("Tenant email is required.");
  if (!phone) throw new Error("Tenant phone is required.");
  if (!args.room_id) throw new Error("A room must be chosen for the tenant.");
  if (!(args.monthly_rent > 0)) throw new Error("Monthly rent must be greater than 0.");
  if (!args.start_date) throw new Error("Lease start date is required.");
  if (!args.lease_end_date) throw new Error("Lease end date is required.");
  if (args.lease_end_date < args.start_date) {
    throw new Error("Lease end date cannot be before the start date.");
  }

  // Guard against double-booking: refuse if the room already has an active
  // tenancy. Also gives us a friendly room label for the confirmation.
  const { data: room, error: roomErr } = await supabase
    .from("rooms")
    .select(
      `id, room_number, status,
       properties(building_name, street_address, unit_number),
       tenancies!left(id, status, tenants(full_name))`,
    )
    .eq("id", args.room_id)
    .maybeSingle();
  if (roomErr) throw new Error(roomErr.message);
  if (!room) throw new Error("Room not found.");
  const occupant = (room.tenancies ?? []).find(
    (t: { status: string }) =>
      t.status === "active" || t.status === "upcoming",
  );
  if (occupant) {
    const who = one(occupant.tenants)?.full_name ?? "another tenant";
    throw new Error(
      `That room already has an active tenancy (${who}). End it first, or pick a different room.`,
    );
  }
  const property = one(room.properties);
  const roomLabel = `${property ? propertyLabel(property) : "room"} room ${room.room_number}`;

  // 1. Insert the tenant record.
  const { data: tenant, error: tErr } = await supabase
    .from("tenants")
    .insert({
      full_name,
      email,
      phone,
      pays_as: args.pays_as?.trim() || null,
      notes: args.notes?.trim() || null,
    })
    .select("id")
    .single();
  if (tErr) throw new Error(tErr.message);

  // 2. Open the tenancy. Roll the tenant back if this fails so we don't leave
  //    an orphaned contact with no room.
  const { data: tenancy, error: leErr } = await supabase
    .from("tenancies")
    .insert({
      room_id: args.room_id,
      tenant_id: tenant.id,
      start_date: args.start_date,
      lease_end_date: args.lease_end_date,
      monthly_rent: args.monthly_rent,
      // Security deposit is intentionally never recorded here, even if the
      // operator's message includes one — left null on the tenancy.
      security_deposit: null,
      first_month_rent: args.first_month_rent ?? null,
      status: args.start_date > todayISO() ? "upcoming" : "active",
    })
    .select("id")
    .single();
  if (leErr) {
    await supabase.from("tenants").delete().eq("id", tenant.id);
    throw new Error(leErr.message);
  }

  // 3. Future tenancies reserve the room until their start date.
  await updateRoomsWithNotification(supabase, args.room_id, {
    status: args.start_date > todayISO() ? "reserved" : "occupied",
    pending_tenant: false,
  });

  return {
    ok: true,
    tenant_id: tenant.id,
    tenancy_id: tenancy.id,
    full_name,
    room: roomLabel,
    monthly_rent: args.monthly_rent,
    lease: { start: args.start_date, end: args.lease_end_date },
  };
}

// Patch tenant profile fields. Only the fields provided change; pass null to
// clear a clearable field.
export async function updateTenant(args: {
  tenant_id: string;
  full_name?: string;
  email?: string | null;
  phone?: string | null;
  pays_as?: string | null;
  profession?: string | null;
  age?: number | null;
  notes?: string | null;
}) {
  const patch: Database["public"]["Tables"]["tenants"]["Update"] = {};
  if (args.full_name !== undefined) patch.full_name = args.full_name;
  if (args.email !== undefined) patch.email = args.email;
  if (args.phone !== undefined) patch.phone = args.phone;
  if (args.pays_as !== undefined) patch.pays_as = args.pays_as;
  if (args.profession !== undefined) patch.profession = args.profession;
  if (args.age !== undefined) patch.age = args.age;
  if (args.notes !== undefined) patch.notes = args.notes;
  if (typeof patch.full_name === "string" && !patch.full_name.trim()) {
    throw new Error("full_name cannot be blank.");
  }
  if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");

  const supabase = admin();
  const { error } = await supabase
    .from("tenants")
    .update(patch)
    .eq("id", args.tenant_id);
  if (error) throw new Error(error.message);
  return { ok: true, updated_fields: Object.keys(patch) };
}

export const tenantsTools = [
  betaZodTool({
    name: "list_active_tenants",
    description:
      "Active tenants with monthly rent, paid-this-cycle amount (by payment " +
      "transaction date), and balances. net_balance is the carry-forward " +
      "ledger balance — everything the tenant owes overall right now, prior " +
      "months and non-rent charges included (negative = account credit / paid " +
      "ahead). ALWAYS quote net_balance when asked what someone owes or their " +
      "balance. cycle_balance is this cycle's rent minus this cycle's payments " +
      "only — use it solely for 'how does this cycle look' questions. Rent is " +
      "collected on a 27th→26th cycle (tenants pay from the 27th), so 'this " +
      "month' = the 27th of the prior month through the 26th. Defaults to the " +
      "current cycle (net_balance is always as of today regardless of month). " +
      "Pass only_overdue: true to filter to net_balance > 0. Pass unpaid_only: " +
      "true to list tenants who have made NO rent payment dated in the cycle " +
      "(paid = 0) — i.e. who hasn't paid anything this month, regardless of " +
      "whether they're paid ahead.",
    inputSchema: z.object({
      month: z
        .string()
        .optional()
        .describe(
          'Rent month as "YYYY-MM" (its 27th→26th cycle); defaults to the current cycle',
        ),
      only_overdue: z.boolean().optional(),
      unpaid_only: z
        .boolean()
        .optional()
        .describe("Only tenants with $0 paid this cycle (by transaction date)."),
    }),
    run: async (args) => JSON.stringify(await listActiveTenants(args)),
  }),
  betaZodTool({
    name: "add_tenant",
    description:
      "Add a new tenant and place them in a room (creates the tenant record AND " +
      "an active tenancy). Use this when the operator asks to add / create / " +
      "onboard a tenant — typically right after sending their agreement, by " +
      "re-sending the agreement details. Required: full name, email, phone, " +
      "monthly rent, lease start date, lease end date, and the room to place " +
      "them in. You must resolve room_id first. If the operator named the unit/" +
      "room, call list_properties to find the unit by address, then get_property " +
      "to list its rooms and pick the vacant one (ask which room if ambiguous). " +
      "If no unit + room is given, call list_inventory and ask the operator which " +
      "room to use — never guess. ALWAYS confirm the " +
      "full details — name, email, phone, room, rent, and lease dates — with the " +
      "operator before calling this. Ask for any missing required field; do not " +
      "guess. Do NOT collect or record a security deposit here, even if the " +
      "message includes one. This does not send an agreement (use send_agreement " +
      "for that).",
    inputSchema: z.object({
      full_name: z.string().describe("Tenant's full name"),
      email: z.string().describe("Tenant email address"),
      phone: z.string().describe("Tenant phone number"),
      room_id: z
        .string()
        .describe(
          "UUID of the room to place the tenant in. Resolve via list_properties → get_property.",
        ),
      monthly_rent: z.number().positive().describe("Monthly rent amount"),
      start_date: z.string().describe('Lease start date "YYYY-MM-DD"'),
      lease_end_date: z.string().describe('Lease end date "YYYY-MM-DD"'),
      first_month_rent: z
        .number()
        .nonnegative()
        .optional()
        .describe("Prorated first-month rent, if different from monthly rent"),
      pays_as: z
        .string()
        .optional()
        .describe("Name the tenant's payments arrive under, if different"),
      notes: z.string().optional().describe("Free-form notes about the tenant"),
    }),
    run: async (args) => JSON.stringify(await addTenant(args)),
  }),
  betaZodTool({
    name: "update_tenant",
    description:
      "Update a tenant's profile fields (name, email, phone, pays_as, " +
      "profession, age, notes). Only the fields provided change; pass null " +
      "to clear a field. Does not touch the tenancy or ledger.",
    inputSchema: z.object({
      tenant_id: z.string(),
      full_name: z.string().optional(),
      email: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      pays_as: z
        .string()
        .nullable()
        .optional()
        .describe("Name on Zelle deposits, used by reconciliation matching"),
      profession: z.string().nullable().optional(),
      age: z.number().int().min(0).max(150).nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    run: async (args) => JSON.stringify(await updateTenant(args)),
  }),
];
