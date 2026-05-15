import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { formatDate } from "@/lib/date";
import { TenantInfo } from "./tenant-info";
import { RecordPayment } from "./record-payment";
import {
  EndTenancyForm,
  DeleteTenantButton,
  DeletePaymentButton,
  ReactivateTenancyButton,
} from "./tenant-actions";
import { LeaseDownload } from "./lease-download";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

type PropertyRel = {
  id: string;
  building_name: string | null;
  street_address: string;
  unit_number: string;
};
type RoomRel = {
  id: string;
  room_number: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};
type Tenancy = {
  id: string;
  monthly_rent: number;
  security_deposit: number | null;
  start_date: string;
  end_date: string | null;
  status: "active" | "ended" | "upcoming";
  lease_pdf_path: string | null;
  rooms: RoomRel | RoomRel[] | null;
};

type Payment = {
  id: string;
  paid_on: string;
  amount: number;
  payment_type: string;
  method: string | null;
  notes: string | null;
  tenancy_id: string;
};

function fmtMoney(n: number | null) {
  if (n === null) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function unitTitle(t: Tenancy) {
  const room = one(t.rooms);
  const p = one(room?.properties ?? null);
  if (!p) return "—";
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

export default async function TenantDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: tenant }, { data: tenancies }, { data: payments }] =
    await Promise.all([
      supabase
        .from("tenants")
        .select(
          "id, full_name, email, phone, pays_as, notes, age, profession, linkedin_url, instagram_url",
        )
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("tenancies")
        .select(
          `id, monthly_rent, security_deposit, start_date, end_date, status,
           lease_pdf_path,
           rooms(id, room_number,
                 properties(id, building_name, street_address, unit_number))`,
        )
        .eq("tenant_id", id)
        .order("start_date", { ascending: false })
        .returns<Tenancy[]>(),
      supabase
        .from("payments")
        .select(
          `id, paid_on, amount, payment_type, method, notes, tenancy_id,
           tenancies!inner(tenant_id)`,
        )
        .eq("tenancies.tenant_id", id)
        .order("paid_on", { ascending: false })
        .returns<Payment[]>(),
    ]);

  if (!tenant) notFound();

  const active = tenancies?.find((t) => t.status === "active") ?? null;
  const past = (tenancies ?? []).filter((t) => t.status !== "active");
  const totalPaid =
    payments
      ?.filter((p) => p.payment_type === "rent")
      .reduce((sum, p) => sum + Number(p.amount), 0) ?? 0;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-6">
        <div>
          <Link
            href="/tenants"
            className="text-xs uppercase tracking-wide text-muted hover:text-ink"
          >
            ← Tenants &amp; Rent
          </Link>
          <h1 className="mt-2 text-3xl tracking-tight text-ink">
            {tenant.full_name}
          </h1>
          {active && (
            <p className="mt-1 text-sm text-muted">
              {unitTitle(active)} · {one(active.rooms)?.room_number ?? "—"}
            </p>
          )}
        </div>
      </header>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <TenantInfo
          id={tenant.id}
          full_name={tenant.full_name}
          email={tenant.email}
          phone={tenant.phone}
          pays_as={tenant.pays_as}
          notes={tenant.notes}
          age={tenant.age}
          profession={tenant.profession}
          linkedin_url={tenant.linkedin_url}
          instagram_url={tenant.instagram_url}
        />

        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Current tenancy
          </h2>
          {active ? (
            <>
              <dl className="mt-4 grid grid-cols-3 gap-y-3 text-sm">
                <dt className="text-muted">Unit</dt>
                <dd className="col-span-2 text-ink">
                  <Link
                    href={`/properties/${one(one(active.rooms)?.properties ?? null)?.id ?? ""}`}
                    className="hover:text-accent-text"
                  >
                    {unitTitle(active)} · {one(active.rooms)?.room_number ?? "—"}
                  </Link>
                </dd>
                <dt className="text-muted">Monthly</dt>
                <dd className="col-span-2 text-ink">
                  {fmtMoney(active.monthly_rent)}
                </dd>
                <dt className="text-muted">Deposit</dt>
                <dd className="col-span-2 text-ink">
                  {fmtMoney(active.security_deposit)}
                </dd>
                <dt className="text-muted">Started</dt>
                <dd className="col-span-2 text-ink">{formatDate(active.start_date)}</dd>
                {active.end_date && (
                  <>
                    <dt className="text-muted">Ending</dt>
                    <dd className="col-span-2">
                      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs uppercase tracking-wide text-accent-text">
                        {formatDate(active.end_date)}
                      </span>
                    </dd>
                  </>
                )}
              </dl>
              <div className="mt-4 flex flex-wrap items-center gap-4">
                {!active.end_date ? (
                  <EndTenancyForm
                    tenancyId={active.id}
                    tenantId={tenant.id}
                  />
                ) : (
                  <ReactivateTenancyButton
                    tenancyId={active.id}
                    tenantId={tenant.id}
                    label="Cancel scheduled end"
                    variant="primary"
                  />
                )}
                {active.lease_pdf_path && (
                  <LeaseDownload tenancyId={active.id} />
                )}
              </div>
              <p className="mt-3 text-xs text-muted">
                A future end date keeps the room occupied until then, but marks
                it as <em>Available from</em> that date on the Inventory page.
              </p>
            </>
          ) : (
            <p className="mt-4 text-sm text-muted">
              No active tenancy. Past tenancies are listed below if any.
            </p>
          )}
        </div>
      </div>

      <section className="mt-10">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl tracking-tight text-ink">
              <span className="font-display text-accent-text">Payments</span>
            </h2>
            <p className="mt-1 text-xs text-muted">
              Total rent paid to date: {fmtMoney(totalPaid)}
            </p>
          </div>
          {active && (
            <RecordPayment
              tenancyId={active.id}
              tenantId={tenant.id}
              defaultAmount={Number(active.monthly_rent)}
            />
          )}
        </header>

        {(!payments || payments.length === 0) && (
          <p className="mt-4 rounded-2xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
            No payments recorded yet.
          </p>
        )}

        {payments && payments.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 text-right font-medium">Amount</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 font-medium">Method</th>
                  <th className="px-5 py-3 font-medium">Notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-t border-stone/40">
                    <td className="px-5 py-3 text-ink">{formatDate(p.paid_on)}</td>
                    <td className="px-5 py-3 text-right text-ink">
                      {fmtMoney(p.amount)}
                    </td>
                    <td className="px-5 py-3 text-muted">
                      {p.payment_type.replace("_", " ")}
                    </td>
                    <td className="px-5 py-3 text-muted">{p.method ?? "—"}</td>
                    <td className="px-5 py-3 text-muted">{p.notes ?? ""}</td>
                    <td className="px-5 py-3 text-right">
                      <DeletePaymentButton
                        paymentId={p.id}
                        tenantId={tenant.id}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {past.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Past tenancies</span>
          </h2>
          <ul className="mt-4 flex flex-col gap-3">
            {past.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-white px-5 py-4 shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    {unitTitle(t)} · {one(t.rooms)?.room_number ?? "—"}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDate(t.start_date)} – {formatDate(t.end_date)} ·{" "}
                    {fmtMoney(t.monthly_rent)}/mo
                  </p>
                </div>
                <ReactivateTenancyButton
                  tenancyId={t.id}
                  tenantId={tenant.id}
                  label="Reactivate"
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-16 border-t border-stone/60 pt-6">
        <DeleteTenantButton id={tenant.id} name={tenant.full_name} />
      </section>
    </div>
  );
}
