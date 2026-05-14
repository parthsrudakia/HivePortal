import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { AddTenantForm } from "./add-tenant-form";

export const dynamic = "force-dynamic";

type PropertyRel = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
};
type RoomRow = {
  id: string;
  room_number: string | null;
  total_rent: number | null;
  status: "available" | "occupied" | "reserved" | "maintenance";
  available_from: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};

type PageProps = {
  searchParams: Promise<{ room_id?: string }>;
};

export default async function NewTenantPage({ searchParams }: PageProps) {
  const { room_id } = await searchParams;
  const defaultRoomId =
    typeof room_id === "string" && room_id.length > 0 ? room_id : "";

  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  // Show rooms that are listable on /inventory: available now, or
  // currently occupied but with a future end-date so the tenant slot is
  // about to open up. Also include the explicitly-requested room (via
  // ?room_id=) so the form can pre-select it even if it doesn't match.
  let q = supabase
    .from("rooms")
    .select(
      "id, room_number, total_rent, status, available_from, properties(building_name, street_address, unit_number)",
    )
    .or(
      `status.eq.available,and(status.eq.occupied,available_from.gte.${today})${defaultRoomId ? `,id.eq.${defaultRoomId}` : ""}`,
    )
    .order("available_from", { ascending: true, nullsFirst: true });

  const { data } = await q.returns<RoomRow[]>();

  const rooms = (data ?? []).map((r) => {
    const p = one(r.properties);
    const unitTitle = p
      ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
      : "—";
    const scheduled = r.status === "occupied" && r.available_from;
    const suffix = scheduled ? ` (opens ${r.available_from})` : "";
    return {
      id: r.id,
      label: `${unitTitle} · ${r.room_number ?? "Room"}${suffix}`,
      total_rent: r.total_rent,
    };
  });

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-stone/60 pb-6">
        <Link
          href="/tenants"
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          ← Tenants &amp; Rent
        </Link>
        <h1 className="mt-2 text-3xl tracking-tight text-ink">
          Add a <span className="font-display text-accent-text">tenant</span>
        </h1>
      </header>

      <div className="mt-8">
        <AddTenantForm rooms={rooms} defaultRoomId={defaultRoomId} />
      </div>
    </div>
  );
}
