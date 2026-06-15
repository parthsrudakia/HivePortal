import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { formatDate } from "@/lib/date";
import { TenantInfo } from "./tenant-info";
import { RecordPayment } from "./record-payment";
import { RecordCharge } from "./record-charge";
import { ApplyCredit } from "./apply-credit";
import {
  EndTenancyForm,
  DeleteTenantButton,
  DeletePaymentButton,
  DeleteChargeButton,
  DeleteAllocationButton,
  ReactivateTenancyButton,
} from "./tenant-actions";
import { LeaseDownload } from "./lease-download";
import { LeaseEndEdit } from "./lease-end-edit";
import { computeLedger } from "@/lib/rent";
import { todayISO } from "@/lib/date";

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

const KIND_LABEL: Record<string, string> = {
  rent: "Rent",
  security_deposit: "Security deposit",
  broker_fee: "Broker fee",
  late_fee: "Late fee",
  other: "Other",
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
  const totalPaid =
    payments
      ?.filter((p) => p.payment_type === "rent")
      .reduce((sum, p) => sum + Number(p.amount), 0) ?? 0;

  // Running ledger for the active tenancy: rent carry-forward + the deposit /
  // broker / late-fee buckets, plus any rent overpayment directed into them.
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
  const ledgerRows = ledger
    ? [
        { label: "Rent", owedLabel: "Due", b: ledger.rent },
        { label: "Security deposit", owedLabel: "Owed", b: ledger.deposit },
        { label: "Broker fee", owedLabel: "Owed", b: ledger.broker },
        { label: "Late fees", owedLabel: "Owed", b: ledger.lateFee },
        { label: "Other", owedLabel: "Owed", b: ledger.other },
      ].filter((r) => r.label === "Rent" || r.b.owed > 0.005 || r.b.paid > 0.005)
    : [];

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
                    <dt className="text-muted">Ending</dt>
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
                    label="Cancel scheduled end"
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
                <span className="font-display text-accent-text">Account</span>
              </h2>
              <p className="mt-1 text-xs text-muted">
                Running balance carried across months.
                {ledger.availableCredit > 0.005
                  ? ` ${fmtMoney(ledger.availableCredit)} rent credit available to apply.`
                  : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {ledger.availableCredit > 0.005 && (
                <ApplyCredit
                  tenancyId={active.id}
                  tenantId={tenant.id}
                  availableCredit={ledger.availableCredit}
                  depositOwed={Math.max(0, ledger.deposit.balance)}
                  brokerOwed={Math.max(0, ledger.broker.balance)}
                  lateFeeOwed={Math.max(0, ledger.lateFee.balance)}
                />
              )}
              <RecordCharge tenancyId={active.id} tenantId={tenant.id} />
            </div>
          </header>

          <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Bucket</th>
                  <th className="px-5 py-3 text-right font-medium">Owed / Due</th>
                  <th className="px-5 py-3 text-right font-medium">Paid</th>
                  <th className="px-5 py-3 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledgerRows.map((r) => (
                  <tr key={r.label} className="border-t border-stone/40">
                    <td className="px-5 py-3 text-ink">{r.label}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink">
                      {fmtMoney(r.b.owed)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink">
                      {fmtMoney(r.b.paid)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      <BalanceCell n={r.b.balance} />
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-stone/60 bg-cream/40">
                  <td className="px-5 py-3 font-medium text-ink" colSpan={3}>
                    Net balance
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums font-medium">
                    <BalanceCell n={ledger.netBalance} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {charges.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm">
              <p className="border-b border-stone/40 bg-warm/40 px-5 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                Charges
              </p>
              <ul className="divide-y divide-stone/30">
                {charges.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="text-ink">
                        {KIND_LABEL[c.kind] ?? c.kind}
                      </span>{" "}
                      <span className="text-muted">· {formatDate(c.charged_on)}</span>
                      {c.note && (
                        <span className="text-muted"> · {c.note}</span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      <span className="tabular-nums text-ink">
                        {fmtMoney(c.amount)}
                      </span>
                      <DeleteChargeButton chargeId={c.id} tenantId={tenant.id} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {allocations.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm">
              <p className="border-b border-stone/40 bg-warm/40 px-5 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                Rent credit applied
              </p>
              <ul className="divide-y divide-stone/30">
                {allocations.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="text-ink">
                        → {KIND_LABEL[a.kind] ?? a.kind}
                      </span>
                      {a.note && (
                        <span className="text-muted"> · {a.note}</span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      <span className="tabular-nums text-ink">
                        {fmtMoney(a.amount)}
                      </span>
                      <DeleteAllocationButton
                        allocationId={a.id}
                        tenantId={tenant.id}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

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
