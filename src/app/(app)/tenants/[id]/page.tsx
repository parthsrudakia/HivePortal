import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { formatDate } from "@/lib/date";
import { TenantInfo } from "./tenant-info";
import { LedgerActions } from "./ledger-actions";
import {
  EndTenancyForm,
  DeleteTenantButton,
  DeletePaymentButton,
  DeleteChargeButton,
  ReactivateTenancyButton,
} from "./tenant-actions";
import { LeaseDownload } from "./lease-download";
import { LeaseDateEdit } from "./lease-end-edit";
import { RentAmountEdit } from "./rent-edit";
import { TenantBackLink } from "./tenant-back-link";
import { TransferDialog } from "./transfer-dialog";
import { StartTenancyDialog } from "./start-tenancy-dialog";
import {
  computeTenantLedger,
  buildTenantLedgerEntries,
  type RentChange,
  type TenancyLedgerInput,
} from "@/lib/rent";
import { canEditLedger } from "@/lib/access";
import { pauseTenancy, resumeTenancy } from "../actions";
import { fetchAssignableRooms, type RoomOption } from "../room-options";
import { getSessionUser } from "@/lib/session";
import { todayISO } from "@/lib/date";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
};

/** Known referrers for the profile back link, so the fallback href/label point
 *  back to where the user actually came from (not always the Rent Tracker). */
const BACK_TARGETS: Record<string, { href: string; label: string }> = {
  reconciliation: { href: "/reconciliation", label: "Reconciliation" },
};

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
  paused_at: string | null;
  pause_source: "tenant" | "property" | null;
  lease_start_date: string | null;
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
  bill_id: string | null;
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

export default async function TenantDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const { from } = await searchParams;
  const back = (from ? BACK_TARGETS[from] : undefined) ?? {
    href: "/tenants",
    label: "Rent Tracker",
  };
  const supabase = await createClient();

  const [user, { data: tenant }, { data: tenancies }, { data: payments }] =
    await Promise.all([
      getSessionUser(),
      supabase
        .from("tenants")
        .select(
          "id, full_name, email, phone, pays_as, notes, age, gender, profession, social_links",
        )
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("tenancies")
        .select(
          `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at, pause_source, lease_start_date, lease_end_date, status,
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

  // Ledger charges (add/delete) are operator-only; payments stay open to all.
  const ledgerAdmin = canEditLedger(user?.email);

  const active = tenancies?.find((t) => t.status === "active") ?? null;
  const upcoming = (tenancies ?? []).filter((t) => t.status === "upcoming");
  const past = (tenancies ?? []).filter((t) => t.status === "ended");

  // ONE ledger per tenant: every tenancy (past, active, upcoming) feeds the
  // same running balance, so a room change never starts a fresh ledger. New
  // charges and payments post to the active tenancy, or — so a move-out with
  // money still owed can be settled here — the most recent one.
  const ledgerTenancy =
    active ?? upcoming[0] ?? past.find((t) => t.status === "ended") ?? null;

  // Room options for the transfer / start-new-tenancy dialogs — only
  // fetched when a ledger admin can actually see one of those buttons.
  const canTransfer = ledgerAdmin && !!active && !active.move_out_date;
  const canStartNew = ledgerAdmin && !active && upcoming.length === 0;
  let assignableRooms: RoomOption[] = [];
  if (canTransfer || canStartNew) {
    assignableRooms = await fetchAssignableRooms(supabase);
    if (canTransfer && active) {
      const currentRoomId = one(active.rooms)?.id;
      assignableRooms = assignableRooms.filter((r) => r.id !== currentRoomId);
    }
  }

  // Running ledger: auto monthly rent + ad-hoc charges (deposit / late fee)
  // + payments across every tenancy, in one carry-forward balance.
  const tenancyIds = (tenancies ?? []).map((t) => t.id);
  let charges: (Charge & { tenancy_id: string })[] = [];
  let allocations: (Allocation & { tenancy_id: string })[] = [];
  let rentChanges: (RentChange & { tenancy_id: string })[] = [];
  if (tenancyIds.length > 0) {
    const [chargeRes, allocRes, rentHistRes] = await Promise.all([
      supabase
        .from("tenancy_charges")
        .select("id, kind, amount, charged_on, note, bill_id, tenancy_id")
        .in("tenancy_id", tenancyIds)
        .order("charged_on", { ascending: false }),
      // Legacy credit allocations are no longer created, but existing rows are
      // still fed to computeLedger so historical balances stay consistent.
      supabase
        .from("credit_allocations")
        .select("id, kind, amount, note, created_at, tenancy_id")
        .in("tenancy_id", tenancyIds)
        .order("created_at", { ascending: false }),
      supabase
        .from("tenancy_rent_history")
        .select("effective_month, monthly_rent, tenancy_id")
        .in("tenancy_id", tenancyIds),
    ]);
    charges = chargeRes.data ?? [];
    allocations = allocRes.data ?? [];
    rentChanges = rentHistRes.data ?? [];
  }
  const ledgerInputs: TenancyLedgerInput[] = (tenancies ?? []).map((t) => ({
    id: t.id,
    tenancy: t,
    unitLabel: `${unitTitle(t)} · ${one(t.rooms)?.room_number ?? "—"}`,
    payments: (payments ?? []).filter((p) => p.tenancy_id === t.id),
    charges: charges.filter((c) => c.tenancy_id === t.id),
    allocations: allocations.filter((a) => a.tenancy_id === t.id),
    rentChanges: rentChanges.filter((r) => r.tenancy_id === t.id),
  }));
  const today = todayISO();
  const ledger = ledgerTenancy ? computeTenantLedger(ledgerInputs, today) : null;
  const ledgerEntries = ledgerTenancy
    ? buildTenantLedgerEntries(ledgerInputs, today)
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
          <TenantBackLink fallbackHref={back.href} label={back.label} />
          <h1 className="mt-2 text-3xl tracking-tight text-ink">
            {tenant.full_name}
            {active?.paused_at && (
              <span className="ml-3 align-middle rounded-full bg-accent/15 px-3 py-1 text-xs font-medium uppercase tracking-wide text-accent-text">
                Paused{active.pause_source === "property" ? " (property)" : ""}
              </span>
            )}
          </h1>
          {active && (
            <p className="mt-1 text-sm text-muted">
              {unitTitle(active)} · {one(active.rooms)?.room_number ?? "—"}
            </p>
          )}
          {active?.paused_at && (
            <p className="mt-1 text-sm text-accent-text">
              Paused since {formatDate(active.paused_at.slice(0, 10))} — no new
              rent accrues, and this tenant is excluded from all reminders,
              late fees, and other automatic actions.
            </p>
          )}
        </div>
        {ledgerAdmin && active && (
          <form action={active.paused_at ? resumeTenancy : pauseTenancy}>
            <input type="hidden" name="tenancy_id" value={active.id} />
            <input type="hidden" name="tenant_id" value={tenant.id} />
            {active.paused_at ? (
              <button
                type="submit"
                className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-ink hover:bg-warm"
                title={
                  active.pause_source === "property"
                    ? "This pause came from the property — resuming here lifts it for this tenant only."
                    : undefined
                }
              >
                Resume actions
              </button>
            ) : (
              <button
                type="submit"
                className="rounded-full border border-accent bg-accent/10 px-4 py-2 text-sm text-accent-text hover:bg-accent/20"
                title="Stop rent accrual, reminders, late fees, and every automatic action for this tenant."
              >
                Pause actions
              </button>
            )}
          </form>
        )}
      </header>

      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
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
          social_links={tenant.social_links ?? []}
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
                  {ledgerAdmin ? (
                    <RentAmountEdit
                      field="monthly_rent"
                      tenancyId={active.id}
                      tenantId={tenant.id}
                      value={Number(active.monthly_rent)}
                    />
                  ) : (
                    fmtMoney(Number(active.monthly_rent))
                  )}
                </dd>
                <dt className="text-muted">First month (prorated)</dt>
                <dd className="col-span-2 text-ink">
                  {ledgerAdmin ? (
                    <RentAmountEdit
                      field="first_month_rent"
                      tenancyId={active.id}
                      tenantId={tenant.id}
                      value={
                        active.first_month_rent !== null
                          ? Number(active.first_month_rent)
                          : null
                      }
                    />
                  ) : active.first_month_rent !== null ? (
                    fmtMoney(Number(active.first_month_rent))
                  ) : (
                    "—"
                  )}
                </dd>
                <dt className="text-muted">Deposit (lease reference)</dt>
                <dd className="col-span-2 text-ink">
                  {ledgerAdmin ? (
                    <RentAmountEdit
                      field="security_deposit"
                      tenancyId={active.id}
                      tenantId={tenant.id}
                      value={
                        active.security_deposit !== null
                          ? Number(active.security_deposit)
                          : null
                      }
                    />
                  ) : active.security_deposit !== null ? (
                    fmtMoney(Number(active.security_deposit))
                  ) : (
                    "—"
                  )}
                  <p className="mt-1 text-[11px] text-muted">
                    Ledger amount is controlled by security-deposit charges.
                  </p>
                </dd>
                <dt className="text-muted">Lease Start Date</dt>
                <dd className="col-span-2 text-ink">
                  {ledgerAdmin ? (
                    <LeaseDateEdit
                      field="start"
                      tenancyId={active.id}
                      tenantId={tenant.id}
                      value={active.lease_start_date ?? active.start_date}
                    />
                  ) : (
                    formatDate(active.lease_start_date ?? active.start_date)
                  )}
                </dd>
                <dt className="text-muted">Lease End Date</dt>
                <dd className="col-span-2 text-ink">
                  <LeaseDateEdit
                    field="end"
                    tenancyId={active.id}
                    tenantId={tenant.id}
                    value={active.lease_end_date}
                  />
                </dd>
                {active.move_out_date && (
                  <>
                    <dt className="text-muted">Moving out</dt>
                    <dd className="col-span-2 text-ink">
                      {ledgerAdmin ? (
                        <LeaseDateEdit
                          field="moveout"
                          tenancyId={active.id}
                          tenantId={tenant.id}
                          value={active.move_out_date}
                        />
                      ) : (
                        formatDate(active.move_out_date)
                      )}
                    </dd>
                  </>
                )}
              </dl>
              <div className="mt-4 flex flex-wrap items-center gap-4">
                {ledgerAdmin &&
                  (!active.move_out_date ? (
                    <>
                      <EndTenancyForm
                        tenancyId={active.id}
                        tenantId={tenant.id}
                      />
                      <TransferDialog
                        tenancyId={active.id}
                        tenantId={tenant.id}
                        tenantName={tenant.full_name}
                        currentRoomLabel={`${unitTitle(active)} · ${one(active.rooms)?.room_number ?? "—"}`}
                        // Carry preview only — the server recomputes the
                        // exact balance at transfer time.
                        netBalance={ledger?.netBalance ?? 0}
                        rooms={assignableRooms}
                      />
                    </>
                  ) : (
                    <ReactivateTenancyButton
                      tenancyId={active.id}
                      tenantId={tenant.id}
                      label="Cancel move out"
                      variant="primary"
                    />
                  ))}
                {active.lease_pdf_path && (
                  <LeaseDownload tenancyId={active.id} />
                )}
              </div>
            </>
          ) : (
            <>
              <p className="mt-4 text-sm text-muted">
                No active tenancy. Past tenancies are listed below if any.
              </p>
              {canStartNew && (
                <div className="mt-4">
                  <StartTenancyDialog
                    tenantId={tenant.id}
                    tenantName={tenant.full_name}
                    rooms={assignableRooms}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {upcoming.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xl tracking-tight text-ink">
            <span className="font-display text-accent-text">
              Upcoming tenancy
            </span>
          </h2>
          <ul className="mt-4 flex flex-col gap-3">
            {upcoming.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-white px-5 py-4 shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    {unitTitle(t)} · {one(t.rooms)?.room_number ?? "—"}
                  </p>
                  <p className="text-xs text-muted">
                    Starts {formatDate(t.start_date)} ·{" "}
                    {fmtMoney(t.monthly_rent)}/mo
                  </p>
                </div>
                <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-medium uppercase tracking-wide text-accent-text">
                  Reserved
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ledgerTenancy && ledger && (
        <section className="mt-10">
          <LedgerActions
            heading={
              <div>
                <h2 className="text-xl tracking-tight text-ink">
                  <span className="font-display text-accent-text">Ledger</span>
                  {ledgerTenancy.status === "ended" && (
                    <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 align-middle text-xs font-medium text-amber-800">
                      moved out{" "}
                      {ledgerTenancy.move_out_date
                        ? formatDate(ledgerTenancy.move_out_date)
                        : ""}
                    </span>
                  )}
                </h2>
                <p className="mt-1 text-xs text-muted">
                  Every rent charge, fee, and payment in one running balance
                  {ledgerInputs.length > 1
                    ? " — carried across every room this tenant has had."
                    : "."}
                  {ledger.availableCredit > 0.005
                    ? ` ${fmtMoney(ledger.availableCredit)} in credit.`
                    : ""}
                </p>
              </div>
            }
            exportHref={`/tenants/${tenant.id}/ledger/export`}
            tenancyId={ledgerTenancy.id}
            tenantId={tenant.id}
            defaultAmount={Number(ledgerTenancy.monthly_rent)}
            canAddCharge={ledgerAdmin}
          />

          {/* Summary — fee totals charged so far, plus the overall balance/credit. */}
          <h3 className="mt-4 px-1 text-xs font-medium uppercase tracking-wide text-muted">
            Summary
          </h3>
          <div className="mt-2 overflow-hidden rounded-2xl bg-white shadow-sm">
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
          <h3 className="mt-4 px-1 text-xs font-medium uppercase tracking-wide text-muted">
            Transactions
          </h3>
          {ledgerEntries.length === 0 ? (
            <p className="mt-2 rounded-2xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
              No charges or payments yet.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
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
                      <td className="px-5 py-3 text-ink">
                        {e.billId ? (
                          <Link
                            href={`/utilities?bill=${e.billId}`}
                            title="Open the utility bill behind this charge"
                            className="underline decoration-stone underline-offset-2 hover:text-accent-text"
                          >
                            {e.description}
                          </Link>
                        ) : (
                          e.description
                        )}
                        {e.unit && (
                          <span className="mt-0.5 block text-xs text-muted">
                            {e.unit}
                          </span>
                        )}
                      </td>
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
                        {e.deletable === "payment" && ledgerAdmin ? (
                          <DeletePaymentButton
                            paymentId={e.refIds[0]}
                            tenantId={tenant.id}
                          />
                        ) : e.deletable === "charge" && ledgerAdmin ? (
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
        </section>
      )}

      {past.length > 0 && (
        <section className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl tracking-tight text-ink">
              <span className="font-display text-accent-text">
                Past tenancies
              </span>
            </h2>
            {canStartNew && (
              <StartTenancyDialog
                tenantId={tenant.id}
                tenantName={tenant.full_name}
                rooms={assignableRooms}
              />
            )}
          </div>
          <ul className="mt-4 flex flex-col gap-3">
            {past.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4 shadow-sm"
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
                <span className="flex shrink-0 flex-wrap items-center gap-3">
                  {t.lease_pdf_path && <LeaseDownload tenancyId={t.id} />}
                  {ledgerAdmin && (
                    <ReactivateTenancyButton
                      tenancyId={t.id}
                      tenantId={tenant.id}
                      label="Undo move-out"
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ledgerAdmin && (
        <section className="mt-16 border-t border-stone/60 pt-6">
          <DeleteTenantButton id={tenant.id} name={tenant.full_name} />
        </section>
      )}
    </div>
  );
}
