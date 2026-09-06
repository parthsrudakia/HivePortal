import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { todayISO } from "@/lib/date";
import { computeLedger, LEDGER_PAYMENT_CUTOFF } from "@/lib/rent";
import { fetchLedgerSidecars, fetchTenantLedgers, tenantLedger } from "@/lib/rent-data";
import { getToolContext } from "./context";
import { admin, one } from "./helpers";

export async function recordPayment(args: {
  tenancy_id: string;
  amount: number;
  paid_on: string;
  payment_type?:
    | "rent"
    | "security_deposit"
    | "late_fee"
    | "utility"
    | "other"
    | "refund";
  method?: string;
  notes?: string;
}) {
  if (!(args.amount > 0)) throw new Error("Amount must be a positive number.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.paid_on))
    throw new Error("paid_on must be YYYY-MM-DD.");
  if (args.paid_on > todayISO())
    throw new Error("paid_on cannot be in the future.");
  if (
    (args.payment_type ?? "rent") === "rent" &&
    args.paid_on < LEDGER_PAYMENT_CUTOFF
  ) {
    throw new Error(
      `Rent payments must be dated ${LEDGER_PAYMENT_CUTOFF} or later.`,
    );
  }
  const supabase = admin();
  const { error } = await supabase.from("payments").insert({
    tenancy_id: args.tenancy_id,
    amount: args.amount,
    paid_on: args.paid_on,
    payment_type: args.payment_type ?? "rent",
    method: args.method ?? null,
    notes: args.notes ?? null,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

// Post an ad-hoc charge to the ledger (owed side). Distinct from
// record_payment, which records money received.
export async function addTenancyCharge(args: {
  tenancy_id: string;
  kind: "security_deposit" | "late_fee" | "other";
  amount: number;
  note?: string;
  charged_on?: string;
}) {
  if (!(args.amount > 0)) throw new Error("Amount must be a positive number.");
  if (args.kind === "other" && !args.note?.trim())
    throw new Error("An 'other' charge needs a note describing it.");
  const chargedOn = args.charged_on ?? todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chargedOn))
    throw new Error("charged_on must be YYYY-MM-DD.");
  if (chargedOn > todayISO())
    throw new Error("charged_on cannot be in the future.");

  const supabase = admin();
  const { error } = await supabase.from("tenancy_charges").insert({
    tenancy_id: args.tenancy_id,
    kind: args.kind,
    amount: args.amount,
    charged_on: chargedOn,
    dedupe_key:
      args.kind === "late_fee" ? `late_fee:${chargedOn.slice(0, 7)}` : null,
    note: args.note?.trim() || null,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

// Moved-out tenants whose running ledger still shows money owed — the same
// list as the Rent Tracker's "Moved out with balance" section plus the
// dismissed ones. Source of tenancy_ids for settle/dismiss.
export async function listMovedOutBalances() {
  const supabase = admin();
  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, monthly_rent, first_month_rent, security_deposit,
       start_date, move_out_date, paused_at, balance_dismissed_at,
       tenants(full_name),
       rooms(room_number, properties(building_name, street_address, unit_number)),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "ended");
  if (error) throw new Error(error.message);

  const [{ charges, allocations, rentChanges }, tl] = await Promise.all([
    fetchLedgerSidecars(supabase),
    fetchTenantLedgers(supabase),
  ]);
  const today = todayISO();
  return (data ?? [])
    // One ledger per tenant: someone who moved to another room isn't "moved
    // out" — their balance shows on the active tenancy instead.
    .filter((t) => !tl.activeTenants.has(t.tenant_id))
    .map((t) => {
      const { netBalance, deposit } = tenantLedger(tl, t.tenant_id, () =>
        computeLedger(
          t,
          t.payments ?? [],
          charges.get(t.id) ?? [],
          allocations.get(t.id) ?? [],
          today,
          rentChanges.get(t.id) ?? [],
        ),
      );
      const room = one(t.rooms);
      const property = one(room?.properties ?? null);
      return {
        tenancy_id: t.id,
        tenant: one(t.tenants)?.full_name ?? null,
        unit: property
          ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
          : null,
        room: room?.room_number ?? null,
        moved_out: t.move_out_date,
        balance: netBalance,
        deposit_paid: deposit.paid,
        dismissed: !!t.balance_dismissed_at,
      };
    })
    .filter((r) => r.balance > 0.005)
    .sort((a, b) => b.balance - a.balance);
}

// Dismiss (or un-dismiss) a moved-out tenant's outstanding balance from the
// Rent Tracker. The ledger is untouched — the debt stays visible on the
// tenant's ledger and on the Tenant history page.
export async function dismissMovedOutBalance(args: {
  tenancy_id: string;
  undo?: boolean;
}) {
  const supabase = admin();
  const { data: t } = await supabase
    .from("tenancies")
    .select("id, status, tenants(full_name)")
    .eq("id", args.tenancy_id)
    .maybeSingle();
  if (!t) return { ok: false, error: "No tenancy with that id." };
  if (t.status !== "ended")
    return {
      ok: false,
      error:
        "That tenancy is still active — only moved-out balances can be dismissed.",
    };

  const ctx = getToolContext();
  const by = ctx?.username
    ? `telegram:@${ctx.username}`
    : ctx?.telegramUserId
      ? `telegram:${ctx.telegramUserId}`
      : "telegram";
  const patch = args.undo
    ? { balance_dismissed_at: null, balance_dismissed_by: null }
    : { balance_dismissed_at: new Date().toISOString(), balance_dismissed_by: by };
  const { error } = await supabase
    .from("tenancies")
    .update(patch)
    .eq("id", args.tenancy_id);
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    tenant: one(t.tenants)?.full_name ?? null,
    dismissed: !args.undo,
  };
}

// Settle a moved-out tenant's outstanding balance: post a 'settlement'
// credit for the exact net balance (deposit applied toward the debt,
// remainder written off) so the ledger nets to $0. Mirrors the portal's
// Settle button; no payment row is created, so collections analytics never
// count settled debt as money received.
export async function settleMovedOutBalance(args: { tenancy_id: string }) {
  const supabase = admin();
  const { data: t } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, status, monthly_rent, first_month_rent, security_deposit,
       start_date, move_out_date, paused_at,
       tenants(full_name),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("id", args.tenancy_id)
    .maybeSingle();
  if (!t) return { ok: false, error: "No tenancy with that id." };
  if (t.status !== "ended")
    return {
      ok: false,
      error:
        "That tenancy is still active — Settle is only for moved-out tenants.",
    };

  const { charges, allocations, rentChanges } =
    await fetchLedgerSidecars(supabase);
  const today = todayISO();
  const { netBalance, deposit } = computeLedger(
    t,
    t.payments ?? [],
    charges.get(t.id) ?? [],
    allocations.get(t.id) ?? [],
    today,
    rentChanges.get(t.id) ?? [],
  );
  if (netBalance <= 0.005)
    return {
      ok: false,
      error: `Nothing to settle — the ledger balance is $${netBalance.toFixed(2)}.`,
    };

  const depositHeld = deposit.paid;
  const note =
    depositHeld > 0.005
      ? `Settled at move-out — $${depositHeld.toLocaleString(undefined, {
          minimumFractionDigits: 2,
        })} security deposit applied toward the balance; remainder written off.`
      : "Settled at move-out — balance written off.";
  const { error } = await supabase.from("tenancy_charges").insert({
    tenancy_id: args.tenancy_id,
    kind: "settlement",
    amount: netBalance,
    charged_on: today,
    note,
  });
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    tenant: one(t.tenants)?.full_name ?? null,
    settled_amount: netBalance,
    deposit_applied: depositHeld,
  };
}

export const paymentsTools = [
  betaZodTool({
    name: "record_payment",
    description:
      "Add a payment row against a tenancy. Use list_active_tenants to find the tenancy_id.",
    inputSchema: z.object({
      tenancy_id: z.string(),
      amount: z.number().positive(),
      paid_on: z.string().describe('"YYYY-MM-DD"'),
      payment_type: z
        .enum([
          "rent",
          "security_deposit",
          "late_fee",
          "utility",
          "other",
          "refund",
        ])
        .optional(),
      method: z.string().optional(),
      notes: z.string().optional(),
    }),
    run: async (args) => JSON.stringify(await recordPayment(args)),
  }),
  betaZodTool({
    name: "add_charge",
    description:
      "Post an ad-hoc charge a tenant owes on their ledger: security_deposit, " +
      "late_fee (~$50), or other (note required). This is the owed side — use " +
      "record_payment when money is received.",
    inputSchema: z.object({
      tenancy_id: z.string(),
      kind: z.enum(["security_deposit", "late_fee", "other"]),
      amount: z.number().positive(),
      note: z.string().optional().describe("Required when kind is 'other'"),
      charged_on: z
        .string()
        .optional()
        .describe('"YYYY-MM-DD", defaults to today'),
    }),
    run: async (args) => JSON.stringify(await addTenancyCharge(args)),
  }),
  betaZodTool({
    name: "list_moved_out_balances",
    description:
      "Moved-out tenants whose ledger still shows money owed (the Rent " +
      "Tracker's 'Moved out with balance' list, dismissed ones included). " +
      "Returns tenancy_id, tenant, unit/room, move-out date, balance, deposit " +
      "paid, and dismissed flag — the id source for settle_moved_out_balance " +
      "/ dismiss_moved_out_balance.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await listMovedOutBalances()),
  }),
  betaZodTool({
    name: "settle_moved_out_balance",
    description:
      "Settle a MOVED-OUT tenant's outstanding balance: posts a settlement " +
      "credit for the exact amount owed (security deposit applied toward the " +
      "debt, remainder written off) so their ledger nets to $0 and they drop " +
      "off the Rent Tracker's moved-out list. Destructive — read back the " +
      "tenant and amount and get an explicit confirmation first. Reversible " +
      "only by deleting the Settlement line on the tenant's ledger page.",
    inputSchema: z.object({ tenancy_id: z.string() }),
    run: async (args) => JSON.stringify(await settleMovedOutBalance(args)),
  }),
  betaZodTool({
    name: "dismiss_moved_out_balance",
    description:
      "Dismiss a MOVED-OUT tenant's outstanding balance from the Rent " +
      "Tracker's moved-out list WITHOUT touching the ledger — the debt stays " +
      "on their ledger and in Tenant history. Pass undo=true to put a " +
      "dismissed balance back on the list. Use settle_moved_out_balance " +
      "instead when the operator wants the ledger zeroed.",
    inputSchema: z.object({
      tenancy_id: z.string(),
      undo: z.boolean().optional(),
    }),
    run: async (args) => JSON.stringify(await dismissMovedOutBalance(args)),
  }),
];
