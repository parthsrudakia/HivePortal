"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";
import { updateRoomsWithNotification } from "@/lib/notifications";
import { sendBalanceReminder } from "@/lib/email";

type PaymentType = Database["public"]["Enums"]["payment_type"];
const VALID_PAYMENT_TYPES: PaymentType[] = [
  "rent",
  "security_deposit",
  "late_fee",
  "utility",
  "other",
  "refund",
];

export type TenantFormState = { error?: string } | undefined;
export type PaymentFormState = { error?: string } | undefined;
export type ReminderState = { error?: string; success?: string } | undefined;

// Services bundle baked into every room's rent: utilities + wi-fi + maid +
// amenities. A room's total_rent (generated) = base_rent + bundle_fee.
const BUNDLE_FEE = 125;

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
  const first_month_rent_str = String(
    formData.get("first_month_rent") ?? "",
  ).trim();
  const leaseFile = formData.get("lease_pdf");

  if (room_id) {
    if (!monthly_rent_str)
      return { error: "Monthly rent is required when assigning a room." };
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

    // Mark the room as occupied
    await updateRoomsWithNotification(supabase, room_id, {
      status: "occupied",
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

// ----- End (or schedule the end of) a tenancy -----
// If end_date is today or earlier  → tenant has moved out; room is Available now.
// If end_date is in the future     → tenant is still there until that date;
//                                    room stays Occupied but we set
//                                    `rooms.available_from = end_date` so it
//                                    surfaces on /inventory as "Available from X".
//                                    Tenancy stays 'active' and is auto-finalized
//                                    when end_date passes (see processExpiredTenancies).

export async function endTenancy(formData: FormData) {
  const tenancy_id = String(formData.get("tenancy_id") ?? "");
  const tenant_id = String(formData.get("tenant_id") ?? "");
  const end_date = String(formData.get("end_date") ?? "").trim();
  if (!tenancy_id || !end_date) return;

  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  const isPastOrToday = end_date <= today;

  const { data: tenancy } = await supabase
    .from("tenancies")
    .select("room_id, monthly_rent")
    .eq("id", tenancy_id)
    .single();

  await supabase
    .from("tenancies")
    .update({
      end_date,
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

    // Re-entering the vacancy queue — reset the VA workflow flag so the
    // room shows up as a fresh "Create new ad" instead of inheriting the
    // previous tenancy's color.
    await updateRoomsWithNotification(supabase, tenancy.room_id, {
      status: isPastOrToday ? "available" : "occupied",
      available_from: end_date,
      listing_action: "new_ad",
      ...rentPatch,
    });
  }

  revalidatePath("/tenants");
  if (tenant_id) revalidatePath(`/tenants/${tenant_id}`);
  revalidatePath("/inventory");
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
    .update({ end_date: null, status: "active" })
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

// ----- Auto-finalize any tenancies whose end_date has now passed -----

export async function processExpiredTenancies() {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  const { data: expired } = await supabase
    .from("tenancies")
    .select("id, room_id")
    .eq("status", "active")
    .lt("end_date", today)
    .not("end_date", "is", null);

  if (!expired || expired.length === 0) return;

  const ids = expired.map((t) => t.id);
  const roomIds = expired
    .map((t) => t.room_id)
    .filter((v): v is string => Boolean(v));

  await supabase.from("tenancies").update({ status: "ended" }).in("id", ids);

  if (roomIds.length > 0) {
    await updateRoomsWithNotification(supabase, roomIds, {
      status: "available",
      listing_action: "new_ad",
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
  const method = String(formData.get("method") ?? "").trim() || null;
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
    method,
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

// ----- Manually email this month's rent reminder to tenants with a balance -----
// Computes each active tenant's outstanding balance for the current month
// (due − rent paid this month, the same way the Tenants & Rent page does) and
// emails only those who still owe. Meant to be run after the month's
// reconciliation has posted payments. Records a batch row so the page can show
// when these last went out.

export async function sendBalanceReminders(
  _prev: ReminderState,
  _formData: FormData,
): Promise<ReminderState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthStart = new Date(y, m, 1).toISOString().slice(0, 10);
  const monthEnd = new Date(y, m + 1, 0).toISOString().slice(0, 10);
  const period = `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthLabel = now.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const today = now.toISOString().slice(0, 10);

  type ReminderTenancy = {
    monthly_rent: number;
    first_month_rent: number | null;
    start_date: string;
    end_date: string | null;
    tenants:
      | { full_name: string; email: string | null }
      | { full_name: string; email: string | null }[]
      | null;
    payments: { amount: number; paid_on: string; payment_type: string }[];
  };

  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `monthly_rent, first_month_rent, start_date, end_date,
       tenants(full_name, email),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "active")
    .returns<ReminderTenancy[]>();

  if (error) return { error: error.message };

  let sent = 0;
  let failed = 0;
  for (const row of data ?? []) {
    const tenant = one(row.tenants);
    const email = tenant?.email?.trim();
    if (!email) continue;
    // Skip tenancies that have already ended this month.
    if (row.end_date && row.end_date <= today) continue;
    // Skip tenancies that haven't started yet.
    if (row.start_date > monthEnd) continue;

    const isStartingMonth =
      row.start_date >= monthStart && row.start_date <= monthEnd;
    const due =
      isStartingMonth && row.first_month_rent !== null
        ? Number(row.first_month_rent)
        : Number(row.monthly_rent);
    const paid = (row.payments ?? [])
      .filter(
        (p) =>
          p.payment_type === "rent" &&
          p.paid_on >= monthStart &&
          p.paid_on <= monthEnd,
      )
      .reduce((s, p) => s + Number(p.amount), 0);
    const balance = due - paid;
    if (balance <= 0.01) continue;

    const res = await sendBalanceReminder(email, balance, monthLabel);
    if (res.ok) sent++;
    else failed++;
  }

  if (sent === 0 && failed === 0) {
    return { success: "No tenants have an outstanding balance this month." };
  }

  // Record the batch so the page can show when balance reminders last ran.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from("rent_reminder_batches").insert({
    kind: "balance",
    period_month: period,
    recipient_count: sent,
    triggered_by: user?.email ?? null,
  });

  revalidatePath("/tenants");
  const msg =
    `Sent ${sent} balance reminder${sent === 1 ? "" : "s"}.` +
    (failed > 0 ? ` ${failed} failed to send.` : "");
  return { success: msg };
}
