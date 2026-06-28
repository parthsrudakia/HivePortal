"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { enqueueCleanerScheduleChange } from "@/lib/cleaner-reminders";

export type CleaningFormState = { error?: string } | undefined;
export type SaveResult = { error?: string; ok?: boolean } | undefined;

// Inline edit of an upcoming cleaning date. With a record_id it updates (or
// deletes when the date is cleared); without one it inserts a new upcoming row.
export async function saveUpcomingDate(formData: FormData): Promise<SaveResult> {
  const property_id = String(formData.get("property_id") ?? "").trim();
  const record_id = String(formData.get("record_id") ?? "").trim();
  const cleaning_date = String(formData.get("cleaning_date") ?? "").trim();
  const assigned_to =
    String(formData.get("assigned_to") ?? "").trim() || null;
  if (!property_id) return { error: "Missing property." };

  const supabase = await createClient();
  // Both the new and the prior date may fall in (or move out of) the current
  // week, so collect both for the change-notice check.
  const affected: (string | null)[] = [cleaning_date || null];
  const fetchOld = async () => {
    if (!record_id) return;
    const { data } = await supabase
      .from("cleaning_records")
      .select("cleaning_date")
      .eq("id", record_id)
      .maybeSingle<{ cleaning_date: string }>();
    if (data?.cleaning_date) affected.push(data.cleaning_date);
  };

  if (!cleaning_date) {
    if (record_id) {
      await fetchOld();
      const { error } = await supabase
        .from("cleaning_records")
        .delete()
        .eq("id", record_id);
      if (error) return { error: error.message };
    }
  } else if (record_id) {
    await fetchOld();
    const { error } = await supabase
      .from("cleaning_records")
      .update({ cleaning_date })
      .eq("id", record_id);
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase
      .from("cleaning_records")
      .insert({ property_id, cleaning_date, assigned_to });
    if (error) return { error: error.message };
  }

  await enqueueCleanerScheduleChange(supabase, property_id, affected, "manual");
  revalidatePath("/cleaning");
  revalidatePath(`/properties/${property_id}`);
  return { ok: true };
}

type CleaningValues = {
  property_id: string;
  cleaning_date: string;
  assigned_to: string | null;
  notes: string | null;
};

function parse(formData: FormData): CleaningValues | { error: string } {
  const property_id = String(formData.get("property_id") ?? "").trim();
  const cleaning_date = String(formData.get("cleaning_date") ?? "").trim();
  if (!property_id) return { error: "Pick a property." };
  if (!cleaning_date) return { error: "Cleaning date is required." };

  const strOrNull = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };

  return {
    property_id,
    cleaning_date,
    assigned_to: strOrNull("assigned_to"),
    notes: strOrNull("notes"),
  };
}

export async function addCleaning(
  _prev: CleaningFormState,
  formData: FormData,
): Promise<CleaningFormState> {
  const parsed = parse(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();
  const { error } = await supabase.from("cleaning_records").insert(parsed);

  if (error) return { error: error.message };

  await enqueueCleanerScheduleChange(
    supabase,
    parsed.property_id,
    [parsed.cleaning_date],
    "manual",
  );
  revalidatePath("/cleaning");
  revalidatePath(`/properties/${parsed.property_id}`);
  return undefined;
}

export async function updateCleaning(
  id: string,
  _prev: CleaningFormState,
  formData: FormData,
): Promise<CleaningFormState> {
  const parsed = parse(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();
  const { data: old } = await supabase
    .from("cleaning_records")
    .select("cleaning_date")
    .eq("id", id)
    .maybeSingle<{ cleaning_date: string }>();
  const { error } = await supabase
    .from("cleaning_records")
    .update(parsed)
    .eq("id", id);

  if (error) return { error: error.message };

  await enqueueCleanerScheduleChange(
    supabase,
    parsed.property_id,
    [parsed.cleaning_date, old?.cleaning_date],
    "manual",
  );
  revalidatePath("/cleaning");
  revalidatePath(`/properties/${parsed.property_id}`);
  return undefined;
}

export async function deleteCleaning(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const property_id = String(formData.get("property_id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  const { data: old } = await supabase
    .from("cleaning_records")
    .select("cleaning_date, property_id")
    .eq("id", id)
    .maybeSingle<{ cleaning_date: string; property_id: string }>();
  await supabase.from("cleaning_records").delete().eq("id", id);

  const pid = property_id || old?.property_id;
  if (pid) {
    await enqueueCleanerScheduleChange(supabase, pid, [old?.cleaning_date], "manual");
    revalidatePath(`/properties/${pid}`);
  }
  revalidatePath("/cleaning");
}
