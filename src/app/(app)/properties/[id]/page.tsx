import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { formatDate } from "@/lib/date";
import { cleaningScheduleFor, todayISO } from "@/lib/cleaning";
import { DeletePropertyButton } from "./delete-button";
import { AddRoom } from "./add-room";
import { RoomRow } from "./room-row";
import { AddCleaning } from "../../cleaning/add-cleaning";
import { CleaningRow, type CleaningRowData } from "../../cleaning/cleaning-row";
import {
  CredentialRow,
  type CredentialRowData,
} from "../../credentials/credential-row";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
} from "../../credentials/constants";
import type { Database } from "@/lib/supabase/types";

type CredentialCategory =
  Database["public"]["Enums"]["credential_category"];

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function PropertyDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: property },
    { data: rooms },
    { data: cleanings },
    { data: credentials },
  ] = await Promise.all([
    supabase
      .from("properties")
      .select(
        `id, building_name, street_address, unit_number, cross_street,
         neighborhood, bedrooms, bathrooms,
         has_gym, has_elevator, has_parking, has_doorman, has_rooftop,
         laundry_in_building, in_unit_laundry,
         amenities_notes, notes,
         leaseholders(id, name)`,
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("rooms")
      .select(
        "id, room_number, base_rent, bundle_fee, total_rent, status, available_from, has_ac, has_private_bathroom, notes, marketing_description, photos_url",
      )
      .eq("property_id", id)
      .order("room_number", { ascending: true }),
    supabase
      .from("cleaning_records")
      .select("id, property_id, cleaning_date, assigned_to, notes")
      .eq("property_id", id)
      .order("cleaning_date", { ascending: false }),
    supabase
      .from("credentials")
      .select(
        `id, category, service_name, property_id, username, password,
         login_url, account_number, owner_label, notes`,
      )
      .eq("property_id", id)
      .order("category", { ascending: true })
      .order("service_name", { ascending: true }),
  ]);

  if (!property) notFound();

  const title = property.building_name?.trim() || property.street_address;
  const leaseholder = one(property.leaseholders);

  const amenities: { label: string; on: boolean }[] = [
    { label: "Gym", on: property.has_gym },
    { label: "Elevator", on: property.has_elevator },
    { label: "Parking", on: property.has_parking },
    { label: "Doorman", on: property.has_doorman },
    { label: "Rooftop", on: property.has_rooftop },
    { label: "Laundry in building", on: property.laundry_in_building },
    { label: "In-unit laundry", on: property.in_unit_laundry },
  ];

  const propertyLabel = `${title} Apt ${property.unit_number}`;
  const propertyOptions = [{ id: property.id, label: propertyLabel }];

  const cleaningRows: CleaningRowData[] = (cleanings ?? []).map((c) => ({
    id: c.id,
    property_id: c.property_id,
    property_label: propertyLabel,
    cleaning_date: c.cleaning_date,
    assigned_to: c.assigned_to,
    notes: c.notes,
  }));

  const credentialRows: CredentialRowData[] = (credentials ?? []).map((c) => ({
    id: c.id,
    category: c.category,
    service_name: c.service_name,
    property_id: c.property_id,
    property_label: propertyLabel,
    username: c.username,
    password: c.password,
    login_url: c.login_url,
    account_number: c.account_number,
    owner_label: c.owner_label,
    notes: c.notes,
  }));

  const credsByCategory = new Map<CredentialCategory, CredentialRowData[]>();
  for (const c of CATEGORY_ORDER) credsByCategory.set(c, []);
  for (const c of credentialRows) credsByCategory.get(c.category)?.push(c);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone/60 pb-6">
        <div>
          <Link
            href="/properties"
            className="text-xs uppercase tracking-wide text-muted hover:text-ink"
          >
            ← Properties
          </Link>
          <h1 className="mt-2 text-3xl tracking-tight text-ink">
            {title}{" "}
            <span className="font-display text-accent-text">
              Apt {property.unit_number}
            </span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            {property.building_name && `${property.street_address} · `}
            {property.neighborhood ?? "—"}
            {property.cross_street && ` · ${property.cross_street}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/properties/${property.id}/edit`}
            className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-ink hover:bg-warm"
          >
            Edit
          </Link>
        </div>
      </header>

      <section className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Unit
          </h2>
          <dl className="mt-4 grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-muted">Bedrooms</dt>
            <dd className="text-ink">{property.bedrooms ?? "—"}</dd>
            <dt className="text-muted">Bathrooms</dt>
            <dd className="text-ink">{property.bathrooms ?? "—"}</dd>
            <dt className="text-muted">Leaseholder</dt>
            <dd className="text-ink">{leaseholder?.name ?? "—"}</dd>
          </dl>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Amenities
          </h2>
          <ul className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
            {amenities.map((a) => (
              <li
                key={a.label}
                className={a.on ? "text-ink" : "text-muted line-through"}
              >
                {a.label}
              </li>
            ))}
          </ul>
          {property.amenities_notes && (
            <p className="mt-4 text-sm text-muted">{property.amenities_notes}</p>
          )}
        </div>
      </section>

      {property.notes && (
        <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Notes
          </h2>
          <p className="mt-3 whitespace-pre-wrap text-sm text-ink">
            {property.notes}
          </p>
        </section>
      )}

      <section className="mt-10">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Rooms</span>
          </h2>
          <AddRoom propertyId={property.id} />
        </header>

        {(!rooms || rooms.length === 0) && (
          <p className="mt-4 rounded-2xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
            No rooms yet. Click <em>Add room</em> to add the first one.
          </p>
        )}

        {rooms && rooms.length > 0 && (
          <ul className="mt-4 flex flex-col gap-3">
            {rooms.map((r) => (
              <RoomRow key={r.id} propertyId={property.id} room={r} />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Cleaning</span>
          </h2>
          <AddCleaning
            properties={propertyOptions}
            defaultPropertyId={property.id}
          />
        </header>

        {(() => {
          const today = todayISO();
          const last = cleaningRows[0]?.cleaning_date ?? null;
          const s = cleaningScheduleFor(last, today);
          const pill =
            s.status === "never" || s.status === "overdue"
              ? "bg-red-100 text-red-900"
              : s.status === "due_soon"
                ? "bg-orange-100 text-orange-900"
                : "bg-warm text-ink/70";
          const label =
            s.status === "never"
              ? "Never cleaned"
              : s.status === "overdue"
                ? `Overdue ${Math.abs(s.daysUntil ?? 0)}d`
                : s.status === "due_soon"
                  ? `Due in ${s.daysUntil}d`
                  : `In ${s.daysUntil}d`;
          return (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-white px-4 py-3 text-sm shadow-sm">
              <span className="text-xs uppercase tracking-wide text-muted">
                Last: {s.last ? formatDate(s.last) : "—"}
              </span>
              {s.nextDue && (
                <span className="text-xs uppercase tracking-wide text-muted">
                  Next: {formatDate(s.nextDue)}
                </span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${pill}`}
              >
                {label}
              </span>
            </div>
          );
        })()}

        {cleaningRows.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
            No cleanings logged for this unit yet.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {cleaningRows.map((r) => (
              <CleaningRow
                key={r.id}
                record={r}
                properties={propertyOptions}
                showProperty={false}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Credentials</span>
          </h2>
          <Link
            href="/credentials"
            className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
          >
            Manage in vault →
          </Link>
        </header>
        {credentialRows.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
            No credentials linked to this unit yet. Add them from{" "}
            <Link href="/credentials" className="text-accent-text">
              Credentials
            </Link>{" "}
            and pick this property.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Service</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Username</th>
                  <th className="px-3 py-2 font-medium">Password</th>
                  <th className="px-3 py-2 font-medium">Account #</th>
                  <th className="px-3 py-2 font-medium">Link</th>
                  <th className="px-3 py-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {CATEGORY_ORDER.flatMap((cat) =>
                  (credsByCategory.get(cat) ?? []).map((c) => c),
                ).map((c, i) => (
                  <CredentialRow
                    key={c.id}
                    credential={c}
                    properties={propertyOptions}
                    striped={i % 2 === 1}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-16 border-t border-stone/60 pt-6">
        <DeletePropertyButton id={property.id} label={propertyLabel} />
      </section>
    </div>
  );
}
