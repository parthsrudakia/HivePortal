"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type PropertyFormState = { error?: string } | undefined;

type ParsedForm = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
  cross_street: string | null;
  neighborhood: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  has_gym: boolean;
  has_elevator: boolean;
  has_parking: boolean;
  has_doorman: boolean;
  laundry_in_building: boolean;
  in_unit_laundry: boolean;
  amenities_notes: string | null;
  leaseholder_name: string | null;
  cleaner_id: string | null;
  notes: string | null;
};

function parseForm(formData: FormData): ParsedForm | { error: string } {
  const street_address = String(formData.get("street_address") ?? "").trim();
  const unit_number = String(formData.get("unit_number") ?? "").trim();

  if (!street_address) return { error: "Street address is required." };
  if (!unit_number) return { error: "Unit number is required." };

  const numOrNull = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    if (v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const strOrNull = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };

  return {
    building_name: strOrNull("building_name"),
    street_address,
    unit_number,
    cross_street: strOrNull("cross_street"),
    neighborhood: strOrNull("neighborhood"),
    bedrooms: numOrNull("bedrooms"),
    bathrooms: numOrNull("bathrooms"),
    has_gym: formData.get("has_gym") === "on",
    has_elevator: formData.get("has_elevator") === "on",
    has_parking: formData.get("has_parking") === "on",
    has_doorman: formData.get("has_doorman") === "on",
    laundry_in_building: formData.get("laundry_in_building") === "on",
    in_unit_laundry: formData.get("in_unit_laundry") === "on",
    amenities_notes: strOrNull("amenities_notes"),
    leaseholder_name: strOrNull("leaseholder_name"),
    cleaner_id: strOrNull("cleaner_id"),
    notes: strOrNull("notes"),
  };
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
  const leaseholder_id = await resolveLeaseholderId(
    supabase,
    parsed.leaseholder_name,
  );

  const { leaseholder_name: _ignore, ...rest } = parsed;
  void _ignore;
  // cleaner_id is brand-new; types.ts is regenerated after the migration push.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
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
  const leaseholder_id = await resolveLeaseholderId(
    supabase,
    parsed.leaseholder_name,
  );

  const { leaseholder_name: _ignore, ...rest } = parsed;
  void _ignore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
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

  revalidatePath("/properties");
  revalidatePath(`/properties/${id}`);
  return undefined;
}

export async function deleteProperty(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  await supabase.from("properties").delete().eq("id", id);
  revalidatePath("/properties");
  redirect("/properties");
}
