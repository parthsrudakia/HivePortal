import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { PropertyForm } from "../../property-form";
import { updateProperty, type PropertyFormState } from "../../actions";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

type LeaseholderRel = { name: string };
type PropertyRecord = {
  id: string;
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
  notes: string | null;
  leaseholders: LeaseholderRel | LeaseholderRel[] | null;
};

export default async function EditPropertyPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: property },
    { data: leaseholders },
    { data: cleanersData },
    { data: assignedData },
  ] = await Promise.all([
    supabase
      .from("properties")
      .select(
        `id, building_name, street_address, unit_number, cross_street,
           neighborhood, is_new_york, bedrooms, bathrooms,
           unit_rent, unit_lease_start, unit_lease_end,
           amenity_fees_yearly, misc_fees_yearly,
           internet_monthly, cleaning_fee_monthly, insurance_monthly,
           unit_amenities, building_amenities,
           amenities_notes, notes,
           leaseholders(name)`,
      )
      .eq("id", id)
      .maybeSingle<PropertyRecord>(),
    supabase
      .from("leaseholders")
      .select("name")
      .eq("active", true)
      .order("name"),
    supabase
      .from("cleaners")
      .select("id, name, email")
      .eq("enabled", true)
      .order("name"),
    supabase
      .from("property_cleaners")
      .select("cleaner_id")
      .eq("property_id", id),
  ]);
  const cleaners = (cleanersData ?? []) as Array<{
    id: string;
    name: string;
    email: string;
  }>;
  const cleanerIds = ((assignedData ?? []) as Array<{ cleaner_id: string }>).map(
    (a) => a.cleaner_id,
  );

  if (!property) notFound();

  const boundUpdate = updateProperty.bind(null, id) as (
    state: PropertyFormState,
    formData: FormData,
  ) => Promise<PropertyFormState>;

  const title = property.building_name?.trim() || property.street_address;
  const knownLeaseholders = (leaseholders ?? []).map((l) => l.name);
  const currentLeaseholderName = one(property.leaseholders)?.name ?? null;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-stone/60 pb-6">
        <Link
          href={`/properties/${property.id}`}
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          ← {title} Apt {property.unit_number}
        </Link>
        <h1 className="mt-2 text-3xl tracking-tight text-ink">
          Edit <span className="font-display text-accent-text">property</span>
        </h1>
      </header>

      <div className="mt-8">
        <PropertyForm
          action={boundUpdate}
          knownLeaseholders={knownLeaseholders}
          cleaners={cleaners}
          initial={{
            building_name: property.building_name,
            street_address: property.street_address,
            unit_number: property.unit_number,
            cross_street: property.cross_street,
            neighborhood: property.neighborhood,
            is_new_york: property.is_new_york,
            bedrooms: property.bedrooms,
            bathrooms: property.bathrooms,
            unit_rent: property.unit_rent,
            unit_lease_start: property.unit_lease_start,
            unit_lease_end: property.unit_lease_end,
            amenity_fees_yearly: property.amenity_fees_yearly,
            misc_fees_yearly: property.misc_fees_yearly,
            internet_monthly: property.internet_monthly,
            cleaning_fee_monthly: property.cleaning_fee_monthly,
            insurance_monthly: property.insurance_monthly,
            unit_amenities: property.unit_amenities,
            building_amenities: property.building_amenities,
            amenities_notes: property.amenities_notes,
            cleaner_ids: cleanerIds,
            notes: property.notes,
            leaseholder_name: currentLeaseholderName,
          }}
          submitLabel="Save changes"
        />
      </div>
    </div>
  );
}
