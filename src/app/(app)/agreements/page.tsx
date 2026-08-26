import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
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
  ] = await Promise.all([
    supabase
      .from("tenancies")
      .select(
        `id, status, tenant_id, monthly_rent, security_deposit, start_date, lease_start_date, lease_end_date, lease_pdf_path,
           tenants(full_name, email),
           rooms(room_number, properties(id, building_name, street_address, unit_number, is_new_york))`,
      )
      .in("status", ["active", "upcoming"])
      .order("start_date", { ascending: false })
      .returns<Row[]>(),
    supabase
      .from("agreement_requests")
      .select(
        "id, status, tenant_name, recipient_email, property_address, sent_at, expires_at, signed_at, tenant_signature_kind, assigned_tenancy_id",
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
  ]);

  const prefills: TenancyPrefill[] = (data ?? []).flatMap((row) => {
    const tenant = one(row.tenants);
    const room = one(row.rooms);
    const property = room ? one(room.properties) : null;
    if (!tenant) return [];
    const address = property
      ? `${property.street_address}${property.unit_number ? `, Apt ${property.unit_number}` : ""}`
      : "";
    const place = property
      ? property.building_name?.trim() || property.street_address
      : "";
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
    const place = property
      ? property.building_name?.trim() || property.street_address
      : "";
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

  const requests: SigningRequestRow[] = (requestRows ?? []).map((r) => ({
    id: r.id,
    status: r.status as SigningRequestRow["status"],
    tenantName: r.tenant_name,
    recipientEmail: r.recipient_email,
    propertyAddress: r.property_address,
    sentAt: r.sent_at,
    expiresAt: r.expires_at,
    signedAt: r.signed_at,
    signatureKind: r.tenant_signature_kind as SigningRequestRow["signatureKind"],
    assignedTenancyId: r.assigned_tenancy_id,
  }));

  const confirmedById = new Map(
    (addressRows ?? []).map((a) => [a.property_id, a.full_address]),
  );
  const propertyOptions: PropertyOption[] = (propertyRows ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} · Apt ${p.unit_number}`,
    address: confirmedById.get(p.id) ?? composeFullAddress(p).full_address,
    isNewYork: p.is_new_york,
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
