import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { unitLabel } from "@/lib/unit-label";
import { formatDate, todayISO } from "@/lib/date";
import { UNIT_AMENITIES, BUILDING_AMENITIES } from "@/lib/amenities";
import { CopyListing } from "../copy-listing";
import { ListingActionSelector } from "../listing-action";
import {
  ACTION_BORDER,
  ACTION_TINT,
  type Action,
  type AdRow,
} from "../constants";
import { RentEdit } from "./rent-edit";
import { AdEdit } from "./ad-edit";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ roomId: string }> };

type PropertyRel = {
  id: string;
  building_name: string | null;
  street_address: string;
  unit_number: string;
  cross_street: string | null;
  neighborhood: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  unit_amenities: string[];
  building_amenities: string[];
};

type Room = {
  id: string;
  room_number: string | null;
  status: "occupied" | "available" | "reserved" | "maintenance";
  base_rent: number | null;
  bundle_fee: number | null;
  total_rent: number | null;
  available_from: string | null;
  has_private_bathroom: boolean;
  has_ac: boolean;
  marketing_description: string | null;
  photos_url: string | null;
  listing_action: Action;
  properties: PropertyRel | PropertyRel[] | null;
};

type TenantRel = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
};

type Tenancy = {
  id: string;
  start_date: string;
  move_out_date: string | null;
  status: "active" | "ended" | "upcoming";
  tenants: TenantRel | TenantRel[] | null;
};

export default async function VacancyDetailPage({ params }: PageProps) {
  const { roomId } = await params;
  const supabase = await createClient();

  const [{ data: room }, { data: tenancies }, { data: adRowsData }] =
    await Promise.all([
      supabase
        .from("rooms")
        .select(
          `id, room_number, status, base_rent, bundle_fee, total_rent,
         available_from, has_private_bathroom, has_ac,
         marketing_description, photos_url, listing_action,
         properties(id, building_name, street_address, unit_number,
                    cross_street, neighborhood, bedrooms, bathrooms,
                    unit_amenities, building_amenities)`,
        )
        .eq("id", roomId)
        .maybeSingle<Room>(),
      supabase
        .from("tenancies")
        .select(
          `id, start_date, move_out_date, status,
         tenants(id, full_name, email, phone)`,
        )
        .eq("room_id", roomId)
        .order("start_date", { ascending: false })
        .returns<Tenancy[]>(),
      supabase
        .from("room_ads")
        .select("id, url, posted_by")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true }),
    ]);
  const ads = (adRowsData ?? []) as AdRow[];

  if (!room) notFound();

  const p = one(room.properties);
  const today = todayISO();
  const isNow =
    room.status === "available" &&
    (!room.available_from || room.available_from <= today);
  const unitTitle = p ? unitLabel(p) : "—";

  const amenities = p
    ? [
        ...UNIT_AMENITIES.map((label) => ({
          label,
          on: (p.unit_amenities ?? []).includes(label),
        })),
        ...BUILDING_AMENITIES.map((label) => ({
          label,
          on: (p.building_amenities ?? []).includes(label),
        })),
        { label: "Private bathroom", on: room.has_private_bathroom },
        { label: "AC", on: room.has_ac },
      ]
    : [];

  // Current = active tenancy still here (or scheduled future end).
  // Previous = most recent ended tenancy.
  const current = (tenancies ?? []).find((t) => t.status === "active");
  const previous = (tenancies ?? []).find((t) => t.status === "ended");

  return (
    <div
      className={`mx-auto w-full max-w-4xl rounded-2xl border-l-4 ${ACTION_BORDER[room.listing_action]} ${ACTION_TINT[room.listing_action]} p-2`}
    >
      <div className="px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone/60 pb-6">
          <div>
            <Link
              href="/inventory"
              className="text-xs uppercase tracking-wide text-muted hover:text-ink"
            >
              ← Inventory
            </Link>
            <h1 className="mt-2 text-3xl tracking-tight text-ink">
              <span className="font-display text-accent-text">Listing:</span>{" "}
              {unitTitle}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {room.room_number ?? "Room"} · {p?.neighborhood ?? "—"}
            </p>
          </div>
          <ListingActionSelector
            roomId={room.id}
            current={room.listing_action}
          />
        </header>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold shadow-sm ${
              isNow ? "bg-accent text-white" : "bg-ink text-white"
            }`}
          >
            <span className="text-xs font-normal uppercase tracking-wide opacity-80">
              {isNow ? "Available now" : "Available"}
            </span>
            {room.available_from && (
              <span>{formatDate(room.available_from)}</span>
            )}
          </span>
          {p && (
            <Link
              href={`/properties/${p.id}`}
              className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
            >
              Full property page →
            </Link>
          )}
        </div>

        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
              Address
            </h2>
            <p className="mt-4 text-lg text-ink">{unitTitle}</p>
            {p?.building_name && (
              <p className="text-sm text-muted">{p.street_address}</p>
            )}
            {p?.cross_street && (
              <p className="mt-1 text-xs text-muted">
                Cross street: {p.cross_street}
              </p>
            )}
            <p className="mt-2 text-xs text-muted">{p?.neighborhood ?? "—"}</p>
            {p && (
              <dl className="mt-4 flex gap-6 border-t border-stone/40 pt-4">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">
                    Rooms
                  </dt>
                  <dd className="mt-0.5 text-lg tabular-nums text-ink">
                    {p.bedrooms ?? <span className="text-muted">—</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">
                    Bathrooms
                  </dt>
                  <dd className="mt-0.5 text-lg tabular-nums text-ink">
                    {p.bathrooms ?? <span className="text-muted">—</span>}
                  </dd>
                </div>
              </dl>
            )}
          </div>

          <RentEdit
            roomId={room.id}
            baseRent={room.base_rent}
            bundleFee={room.bundle_fee}
            totalRent={room.total_rent}
          />
        </section>

        <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Amenities &amp; features
          </h2>
          <ul className="mt-4 grid grid-cols-2 gap-y-2 text-sm sm:grid-cols-3">
            {amenities.map((a) => (
              <li
                key={a.label}
                className={a.on ? "text-ink" : "text-muted line-through"}
              >
                {a.label}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
              Listing description
            </h2>
            {room.marketing_description && (
              <CopyListing text={room.marketing_description} />
            )}
          </div>
          {room.marketing_description ? (
            <p className="mt-4 whitespace-pre-wrap text-sm text-ink">
              {room.marketing_description}
            </p>
          ) : (
            <p className="mt-4 text-sm text-muted">
              No description yet.{" "}
              {p && (
                <Link
                  href={`/properties/${p.id}`}
                  className="text-accent-text hover:text-accent-dark"
                >
                  Add one on the property page →
                </Link>
              )}
            </p>
          )}
        </section>

        <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Photos
          </h2>
          {room.photos_url ? (
            <a
              href={room.photos_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark"
            >
              Open Google Drive folder ↗
            </a>
          ) : (
            <p className="mt-4 text-sm text-muted">
              No photos folder yet.{" "}
              {p && (
                <Link
                  href={`/properties/${p.id}`}
                  className="text-accent-text hover:text-accent-dark"
                >
                  Add one on the property page →
                </Link>
              )}
            </p>
          )}
        </section>

        <section className="mt-6">
          <AdEdit roomId={room.id} ads={ads} />
        </section>

        <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            {current ? "Current tenant" : "Previous tenant"}
          </h2>
          {current ? (
            <TenantBlock t={current} kind="current" />
          ) : previous ? (
            <TenantBlock t={previous} kind="previous" />
          ) : (
            <p className="mt-4 text-sm text-muted">
              No tenant history on this room yet.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function TenantBlock({
  t,
  kind,
}: {
  t: Tenancy;
  kind: "current" | "previous";
}) {
  const tenant = one(t.tenants);
  if (!tenant) {
    return (
      <p className="mt-4 text-sm text-muted">Tenant record unavailable.</p>
    );
  }
  return (
    <div className="mt-4 flex flex-wrap items-start justify-between gap-3 text-sm">
      <div>
        <Link
          href={`/tenants/${tenant.id}`}
          className="text-ink hover:text-accent-text"
        >
          {tenant.full_name}
        </Link>
        {tenant.email && (
          <p className="mt-0.5 text-xs text-muted">{tenant.email}</p>
        )}
        {tenant.phone && (
          <p className="text-xs text-muted">{tenant.phone}</p>
        )}
      </div>
      <p className="text-xs text-muted">
        {formatDate(t.start_date)} – {formatDate(t.move_out_date)}
        {kind === "current" && t.move_out_date && " (scheduled)"}
      </p>
    </div>
  );
}
