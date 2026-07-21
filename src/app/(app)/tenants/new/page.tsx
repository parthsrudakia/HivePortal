import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
import { AddTenantForm } from "./add-tenant-form";
import { RestoreListingButton } from "./restore-listing";

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
  searchParams: Promise<{ room_id?: string; agreement?: string }>;
};

// Shape of agreement_requests.input (the AgreementInput snapshot the signed
// PDF was rendered from) — only the fields the prefill needs.
type AgreementInputSnapshot = {
  rent?: string;
  securityDeposit?: string;
  leaseStartDate?: string;
  leaseEndDate?: string;
  proRateRent?: string;
};

export default async function NewTenantPage({ searchParams }: PageProps) {
  const { room_id, agreement } = await searchParams;
  const defaultRoomId =
    typeof room_id === "string" && room_id.length > 0 ? room_id : "";
  const agreementId =
    typeof agreement === "string" && agreement.length > 0 ? agreement : "";

  const supabase = await createClient();
  const today = todayISO();

  // Coming from the signing tally's "Add a tenant" button: prefill the form
  // from the signed agreement and attach its PDF on save.
  let agreementPrefill = null;
  if (agreementId) {
    const { data: request } = await supabase
      .from("agreement_requests")
      .select("id, status, tenant_name, recipient_email, signed_pdf_path, input")
      .eq("id", agreementId)
      .maybeSingle();
    if (request?.status === "signed" && request.signed_pdf_path) {
      const input = (request.input ?? {}) as AgreementInputSnapshot;
      agreementPrefill = {
        agreementRequestId: request.id,
        fullName: request.tenant_name,
        email: request.recipient_email,
        monthlyRent: input.rent ?? "",
        securityDeposit: input.securityDeposit ?? "",
        startDate: input.leaseStartDate ?? "",
        leaseEndDate: input.leaseEndDate ?? "",
        firstMonthRent: input.proRateRent ?? "",
      };
    }
  }

  // Show rooms that are listable on /inventory: available now, or
  // currently occupied but with a future end-date so the tenant slot is
  // about to open up. Also include the explicitly-requested room (via
  // ?room_id=) so the form can pre-select it even if it doesn't match.
  const q = supabase
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

  // Listings the admin pulled off Inventory ("delete listing") that are waiting
  // to be filled with a tenant.
  const { data: pendingData } = await supabase
    .from("rooms")
    .select(
      "id, room_number, total_rent, properties(building_name, street_address, unit_number)",
    )
    .eq("pending_tenant", true)
    .order("room_number", { ascending: true })
    .returns<RoomRow[]>();

  const pending = (pendingData ?? []).map((r) => {
    const p = one(r.properties);
    const unitTitle = p
      ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
      : "—";
    return {
      id: r.id,
      label: `${unitTitle} · ${r.room_number ?? "Room"}`,
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
          ← Rent Tracker
        </Link>
        <h1 className="mt-2 text-3xl tracking-tight text-ink">
          Add a <span className="font-display text-accent-text">tenant</span>
        </h1>
      </header>

      {pending.length > 0 && (
        <div className="mt-6 rounded-2xl border border-accent/30 bg-accent/5 p-5">
          <h2 className="text-sm font-medium uppercase tracking-wide text-accent-text">
            Listings to fill ({pending.length})
          </h2>
          <p className="mt-1 text-xs text-muted">
            Rooms pulled from Inventory and waiting for a tenant. Pick one to
            prefill the room below, or restore it to Inventory.
          </p>
          <ul className="mt-3 divide-y divide-stone/40">
            {pending.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate text-ink">
                  {p.label}
                  {p.total_rent ? (
                    <span className="text-muted">
                      {" "}
                      — ${p.total_rent.toLocaleString()}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <RestoreListingButton roomId={p.id} />
                  <Link
                    href={`/tenants/new?room_id=${p.id}#add-tenant`}
                    className="rounded-full bg-ink px-3 py-1 text-xs font-medium text-white hover:bg-accent-dark"
                  >
                    Fill →
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div id="add-tenant" className="mt-8 scroll-mt-6">
        <AddTenantForm
          key={`${agreementPrefill?.agreementRequestId ?? "none"}:${defaultRoomId || "blank"}`}
          rooms={rooms}
          defaultRoomId={defaultRoomId}
          agreementPrefill={agreementPrefill}
        />
      </div>
    </div>
  );
}
