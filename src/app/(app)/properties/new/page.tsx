import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PropertyForm } from "../property-form";
import { createProperty } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewPropertyPage() {
  const supabase = await createClient();
  const [{ data: leaseholders }, { data: cleanersData }] = await Promise.all([
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

  const knownLeaseholders = (leaseholders ?? []).map((l) => l.name);
  const cleaners = (cleanersData ?? []) as Array<{
    id: string;
    name: string;
    email: string;
  }>;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-stone/60 pb-6">
        <Link
          href="/properties"
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          ← Properties
        </Link>
        <h1 className="mt-2 text-3xl tracking-tight text-ink">
          Add a <span className="font-display text-accent-text">property</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Enter the unit details. You&apos;ll add rooms after saving.
        </p>
      </header>

      <div className="mt-8">
        <PropertyForm
          action={createProperty}
          knownLeaseholders={knownLeaseholders}
          cleaners={cleaners}
          submitLabel="Save property"
        />
      </div>
    </div>
  );
}
