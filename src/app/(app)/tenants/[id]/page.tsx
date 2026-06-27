import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { formatDate } from "@/lib/date";
import { TenantInfo } from "./tenant-info";
import { RecordPayment } from "./record-payment";
import { RecordCharge } from "./record-charge";
import {
  EndTenancyForm,
  DeleteTenantButton,
  DeletePaymentButton,
  DeleteChargeButton,
  ReactivateTenancyButton,
} from "./tenant-actions";
import { LeaseDownload } from "./lease-download";
import { LeaseEndEdit } from "./lease-end-edit";
import { computeLedger, buildLedgerEntries } from "@/lib/rent";
import { todayISO } from "@/lib/date";
import { isMaster } from "@/lib/access";

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
  first_month_rent: number | null;
  security_deposit: number | null;
  start_date: string;
  move_out_date: string | null;
  lease_end_date: string | null;
  status: "active" | "ended" | "upcoming";
  lease_pdf_path: string | null;
  rooms: RoomRel | RoomRel[] | null;
};

type Charge = {
  id: string;
  kind: string;
  amount: number;
  charged_on: string;
  note: string | null;
};
type Allocation = {
  id: string;
  kind: string;
  amount: number;
  note: string | null;
  created_at: string;
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

// Renders a ledger balance: red when owed, a honey "Credit" badge when the
// bucket is in credit (overpaid), muted "Settled" when flat.
function BalanceCell({ n }: { n: number }) {
  if (n > 0.005) {
    return <span className="text-red-700">{fmtMoney(n)}</span>;
  }
  if (n < -0.005) {
    return (
      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs uppercase tracking-wide text-accent-text">
        Credit {fmtMoney(-n)}
      </span>
    );
  }
  return <span className="text-muted">Settled</span>;
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Only admins see ledger amounts; others see paid/balance/credit status only.
  const admin = isMaster(user?.email);

  const [{ data: tenant }, { data: tenancies }, { data: payments }] =
    await Promise.all([
      supabase
        .from("tenants")
        .select(
          "id, full_name, email, phone, pays_as, notes, age, gender, profession, linkedin_url, instagram_url",
        )
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("tenancies")
        .select(
          `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, lease_end_date, status,
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

  // Running ledger for the active tenancy: auto monthly rent + ad-hoc charges
  // (deposit / late fee) + payments, in one carry-forward balance.
  let charges: Charge[] = [];
  let allocations: Allocation[] = [];
  if (active) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const [chargeRes, allocRes] = await Promise.all([
      sb
        .from("tenancy_charges")
        .select("id, kind, amount, charged_on, note")
        .eq("tenancy_id", active.id)
        .order("charged_on", { ascending: false }),
      // Legacy credit allocations are no longer created, but existing rows are
      // still fed to computeLedger so historical balances stay consistent.
      sb
        .from("credit_allocations")
        .select("id, kind, amount, note, created_at")
        .eq("tenancy_id", active.id)
        .order("created_at", { ascending: false }),
    ]);
    charges = (chargeRes.data ?? []) as Charge[];
    allocations = (allocRes.data ?? []) as Allocation[];
  }
  const activePayments = active
    ? (payments ?? []).filter((p) => p.tenancy_id === active.id)
    : [];
  const ledger = active
    ? computeLedger(active, activePayments, charges, allocations, todayISO())
    : null;
  const ledgerEntries = active
    ? buildLedgerEntries(active, activePayments, charges, todayISO())
    : [];
  const summaryRows = ledger
    ? [
        { label: "Security deposit", amount: ledger.deposit.owed },
        { label: "Late fees", amount: ledger.lateFee.owed },
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-6">
        <div>
          <Link
            href="/tenants"
            className="text-xs uppercase tracking-wide text-muted hover:text-ink"
          >
            ← Rent Tracker
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
          gender={tenant.gender}
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
                <dt className="text-muted">Lease ends</dt>
                <dd className="col-span-2 text-ink">
                  <LeaseEndEdit
                    tenancyId={active.id}
                    tenantId={tenant.id}
                    value={active.lease_end_date}
                  />
                </dd>
                {active.move_out_date && (
                  <>
                    <dt className="text-muted">Moving out</dt>
                    <dd className="col-span-2">
                      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs uppercase tracking-wide text-accent-text">
                        {formatDate(active.move_out_date)}
                      </span>
                    </dd>
                  </>
                )}
              </dl>
              <div className="mt-4 flex flex-wrap items-center gap-4">
                {!active.move_out_date ? (
                  <EndTenancyForm
                    tenancyId={active.id}
                    tenantId={tenant.id}
                  />
                ) : (
                  <ReactivateTenancyButton
                    tenancyId={active.id}
                    tenantId={tenant.id}
                    label="Cancel move out"
                    variant="primary"
                  />
                )}
                {active.lease_pdf_path && (
                  <LeaseDownload tenancyId={active.id} />
                )}
              </div>
            </>
          ) : (
            <p className="mt-4 text-sm text-muted">
              No active tenancy. Past tenancies are listed below if any.
            </p>
          )}
        </div>
      </div>

      {active && ledger && (
        <section className="mt-10">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl tracking-tight text-ink">
                <span className="font-display text-accent-text">Ledger</span>
              </h2>
              <p className="mt-1 text-xs text-muted">
                {admin
                  ? `Every rent charge, fee, and payment in one running balance.${
                      ledger.availableCredit > 0.005
                        ? ` ${fmtMoney(ledger.availableCredit)} in credit.`
                        : ""
                    }`
                  : "Payment status."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {admin && (
                <a
                  href={`/tenants/${tenant.id}/ledger/export`}
                  className="rounded-full border border-stone bg-white px-3 py-1.5 text-xs uppercase tracking-wide text-ink hover:bg-warm"
                >
                  Download ledger ↓
                </a>
              )}
              <RecordCharge tenancyId={active.id} tenantId={tenant.id} />
              <RecordPayment
                tenancyId={active.id}
                tenantId={tenant.id}
                defaultAmount={Number(active.monthly_rent)}
              />
            </div>
          </header>

          {admin ? (
          <>
          {/* Summary — fee totals charged so far, plus the overall balance/credit. */}
          <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm">
            <table className="w-full text-sm">
              <tbody>
                {summaryRows.map((r) => (
                  <tr key={r.label} className="border-b border-stone/30">
                    <td className="px-5 py-3 text-muted">{r.label}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink">
                      {fmtMoney(r.amount)}
                    </td>
                  </tr>
                ))}
                <tr className="bg-cream/40">
                  <td className="px-5 py-3 font-medium text-ink">
                    {ledger.netBalance < -0.005 ? "Credit" : "Balance"}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums font-medium">
                    <BalanceCell n={ledger.netBalance} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Running ledger — oldest first, balance carried down. */}
          {ledgerEntries.length === 0 ? (
            <p className="mt-4 rounded-2xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
              No charges or payments yet.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-2xl bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-5 py-3 font-medium">Date</th>
                    <th className="px-5 py-3 font-medium">Description</th>
                    <th className="px-5 py-3 text-right font-medium">Charge</th>
                    <th className="px-5 py-3 text-right font-medium">Payment</th>
                    <th className="px-5 py-3 text-right font-medium">Balance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ledgerEntries.map((e) => (
                    <tr key={e.id} className="border-t border-stone/40">
                      <td className="whitespace-nowrap px-5 py-3 text-ink">
                        {formatDate(e.date)}
                      </td>
                      <td className="px-5 py-3 text-ink">{e.description}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-ink">
                        {e.charge > 0 ? fmtMoney(e.charge) : ""}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-accent-text">
                        {e.payment > 0 ? `−${fmtMoney(e.payment)}` : ""}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        <BalanceCell n={e.balance} />
                      </td>
                      <td className="px-5 py-3 text-right">
                        {e.deletable === "payment" ? (
                          <DeletePaymentButton
                            paymentId={e.refIds[0]}
                            tenantId={tenant.id}
                          />
                        ) : e.deletable === "charge" ? (
                          <DeleteChargeButton
                            chargeIds={e.refIds}
                            tenantId={tenant.id}
                          />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </>
          ) : (
            <div className="mt-4 rounded-2xl bg-white p-6 shadow-sm">
              {ledger.netBalance > 0.005 ? (
                <span className="rounded-full bg-red-100 px-3 py-1 text-sm uppercase tracking-wide text-red-800">
                  Balance due
                </span>
              ) : ledger.netBalance < -0.005 ? (
                <span className="rounded-full bg-accent/15 px-3 py-1 text-sm uppercase tracking-wide text-accent-text">
                  Credit
                </span>
              ) : (
                <span className="rounded-full bg-green-100 px-3 py-1 text-sm uppercase tracking-wide text-green-800">
                  Paid
                </span>
              )}
              <p className="mt-3 text-xs text-muted">
                Detailed balances are restricted to admins.
              </p>
            </div>
          )}
        </section>
      )}

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
                    {formatDate(t.start_date)} – {formatDate(t.move_out_date)} ·{" "}
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
