"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";
import { updateRoomsWithNotification } from "@/lib/notifications";
import {
  sendBalanceReminder,
  sendBalanceReminderGmail,
  balanceReminderText,
} from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { todayISO } from "@/lib/date";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { canEditLedger, LEDGER_ADMIN_ERROR } from "@/lib/access";

type PaymentType = Database["public"]["Enums"]["payment_type"];
// Typed as string[] (not PaymentType[]) so values validate even before the
// generated enum types are regenerated against the ledger migration.
const VALID_PAYMENT_TYPES: string[] = [
  "rent",
  "security_deposit",
  "late_fee",
  "utility",
  "other",
  "refund",
];

// Ad-hoc charges that post to the ledger alongside the auto monthly rent: the
// security deposit, a $50 late fee, or misc. Keep in sync with the
// tenancy_charges.kind CHECK constraint.
const VALID_CHARGE_KINDS = [
  "security_deposit",
  "late_fee",
  "other",
] as const;
type ChargeKind = (typeof VALID_CHARGE_KINDS)[number];

export type TenantFormState = { error?: string } | undefined;
export type PaymentFormState = { error?: string } | undefined;
export type ChargeFormState = { error?: string } | undefined;
export type ReminderState = { error?: string; success?: string } | undefined;

// Services bundle baked into every room's rent: utilities + wi-fi + maid +
// amenities. A room's total_rent (generated) = base_rent + bundle_fee.
const BUNDLE_FEE = 125;

// Keep in sync with the client-side check in new/add-tenant-form.tsx and the
// serverActions.bodySizeLimit in next.config.ts (25mb, with encoding headroom).
const MAX_LEASE_PDF_BYTES = 20 * 1024 * 1024;

// ----- Create tenant + first tenancy -----

export async function createTenant(
  _prev: TenantFormState,
  formData: FormData,
): Promise<TenantFormState> {
  const full_name = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim() || null;
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const pays_as = String(formData.get("pays_as") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!full_name) return { error: "Tenant name is required." };

  // Optional initial tenancy
  const room_id = String(formData.get("room_id") ?? "").trim() || null;
  const monthly_rent_str = String(formData.get("monthly_rent") ?? "").trim();
  const security_deposit_str = String(
    formData.get("security_deposit") ?? "",
  ).trim();
  const start_date = String(formData.get("start_date") ?? "").trim() || null;
  const lease_end_date =
    String(formData.get("lease_end_date") ?? "").trim() || null;
  const first_month_rent_str = String(
    formData.get("first_month_rent") ?? "",
  ).trim();
  const leaseFile = formData.get("lease_pdf");

  if (room_id) {
    if (!monthly_rent_str)
      return { error: "Monthly rent is required when assigning a room." };
    // Guard against a $0 monthly rent (e.g. the prorated amount typed into
    // the wrong field) — it would post $0 for every month after the first.
    const monthly = Number(monthly_rent_str);
    if (!Number.isFinite(monthly) || monthly <= 0)
      return { error: "Monthly rent must be a number greater than 0." };
    if (!start_date)
      return { error: "Start date is required when assigning a room." };
  }

  // If a lease was provided but no room, the file would be orphaned.
  if (leaseFile instanceof File && leaseFile.size > 0 && !room_id) {
    return {
      error:
        "Pick a room (so the lease attaches to the tenancy) or remove the PDF.",
    };
  }
  if (
    leaseFile instanceof File &&
    leaseFile.size > 0 &&
    leaseFile.type !== "application/pdf"
  ) {
    return { error: "Lease file must be a PDF." };
  }
  if (leaseFile instanceof File && leaseFile.size > MAX_LEASE_PDF_BYTES) {
    return { error: "Lease PDF must be 20 MB or smaller." };
  }

  const supabase = await createClient();
  const { data: tenant, error: tErr } = await supabase
    .from("tenants")
    .insert({ full_name, email, phone, pays_as, notes })
    .select("id")
    .single();

  if (tErr) return { error: tErr.message };

  if (room_id && start_date) {
    const monthly_rent = Number(monthly_rent_str);
    const security_deposit = security_deposit_str
      ? Number(security_deposit_str)
      : null;

    let lease_pdf_path: string | null = null;
    if (leaseFile instanceof File && leaseFile.size > 0) {
      const filename = `${tenant.id}/${Date.now()}-${leaseFile.name.replace(/[^\w.\-]/g, "_")}`;
      const { error: upErr } = await supabase.storage
        .from("leases")
        .upload(filename, leaseFile, {
          contentType: "application/pdf",
          upsert: false,
        });
      if (upErr) {
        await supabase.from("tenants").delete().eq("id", tenant.id);
        return { error: `Failed to upload lease PDF: ${upErr.message}` };
      }
      lease_pdf_path = filename;
    }

    const first_month_rent = first_month_rent_str
      ? Number(first_month_rent_str)
      : null;
    if (
      first_month_rent !== null &&
      (!Number.isFinite(first_month_rent) || first_month_rent < 0)
    ) {
      if (lease_pdf_path) {
        await supabase.storage.from("leases").remove([lease_pdf_path]);
      }
      await supabase.from("tenants").delete().eq("id", tenant.id);
      return { error: "First month rent must be a non-negative number." };
    }

    const { error: leErr } = await supabase.from("tenancies").insert({
      room_id,
      tenant_id: tenant.id,
      start_date,
      lease_end_date,
      monthly_rent,
      security_deposit,
      status: "active",
      lease_pdf_path,
      first_month_rent,
    });

    if (leErr) {
      if (lease_pdf_path) {
        await supabase.storage.from("leases").remove([lease_pdf_path]);
      }
      await supabase.from("tenants").delete().eq("id", tenant.id);
      return { error: leErr.message };
    }

    // Mark the room as occupied and clear any "pending tenant" listing flag.
    await updateRoomsWithNotification(supabase, room_id, {
      status: "occupied",
      pending_tenant: false,
    });
  }

  revalidatePath("/tenants");
  revalidatePath("/inventory");
  revalidatePath("/properties");
  redirect(`/tenants/${tenant.id}`);
}

// Generate a short-lived signed URL for downloading the lease PDF.
export async function getLeaseDownloadUrl(
  tenancyId: string,
): Promise<{ url?: string; error?: string }> {
  const supabase = await createClient();
  const { data: tenancy, error } = await supabase
    .from("tenancies")
    .select("lease_pdf_path")
    .eq("id", tenancyId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!tenancy?.lease_pdf_path) return { error: "No lease on file." };

  const { data, error: signErr } = await supabase.storage
    .from("leases")
    .createSignedUrl(tenancy.lease_pdf_path, 60);
  if (signErr) return { error: signErr.message };
  return { url: data.signedUrl };
}

// ----- Update tenant info -----

export async function updateTenant(
  id: string,
  _prev: TenantFormState,
  formData: FormData,
): Promise<TenantFormState> {
  const full_name = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim() || null;
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const pays_as = String(formData.get("pays_as") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const profession =
    String(formData.get("profession") ?? "").trim() || null;
  const linkedin_url =
    String(formData.get("linkedin_url") ?? "").trim() || null;
  const instagram_url =
    String(formData.get("instagram_url") ?? "").trim() || null;
  const ageStr = String(formData.get("age") ?? "").trim();
  let age: number | null = null;
  if (ageStr !== "") {
    const n = Number(ageStr);
    if (!Number.isInteger(n) || n < 0 || n > 150) {
      return { error: "Age must be a whole number between 0 and 150." };
    }
    age = n;
  }

  const genderRaw = String(formData.get("gender") ?? "").trim();
  const gender = genderRaw === "" ? null : genderRaw;
  if (gender !== null && !["male", "female", "other"].includes(gender)) {
    return { error: "Gender must be male, female, or other." };
  }

  if (!full_name) return { error: "Name is required." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({
      full_name,
      email,
      phone,
      pays_as,
      notes,
      age,
      gender,
      profession,
      linkedin_url,
      instagram_url,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/tenants");
  revalidatePath(`/tenants/${id}`);
  return undefined;
}

// ----- Informational lease end date (does NOT drive move-out / inventory) -----
// Stored on the tenancy purely so the profile can show it and a cron can send a
// 45-day "lease ending" heads-up. Changing it re-arms that reminder.
export async function setTenancyStartDate(
  tenancyId: string,
  tenantId: string,
  date: string | null,
): Promise<{ ok: true } | { error: string }> {
  const value = date && date.trim() ? date.trim() : null;
  if (!value) return { error: "Lease start date is required." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("tenancies")
    .update({ start_date: value })
    .eq("id", tenancyId);
  if (error) return { error: error.message };
  revalidatePath("/tenants");
  if (tenantId) revalidatePath(`/tenants/${tenantId}`);
  return { ok: true };
}

// Inline edits for the tenancy's rent amounts. The ledger recomputes from
// these on every render, so changing them immediately reprices the auto
// monthly charges (first_month_rent applies only to the starting month).
export async function setTenancyRentAmount(
  tenancyId: string,
  tenantId: string,
  field: "monthly_rent" | "first_month_rent" | "security_deposit",
  value: string | null,
): Promise<{ ok: true } | { error: string }> {
  const raw = value?.trim() ?? "";
  let amount: number | null = null;
  if (raw !== "") {
    amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0)
      return { error: "Amount must be a non-negative number." };
  }
  if (field === "monthly_rent" && (amount === null || amount <= 0))
    return { error: "Monthly rent must be a number greater than 0." };
  const patch =
    field === "monthly_rent"
      ? { monthly_rent: amount as number }
      : field === "first_month_rent"
        ? { first_month_rent: amount }
        : { security_deposit: amount };

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenancies")
    .update(patch)
    .eq("id", tenancyId);
  if (error) return { error: error.message };
  revalidatePath("/tenants");
  if (tenantId) revalidatePath(`/tenants/${tenantId}`);
  return { ok: true };
}

export async function setTenancyLeaseEndDate(
  tenancyId: string,
  tenantId: string,
  date: string | null,
): Promise<{ ok: true } | { error: string }> {
  const value = date && date.trim() ? date.trim() : null;
  const supabase = await createClient();
  const { error } = await supabase
    .from("tenancies")
    .update({
      lease_end_date: value,
      lease_end_reminded_at: null,
      lease_end_reminded_30_at: null,
    })
    .eq("id", tenancyId);
  if (error) return { error: error.message };
  revalidatePath("/tenants");
  if (tenantId) revalidatePath(`/tenants/${tenantId}`);
  return { ok: true };
}

// ----- End (or schedule the end of) a tenancy -----
// If move_out_date is today or earlier  → tenant has moved out; room is Available now.
// If move_out_date is in the future     → tenant is still there until that date;
//                                    room stays Occupied but we set
//                                    `rooms.available_from = move_out_date` so it
//                                    surfaces on /inventory as "Available from X".
//                                    Tenancy stays 'active' and is auto-finalized
//                                    when move_out_date passes (see processExpiredTenancies).

async function applyMoveOut(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenancy_id: string,
  move_out_date: string,
) {
  const today = todayISO();
  const isPastOrToday = move_out_date <= today;

  const { data: tenancy } = await supabase
    .from("tenancies")
    .select("room_id, monthly_rent")
    .eq("id", tenancy_id)
    .single();

  await supabase
    .from("tenancies")
    .update({
      move_out_date,
      status: isPastOrToday ? "ended" : "active",
    })
    .eq("id", tenancy_id);

  if (tenancy?.room_id) {
    // Carry the last tenant's rent forward as the room's list price. Their
    // monthly_rent is the all-in total (base + $125 bundle), so split it back
    // into base_rent + the services bundle; the room's generated total_rent
    // then equals exactly what the tenant was paying.
    const total = Number(tenancy.monthly_rent);
    const rentPatch =
      Number.isFinite(total) && total > 0
        ? { base_rent: Math.max(0, total - BUNDLE_FEE), bundle_fee: BUNDLE_FEE }
        : {};

    // Re-entering the vacancy queue — reset the VA workflow flag to "no action"
    // so the room doesn't inherit the previous tenancy's color.
    await updateRoomsWithNotification(supabase, tenancy.room_id, {
      status: isPastOrToday ? "available" : "occupied",
      available_from: move_out_date,
      listing_action: "no_action",
      ...rentPatch,
    });
  }
}

export async function endTenancy(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  const tenant_id = String(formData.get("tenant_id") ?? "");
  const move_out_date = String(formData.get("move_out_date") ?? "").trim();
  if (!tenancy_id || !move_out_date) return;

  const supabase = await createClient();
  await applyMoveOut(supabase, tenancy_id, move_out_date);

  revalidatePath("/tenants");
  if (tenant_id) revalidatePath(`/tenants/${tenant_id}`);
  revalidatePath("/inventory");
}

// Inline edit for the move-out date badge. A new date reruns the same
// room/status side effects as ending the tenancy; clearing it cancels the
// move-out entirely (same as the "Cancel move out" button).
export async function setTenancyMoveOutDate(
  tenancyId: string,
  tenantId: string,
  date: string | null,
): Promise<{ ok: true } | { error: string }> {
  const value = date && date.trim() ? date.trim() : null;
  const supabase = await createClient();

  if (value) {
    await applyMoveOut(supabase, tenancyId, value);
  } else {
    const { data: tenancy } = await supabase
      .from("tenancies")
      .select("room_id")
      .eq("id", tenancyId)
      .single();
    await supabase
      .from("tenancies")
      .update({ move_out_date: null, status: "active" })
      .eq("id", tenancyId);
    if (tenancy?.room_id) {
      await updateRoomsWithNotification(supabase, tenancy.room_id, {
        status: "occupied",
        available_from: null,
      });
    }
  }

  revalidatePath("/tenants");
  if (tenantId) revalidatePath(`/tenants/${tenantId}`);
  revalidatePath("/inventory");
  return { ok: true };
}

// ----- Undo an end-tenancy (or revive a finalized one) -----

export async function reactivateTenancy(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  const tenant_id = String(formData.get("tenant_id") ?? "");
  if (!tenancy_id) return;

  const supabase = await createClient();

  const { data: tenancy } = await supabase
    .from("tenancies")
    .select("room_id")
    .eq("id", tenancy_id)
    .single();

  await supabase
    .from("tenancies")
    .update({ move_out_date: null, status: "active" })
    .eq("id", tenancy_id);

  if (tenancy?.room_id) {
    await updateRoomsWithNotification(supabase, tenancy.room_id, {
      status: "occupied",
      available_from: null,
    });
  }

  revalidatePath("/tenants");
  if (tenant_id) revalidatePath(`/tenants/${tenant_id}`);
  revalidatePath("/inventory");
}

// ----- Auto-finalize any tenancies whose move_out_date has now passed -----

export async function processExpiredTenancies() {
  const supabase = await createClient();
  const today = todayISO();

  const { data: expired } = await supabase
    .from("tenancies")
    .select("id, room_id")
    .eq("status", "active")
    .lt("move_out_date", today)
    .not("move_out_date", "is", null);

  if (!expired || expired.length === 0) return;

  const ids = expired.map((t) => t.id);
  const roomIds = expired
    .map((t) => t.room_id)
    .filter((v): v is string => Boolean(v));

  await supabase.from("tenancies").update({ status: "ended" }).in("id", ids);

  if (roomIds.length > 0) {
    await updateRoomsWithNotification(supabase, roomIds, {
      status: "available",
      listing_action: "no_action",
    });
  }
}

// ----- Delete tenant (and their tenancies + payments via cascades) -----

export async function deleteTenant(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();

  // Free up any rooms that were occupied by this tenant
  const { data: rooms } = await supabase
    .from("tenancies")
    .select("room_id")
    .eq("tenant_id", id)
    .eq("status", "active");

  await supabase.from("tenants").delete().eq("id", id);

  if (rooms && rooms.length > 0) {
    const roomIds = rooms.map((r) => r.room_id).filter(Boolean) as string[];
    if (roomIds.length > 0) {
      await updateRoomsWithNotification(supabase, roomIds, {
        status: "available",
      });
    }
  }

  revalidatePath("/tenants");
  revalidatePath("/inventory");
  redirect("/tenants");
}

// ----- Record a payment against a tenancy -----

export async function recordPayment(
  tenancyId: string,
  tenantId: string,
  _prev: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const paid_on = String(formData.get("paid_on") ?? "").trim();
  const amount_str = String(formData.get("amount") ?? "").trim();
  const payment_type = String(
    formData.get("payment_type") ?? "rent",
  ) as PaymentType;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!paid_on) return { error: "Payment date is required." };
  if (!amount_str) return { error: "Amount is required." };
  if (!VALID_PAYMENT_TYPES.includes(payment_type))
    return { error: "Invalid payment type." };

  const amount = Number(amount_str);
  if (!Number.isFinite(amount) || amount <= 0)
    return { error: "Amount must be a positive number." };

  const supabase = await createClient();
  const { error } = await supabase.from("payments").insert({
    tenancy_id: tenancyId,
    paid_on,
    amount,
    payment_type,
    notes,
  });

  if (error) return { error: error.message };

  revalidatePath("/tenants");
  revalidatePath(`/tenants/${tenantId}`);
  return undefined;
}

// ----- Delete a payment -----

export async function deletePayment(formData: FormData) {
  const payment_id = String(formData.get("payment_id") ?? "");
  const tenant_id = String(formData.get("tenant_id") ?? "");
  if (!payment_id) return;

  const supabase = await createClient();
  await supabase.from("payments").delete().eq("id", payment_id);

  revalidatePath("/tenants");
  if (tenant_id) revalidatePath(`/tenants/${tenant_id}`);
}

// ----- Add an ad-hoc charge (late fee, misc) to a tenancy -----

export async function addCharge(
  tenancyId: string,
  tenantId: string,
  _prev: ChargeFormState,
  formData: FormData,
): Promise<ChargeFormState> {
  const kind = String(formData.get("kind") ?? "") as ChargeKind;
  const amount_str = String(formData.get("amount") ?? "").trim();
  const charged_on = String(formData.get("charged_on") ?? "").trim() || todayISO();
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!VALID_CHARGE_KINDS.includes(kind))
    return { error: "Pick a valid charge type." };
  if (kind === "other" && !note)
    return { error: "Add a description for an Other charge." };
  const amount = Number(amount_str);
  if (!Number.isFinite(amount) || amount <= 0)
    return { error: "Amount must be a positive number." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("tenancy_charges")
    .insert({ tenancy_id: tenancyId, kind, amount, charged_on, note });
  if (error) return { error: error.message };

  revalidatePath("/tenants");
  revalidatePath(`/tenants/${tenantId}`);
  return undefined;
}

// ----- Acknowledge utility-overage alerts (moved-out tenants) -----
// Shares of an over-$200 utility split that belonged to tenants who had
// already moved out are not charged; they pop up on the Rent Tracker until
// the admin acknowledges them here.

export async function acknowledgeOverageAlerts(ids: string[]) {
  if (ids.length === 0) return;
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from("utility_overage_alerts")
    .update({ acknowledged_at: new Date().toISOString() })
    .in("id", ids);
  revalidatePath("/tenants");
}

export async function deleteCharge(formData: FormData) {
  // charge_ids carries one or more ids (a consolidated "Other" line deletes
  // every underlying charge at once).
  const ids = String(formData.get("charge_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tenant_id = String(formData.get("tenant_id") ?? "");
  if (ids.length === 0) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canEditLedger(user?.email)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from("tenancy_charges").delete().in("id", ids);

  revalidatePath("/tenants");
  if (tenant_id) revalidatePath(`/tenants/${tenant_id}`);
}

// ----- Manually email tenants with an outstanding balance -----
// Emails each active tenant whose running ledger balance (rent carry-forward
// plus any deposit / late-fee amounts owed) is positive. Meant to be
// run after the month's reconciliation has posted payments. Records a batch row
// so the page can show when these last went out.

export async function sendBalanceReminders(
  _prev: ReminderState,
  formData: FormData,
): Promise<ReminderState> {
  // Which channel(s) to send on: "email", "sms", or "both" (default).
  const channel = String(formData.get("channel") ?? "both");
  const doEmail = channel === "email" || channel === "both";
  const doSms = channel === "sms" || channel === "both";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthEnd = new Date(y, m + 1, 0).toISOString().slice(0, 10);
  const period = `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthLabel = now.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const today = todayISO();

  type ReminderTenancy = {
    id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    security_deposit: number | null;
    start_date: string;
    move_out_date: string | null;
    tenants:
      | { full_name: string; email: string | null; phone: string | null }
      | { full_name: string; email: string | null; phone: string | null }[]
      | null;
    rooms:
      | { properties: { is_new_york: boolean } | { is_new_york: boolean }[] | null }
      | { properties: { is_new_york: boolean } | { is_new_york: boolean }[] | null }[]
      | null;
    payments: { amount: number; paid_on: string; payment_type: string }[];
  };

  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date,
       tenants(full_name, email, phone),
       rooms(properties(is_new_york)),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "active")
    .returns<ReminderTenancy[]>();

  if (error) return { error: error.message };

  const { charges, allocations } = await fetchLedgerSidecars(supabase);

  let processed = 0;
  let sent = 0;
  let queued = 0;
  let failed = 0;
  let texted = 0;
  for (const row of data ?? []) {
    const tenant = one(row.tenants);
    const email = tenant?.email?.trim();
    if (!email) continue;
    // Skip tenancies that have already ended this month.
    if (row.move_out_date && row.move_out_date <= today) continue;
    // Skip tenancies that haven't started yet.
    if (row.start_date > monthEnd) continue;

    const { netBalance } = computeLedger(
      row,
      row.payments ?? [],
      charges.get(row.id) ?? [],
      allocations.get(row.id) ?? [],
      today,
    );
    if (netBalance <= 0.01) continue;
    processed++;

    if (doEmail) {
      // New York tenants get a plain, unbranded reminder from Vineet's personal
      // Gmail; everyone else goes through the default Resend sender.
      const isNewYork = one(one(row.rooms)?.properties)?.is_new_york ?? false;
      const res = isNewYork
        ? await sendBalanceReminderGmail(email, netBalance, monthLabel)
        : await sendBalanceReminder(email, netBalance, monthLabel);
      if (res.ok) {
        if ("queued" in res) queued++;
        else sent++;
      } else failed++;
    }

    // Text uses the same wording as the email. A failed text never blocks.
    const phone = tenant?.phone?.trim();
    if (doSms && phone) {
      const smsRes = await sendSms(
        phone,
        balanceReminderText(netBalance, monthLabel),
        { type: "rent_balance", context: `${tenant?.full_name ?? "Tenant"} · ${monthLabel}` },
      );
      if (smsRes.ok) texted++;
    }
  }

  if (processed === 0) {
    return { success: "No tenants have an outstanding balance this month." };
  }

  // Record the batch so the page can show when balance reminders last ran.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from("rent_reminder_batches").insert({
    kind: "balance",
    channel: doEmail && doSms ? "both" : doEmail ? "email" : "sms",
    period_month: period,
    recipient_count: doEmail ? sent + queued : texted,
    triggered_by: user?.email ?? null,
  });

  revalidatePath("/tenants");
  const parts: string[] = [];
  if (sent > 0) parts.push(`Emailed ${sent} balance reminder${sent === 1 ? "" : "s"}.`);
  if (queued > 0)
    parts.push(
      `${queued} queued for tomorrow — Resend daily limit reached.`,
    );
  if (texted > 0) parts.push(`Texted ${texted}.`);
  if (failed > 0) parts.push(`${failed} failed to send.`);
  if (parts.length === 0) {
    parts.push(
      doSms
        ? "No owing tenants have a phone number on file."
        : "Nothing to send.",
    );
  }
  return { success: parts.join(" ") };
}
