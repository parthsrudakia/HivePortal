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
import { computeLedger, LEDGER_PAYMENT_CUTOFF } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { buildBalanceDetail, type BalanceDetail } from "@/lib/balance-detail";
import { updateTenancyRent } from "@/lib/rent-history";
import { canEditLedger, LEDGER_ADMIN_ERROR } from "@/lib/access";
import { AGREEMENTS_BUCKET } from "@/lib/agreement-send";

// Accrual-affecting mutations (rent amounts, tenancy dates, deleting
// payments/tenants) change what a tenant owes just as directly as a charge
// row — same two-operator restriction as charges.
async function requireLedgerAdmin(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return canEditLedger(user?.email) ? null : LEDGER_ADMIN_ERROR;
}

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
  // Present when the form was opened from the signing tally's "Add a tenant"
  // button — the request's signed PDF becomes the tenancy's lease PDF.
  const agreement_request_id =
    String(formData.get("agreement_request_id") ?? "").trim() || null;

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
  // Same rule for a signed agreement: it attaches to the tenancy, so a room
  // is required.
  if (agreement_request_id && !room_id) {
    return {
      error: "Pick a room so the signed agreement attaches to the tenancy.",
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
  const denied = await requireLedgerAdmin(supabase);
  if (denied) return { error: denied };
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
    if (agreement_request_id) {
      // Copy the request's signed PDF into the leases bucket (the request's
      // own copy stays immutable), same as the tally's Assign flow.
      const { data: request } = await supabase
        .from("agreement_requests")
        .select("id, status, signed_pdf_path")
        .eq("id", agreement_request_id)
        .maybeSingle();
      if (!request || request.status !== "signed" || !request.signed_pdf_path) {
        await supabase.from("tenants").delete().eq("id", tenant.id);
        return {
          error: "That signed agreement could not be found — it may have been cleared.",
        };
      }
      const { data: pdfBlob, error: downloadError } = await supabase.storage
        .from(AGREEMENTS_BUCKET)
        .download(request.signed_pdf_path);
      if (downloadError || !pdfBlob) {
        await supabase.from("tenants").delete().eq("id", tenant.id);
        return { error: "The signed agreement PDF could not be read from storage." };
      }
      const filename = `${tenant.id}/${Date.now()}-signed-agreement.pdf`;
      const { error: upErr } = await supabase.storage
        .from("leases")
        .upload(filename, Buffer.from(await pdfBlob.arrayBuffer()), {
          contentType: "application/pdf",
        });
      if (upErr) {
        await supabase.from("tenants").delete().eq("id", tenant.id);
        return { error: `Failed to attach the signed agreement: ${upErr.message}` };
      }
      lease_pdf_path = filename;
    } else if (leaseFile instanceof File && leaseFile.size > 0) {
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

    const { data: tenancy, error: leErr } = await supabase
      .from("tenancies")
      .insert({
        room_id,
        tenant_id: tenant.id,
        start_date,
        lease_end_date,
        monthly_rent,
        security_deposit,
        status: start_date > todayISO() ? "upcoming" : "active",
        lease_pdf_path,
        first_month_rent,
      })
      .select("id")
      .single();

    if (leErr) {
      if (lease_pdf_path) {
        await supabase.storage.from("leases").remove([lease_pdf_path]);
      }
      await supabase.from("tenants").delete().eq("id", tenant.id);
      return { error: leErr.message };
    }

    // A deposit entered during onboarding is money owed, not just profile
    // metadata. Post the matching charge dated at move-in; future-dated rows
    // stay out of the running balance until that date.
    if (security_deposit !== null && security_deposit > 0 && tenancy) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: depositError } = await (supabase as any)
        .from("tenancy_charges")
        .insert({
          tenancy_id: tenancy.id,
          kind: "security_deposit",
          amount: security_deposit,
          charged_on: start_date,
          note: "Security deposit due at move-in",
        });
      if (depositError) {
        await supabase.from("tenancies").delete().eq("id", tenancy.id);
        if (lease_pdf_path) {
          await supabase.storage.from("leases").remove([lease_pdf_path]);
        }
        await supabase.from("tenants").delete().eq("id", tenant.id);
        return {
          error: `Failed to post the security-deposit charge: ${depositError.message}`,
        };
      }
    }

    // Point the signing tally at the tenancy so the request shows as
    // assigned instead of resurfacing in the assign picker. Best-effort,
    // matching the tally's own Assign flow.
    if (agreement_request_id && tenancy) {
      await supabase
        .from("agreement_requests")
        .update({
          assigned_tenancy_id: tenancy.id,
          assigned_at: new Date().toISOString(),
        })
        .eq("id", agreement_request_id);
      revalidatePath("/agreements");
    }

    // Future tenancies reserve the room but do not become billable/active
    // until the lifecycle cron reaches their start date.
    await updateRoomsWithNotification(supabase, room_id, {
      status: start_date > todayISO() ? "reserved" : "occupied",
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
  const denied = await requireLedgerAdmin(supabase);
  if (denied) return { error: denied };
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
  const denied = await requireLedgerAdmin(supabase);
  if (denied) return { error: denied };
  // The profile shows lease_start_date ?? start_date, so edit whichever is
  // currently displayed. Before any renewal that's start_date (the move-in,
  // which also anchors ledger accrual — pre-renewal they're the same lease);
  // after a renewal it's lease_start_date, and accrual stays untouched.
  const { data: cur } = await supabase
    .from("tenancies")
    .select("lease_start_date")
    .eq("id", tenancyId)
    .single();
  const { error } = await supabase
    .from("tenancies")
    .update(
      cur?.lease_start_date
        ? { lease_start_date: value }
        : { start_date: value },
    )
    .eq("id", tenancyId);
  if (error) return { error: error.message };
  revalidatePath("/tenants");
  if (tenantId) revalidatePath(`/tenants/${tenantId}`);
  return { ok: true };
}

// Inline edits for the tenancy's rent amounts. The ledger recomputes from
// these on every render (first_month_rent applies only to the starting
// month). A monthly-rent change is a lease renewal: it requires the new
// lease's start and end dates and takes effect from the lease-start month —
// which may be in the past for a renewal recorded late; months before the
// lease start keep billing the old rate.
export async function setTenancyRentAmount(
  tenancyId: string,
  tenantId: string,
  field: "monthly_rent" | "first_month_rent" | "security_deposit",
  value: string | null,
  newLease?: { start: string; end: string },
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

  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (field === "monthly_rent") {
    if (!newLease || !isDate(newLease.start) || !isDate(newLease.end))
      return {
        error:
          "A rent change needs the new lease's start and end dates — the new rent takes effect from the lease start.",
      };
    if (newLease.end <= newLease.start)
      return { error: "The new lease's end date must be after its start date." };
  }

  const patch =
    field === "monthly_rent"
      ? {
          monthly_rent: amount as number,
          // The renewal's dates replace the displayed lease start/end. The
          // start goes to lease_start_date — NOT start_date, which is the
          // move-in anchoring ledger accrual — and the new end re-arms the
          // lease-ending reminder crons (same as setTenancyLeaseEndDate).
          lease_start_date: newLease!.start,
          lease_end_date: newLease!.end,
          lease_end_reminded_at: null,
          lease_end_reminded_30_at: null,
        }
      : field === "first_month_rent"
        ? { first_month_rent: amount }
        : { security_deposit: amount };

  const supabase = await createClient();
  const denied = await requireLedgerAdmin(supabase);
  if (denied) return { error: denied };

  // The rate-history row and tenancy terms are committed together by the
  // database. A failure cannot leave one updated without the other.
  if (field === "monthly_rent") {
    const { error: rentError } = await updateTenancyRent(
      supabase,
      tenancyId,
      amount as number,
      newLease!.start,
      newLease!.start,
      newLease!.end,
    );
    if (rentError) return { error: rentError };
    revalidatePath("/tenants");
    if (tenantId) revalidatePath(`/tenants/${tenantId}`);
    return { ok: true };
  }

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
  const denied = await requireLedgerAdmin(supabase);
  if (denied) return { error: denied };
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

  const { data: tenancy, error: tenancyLoadError } = await supabase
    .from("tenancies")
    .select("room_id, monthly_rent, start_date, move_out_date, status")
    .eq("id", tenancy_id)
    .single();
  if (tenancyLoadError || !tenancy) {
    return { error: tenancyLoadError?.message ?? "Tenancy not found." };
  }
  if (move_out_date < tenancy.start_date) {
    return { error: "Move-out date cannot be before the tenancy start date." };
  }

  const { error: tenancyUpdateError } = await supabase
    .from("tenancies")
    .update({
      move_out_date,
      status: isPastOrToday ? "ended" : "active",
    })
    .eq("id", tenancy_id);
  if (tenancyUpdateError) return { error: tenancyUpdateError.message };

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
    const { error: roomError } = await updateRoomsWithNotification(
      supabase,
      tenancy.room_id,
      {
      status: isPastOrToday ? "available" : "occupied",
      available_from: move_out_date,
      listing_action: "no_action",
      ...rentPatch,
      },
    );
    if (roomError) {
      await supabase
        .from("tenancies")
        .update({
          move_out_date: tenancy.move_out_date,
          status: tenancy.status,
        })
        .eq("id", tenancy_id);
      return { error: roomError.message };
    }
  }
  return {};
}

export async function endTenancy(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  const tenant_id = String(formData.get("tenant_id") ?? "");
  const move_out_date = String(formData.get("move_out_date") ?? "").trim();
  if (!tenancy_id || !move_out_date) return;

  const supabase = await createClient();
  if (await requireLedgerAdmin(supabase)) return;
  const result = await applyMoveOut(supabase, tenancy_id, move_out_date);
  if (result.error) throw new Error(result.error);

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
  const denied = await requireLedgerAdmin(supabase);
  if (denied) return { error: denied };

  if (value) {
    const result = await applyMoveOut(supabase, tenancyId, value);
    if (result.error) return { error: result.error };
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
  if (await requireLedgerAdmin(supabase)) return;

  const { data: tenancy } = await supabase
    .from("tenancies")
    .select("room_id")
    .eq("id", tenancy_id)
    .single();

  // Never create two active tenancies on one room: if it was re-let after
  // this tenancy ended, reactivation must not double-accrue rent on it.
  if (tenancy?.room_id) {
    const { data: conflict } = await supabase
      .from("tenancies")
      .select("id")
      .eq("room_id", tenancy.room_id)
      .eq("status", "active")
      .neq("id", tenancy_id)
      .maybeSingle();
    if (conflict) return;
  }

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

// ----- Delete tenant (and their tenancies + payments via cascades) -----

export async function deleteTenant(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  // Deleting a tenant is operator-only; payment history blocks it entirely
  // (payments are on delete RESTRICT — the books outlive the tenant).
  if (await requireLedgerAdmin(supabase)) return;

  // Free up any rooms that were occupied by this tenant
  const { data: rooms } = await supabase
    .from("tenancies")
    .select("room_id")
    .eq("tenant_id", id)
    .eq("status", "active");

  const { error } = await supabase.from("tenants").delete().eq("id", id);
  if (error) {
    // 23503 = the payments FK (on delete restrict): financial history is
    // never deleted with its tenant.
    throw new Error(
      error.code === "23503"
        ? "This tenant has payment history, which can't be deleted. Move them out instead — the tenancy ends but the books keep their record."
        : `Failed to delete tenant: ${error.message}`,
    );
  }

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

// ----- Dismiss a moved-out tenant's outstanding balance -----
// Hides the tenancy from the Rent Tracker's "Moved out with balance" list
// (debt collected outside the system, offset, or written off). The ledger
// itself is untouched and the dismissal is reversible.

export async function dismissEndedBalance(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  if (!tenancy_id) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);

  await supabase
    .from("tenancies")
    .update({
      balance_dismissed_at: new Date().toISOString(),
      balance_dismissed_by: user?.email ?? null,
    })
    .eq("id", tenancy_id);
  revalidatePath("/tenants");
}

export async function undismissEndedBalance(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  if (!tenancy_id) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);

  await supabase
    .from("tenancies")
    .update({ balance_dismissed_at: null, balance_dismissed_by: null })
    .eq("id", tenancy_id);
  revalidatePath("/tenants");
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paid_on))
    return { error: "Payment date must be YYYY-MM-DD." };
  if (paid_on > todayISO())
    return { error: "Payment date can't be in the future." };
  // A rent payment dated before the ledger cutoff would be silently excluded
  // from the balance (pre-ledger months are treated as settled) — catch the
  // typo here instead of recording invisible money.
  if (payment_type === "rent" && paid_on < LEDGER_PAYMENT_CUTOFF)
    return {
      error: `Rent payments must be dated ${LEDGER_PAYMENT_CUTOFF} or later — earlier months predate the ledger and wouldn't count toward the balance.`,
    };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  if (payment_type === "refund" && !canEditLedger(user.email)) {
    return { error: LEDGER_ADMIN_ERROR };
  }
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
  if (await requireLedgerAdmin(supabase)) return;
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(charged_on))
    return { error: "Charge date must be YYYY-MM-DD." };
  if (charged_on > todayISO())
    return { error: "Charge date can't be in the future." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("tenancy_charges")
    .insert({
      tenancy_id: tenancyId,
      kind,
      amount,
      charged_on,
      note,
      dedupe_key:
        kind === "late_fee" ? `late_fee:${charged_on.slice(0, 7)}` : null,
    });
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // The popup is operator-facing; only the ledger admins may dismiss it.
  if (!canEditLedger(user?.email)) return;
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
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
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
    payments: {
      id: string;
      amount: number;
      paid_on: string;
      payment_type: string;
      notes: string | null;
    }[];
  };

  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date,
       tenants(full_name, email, phone),
       rooms(properties(is_new_york)),
       payments(id, amount, paid_on, payment_type, notes)`,
    )
    .eq("status", "active")
    .returns<ReminderTenancy[]>();

  if (error) return { error: error.message };

  const { charges, allocations, rentChanges } =
    await fetchLedgerSidecars(supabase);

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
    if (row.start_date > today) continue;

    const { netBalance } = computeLedger(
      row,
      row.payments ?? [],
      charges.get(row.id) ?? [],
      allocations.get(row.id) ?? [],
      today,
      rentChanges.get(row.id) ?? [],
    );
    if (netBalance <= 0.01) continue;
    processed++;

    if (doEmail) {
      // Mini ledger: the open lines behind the balance, plus statement links
      // for any utility charge in it. Best-effort — a breakdown failure never
      // blocks the reminder itself.
      let detail: BalanceDetail | undefined;
      try {
        detail = await buildBalanceDetail(supabase, {
          tenancy: row,
          payments: row.payments ?? [],
          charges: charges.get(row.id) ?? [],
          rentChanges: rentChanges.get(row.id) ?? [],
          today,
        });
      } catch (e) {
        console.error("[balance-reminders] breakdown failed:", e);
      }
      // New York tenants get a plain, unbranded reminder from Vineet's personal
      // Gmail; everyone else goes through the default Resend sender.
      const isNewYork = one(one(row.rooms)?.properties)?.is_new_york ?? false;
      const res = isNewYork
        ? await sendBalanceReminderGmail(email, netBalance, monthLabel, detail)
        : await sendBalanceReminder(email, netBalance, monthLabel, detail);
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
