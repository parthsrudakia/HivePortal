import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { unitLabel } from "@/lib/unit-label";
import { formatDate, todayISO } from "@/lib/date";
import {
  AGREEMENTS_BUCKET,
  OPERATOR_SIGNATURE_PATH,
} from "@/lib/agreement-send";
import { composeFullAddress } from "@/lib/agreement-address";
import {
  AgreementGenerator,
  type PropertyOption,
  type TenancyPrefill,
} from "./agreement-generator";
import {
  AgreementTally,
  type AssignOption,
  type SigningRequestRow,
} from "./agreement-tally";
import { OperatorSignatureCard } from "./operator-signature-card";

export const metadata = {
  title: "Agreements",
};

export const dynamic = "force-dynamic";

type PropertyRel = {
  id: string;
  building_name: string | null;
  street_address: string;
  unit_number: string;
  is_new_york: boolean;
};
type RoomRel = {
  id: string;
  room_number: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};
type TenantRel = { full_name: string; email: string | null };
type Row = {
  id: string;
  status: string;
  tenant_id: string;
  monthly_rent: number;
  security_deposit: number | null;
  start_date: string;
  lease_start_date: string | null;
  lease_end_date: string | null;
  lease_pdf_path: string | null;
  tenants: TenantRel | TenantRel[] | null;
  rooms: RoomRel | RoomRel[] | null;
};

export default async function AgreementsPage() {
  const supabase = await createClient();

  // Active AND upcoming tenancies feed the prefill picker — agreements are
  // typically sent before move-in, so future tenants must be pickable. Every
  // field stays editable; the picker only saves typing and never constrains
  // what can be generated. The same rows drive the tally's assign-to-tenant
  // picker.
  const [
    { data },
    { data: requestRows },
    { data: signatureUrlData },
    { data: propertyRows },
    { data: addressRows },
    { data: tenantRows },
    { data: tenancyRows },
    { data: roomRows },
  ] = await Promise.all([
    supabase
      .from("tenancies")
      .select(
        `id, status, tenant_id, monthly_rent, security_deposit, start_date, lease_start_date, lease_end_date, lease_pdf_path,
           tenants(full_name, email),
           rooms(id, room_number, properties(id, building_name, street_address, unit_number, is_new_york))`,
      )
      .in("status", ["active", "upcoming"])
      .order("start_date", { ascending: false })
      .returns<Row[]>(),
    supabase
      .from("agreement_requests")
      .select(
        "id, status, tenant_name, recipient_email, property_address, room_number, sent_at, expires_at, signed_at, tenant_signature_kind, assigned_tenancy_id",
      )
      .order("sent_at", { ascending: false }),
    supabase.storage
      .from(AGREEMENTS_BUCKET)
      .createSignedUrl(OPERATOR_SIGNATURE_PATH, 300),
    // Agreements can only be sent for properties already in the system — the
    // form's address field is a searchable picker over these.
    supabase
      .from("properties")
      .select(
        "id, building_name, street_address, unit_number, neighborhood, is_new_york",
      )
      .order("street_address"),
    // Addresses confirmed on previously sent agreements win over composed ones.
    supabase.from("agreement_addresses").select("property_id, full_address"),
    // Every tenant profile plus every tenancy (any status): the tally links a
    // request's tenant name to their profile when one exists, and marks
    // tenants whose tenancies have all ended as past.
    supabase.from("tenants").select("id, full_name, email"),
    supabase.from("tenancies").select("id, tenant_id, status"),
    // The room is mandatory on every agreement and must be one of the
    // property's rooms — the form offers them as a picker per property.
    supabase
      .from("rooms")
      .select("id, property_id, room_number")
      .not("room_number", "is", null)
      .order("room_number"),
  ]);

  const prefills: TenancyPrefill[] = (data ?? []).flatMap((row) => {
    const tenant = one(row.tenants);
    const room = one(row.rooms);
    const property = room ? one(room.properties) : null;
    if (!tenant) return [];
    const address = property
      ? `${property.street_address}${property.unit_number ? `, Apt ${property.unit_number}` : ""}`
      : "";
    // Apt number included: buildings hold many units, so the name alone
    // (e.g. "Singh Tower") would name every unit in the building alike.
    const place = property ? unitLabel(property) : "";
    const upcomingTag =
      row.status === "upcoming" ? ` · moves in ${formatDate(row.start_date)}` : "";
    return [
      {
        id: row.id,
        tenantName: tenant.full_name,
        tenantEmail: tenant.email ?? "",
        label: `${tenant.full_name}${place ? ` — ${place}` : ""}${room?.room_number ? ` · Room ${room.room_number}` : ""}${upcomingTag}`,
        propertyId: property?.id ?? "",
        propertyAddress: address,
        roomId: room?.id ?? "",
        roomNumber: room?.room_number ?? "",
        rent: String(row.monthly_rent),
        securityDeposit: row.security_deposit != null ? String(row.security_deposit) : "",
        leaseStartDate: row.lease_start_date ?? row.start_date,
        leaseEndDate: row.lease_end_date ?? "",
        isNewYork: property?.is_new_york ?? false,
      },
    ];
  });

  const assignOptions: AssignOption[] = (data ?? []).flatMap((row) => {
    const tenant = one(row.tenants);
    if (!tenant) return [];
    const room = one(row.rooms);
    const property = room ? one(room.properties) : null;
    // Apt number included: buildings hold many units, so the name alone
    // (e.g. "Singh Tower") would name every unit in the building alike.
    const place = property ? unitLabel(property) : "";
    const upcomingTag =
      row.status === "upcoming" ? ` · moves in ${formatDate(row.start_date)}` : "";
    return [
      {
        tenancyId: row.id,
        label: `${tenant.full_name}${place ? ` — ${place}` : ""}${room?.room_number ? ` · Room ${room.room_number}` : ""}${upcomingTag}`,
        hasLease: row.lease_pdf_path != null,
      },
    ];
  });

  // Resolve each request to a tenant profile: the assigned tenancy wins,
  // then the recipient email, then an unambiguous full-name match. Requests
  // that resolve to nobody render as plain, unlinked text in the tally.
  const tenantByTenancy = new Map<string, string>();
  const tenantHasCurrent = new Map<string, boolean>();
  for (const t of tenancyRows ?? []) {
    tenantByTenancy.set(t.id, t.tenant_id);
    tenantHasCurrent.set(
      t.tenant_id,
      (tenantHasCurrent.get(t.tenant_id) ?? false) || t.status !== "ended",
    );
  }
  const tenantIdsByEmail = new Map<string, string[]>();
  const tenantIdsByName = new Map<string, string[]>();
  for (const t of tenantRows ?? []) {
    const email = t.email?.trim().toLowerCase();
    if (email) tenantIdsByEmail.set(email, [...(tenantIdsByEmail.get(email) ?? []), t.id]);
    const name = t.full_name.trim().toLowerCase();
    if (name) tenantIdsByName.set(name, [...(tenantIdsByName.get(name) ?? []), t.id]);
  }
  const uniqueMatch = (ids: string[] | undefined) =>
    ids && ids.length === 1 ? ids[0] : null;
  const resolveTenant = (r: {
    assigned_tenancy_id: string | null;
    recipient_email: string;
    tenant_name: string;
  }): string | null =>
    (r.assigned_tenancy_id ? tenantByTenancy.get(r.assigned_tenancy_id) : null) ??
    uniqueMatch(tenantIdsByEmail.get(r.recipient_email.trim().toLowerCase())) ??
    uniqueMatch(tenantIdsByName.get(r.tenant_name.trim().toLowerCase()));

  const requests: SigningRequestRow[] = (requestRows ?? []).map((r) => {
    const tenantId = resolveTenant(r);
    return {
      id: r.id,
      status: r.status as SigningRequestRow["status"],
      tenantName: r.tenant_name,
      recipientEmail: r.recipient_email,
      propertyAddress: r.property_address,
      roomNumber: r.room_number,
      sentAt: r.sent_at,
      expiresAt: r.expires_at,
      signedAt: r.signed_at,
      signatureKind: r.tenant_signature_kind as SigningRequestRow["signatureKind"],
      assignedTenancyId: r.assigned_tenancy_id,
      tenantId,
      // A profile whose tenancies have all ended is a past tenant. Profiles
      // with no tenancy yet (e.g. just added from a signed agreement) count
      // as current.
      tenantIsPast:
        tenantId !== null &&
        tenantHasCurrent.has(tenantId) &&
        !tenantHasCurrent.get(tenantId),
    };
  });

  const confirmedById = new Map(
    (addressRows ?? []).map((a) => [a.property_id, a.full_address]),
  );
  const roomsByProperty = new Map<string, { id: string; roomNumber: string }[]>();
  for (const r of roomRows ?? []) {
    const number = r.room_number?.trim();
    if (!number) continue;
    roomsByProperty.set(r.property_id, [
      ...(roomsByProperty.get(r.property_id) ?? []),
      { id: r.id, roomNumber: number },
    ]);
  }
  const propertyOptions: PropertyOption[] = (propertyRows ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} · Apt ${p.unit_number}`,
    address: confirmedById.get(p.id) ?? composeFullAddress(p).full_address,
    isNewYork: p.is_new_york,
    rooms: roomsByProperty.get(p.id) ?? [],
  }));

  const operatorSignatureUrl = signatureUrlData?.signedUrl ?? null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header>
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Agreements</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Generate a sublease agreement PDF, or email it to the tenant with a
          48-hour online signing link. New York units go out plain; everything
          else includes the Hive letterhead.
        </p>
      </header>

      <OperatorSignatureCard signatureUrl={operatorSignatureUrl} />

      <AgreementTally requests={requests} assignOptions={assignOptions} />

      <AgreementGenerator
        prefills={prefills}
        propertyOptions={propertyOptions}
        defaultAgreementDate={todayISO()}
        hasOperatorSignature={operatorSignatureUrl !== null}
      />
    </div>
  );
}
