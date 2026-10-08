"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isValid, zUuid, zUuidArray } from "@/lib/validation";
import { getSessionUser } from "@/lib/session";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";
import { roomLabel } from "@/lib/room-label";
import { updateRoomsWithNotification } from "@/lib/notifications";
import {
  sendBalanceReminderOutlook,
  sendBalanceReminderGmail,
  balanceReminderText,
  sendOtherChargeNotice,
  sendOtherChargeNoticeGmail,
} from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { todayISO, addDaysISO, proratedMonthRemainder } from "@/lib/date";
import { computeLedger, LEDGER_PAYMENT_CUTOFF } from "@/lib/rent";
import {
  fetchLedgerSidecars,
  fetchTenantLedgers,
  loadTenancyNetBalance,
  tenantLedger,
} from "@/lib/rent-data";
import {
  buildBalanceDetail,
  buildTenantBalanceDetail,
  type BalanceDetail,
} from "@/lib/balance-detail";
import { updateTenancyRent } from "@/lib/rent-history";
import { applyMoveOut } from "@/lib/move-out";
import {
  createTenancyForTenant,
  findRoomClash,
} from "@/lib/tenancy-create";
import { canEditLedger, LEDGER_ADMIN_ERROR } from "@/lib/access";
import { AGREEMENTS_BUCKET } from "@/lib/agreement-send";
import { findExistingTenant, mergeTenantProfile } from "@/lib/tenant-identity";

// Accrual-affecting mutations (rent amounts, tenancy dates, deleting
// payments/tenants) change what a tenant owes just as directly as a charge
// row — same two-operator restriction as charges.
async function requireLedgerAdmin(): Promise<string | null> {
  const user = await getSessionUser();
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

// Date-only strings (YYYY-MM-DD) headed for date columns / date comparisons.
const zIsoDate = z.iso.date();

// Repeated `social_links` inputs → clean deduped list, or an error string.
// Lenient on purpose: any URL-ish profile link is fine, not just LinkedIn
// and Instagram.
const MAX_SOCIAL_LINKS = 10;
function parseSocialLinks(formData: FormData): string[] | string {
  const links = Array.from(
    new Set(
      formData
        .getAll("social_links")
        .map((v) => String(v).trim())
        .filter(Boolean),
    ),
  );
  if (links.length > MAX_SOCIAL_LINKS)
    return `At most ${MAX_SOCIAL_LINKS} social links.`;
  const tooLong = links.find((l) => l.length > 300);
  if (tooLong) return "Each social link must be 300 characters or fewer.";
  return links;
}

export type TenantFormState = { error?: string } | undefined;
export type PaymentFormState = { error?: string } | undefined;
export type ChargeFormState = { error?: string } | undefined;
export type ReminderState = { error?: string; success?: string } | undefined;

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
  const social_links = parseSocialLinks(formData);
  if (typeof social_links === "string") return { error: social_links };

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

  if (room_id && !isValid(zUuid, room_id))
    return { error: "Invalid room id." };
  if (agreement_request_id && !isValid(zUuid, agreement_request_id))
    return { error: "Invalid agreement request id." };
  if (start_date && !isValid(zIsoDate, start_date))
    return { error: "Start date must be YYYY-MM-DD." };
  if (lease_end_date && !isValid(zIsoDate, lease_end_date))
    return { error: "Lease end date must be YYYY-MM-DD." };
  // Checked before anything is inserted: a NaN deposit would otherwise land
  // in the tenancy row (Postgres numeric accepts NaN).
  if (security_deposit_str) {
    const dep = Number(security_deposit_str);
    if (!Number.isFinite(dep) || dep < 0)
      return { error: "Security deposit must be a non-negative number." };
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
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };

  // Submit-time double-booking guard. The room picker filters taken rooms
  // the same way, but another tenant can land in the room between the page
  // render and this submit.
  if (room_id && start_date) {
    const clash = await findRoomClash(supabase, room_id, start_date);
    if (clash) return clash;
  }

  // A tenant is unique by email: the same address with a matching name is
  // the same person coming back, so reuse their record (one ledger, one
  // history) instead of creating a second tenant.
  const existing = await findExistingTenant(supabase, { email, full_name });
  let tenantId = "";
  let createdTenant = false;
  if (existing) {
    if (room_id && start_date) {
      // One live tenancy per tenant — same rule as Start new tenancy.
      const { data: live } = await supabase
        .from("tenancies")
        .select("id, status, rooms(room_number, properties(building_name, street_address, unit_number))")
        .eq("tenant_id", existing.id)
        .in("status", ["active", "upcoming"]);
      if ((live ?? []).length > 0) {
        return {
          error: `${existing.full_name} is already in the system with this email and has an active or upcoming tenancy. Open their profile and use Transfer to move them instead of adding them again.`,
        };
      }
    }
    const patch = mergeTenantProfile(existing, {
      phone,
      pays_as,
      notes,
      social_links,
    });
    if (Object.keys(patch).length > 0) {
      const { error: uErr } = await supabase
        .from("tenants")
        .update(patch)
        .eq("id", existing.id);
      if (uErr) return { error: uErr.message };
    }
    tenantId = existing.id;
  } else {
    const { data: tenant, error: tErr } = await supabase
      .from("tenants")
      .insert({
        full_name,
        email,
        phone,
        pays_as,
        notes,
        social_links,
      })
      .select("id")
      .single();
    if (tErr) return { error: tErr.message };
    tenantId = tenant.id;
    createdTenant = true;
  }
  // Only a record this submit created is removed on a later failure — a
  // reused tenant keeps their profile and history.
  const rollbackTenant = async () => {
    if (createdTenant)
      await supabase.from("tenants").delete().eq("id", tenantId);
  };

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
        await rollbackTenant();
        return {
          error: "That signed agreement could not be found — it may have been cleared.",
        };
      }
      const { data: pdfBlob, error: downloadError } = await supabase.storage
        .from(AGREEMENTS_BUCKET)
        .download(request.signed_pdf_path);
      if (downloadError || !pdfBlob) {
        await rollbackTenant();
        return { error: "The signed agreement PDF could not be read from storage." };
      }
      const filename = `${tenantId}/${Date.now()}-signed-agreement.pdf`;
      const { error: upErr } = await supabase.storage
        .from("leases")
        .upload(filename, Buffer.from(await pdfBlob.arrayBuffer()), {
          contentType: "application/pdf",
        });
      if (upErr) {
        await rollbackTenant();
        return { error: `Failed to attach the signed agreement: ${upErr.message}` };
      }
      lease_pdf_path = filename;
    } else if (leaseFile instanceof File && leaseFile.size > 0) {
      const filename = `${tenantId}/${Date.now()}-${leaseFile.name.replace(/[^\w.\-]/g, "_")}`;
      const { error: upErr } = await supabase.storage
        .from("leases")
        .upload(filename, leaseFile, {
          contentType: "application/pdf",
          upsert: false,
        });
      if (upErr) {
        await rollbackTenant();
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
      await rollbackTenant();
      return { error: "First month rent must be a non-negative number." };
    }

    const { data: tenancy, error: leErr } = await supabase
      .from("tenancies")
      .insert({
        room_id,
        tenant_id: tenantId,
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
      await rollbackTenant();
      return { error: leErr.message };
    }

    // A deposit entered during onboarding is money owed, not just profile
    // metadata. Post the matching charge dated at move-in; future-dated rows
    // stay out of the running balance until that date.
    if (security_deposit !== null && security_deposit > 0 && tenancy) {
      const { error: depositError } = await supabase
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
        await rollbackTenant();
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
  revalidatePath("/tenants/new");
  revalidatePath("/properties");
  redirect(`/tenants/${tenantId}`);
}

// Generate a short-lived signed URL for downloading the lease PDF.
export async function getLeaseDownloadUrl(
  tenancyId: string,
): Promise<{ url?: string; error?: string }> {
  if (!isValid(zUuid, tenancyId)) return { error: "Invalid tenancy id." };
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
  const social_links = parseSocialLinks(formData);
  if (typeof social_links === "string") return { error: social_links };
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
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };
  if (!isValid(zUuid, id)) return { error: "Invalid tenant id." };
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
      social_links,
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
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };
  if (!isValid(zUuid, tenancyId)) return { error: "Invalid tenancy id." };
  if (tenantId && !isValid(zUuid, tenantId))
    return { error: "Invalid tenant id." };
  if (!isValid(zIsoDate, value))
    return { error: "Lease start date must be YYYY-MM-DD." };
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
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };
  if (!isValid(zUuid, tenancyId)) return { error: "Invalid tenancy id." };
  if (tenantId && !isValid(zUuid, tenantId))
    return { error: "Invalid tenant id." };
  if (
    !isValid(
      z.enum(["monthly_rent", "first_month_rent", "security_deposit"]),
      field,
    )
  )
    return { error: "Invalid rent field." };

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
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };
  if (!isValid(zUuid, tenancyId)) return { error: "Invalid tenancy id." };
  if (tenantId && !isValid(zUuid, tenantId))
    return { error: "Invalid tenant id." };
  if (value !== null && !isValid(zIsoDate, value))
    return { error: "Lease end date must be YYYY-MM-DD." };
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

// Move-out semantics + shared applyMoveOut live in @/lib/move-out (also used
// by the property-delete flow, which winds down active tenancies first).

export async function endTenancy(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  const tenant_id = String(formData.get("tenant_id") ?? "");
  const move_out_date = String(formData.get("move_out_date") ?? "").trim();
  if (!tenancy_id || !move_out_date) return;

  const supabase = await createClient();
  if (await requireLedgerAdmin()) return;
  if (
    !isValid(zUuid, tenancy_id) ||
    !isValid(zIsoDate, move_out_date) ||
    (tenant_id !== "" && !isValid(zUuid, tenant_id))
  )
    return;
  const result = await applyMoveOut(supabase, tenancy_id, move_out_date);
  if (result.error) throw new Error(result.error);

  revalidatePath("/tenants");
  if (tenant_id) revalidatePath(`/tenants/${tenant_id}`);
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
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
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };
  if (!isValid(zUuid, tenancyId)) return { error: "Invalid tenancy id." };
  if (tenantId && !isValid(zUuid, tenantId))
    return { error: "Invalid tenant id." };
  if (value !== null && !isValid(zIsoDate, value))
    return { error: "Move-out date must be YYYY-MM-DD." };

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
  revalidatePath("/tenants/new");
  return { ok: true };
}

// ----- Cancel an upcoming move-in -----
// Removes a not-yet-started tenancy (a reservation) so the room can be listed
// again — used from the Add Inventory dialog when the operator chooses to drop
// the reservation. The tenancy's ledger charges (deposit, etc.) go with it;
// recorded payments block the delete the same way they block deleteTenant.

export async function cancelUpcomingTenancy(
  roomId: string,
  availableFrom: string | null,
): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };
  if (!isValid(zUuid, roomId)) return { error: "Invalid room id." };
  const value =
    availableFrom && availableFrom.trim() ? availableFrom.trim() : null;
  if (value !== null && !isValid(zIsoDate, value))
    return { error: "Available-from date must be YYYY-MM-DD." };

  // One live tenancy per room is DB-enforced, so at most one row matches.
  const { data: tenancy, error: findError } = await supabase
    .from("tenancies")
    .select("id, tenant_id")
    .eq("room_id", roomId)
    .eq("status", "upcoming")
    .maybeSingle();
  if (findError) return { error: findError.message };
  if (!tenancy) return { error: "No upcoming move-in found for this room." };

  const { error: chargesError } = await supabase
    .from("tenancy_charges")
    .delete()
    .eq("tenancy_id", tenancy.id);
  if (chargesError) return { error: chargesError.message };

  const { error: deleteError } = await supabase
    .from("tenancies")
    .delete()
    .eq("id", tenancy.id);
  if (deleteError)
    return {
      error:
        deleteError.code === "23503"
          ? "This move-in already has payments recorded, so it can't be cancelled here. Delete the payments on the tenant's ledger first, or keep the reservation."
          : deleteError.message,
    };

  const { error: roomError } = await updateRoomsWithNotification(
    supabase,
    roomId,
    { status: "available", available_from: value },
  );
  if (roomError) return { error: roomError.message };

  // Fresh listing — drop ads left over from the previous vacancy cycle
  // (best-effort; stale ads never block the cancel).
  await supabase.from("room_ads").delete().eq("room_id", roomId);

  revalidatePath("/tenants");
  if (tenancy.tenant_id) revalidatePath(`/tenants/${tenancy.tenant_id}`);
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  return { ok: true };
}

// ----- Undo an end-tenancy (or revive a finalized one) -----

export async function reactivateTenancy(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  const tenant_id = String(formData.get("tenant_id") ?? "");
  if (!tenancy_id) return;

  const supabase = await createClient();
  if (await requireLedgerAdmin()) return;
  if (
    !isValid(zUuid, tenancy_id) ||
    (tenant_id !== "" && !isValid(zUuid, tenant_id))
  )
    return;

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
  revalidatePath("/tenants/new");
}

// ----- Start a NEW tenancy for an existing tenant (reactivate) -----
// Unlike reactivateTenancy above (which un-ends the same tenancy and would
// back-bill every month since the move-out), this starts a fresh tenancy
// with fresh terms — same or different room, new rent, new start date. The
// old ledger stays closed in history; no back-billing.

export async function startNewTenancy(
  _prev: TenantFormState,
  formData: FormData,
): Promise<TenantFormState> {
  const tenant_id = String(formData.get("tenant_id") ?? "").trim();
  const room_id = String(formData.get("room_id") ?? "").trim();
  const start_date = String(formData.get("start_date") ?? "").trim();
  const monthly_rent_str = String(formData.get("monthly_rent") ?? "").trim();
  const first_month_rent_str = String(
    formData.get("first_month_rent") ?? "",
  ).trim();
  const security_deposit_str = String(
    formData.get("security_deposit") ?? "",
  ).trim();
  const lease_end_date =
    String(formData.get("lease_end_date") ?? "").trim() || null;

  const supabase = await createClient();
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };

  if (!isValid(zUuid, tenant_id)) return { error: "Invalid tenant id." };
  if (!room_id) return { error: "Pick a room." };
  if (!isValid(zUuid, room_id)) return { error: "Invalid room id." };
  if (!isValid(zIsoDate, start_date))
    return { error: "Start date must be YYYY-MM-DD." };
  if (lease_end_date && !isValid(zIsoDate, lease_end_date))
    return { error: "Lease end date must be YYYY-MM-DD." };
  const monthly_rent = Number(monthly_rent_str);
  if (!Number.isFinite(monthly_rent) || monthly_rent <= 0)
    return { error: "Monthly rent must be a number greater than 0." };
  const first_month_rent = first_month_rent_str
    ? Number(first_month_rent_str)
    : null;
  if (
    first_month_rent !== null &&
    (!Number.isFinite(first_month_rent) || first_month_rent < 0)
  )
    return { error: "First month rent must be a non-negative number." };
  const security_deposit = security_deposit_str
    ? Number(security_deposit_str)
    : null;
  if (
    security_deposit !== null &&
    (!Number.isFinite(security_deposit) || security_deposit < 0)
  )
    return { error: "Security deposit must be a non-negative number." };

  // One live tenancy per tenant — reactivation is for someone fully out.
  const { data: live } = await supabase
    .from("tenancies")
    .select("id")
    .eq("tenant_id", tenant_id)
    .in("status", ["active", "upcoming"]);
  if ((live ?? []).length > 0)
    return { error: "This tenant already has an active or upcoming tenancy." };

  const created = await createTenancyForTenant(supabase, {
    tenant_id,
    room_id,
    start_date,
    monthly_rent,
    // Mid-month starts default to a prorated first month (the ledger bills
    // whole months); the form can override with an explicit value.
    first_month_rent:
      first_month_rent === null && !start_date.endsWith("-01")
        ? proratedMonthRemainder(start_date, monthly_rent)
        : first_month_rent,
    security_deposit,
    lease_end_date,
    postDepositCharge: true,
  });
  if ("error" in created) return { error: created.error };

  revalidatePath("/tenants");
  revalidatePath(`/tenants/${tenant_id}`);
  revalidatePath("/tenants/history");
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath("/properties");
  return undefined;
}

// ----- Transfer an active tenant to a different room -----
// Ends the current tenancy on the transfer date (the tenant's last day in
// the old room) and starts a new tenancy in the destination, carrying the
// old ledger's net position across as a settlement/adjustment pair so the
// tenant owes (or is owed) the same total, just in one place.

export type TransferFormState =
  | { error?: string; warning?: string }
  | undefined;

type TransferRoomRel = {
  room_number: string | null;
  properties:
    | { building_name: string | null; street_address: string; unit_number: string }
    | { building_name: string | null; street_address: string; unit_number: string }[]
    | null;
};

const fmtUsd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function transferRoomLabel(room: TransferRoomRel | null): string {
  if (!room) return "previous room";
  const p = one(room.properties);
  const unit = p
    ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
    : "—";
  return `${unit} · ${room.room_number ?? "Room"}`;
}

export async function transferTenancy(
  _prev: TransferFormState,
  formData: FormData,
): Promise<TransferFormState> {
  const tenancy_id = String(formData.get("tenancy_id") ?? "").trim();
  const tenant_id = String(formData.get("tenant_id") ?? "").trim();
  const dest_room_id = String(formData.get("dest_room_id") ?? "").trim();
  const transfer_date = String(formData.get("transfer_date") ?? "").trim();
  const new_start_raw = String(formData.get("new_start_date") ?? "").trim();
  const new_rent_str = String(formData.get("new_monthly_rent") ?? "").trim();
  const first_month_rent_str = String(
    formData.get("first_month_rent") ?? "",
  ).trim();
  const new_deposit_str = String(
    formData.get("new_security_deposit") ?? "",
  ).trim();

  const supabase = await createClient();
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };

  if (!isValid(zUuid, tenancy_id) || !isValid(zUuid, tenant_id))
    return { error: "Invalid tenancy or tenant id." };
  if (!dest_room_id) return { error: "Pick a destination room." };
  if (!isValid(zUuid, dest_room_id))
    return { error: "Invalid destination room id." };
  if (!isValid(zIsoDate, transfer_date))
    return { error: "Transfer date must be YYYY-MM-DD." };
  const new_start_date = new_start_raw || addDaysISO(transfer_date, 1);
  if (!isValid(zIsoDate, new_start_date))
    return { error: "New start date must be YYYY-MM-DD." };
  if (new_start_date <= transfer_date)
    return {
      error: "The new room's start date must be after the transfer date.",
    };
  const new_monthly_rent = Number(new_rent_str);
  if (!Number.isFinite(new_monthly_rent) || new_monthly_rent <= 0)
    return { error: "Monthly rent must be a number greater than 0." };
  const first_month_rent = first_month_rent_str
    ? Number(first_month_rent_str)
    : null;
  if (
    first_month_rent !== null &&
    (!Number.isFinite(first_month_rent) || first_month_rent < 0)
  )
    return { error: "First month rent must be a non-negative number." };
  // Blank = the deposit stays what it was in the old room.
  const new_security_deposit = new_deposit_str
    ? Number(new_deposit_str)
    : null;
  if (
    new_security_deposit !== null &&
    (!Number.isFinite(new_security_deposit) || new_security_deposit < 0)
  )
    return { error: "Security deposit must be a non-negative number." };

  // The active + no-move-out requirement doubles as the double-submit guard:
  // a second submit finds the old tenancy already ending and aborts.
  const { data: old } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, room_id, start_date, status, move_out_date, security_deposit,
       rooms(room_number, properties(building_name, street_address, unit_number))`,
    )
    .eq("id", tenancy_id)
    .maybeSingle();
  if (!old || old.tenant_id !== tenant_id)
    return { error: "Tenancy not found." };
  if (old.status !== "active" || old.move_out_date)
    return {
      error:
        "Only an active tenancy without a scheduled move-out can be transferred.",
    };
  if (old.room_id === dest_room_id)
    return {
      error:
        "That's the tenant's current room — edit the rent in place instead.",
    };
  if (transfer_date < old.start_date)
    return { error: "Transfer date cannot be before the tenancy start date." };

  const { data: destRoom } = await supabase
    .from("rooms")
    .select(
      "room_number, properties(building_name, street_address, unit_number)",
    )
    .eq("id", dest_room_id)
    .maybeSingle();
  if (!destRoom) return { error: "Destination room not found." };

  // The deposit already held carries over physically, so the new room never
  // re-charges it in full: only the DIFFERENCE between the old and new deposit
  // posts (a top-up charge when it goes up, a credit when it goes down).
  const old_deposit = Number(old.security_deposit ?? 0);
  const dest_deposit = new_security_deposit ?? old_deposit;
  const deposit_delta = Math.round((dest_deposit - old_deposit) * 100) / 100;

  // 1) Create the new tenancy first: the worst partial state is a visible,
  //    deletable upcoming tenancy — never a tenant with no tenancy. The
  //    deposit carries physically, so no full deposit charge is posted.
  const created = await createTenancyForTenant(supabase, {
    tenant_id,
    room_id: dest_room_id,
    start_date: new_start_date,
    monthly_rent: new_monthly_rent,
    first_month_rent:
      first_month_rent === null && !new_start_date.endsWith("-01")
        ? proratedMonthRemainder(new_start_date, new_monthly_rent)
        : first_month_rent,
    security_deposit: dest_deposit,
    postDepositCharge: false,
  });
  if ("error" in created) return { error: created.error };

  // 2) End the old tenancy (room release, available_from, cleaning record).
  const ended = await applyMoveOut(supabase, tenancy_id, transfer_date);
  if (ended.error) {
    await supabase
      .from("tenancy_charges")
      .delete()
      .eq("tenancy_id", created.tenancy_id);
    await supabase.from("tenancies").delete().eq("id", created.tenancy_id);
    if (created.prior_room) {
      await updateRoomsWithNotification(supabase, dest_room_id, {
        status: created.prior_room.status,
        pending_tenant: created.prior_room.pending_tenant,
        available_from: created.prior_room.available_from,
      });
    }
    return { error: ended.error };
  }

  // 3) Carry the ledger position. Computed after the move-out so rent stops
  //    accruing at the transfer month; asOf covers scheduled transfers.
  const today = todayISO();
  const asOf = transfer_date > today ? transfer_date : today;
  const ledger = await loadTenancyNetBalance(supabase, tenancy_id, asOf);
  const netBalance = ledger?.netBalance ?? 0;
  if (Math.abs(netBalance) > 0.005) {
    const carryFailed = (detail: string): TransferFormState => ({
      warning: `Transferred, but the balance carry failed (${detail}). Post a settlement on the old ledger and a matching adjustment on the new one manually.`,
    });
    // A debt leaves the old room as a 'settlement' (write-off, not money
    // received). A CREDIT can't: the tenancy_charges check only allows a
    // negative amount on an 'adjustment', and a negative adjustment is the
    // designed debit line that absorbs credit — so the credit case posts
    // that instead. The receiving side is an adjustment either way.
    const { data: settlement, error: settleErr } = await supabase
      .from("tenancy_charges")
      .insert({
        tenancy_id,
        kind: netBalance > 0 ? "settlement" : "adjustment",
        amount: netBalance,
        charged_on: transfer_date,
        note: `Balance carried to ${transferRoomLabel(destRoom)}`,
      })
      .select("id")
      .single();
    if (settleErr) return carryFailed(settleErr.message);
    const { error: adjErr } = await supabase.from("tenancy_charges").insert({
      tenancy_id: created.tenancy_id,
      kind: "adjustment",
      amount: -netBalance,
      charged_on: new_start_date,
      note: `Balance carried from ${transferRoomLabel(one(old.rooms))}`,
    });
    if (adjErr) {
      // Never leave a half-carry: without the offsetting adjustment the
      // settlement would silently erase the debt.
      if (settlement)
        await supabase
          .from("tenancy_charges")
          .delete()
          .eq("id", settlement.id);
      return carryFailed(adjErr.message);
    }
  }

  // 4) Deposit difference on the NEW ledger, as a 'security_deposit' charge
  //    either way so the tenant-wide deposit bucket always sums to the deposit
  //    actually held: positive tops it up, negative reduces it and credits the
  //    balance. Posted after the carry so the carried balance reflects only
  //    the old room.
  if (Math.abs(deposit_delta) > 0.005) {
    const oldLabel = transferRoomLabel(one(old.rooms));
    const { error: depositErr } = await supabase
      .from("tenancy_charges")
      .insert({
        tenancy_id: created.tenancy_id,
        kind: "security_deposit",
        amount: deposit_delta,
        charged_on: new_start_date,
        note:
          deposit_delta > 0
            ? `Deposit increase to ${fmtUsd(dest_deposit)} — ${fmtUsd(old_deposit)} carried from ${oldLabel}`
            : `Deposit reduced to ${fmtUsd(dest_deposit)} — ${fmtUsd(old_deposit)} carried from ${oldLabel}`,
      });
    if (depositErr)
      return {
        warning: `Transferred, but the deposit difference of ${fmtUsd(Math.abs(deposit_delta))} did not post (${depositErr.message}). Post it on the new ledger manually.`,
      };
  }

  revalidatePath("/tenants");
  revalidatePath(`/tenants/${tenant_id}`);
  revalidatePath("/tenants/history");
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath("/properties");
  return undefined;
}

// ----- Delete tenant (and their tenancies + payments via cascades) -----

export type DeleteTenantState = { error: string } | undefined;

export async function deleteTenant(
  _prev: DeleteTenantState,
  formData: FormData,
): Promise<DeleteTenantState> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing tenant id." };

  const supabase = await createClient();
  // Deleting a tenant is operator-only; payment history blocks it entirely
  // (payments are on delete RESTRICT — the books outlive the tenant).
  const denied = await requireLedgerAdmin();
  if (denied) return { error: denied };
  if (!isValid(zUuid, id)) return { error: "Invalid tenant id." };

  const { data: tenancies, error: tErr } = await supabase
    .from("tenancies")
    .select("id, room_id, status")
    .eq("tenant_id", id);
  if (tErr) return { error: tErr.message };
  const tenancyIds = (tenancies ?? []).map((t) => t.id);

  if (tenancyIds.length > 0) {
    const { count: paymentCount, error: pErr } = await supabase
      .from("payments")
      .select("id", { count: "exact", head: true })
      .in("tenancy_id", tenancyIds);
    if (pErr) return { error: pErr.message };
    if ((paymentCount ?? 0) > 0)
      return {
        error:
          "This tenant has payment history, which can't be deleted. Move them out instead — the tenancy ends but the books keep their record.",
      };
    const { count: allocCount, error: aErr } = await supabase
      .from("credit_allocations")
      .select("id", { count: "exact", head: true })
      .in("tenancy_id", tenancyIds);
    if (aErr) return { error: aErr.message };
    if ((allocCount ?? 0) > 0)
      return {
        error:
          "This tenant has credit allocations on their ledger, which can't be deleted. Move them out instead.",
      };

    // Charges and rent history are ON DELETE RESTRICT against the tenancy, so
    // the tenant→tenancy cascade can't clear them. Every tenancy starts with
    // the auto-posted deposit charge, which is why deletion used to fail for
    // anyone who had ever moved in. With no payments on the books these rows
    // carry no money, so they go first — same order as cancelUpcomingTenancy.
    const { error: cErr } = await supabase
      .from("tenancy_charges")
      .delete()
      .in("tenancy_id", tenancyIds);
    if (cErr) return { error: `Couldn't clear the tenant's charges: ${cErr.message}` };
    const { error: hErr } = await supabase
      .from("tenancy_rent_history")
      .delete()
      .in("tenancy_id", tenancyIds);
    if (hErr) return { error: `Couldn't clear the tenant's rent history: ${hErr.message}` };
  }

  // Tenancies cascade with the tenant; a signed agreement assigned to one of
  // them is unassigned (FK set null) and stays on /agreements.
  const { error } = await supabase.from("tenants").delete().eq("id", id);
  if (error) return { error: `Failed to delete tenant: ${error.message}` };

  // Free the rooms this tenant was holding (occupied or reserved).
  const roomIds = (tenancies ?? [])
    .filter((t) => t.status === "active" || t.status === "upcoming")
    .map((t) => t.room_id)
    .filter(Boolean);
  if (roomIds.length > 0) {
    await updateRoomsWithNotification(supabase, roomIds, {
      status: "available",
      pending_tenant: false,
    });
  }

  revalidatePath("/tenants");
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath("/agreements");
  revalidatePath("/properties");
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
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);
  if (!isValid(zUuid, tenancy_id)) return;

  await supabase
    .from("tenancies")
    .update({
      balance_dismissed_at: new Date().toISOString(),
      balance_dismissed_by: user?.email ?? null,
    })
    .eq("id", tenancy_id);
  revalidatePath("/tenants");
  revalidatePath("/tenants/history");
}

export async function undismissEndedBalance(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  if (!tenancy_id) return;

  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);
  if (!isValid(zUuid, tenancy_id)) return;

  await supabase
    .from("tenancies")
    .update({ balance_dismissed_at: null, balance_dismissed_by: null })
    .eq("id", tenancy_id);
  revalidatePath("/tenants");
  revalidatePath("/tenants/history");
}

// ----- Settle a moved-out tenant's outstanding balance -----
// Unlike Dismiss (which only hides the row and leaves the debt visible in
// the ledger), Settle posts a 'settlement' credit for the exact outstanding
// amount: the security deposit is treated as applied toward the balance and
// the remainder written off, so the ledger nets to $0. No payment row is
// created — collections analytics never see settled debt as money received.
// Reversible by deleting the Settlement line from the tenant's ledger.

export async function settleEndedBalance(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  if (!tenancy_id) return;

  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);
  if (!isValid(zUuid, tenancy_id)) return;

  const today = todayISO();
  const ledger = await loadTenancyNetBalance(supabase, tenancy_id, today);
  if (!ledger || ledger.tenancy.status !== "ended") return;
  const { netBalance, deposit } = ledger;
  // Nothing (or a credit) outstanding — there is no debt to settle.
  if (netBalance <= 0.005) return;

  const depositHeld = deposit.paid;
  const note =
    depositHeld > 0.005
      ? `Settled at move-out — $${depositHeld.toLocaleString(undefined, {
          minimumFractionDigits: 2,
        })} security deposit applied toward the balance; remainder written off.`
      : "Settled at move-out — balance written off.";
  const { error } = await supabase.from("tenancy_charges").insert({
    tenancy_id,
    kind: "settlement",
    amount: netBalance,
    charged_on: today,
    note,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/tenants");
  revalidatePath("/tenants/history");
  if (ledger.tenancy.tenant_id)
    revalidatePath(`/tenants/${ledger.tenancy.tenant_id}`);
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
  const user = await getSessionUser();
  if (!user) return { error: "You are not signed in." };
  if (payment_type === "refund" && !canEditLedger(user.email)) {
    return { error: LEDGER_ADMIN_ERROR };
  }
  if (!isValid(zUuid, tenancyId)) return { error: "Invalid tenancy id." };
  if (tenantId && !isValid(zUuid, tenantId))
    return { error: "Invalid tenant id." };
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
  if (await requireLedgerAdmin()) return;
  if (
    !isValid(zUuid, payment_id) ||
    (tenant_id !== "" && !isValid(zUuid, tenant_id))
  )
    return;

  // Taking a reconciliation-posted payment off a ledger says "this payer's
  // money is not this tenant's". The remembered payer → tenant alias has to go
  // with it, or the next statement silently re-posts to the same wrong ledger.
  // Only retract a mapping that points at the tenant we are removing from —
  // a mapping since moved elsewhere is somebody else's correct answer.
  const { data: dep } = await supabase
    .from("reconciliation_deposits")
    .select("payer_key, tenancies(tenant_id)")
    .eq("payment_id", payment_id)
    .maybeSingle<{
      payer_key: string;
      tenancies: { tenant_id: string } | { tenant_id: string }[] | null;
    }>();
  const depTenantId = dep ? one(dep.tenancies)?.tenant_id : null;

  await supabase.from("payments").delete().eq("id", payment_id);

  if (dep && depTenantId) {
    await supabase
      .from("tenant_payer_aliases")
      .delete()
      .eq("payer_key", dep.payer_key)
      .eq("tenant_id", depTenantId);
  }

  revalidatePath("/tenants");
  revalidatePath("/reconciliation");
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
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };
  if (!isValid(zUuid, tenancyId)) return { error: "Invalid tenancy id." };
  if (tenantId && !isValid(zUuid, tenantId))
    return { error: "Invalid tenant id." };
  const { error } = await supabase
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

  // Tell the tenant. Best-effort: a failed send must never undo or block
  // the charge, which is already on the ledger.
  if (kind === "other" && note) {
    try {
      await notifyOtherCharge(supabase, tenancyId, amount, charged_on, note);
    } catch (e) {
      console.error("[addCharge] other-charge notice failed", e);
    }
  }

  revalidatePath("/tenants");
  revalidatePath(`/tenants/${tenantId}`);
  return undefined;
}

// Emails the tenant about an "Other" charge just posted to their ledger.
// Which rent month to fold it into: this month if nothing has been paid on
// the tenancy yet this calendar month, otherwise next month (they've likely
// already sent what they meant to for this month). NY tenants get plain
// Gmail, everyone else the branded Resend card — same split as the
// utility-charge notice.
async function notifyOtherCharge(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenancyId: string,
  amount: number,
  chargedOn: string,
  description: string,
): Promise<void> {
  type Row = {
    tenants: { email: string | null } | { email: string | null }[] | null;
    rooms:
      | {
          room_number: string | null;
          properties:
            | { building_name: string | null; street_address: string; unit_number: string; is_new_york: boolean }
            | { building_name: string | null; street_address: string; unit_number: string; is_new_york: boolean }[]
            | null;
        }
      | {
          room_number: string | null;
          properties:
            | { building_name: string | null; street_address: string; unit_number: string; is_new_york: boolean }
            | { building_name: string | null; street_address: string; unit_number: string; is_new_york: boolean }[]
            | null;
        }[]
      | null;
  };
  const { data: row } = await supabase
    .from("tenancies")
    .select(
      "tenants(email), rooms(room_number, properties(building_name, street_address, unit_number, is_new_york))",
    )
    .eq("id", tenancyId)
    .maybeSingle<Row>();
  const email = one(row?.tenants ?? null)?.email?.trim();
  if (!email) return;

  const room = one(row?.rooms ?? null);
  const prop = one(room?.properties ?? null);
  const unitLabel = prop
    ? `${prop.building_name?.trim() || prop.street_address} Apt ${prop.unit_number}${
        roomLabel(room?.room_number) ? ` · ${roomLabel(room?.room_number)}` : ""
      }`
    : "your unit";
  const isNewYork = prop?.is_new_york ?? false;

  const today = todayISO();
  const monthStart = `${today.slice(0, 7)}-01`;
  const { count } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("tenancy_id", tenancyId)
    .gte("paid_on", monthStart)
    .lte("paid_on", today);
  const paidThisMonth = (count ?? 0) > 0;

  const [y, m] = today.slice(0, 7).split("-").map(Number);
  // Date.UTC month is 0-based: `m - 1` is this month, `m` is next.
  const rentMonthLabel = new Date(
    Date.UTC(y, paidThisMonth ? m : m - 1, 1),
  ).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

  const notice = { amount, description, chargedOn, unitLabel, rentMonthLabel };
  if (isNewYork) await sendOtherChargeNoticeGmail(email, notice);
  else await sendOtherChargeNotice(email, notice);
}

// ----- Acknowledge utility-overage alerts (moved-out tenants) -----
// Shares of an over-$200 utility split that belonged to tenants who had
// already moved out are not charged; they pop up on the Rent Tracker until
// the admin acknowledges them here.

export async function acknowledgeOverageAlerts(ids: string[]) {
  if (ids.length === 0) return;
  const supabase = await createClient();
  const user = await getSessionUser();
  // The popup is operator-facing; only the ledger admins may dismiss it.
  if (!canEditLedger(user?.email)) return;
  if (!isValid(zUuidArray, ids)) return;
  await supabase
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
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return;
  if (
    !isValid(zUuidArray, ids) ||
    (tenant_id !== "" && !isValid(zUuid, tenant_id))
  )
    return;
  await supabase.from("tenancy_charges").delete().in("id", ids);

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
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };
  // An unknown channel would send nothing yet still log a batch row.
  if (!isValid(z.enum(["email", "sms", "both"]), channel))
    return { error: "Invalid channel." };

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
    tenant_id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    security_deposit: number | null;
    start_date: string;
    move_out_date: string | null;
    paused_at: string | null;
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
      `id, tenant_id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at,
       tenants(full_name, email, phone),
       rooms(properties(is_new_york)),
       payments(id, amount, paid_on, payment_type, notes)`,
    )
    .eq("status", "active")
    .returns<ReminderTenancy[]>();

  if (error) return { error: error.message };

  const [{ charges, allocations, rentChanges }, tl] = await Promise.all([
    fetchLedgerSidecars(supabase),
    fetchTenantLedgers(supabase),
  ]);

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
    // Paused tenancies are excluded from all reminders, email and SMS.
    if (row.paused_at) continue;

    // Tenant-wide: one ledger per tenant across every room they've had.
    const { netBalance } = tenantLedger(tl, row.tenant_id, () =>
      computeLedger(
        row,
        row.payments ?? [],
        charges.get(row.id) ?? [],
        allocations.get(row.id) ?? [],
        today,
        rentChanges.get(row.id) ?? [],
      ),
    );
    if (netBalance <= 0.01) continue;
    processed++;

    // With this month's late fee already posted, "avoid a late fee" would be
    // a false promise — the templates switch to fee-included wording.
    const lateFeeCharged = (charges.get(row.id) ?? []).some(
      (c) =>
        c.kind === "late_fee" &&
        c.charged_on >= `${today.slice(0, 7)}-01` &&
        c.charged_on <= today,
    );

    if (doEmail) {
      // Mini ledger: the open lines behind the balance, plus statement links
      // for any utility charge in it. Best-effort — a breakdown failure never
      // blocks the reminder itself.
      let detail: BalanceDetail | undefined;
      try {
        const inputs = tl.inputs.get(row.tenant_id);
        detail = inputs
          ? await buildTenantBalanceDetail(supabase, { inputs, today })
          : await buildBalanceDetail(supabase, {
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
        ? await sendBalanceReminderGmail(
            email,
            netBalance,
            monthLabel,
            detail,
            lateFeeCharged,
          )
        : await sendBalanceReminderOutlook(
            email,
            netBalance,
            monthLabel,
            detail,
            lateFeeCharged,
          );
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
        balanceReminderText(netBalance, monthLabel, lateFeeCharged),
        { type: "rent_balance", context: `${tenant?.full_name ?? "Tenant"} · ${monthLabel}` },
      );
      if (smsRes.ok) texted++;
    }
  }

  if (processed === 0) {
    return { success: "No tenants have an outstanding balance this month." };
  }

  // Record the batch so the page can show when balance reminders last ran.
  await supabase.from("rent_reminder_batches").insert({
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

// ----------------------------------------------------------------------------
// Pause / resume a tenancy. Paused tenancies accrue no new rent (months that
// begin after the pause bill nothing — see rentDue), receive no automatic
// communication (rent reminders, late fees, lease reminders) and are excluded
// from manual balance reminders, email and SMS alike.
// ----------------------------------------------------------------------------

export async function pauseTenancy(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  const tenant_id = String(formData.get("tenant_id") ?? "");
  if (!tenancy_id) return;
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);
  if (
    !isValid(zUuid, tenancy_id) ||
    (tenant_id !== "" && !isValid(zUuid, tenant_id))
  )
    return;

  const { error } = await supabase
    .from("tenancies")
    .update({ paused_at: new Date().toISOString(), pause_source: "tenant" })
    .eq("id", tenancy_id)
    .is("paused_at", null);
  if (error) throw new Error(error.message);

  revalidatePath("/tenants");
  revalidatePath("/");
  if (tenant_id) revalidatePath(`/tenants/${tenant_id}`);
}

export async function resumeTenancy(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  const tenant_id = String(formData.get("tenant_id") ?? "");
  if (!tenancy_id) return;
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);
  if (
    !isValid(zUuid, tenancy_id) ||
    (tenant_id !== "" && !isValid(zUuid, tenant_id))
  )
    return;

  const { error } = await supabase
    .from("tenancies")
    .update({ paused_at: null, pause_source: null })
    .eq("id", tenancy_id);
  if (error) throw new Error(error.message);

  revalidatePath("/tenants");
  revalidatePath("/");
  if (tenant_id) revalidatePath(`/tenants/${tenant_id}`);
}
