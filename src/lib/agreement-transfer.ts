/**
 * An agreement sent to an EXISTING tenant is a room transfer.
 *
 * Runs right after an agreement email goes out (sendAgreementRequest). When
 * the recipient email belongs to exactly one tenant who has an active
 * tenancy in a different room, the tenant is transferred into the
 * agreement's room:
 *   - the old room's move-out is the day before the agreement's move-in
 *     (replacing any move-out already booked);
 *   - the old room's move-out month bills only the days stayed
 *     (rent / days in month × days stayed — see transferTenant);
 *   - the new tenancy starts on the agreement's lease start at the
 *     agreement's rent, deposit, and lease end, with its first month
 *     prorated (the agreement's prorated rent when it states one).
 *
 * Anything ambiguous is skipped and reported, never guessed: no tenant or
 * several tenants on the email, no active tenancy, an upcoming tenancy
 * elsewhere, or a tenancy already in the agreement's room (a renewal, not a
 * transfer). Never throws — the agreement has already been sent.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { addDaysISO } from "@/lib/date";
import { z } from "zod";
import { isValid } from "@/lib/validation";
import { transferTenant, transferRoomLabel } from "@/lib/tenancy-transfer";

const zIsoDate = z.iso.date();

export type AgreementTransferOutcome =
  | { status: "skipped"; reason: string }
  | { status: "transferred"; summary: string; warning?: string }
  | { status: "failed"; error: string };

function admin() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** "$1,750.00" / "1750" → 1750; null when blank or not a number. */
export function parseMoney(raw: string | null | undefined): number | null {
  const cleaned = (raw ?? "").replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const fmtUsd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Escape the LIKE wildcards so an ilike compares the whole string literally. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function transferOnAgreementSend(args: {
  recipientEmail: string;
  roomId: string;
  leaseStartDate: string;
  leaseEndDate: string;
  rent: string;
  securityDeposit: string;
  proRateRent?: string;
}): Promise<AgreementTransferOutcome> {
  try {
    const supabase = admin();
    const email = args.recipientEmail.trim();
    if (!email) return { status: "skipped", reason: "no recipient email" };

    const { data: tenants, error: tenantErr } = await supabase
      .from("tenants")
      .select("id, full_name")
      .ilike("email", likeLiteral(email));
    if (tenantErr) return { status: "failed", error: tenantErr.message };
    if (!tenants || tenants.length === 0)
      return { status: "skipped", reason: "new tenant (no profile with this email)" };
    if (tenants.length > 1)
      return {
        status: "skipped",
        reason: `${tenants.length} tenant profiles share this email — transfer them manually`,
      };
    const tenant = tenants[0];

    const { data: live, error: liveErr } = await supabase
      .from("tenancies")
      .select("id, status, room_id, start_date, rooms(room_number, properties(building_name, street_address, unit_number))")
      .eq("tenant_id", tenant.id)
      .in("status", ["active", "upcoming"]);
    if (liveErr) return { status: "failed", error: liveErr.message };
    const tenancies = live ?? [];

    if (tenancies.some((t) => t.room_id === args.roomId))
      return {
        status: "skipped",
        reason: `${tenant.full_name} already has a tenancy in this room (renewal, not a transfer)`,
      };
    if (tenancies.some((t) => t.status === "upcoming"))
      return {
        status: "skipped",
        reason: `${tenant.full_name} already has an upcoming move-in elsewhere — transfer manually`,
      };
    const active = tenancies.filter((t) => t.status === "active");
    if (active.length === 0)
      return {
        status: "skipped",
        reason: `${tenant.full_name} has no active tenancy to transfer from`,
      };
    if (active.length > 1)
      return {
        status: "skipped",
        reason: `${tenant.full_name} has ${active.length} active tenancies — transfer manually`,
      };
    const old = active[0];

    if (!isValid(zIsoDate, args.leaseStartDate))
      return { status: "failed", error: `lease start "${args.leaseStartDate}" is not a YYYY-MM-DD date` };
    const rent = parseMoney(args.rent);
    if (rent === null || rent <= 0)
      return { status: "failed", error: `rent "${args.rent}" is not a positive amount` };
    const deposit = parseMoney(args.securityDeposit);
    if (deposit !== null && deposit < 0)
      return { status: "failed", error: `security deposit "${args.securityDeposit}" is negative` };
    const proRate = parseMoney(args.proRateRent);
    const leaseEnd = isValid(zIsoDate, args.leaseEndDate) ? args.leaseEndDate : null;

    const transferDate = addDaysISO(args.leaseStartDate, -1);
    const result = await transferTenant(
      // Service-role client: the send can come from the Telegram bot, with no
      // user session. Same schema type as the cookie client.
      supabase,
      {
        tenancy_id: old.id,
        tenant_id: tenant.id,
        dest_room_id: args.roomId,
        transfer_date: transferDate,
        new_start_date: args.leaseStartDate,
        new_monthly_rent: rent,
        first_month_rent: proRate !== null && proRate >= 0 ? proRate : null,
        new_security_deposit: deposit,
        lease_end_date: leaseEnd,
        replaceScheduledMoveOut: true,
      },
    );
    if (result.error !== undefined) return { status: "failed", error: result.error };

    const fromLabel = transferRoomLabel(
      (Array.isArray(old.rooms) ? old.rooms[0] : old.rooms) ?? null,
    );
    return {
      status: "transferred",
      summary:
        `${tenant.full_name} is an existing tenant, so this was booked as a room transfer: ` +
        `${fromLabel} ends ${transferDate} (that month prorated to ${fmtUsd(result.lastMonthRent)}), ` +
        `new room starts ${args.leaseStartDate} at ${fmtUsd(rent)}/mo.`,
      warning: result.warning,
    };
  } catch (e) {
    return {
      status: "failed",
      error: e instanceof Error ? e.message : "unexpected error",
    };
  }
}
