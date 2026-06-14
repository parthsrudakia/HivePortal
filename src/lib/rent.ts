/**
 * Carry-forward rent ledger — the single source of truth for what a tenant
 * owes, shared by the Tenants & Rent list, the tenant detail page, the
 * dashboard, and the balance-reminder logic.
 *
 * Rent is a *running* balance starting at {@link LEDGER_ANCHOR} (the month
 * this ledger went live). Months before the anchor are treated as already
 * settled, so turning the ledger on does not retroactively invent arrears for
 * long-standing tenants whose older payments may not all be in the system.
 *
 * Alongside rent we track three more buckets the operator collects on:
 *   • security deposit — owed amount lives on `tenancies.security_deposit`
 *   • broker fee       — ad-hoc `tenancy_charges` rows (kind 'broker_fee')
 *   • late fee (~$50)  — ad-hoc `tenancy_charges` rows (kind 'late_fee')
 *
 * When rent is overpaid the excess becomes an `availableCredit`. The operator
 * can leave it as a rent credit or *direct* it to another bucket by inserting
 * a `credit_allocations` row, which moves the money out of rent and into that
 * bucket without touching the immutable `payments` rows.
 */

import { todayISO } from "@/lib/date";

/** First day of the month the running ledger begins accruing from. */
export const LEDGER_ANCHOR = "2026-06-01";

/** Month number (`year*12 + monthIndex`) from a "YYYY-MM-DD"+ ISO string. */
export function monthIndex(iso: string): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return y * 12 + (m - 1);
}

export type LedgerTenancy = {
  start_date: string;
  move_out_date: string | null;
  monthly_rent: number | string;
  first_month_rent: number | string | null;
  security_deposit: number | string | null;
};

export type LedgerPayment = {
  amount: number | string;
  paid_on: string;
  payment_type: string;
};

export type LedgerCharge = { kind: string; amount: number | string };
export type LedgerAllocation = { kind: string; amount: number | string };

export type Bucket = { owed: number; paid: number; balance: number };

export type Ledger = {
  rent: Bucket; // `owed` is the cumulative amount due since the anchor
  deposit: Bucket;
  broker: Bucket;
  lateFee: Bucket;
  other: Bucket;
  /** What the tenant owes overall (bucket credits other than rent don't roam). */
  netBalance: number;
  /** Rent paid beyond rent due — available to leave as credit or allocate. */
  availableCredit: number;
};

const num = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Cumulative rent owed from the anchor (or the tenancy's start month, if that
 * is later) through the current month, capped at the move-out month.
 */
function rentDue(t: LedgerTenancy, todayIso: string): number {
  const anchorIdx = monthIndex(LEDGER_ANCHOR);
  const startIdx = monthIndex(t.start_date);
  const effStart = Math.max(anchorIdx, startIdx);
  let end = monthIndex(todayIso);
  if (t.move_out_date) end = Math.min(end, monthIndex(t.move_out_date));

  const n = end - effStart + 1;
  if (n <= 0) return 0;

  const monthly = num(t.monthly_rent);
  // The tenancy's real first month gets first_month_rent — but only when that
  // month is inside the ledger window. If the tenancy predates the anchor, the
  // first counted month is the anchor and is just a regular monthly charge.
  const firstCharge =
    startIdx >= anchorIdx && t.first_month_rent !== null
      ? num(t.first_month_rent)
      : monthly;
  return firstCharge + monthly * (n - 1);
}

export function computeLedger(
  t: LedgerTenancy,
  payments: LedgerPayment[],
  charges: LedgerCharge[],
  allocations: LedgerAllocation[],
  todayIso: string = todayISO(),
): Ledger {
  // Rent paid counts only payments from the anchor forward (earlier months are
  // settled). Allocations always move money *out* of the rent bucket.
  const rentPaidGross = payments
    .filter((p) => p.payment_type === "rent" && p.paid_on >= LEDGER_ANCHOR)
    .reduce((s, p) => s + num(p.amount), 0);
  const allocatedAway = allocations.reduce((s, a) => s + num(a.amount), 0);
  const rentPaid = rentPaidGross - allocatedAway;
  const due = rentDue(t, todayIso);
  const rent: Bucket = { owed: due, paid: rentPaid, balance: due - rentPaid };

  const paidOf = (type: string) =>
    payments
      .filter((p) => p.payment_type === type)
      .reduce((s, p) => s + num(p.amount), 0);
  const allocOf = (kind: string) =>
    allocations
      .filter((a) => a.kind === kind)
      .reduce((s, a) => s + num(a.amount), 0);
  const chargedOf = (kind: string) =>
    charges
      .filter((c) => c.kind === kind)
      .reduce((s, c) => s + num(c.amount), 0);

  const bucket = (owed: number, key: string): Bucket => {
    const paid = paidOf(key) + allocOf(key);
    return { owed, paid, balance: owed - paid };
  };

  const deposit = bucket(num(t.security_deposit), "security_deposit");
  const broker = bucket(chargedOf("broker_fee"), "broker_fee");
  const lateFee = bucket(chargedOf("late_fee"), "late_fee");
  const other = bucket(chargedOf("other"), "other");

  // Only rent carries a credit (negative balance). A non-rent bucket that's
  // somehow overpaid reads as settled rather than a roaming credit — so a misc
  // payment can never mask real rent arrears in the headline number.
  const owedOnly = (b: Bucket) => Math.max(0, b.balance);
  const netBalance =
    rent.balance +
    owedOnly(deposit) +
    owedOnly(broker) +
    owedOnly(lateFee) +
    owedOnly(other);
  const availableCredit = Math.max(0, -rent.balance);

  return { rent, deposit, broker, lateFee, other, netBalance, availableCredit };
}
