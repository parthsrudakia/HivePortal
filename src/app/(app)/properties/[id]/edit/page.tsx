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
  bedrooms: number | null;
  bathrooms: number | null;
  has_gym: boolean;
  has_elevator: boolean;
  has_parking: boolean;
  has_doorman: boolean;
  laundry_in_building: boolean;
  in_unit_laundry: boolean;
  amenities_notes: string | null;
  cleaner_id: string | null;
  notes: string | null;
  leaseholders: LeaseholderRel | LeaseholderRel[] | null;
};

export default async function EditPropertyPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: property }, { data: leaseholders }, { data: cleanersData }] =
    await Promise.all([
      supabase
        .from("properties")
        .select(
          `id, building_name, street_address, unit_number, cross_street,
           neighborhood, bedrooms, bathrooms,
           has_gym, has_elevator, has_parking, has_doorman,
           laundry_in_building, in_unit_laundry,
           amenities_notes, cleaner_id, notes,
           leaseholders(name)`,
        )
        .eq("id", id)
        .maybeSingle<PropertyRecord>(),
      supabase
        .from("leaseholders")
        .select("name")
        .eq("active", true)
        .order("name"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("cleaners")
        .select("id, name, email")
        .eq("enabled", true)
        .order("name"),
    ]);
  const cleaners = (cleanersData ?? []) as Array<{
    id: string;
    name: string;
    email: string;
  }>;

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
            bedrooms: property.bedrooms,
            bathrooms: property.bathrooms,
            has_gym: property.has_gym,
            has_elevator: property.has_elevator,
            has_parking: property.has_parking,
            has_doorman: property.has_doorman,
            laundry_in_building: property.laundry_in_building,
            in_unit_laundry: property.in_unit_laundry,
            amenities_notes: property.amenities_notes,
            cleaner_id: property.cleaner_id,
            notes: property.notes,
            leaseholder_name: currentLeaseholderName,
          }}
          submitLabel="Save changes"
        />
      </div>
    </div>
  );
}
