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
    { data: residents },
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
    // Active residents of this property — for the Residents widget.
    supabase
      .from("tenancies")
      .select(
        `status, rooms!inner(room_number, property_id),
         tenants(id, full_name, age, profession, linkedin_url, instagram_url)`,
      )
      .eq("rooms.property_id", id)
      .eq("status", "active"),
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

      <ResidentsWidget rows={residents ?? []} />

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

type ResidentRow = {
  rooms: { room_number: string | null } | { room_number: string | null }[] | null;
  tenants:
    | {
        id: string;
        full_name: string;
        age: number | null;
        profession: string | null;
        linkedin_url: string | null;
        instagram_url: string | null;
      }
    | {
        id: string;
        full_name: string;
        age: number | null;
        profession: string | null;
        linkedin_url: string | null;
        instagram_url: string | null;
      }[]
    | null;
};

function ResidentsWidget({ rows }: { rows: ResidentRow[] }) {
  const cards = rows
    .map((r) => {
      const room = one(r.rooms);
      const tenant = one(r.tenants);
      if (!tenant) return null;
      return {
        ...tenant,
        room_number: room?.room_number ?? null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (a.room_number ?? "").localeCompare(b.room_number ?? ""));

  return (
    <section id="residents" className="mt-10 scroll-mt-6">
      <header className="flex items-end justify-between gap-3">
        <h2 className="text-xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Residents</span>
        </h2>
        <span className="text-xs text-muted">
          {cards.length} active
        </span>
      </header>

      {cards.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
          No active tenants in this unit yet.
        </p>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => {
            const initials = c.full_name
              .split(/\s+/)
              .map((part) => part[0])
              .slice(0, 2)
              .join("")
              .toUpperCase();
            return (
              <li
                key={c.id}
                className="rounded-2xl bg-white p-5 shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent/15 text-base font-medium text-accent-text">
                    {initials || "—"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/tenants/${c.id}`}
                      className="block truncate text-ink hover:text-accent-text"
                    >
                      {c.full_name}
                    </Link>
                    {c.room_number && (
                      <p className="text-[11px] uppercase tracking-wide text-muted">
                        {c.room_number}
                      </p>
                    )}
                  </div>
                </div>

                <dl className="mt-4 grid grid-cols-3 gap-y-1.5 text-xs">
                  <dt className="text-muted">Age</dt>
                  <dd className="col-span-2 text-ink">{c.age ?? "—"}</dd>
                  <dt className="text-muted">Profession</dt>
                  <dd className="col-span-2 truncate text-ink">
                    {c.profession ?? "—"}
                  </dd>
                </dl>

                <div className="mt-4 flex items-center gap-2">
                  {c.linkedin_url ? (
                    <a
                      href={c.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="LinkedIn"
                      title="LinkedIn"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-stone bg-white text-[#0a66c2] transition hover:bg-warm"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.05-1.86-3.05-1.86 0-2.14 1.45-2.14 2.95v5.67H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.86 3.38-1.86 3.61 0 4.28 2.38 4.28 5.47v6.28zM5.34 7.43a2.06 2.06 0 11-.01-4.12 2.06 2.06 0 01.01 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z" />
                      </svg>
                    </a>
                  ) : (
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-stone/50 text-muted/50">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.05-1.86-3.05-1.86 0-2.14 1.45-2.14 2.95v5.67H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.86 3.38-1.86 3.61 0 4.28 2.38 4.28 5.47v6.28zM5.34 7.43a2.06 2.06 0 11-.01-4.12 2.06 2.06 0 01.01 4.12zM7.12 20.45H3.56V9h3.56v11.45z" />
                      </svg>
                    </span>
                  )}
                  {c.instagram_url ? (
                    <a
                      href={c.instagram_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Instagram"
                      title="Instagram"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-stone bg-white text-[#e1306c] transition hover:bg-warm"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M12 2.16c3.2 0 3.58.012 4.85.07 1.17.054 1.8.249 2.22.415.56.217.96.477 1.38.897.42.42.68.819.897 1.38.166.42.36 1.05.415 2.22.058 1.27.07 1.65.07 4.85s-.012 3.58-.07 4.85c-.054 1.17-.249 1.8-.415 2.22a3.72 3.72 0 01-.897 1.38 3.72 3.72 0 01-1.38.897c-.42.166-1.05.36-2.22.415-1.27.058-1.65.07-4.85.07s-3.58-.012-4.85-.07c-1.17-.054-1.8-.249-2.22-.415a3.72 3.72 0 01-1.38-.897 3.72 3.72 0 01-.897-1.38c-.166-.42-.36-1.05-.415-2.22-.058-1.27-.07-1.65-.07-4.85s.012-3.58.07-4.85c.054-1.17.249-1.8.415-2.22.217-.56.477-.96.897-1.38.42-.42.819-.68 1.38-.897.42-.166 1.05-.36 2.22-.415C8.42 2.172 8.8 2.16 12 2.16zM12 0C8.74 0 8.33.014 7.05.072 5.78.13 4.9.333 4.14.63a5.88 5.88 0 00-2.13 1.38A5.88 5.88 0 00.63 4.14C.333 4.9.13 5.78.072 7.05.014 8.33 0 8.74 0 12s.014 3.67.072 4.95c.058 1.27.261 2.15.558 2.91a5.88 5.88 0 001.38 2.13 5.88 5.88 0 002.13 1.38c.76.297 1.64.5 2.91.558C8.33 23.986 8.74 24 12 24s3.67-.014 4.95-.072c1.27-.058 2.15-.261 2.91-.558a5.88 5.88 0 002.13-1.38 5.88 5.88 0 001.38-2.13c.297-.76.5-1.64.558-2.91.058-1.28.072-1.69.072-4.95s-.014-3.67-.072-4.95c-.058-1.27-.261-2.15-.558-2.91a5.88 5.88 0 00-1.38-2.13A5.88 5.88 0 0019.86.63c-.76-.297-1.64-.5-2.91-.558C15.67.014 15.26 0 12 0zm0 5.84a6.16 6.16 0 100 12.32 6.16 6.16 0 000-12.32zM12 16a4 4 0 110-8 4 4 0 010 8zm6.4-11.85a1.44 1.44 0 11-2.88 0 1.44 1.44 0 012.88 0z" />
                      </svg>
                    </a>
                  ) : (
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-stone/50 text-muted/50">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2.16c3.2 0 3.58.012 4.85.07 1.17.054 1.8.249 2.22.415.56.217.96.477 1.38.897.42.42.68.819.897 1.38.166.42.36 1.05.415 2.22.058 1.27.07 1.65.07 4.85s-.012 3.58-.07 4.85c-.054 1.17-.249 1.8-.415 2.22a3.72 3.72 0 01-.897 1.38 3.72 3.72 0 01-1.38.897c-.42.166-1.05.36-2.22.415-1.27.058-1.65.07-4.85.07s-3.58-.012-4.85-.07c-1.17-.054-1.8-.249-2.22-.415a3.72 3.72 0 01-1.38-.897 3.72 3.72 0 01-.897-1.38c-.166-.42-.36-1.05-.415-2.22-.058-1.27-.07-1.65-.07-4.85s.012-3.58.07-4.85c.054-1.17.249-1.8.415-2.22.217-.56.477-.96.897-1.38.42-.42.819-.68 1.38-.897.42-.166 1.05-.36 2.22-.415C8.42 2.172 8.8 2.16 12 2.16z" />
                      </svg>
                    </span>
                  )}
                  <Link
                    href={`/tenants/${c.id}`}
                    className="ml-auto text-[11px] uppercase tracking-wide text-muted hover:text-accent-text"
                  >
                    Edit →
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
