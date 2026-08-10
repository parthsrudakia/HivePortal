"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { canEditLedger } from "@/lib/access";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
import { applyMoveOut } from "@/lib/move-out";
import {
  normalizeUnitAmenities,
  normalizeBuildingAmenities,
} from "@/lib/amenities";

export type PropertyFormState = { error?: string } | undefined;

type ParsedForm = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
  cross_street: string | null;
  neighborhood: string | null;
  is_new_york: boolean;
  bedrooms: number | null;
  bathrooms: number | null;
  unit_rent: number | null;
  unit_lease_start: string | null;
  unit_lease_end: string | null;
  amenity_fees_yearly: number | null;
  misc_fees_yearly: number | null;
  internet_monthly: number | null;
  cleaning_fee_monthly: number | null;
  insurance_monthly: number | null;
  unit_amenities: string[];
  building_amenities: string[];
  amenities_notes: string | null;
  leaseholder_name: string | null;
  cleaner_ids: string[];
  notes: string | null;
};

function parseForm(formData: FormData): ParsedForm | { error: string } {
  const street_address = String(formData.get("street_address") ?? "").trim();
  const unit_number = String(formData.get("unit_number") ?? "").trim();

  if (!street_address) return { error: "Street address is required." };
  if (!unit_number) return { error: "Unit number is required." };

  const lease_start = String(formData.get("unit_lease_start") ?? "").trim();
  const lease_end = String(formData.get("unit_lease_end") ?? "").trim();
  if (lease_start && lease_end && lease_end < lease_start) {
    return { error: "Unit lease end date is before the start date." };
  }

  const numOrNull = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    if (v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.NaN;
  };
  const strOrNull = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };

  const numeric = {
    bedrooms: numOrNull("bedrooms"),
    bathrooms: numOrNull("bathrooms"),
    unit_rent: numOrNull("unit_rent"),
    amenity_fees_yearly: numOrNull("amenity_fees_yearly"),
    misc_fees_yearly: numOrNull("misc_fees_yearly"),
    internet_monthly: numOrNull("internet_monthly"),
    cleaning_fee_monthly: numOrNull("cleaning_fee_monthly"),
    insurance_monthly: numOrNull("insurance_monthly"),
  };
  for (const [field, value] of Object.entries(numeric)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
      return {
        error: `${field.replaceAll("_", " ")} must be a non-negative number.`,
      };
    }
  }

  return {
    building_name: strOrNull("building_name"),
    street_address,
    unit_number,
    cross_street: strOrNull("cross_street"),
    neighborhood: strOrNull("neighborhood"),
    is_new_york: formData.get("is_new_york") === "on",
    bedrooms: numeric.bedrooms,
    bathrooms: numeric.bathrooms,
    unit_rent: numeric.unit_rent,
    unit_lease_start: lease_start || null,
    unit_lease_end: lease_end || null,
    amenity_fees_yearly: numeric.amenity_fees_yearly,
    misc_fees_yearly: numeric.misc_fees_yearly,
    internet_monthly: numeric.internet_monthly,
    cleaning_fee_monthly: numeric.cleaning_fee_monthly,
    insurance_monthly: numeric.insurance_monthly,
    unit_amenities: normalizeUnitAmenities(
      formData.getAll("unit_amenities").map((v) => String(v)),
    ),
    building_amenities: normalizeBuildingAmenities(
      formData.getAll("building_amenities").map((v) => String(v)),
    ),
    amenities_notes: strOrNull("amenities_notes"),
    leaseholder_name: strOrNull("leaseholder_name"),
    cleaner_ids: formData
      .getAll("cleaner_ids")
      .map((v) => String(v))
      .filter(Boolean),
    notes: strOrNull("notes"),
  };
}

async function isPropertyOperator(): Promise<boolean> {
  const user = await getSessionUser();
  return canEditLedger(user?.email);
}

// Replace a property's cleaner assignments with the given set.
async function syncPropertyCleaners(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyId: string,
  cleanerIds: string[],
) {
  await supabase
    .from("property_cleaners")
    .delete()
    .eq("property_id", propertyId);
  if (cleanerIds.length > 0) {
    await supabase.from("property_cleaners").insert(
      cleanerIds.map((cleaner_id) => ({
        property_id: propertyId,
        cleaner_id,
      })),
    );
  }
}

// Find an existing leaseholder by name (case-insensitive); create one if not.
// Returns the leaseholder_id, or null if name is empty.
async function resolveLeaseholderId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  name: string | null,
): Promise<string | null> {
  if (!name) return null;
  const { data: existing } = await supabase
    .from("leaseholders")
    .select("id")
    .ilike("name", name)
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("leaseholders")
    .insert({ name })
    .select("id")
    .single();
  if (error || !created) return null;
  return created.id;
}

export async function createProperty(
  _prev: PropertyFormState,
  formData: FormData,
): Promise<PropertyFormState> {
  const parsed = parseForm(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();
  if (!(await isPropertyOperator())) {
    return { error: "Only the financial operators can change properties." };
  }
  const leaseholder_id = await resolveLeaseholderId(
    supabase,
    parsed.leaseholder_name,
  );

  const { leaseholder_name: _ignore, cleaner_ids, ...rest } = parsed;
  void _ignore;
  const { data, error } = await supabase
    .from("properties")
    .insert({ ...rest, leaseholder_id })
    .select("id")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "A property with that street address + unit number already exists."
          : error.message,
    };
  }

  await syncPropertyCleaners(supabase, data.id, cleaner_ids);

  revalidatePath("/properties");
  redirect(`/properties/${data.id}`);
}

export async function updateProperty(
  id: string,
  _prev: PropertyFormState,
  formData: FormData,
): Promise<PropertyFormState> {
  const parsed = parseForm(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();
  if (!(await isPropertyOperator())) {
    return { error: "Only the financial operators can change properties." };
  }
  const leaseholder_id = await resolveLeaseholderId(
    supabase,
    parsed.leaseholder_name,
  );

  const { leaseholder_name: _ignore, cleaner_ids, ...rest } = parsed;
  void _ignore;
  const { error } = await supabase
    .from("properties")
    .update({ ...rest, leaseholder_id })
    .eq("id", id);

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "A property with that street address + unit number already exists."
          : error.message,
    };
  }

  await syncPropertyCleaners(supabase, id, cleaner_ids);

  revalidatePath("/properties");
  revalidatePath(`/properties/${id}`);
  return undefined;
}

// Deleting a property must not silently erase active tenants. The client
// collects a move-out date per active tenancy (`moveout_<tenancyId>` fields);
// the outcome depends on those dates and on whether money ever moved:
//  - payment history exists → record the move-outs and ARCHIVE the property
//    (archived_at): its ledgers stay for the books, it leaves the Rent
//    Tracker once the last tenant's move-out passes, and it lives on the
//    Past Tenants page under its own group. Restorable.
//  - no payment history, any date today/future → record the move-outs, keep
//    the property until everyone is gone ({ notice });
//  - no payment history, all dates past → delete outright (cascade), clearing
//    unpaid ledger charges (e.g. the auto security-deposit row) first.
export type DeletePropertyState =
  | { error?: string; notice?: string }
  | undefined;

const BOOKS_ERROR =
  "This property has tenancies with payment history, which can't be deleted. The property must stay for the books.";

export async function deleteProperty(
  formData: FormData,
): Promise<DeletePropertyState> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  if (!(await isPropertyOperator())) {
    return { error: "Only the financial operators can delete properties." };
  }

  const { data: tenancyRows, error: tenancyError } = await supabase
    .from("tenancies")
    .select("id, status, tenants(full_name), rooms!inner(property_id)")
    .eq("rooms.property_id", id);
  if (tenancyError) return { error: tenancyError.message };

  const tenancyIds = (tenancyRows ?? []).map((t) => t.id);
  const active = (tenancyRows ?? []).filter((t) => t.status === "active");

  // Every active tenant needs a move-out date before the property can go.
  const moveOuts = active.map((t) => ({
    tenancy_id: t.id,
    name: one(t.tenants)?.full_name ?? "Tenant",
    date: String(formData.get(`moveout_${t.id}`) ?? "").trim(),
  }));
  const missing = moveOuts.filter((m) => !m.date);
  if (missing.length > 0) {
    return {
      error: `Enter a move-out date for every active tenant (missing: ${missing
        .map((m) => m.name)
        .join(", ")}).`,
    };
  }

  // "For the books" = money actually moved. Unpaid charges alone don't count.
  let hasBooks = false;
  if (tenancyIds.length > 0) {
    const [payments, credits, rentHistory] = await Promise.all([
      supabase
        .from("payments")
        .select("id", { count: "exact", head: true })
        .in("tenancy_id", tenancyIds),
      supabase
        .from("credit_allocations")
        .select("id", { count: "exact", head: true })
        .in("tenancy_id", tenancyIds),
      supabase
        .from("tenancy_rent_history")
        .select("id", { count: "exact", head: true })
        .in("tenancy_id", tenancyIds),
    ]);
    hasBooks =
      (payments.count ?? 0) > 0 ||
      (credits.count ?? 0) > 0 ||
      (rentHistory.count ?? 0) > 0;
  }

  const today = todayISO();
  const someoneStillHere = moveOuts.some((m) => m.date >= today);

  if (someoneStillHere || hasBooks) {
    // The property stays (for now) — record the move-outs with full room
    // side effects so /inventory and notifications reflect them.
    for (const m of moveOuts) {
      const result = await applyMoveOut(supabase, m.tenancy_id, m.date);
      if (result.error) return { error: `${m.name}: ${result.error}` };
    }

    if (hasBooks) {
      // Money moved, so the records must survive — retire the property
      // instead of deleting. It keeps its Rent Tracker group only while
      // tenants remain; after the last move-out it lives on Past Tenants.
      const { error: archiveError } = await supabase
        .from("properties")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", id);
      if (archiveError) {
        return { error: `Failed to retire the property: ${archiveError.message}` };
      }
    }

    revalidatePath("/properties");
    revalidatePath(`/properties/${id}`);
    revalidatePath("/tenants");
    revalidatePath("/tenants/history");
    revalidatePath("/inventory");
    revalidatePath("/tenants/new");
    revalidatePath("/cleaning");
    revalidatePath("/");

    const lastDay = moveOuts.reduce(
      (max, m) => (m.date > max ? m.date : max),
      "",
    );
    if (hasBooks) {
      return {
        notice: someoneStillHere
          ? `Property retired — it stays on the Rent Tracker until the last move-out (${lastDay}), then moves to Past Tenants.`
          : "Property retired — its history now lives on the Past Tenants page.",
      };
    }
    return {
      notice: `Move-out dates saved — tenants are here through ${lastDay}. Delete the property again once everyone has moved out.`,
    };
  }

  // Deleting now: no money ever moved, and everyone is already out. Skip
  // applyMoveOut — its room-availability notifications would advertise rooms
  // that are about to disappear. Clear unpaid ledger charges (RESTRICT FK)
  // so the cascade can proceed.
  if (tenancyIds.length > 0) {
    const { error: chargesError } = await supabase
      .from("tenancy_charges")
      .delete()
      .in("tenancy_id", tenancyIds);
    if (chargesError) {
      return { error: `Failed to clear ledger charges: ${chargesError.message}` };
    }
  }

  const { error } = await supabase.from("properties").delete().eq("id", id);
  if (error) {
    return {
      error:
        error.code === "23503"
          ? BOOKS_ERROR
          : `Failed to delete property: ${error.message}`,
    };
  }
  revalidatePath("/properties");
  redirect("/properties");
}

// Pause every action on a property: stamps all its current (active/upcoming)
// tenancies as paused (pause_source = 'property') — no new rent accrual, no
// automatic or manual reminders — and takes the unit off the cleaning
// schedule entirely. Resume clears only the property-stamped pauses, so a
// tenant paused individually stays paused.
export async function pauseProperty(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  if (!(await isPropertyOperator())) {
    throw new Error("Only the financial operators can pause properties.");
  }
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("properties")
    .update({ paused_at: now })
    .eq("id", id);
  if (error) throw new Error(error.message);

  const { data: tens } = await supabase
    .from("tenancies")
    .select("id, rooms!inner(property_id)")
    .eq("rooms.property_id", id)
    .in("status", ["active", "upcoming"])
    .is("paused_at", null);
  const ids = (tens ?? []).map((t) => t.id);
  if (ids.length > 0) {
    const { error: stampError } = await supabase
      .from("tenancies")
      .update({ paused_at: now, pause_source: "property" })
      .in("id", ids);
    if (stampError) throw new Error(stampError.message);
  }

  revalidatePath("/properties");
  revalidatePath(`/properties/${id}`);
  revalidatePath("/tenants");
  revalidatePath("/cleaning");
  revalidatePath("/");
}

export async function resumeProperty(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  if (!(await isPropertyOperator())) {
    throw new Error("Only the financial operators can resume properties.");
  }

  const { error } = await supabase
    .from("properties")
    .update({ paused_at: null })
    .eq("id", id);
  if (error) throw new Error(error.message);

  const { data: tens } = await supabase
    .from("tenancies")
    .select("id, rooms!inner(property_id)")
    .eq("rooms.property_id", id)
    .eq("pause_source", "property");
  const ids = (tens ?? []).map((t) => t.id);
  if (ids.length > 0) {
    const { error: clearError } = await supabase
      .from("tenancies")
      .update({ paused_at: null, pause_source: null })
      .in("id", ids);
    if (clearError) throw new Error(clearError.message);
  }

  revalidatePath("/properties");
  revalidatePath(`/properties/${id}`);
  revalidatePath("/tenants");
  revalidatePath("/cleaning");
  revalidatePath("/");
}

// Bring a retired property back: it reappears on /properties, the Rent
// Tracker (as a vacant group if empty), inventory, and cleaning.
export async function restoreProperty(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  if (!(await isPropertyOperator())) {
    throw new Error("Only the financial operators can restore properties.");
  }
  const { error } = await supabase
    .from("properties")
    .update({ archived_at: null })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/properties");
  revalidatePath(`/properties/${id}`);
  revalidatePath("/tenants");
  revalidatePath("/tenants/history");
  revalidatePath("/inventory");
  revalidatePath("/tenants/new");
  revalidatePath("/cleaning");
  revalidatePath("/");
}
