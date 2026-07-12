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
 * Alongside rent we track more buckets the operator collects on:
 *   • security deposit — owed amount lives on `tenancies.security_deposit`
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

/**
 * Rent payments count from here. Rent is collected on a 27th→26th cycle
 * (see currentRentCycle), so the anchor month's rent legitimately arrives
 * from the 27th of the prior month — cutting payments off at the anchor
 * itself silently voided a May 27–31 payment for June rent.
 */
export const LEDGER_PAYMENT_CUTOFF = "2026-05-27";

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

/**
 * A rent-rate change: from `effective_month` (first-of-month ISO date)
 * onward, the monthly rent is `monthly_rent`. Rows live in
 * tenancy_rent_history; a tenancy with no rows bills its current
 * monthly_rent for every month (no change ever happened).
 */
export type RentChange = {
  effective_month: string;
  monthly_rent: number | string;
};

export type Bucket = { owed: number; paid: number; balance: number };

export type Ledger = {
  rent: Bucket; // `owed` is the cumulative amount due since the anchor
  deposit: Bucket;
  lateFee: Bucket;
  other: Bucket;
  /** Single running balance across all buckets. Negative means account credit. */
  netBalance: number;
  /** Total overpayment available as account credit (max(0, -netBalance)). */
  availableCredit: number;
};

const num = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// Ledger amounts are cent-precision, but binary floating point can't sum them
// exactly (726.61 + 598.39 + 1325 − 2650 ≈ 1e-13, not 0). Every figure the
// ledger publishes is rounded to the cent so a settled account nets to exactly
// 0 and strict `> 0` checks ("Balance due only", reminder gates) never see
// sub-cent dust as money owed.
const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * The monthly rate in effect for a given month: the latest rent-history row
 * at or before it, falling back to the tenancy's current monthly_rent (no
 * change has ever been recorded, or the month predates the baseline).
 */
function rateForMonth(
  idx: number,
  t: LedgerTenancy,
  rentChanges: RentChange[],
): number {
  return rateForMonthIdx(idx, num(t.monthly_rent), rentChanges);
}

function rateForMonthIdx(
  idx: number,
  currentRent: number,
  rentChanges: RentChange[],
): number {
  let rate = currentRent;
  let best = -Infinity;
  for (const c of rentChanges) {
    const ci = monthIndex(c.effective_month);
    if (ci <= idx && ci > best) {
      best = ci;
      rate = num(c.monthly_rent);
    }
  }
  return rate;
}

/**
 * The monthly rate in effect for the month containing `monthISO` — for
 * history-aware callers outside the ledger (reconciliation, reports,
 * rent-status tools). Same resolution rule as the ledger: the latest
 * rent-history row at or before the month, falling back to `currentRent`.
 */
export function rateForMonthISO(
  monthISO: string,
  currentRent: number | string,
  rentChanges: RentChange[],
): number {
  return rateForMonthIdx(monthIndex(monthISO), num(currentRent), rentChanges);
}

/**
 * Cumulative rent owed from the anchor (or the tenancy's start month, if that
 * is later) through the current month, capped at the move-out month. Each
 * month bills the rate in effect that month (see rateForMonth), so a rent
 * change reprices future months only.
 */
function rentDue(
  t: LedgerTenancy,
  todayIso: string,
  rentChanges: RentChange[],
): number {
  const anchorIdx = monthIndex(LEDGER_ANCHOR);
  const startIdx = monthIndex(t.start_date);
  const effStart = Math.max(anchorIdx, startIdx);
  let end = monthIndex(todayIso);
  if (t.move_out_date) end = Math.min(end, monthIndex(t.move_out_date));
  if (end < effStart) return 0;

  let total = 0;
  for (let idx = effStart; idx <= end; idx++) {
    // The tenancy's real first month gets first_month_rent — but only when
    // that month is inside the ledger window. If the tenancy predates the
    // anchor, the first counted month is just a regular monthly charge.
    total +=
      idx === startIdx && startIdx >= anchorIdx && t.first_month_rent !== null
        ? num(t.first_month_rent)
        : rateForMonth(idx, t, rentChanges);
  }
  return total;
}

export function computeLedger(
  t: LedgerTenancy,
  payments: LedgerPayment[],
  charges: LedgerCharge[],
  allocations: LedgerAllocation[],
  todayIso: string = todayISO(),
  rentChanges: RentChange[] = [],
): Ledger {
  // Rent paid counts only payments from the anchor cycle forward (earlier
  // months are settled). Allocations always move money *out* of the rent
  // bucket.
  const rentPaidGross = payments
    .filter(
      (p) => p.payment_type === "rent" && p.paid_on >= LEDGER_PAYMENT_CUTOFF,
    )
    .reduce((s, p) => s + num(p.amount), 0);
  const allocatedAway = allocations.reduce((s, a) => s + num(a.amount), 0);
  const rentPaid = cents(rentPaidGross - allocatedAway);
  const due = cents(rentDue(t, todayIso, rentChanges));
  const rent: Bucket = { owed: due, paid: rentPaid, balance: cents(due - rentPaid) };

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
    const paid = cents(paidOf(key) + allocOf(key));
    return { owed: cents(owed), paid, balance: cents(owed - paid) };
  };

  // The security deposit is now an ad-hoc charge (kind 'security_deposit') like
  // late fees, so the tenancy's deposit field is purely informational.
  const deposit = bucket(chargedOf("security_deposit"), "security_deposit");
  const lateFee = bucket(chargedOf("late_fee"), "late_fee");
  // Utility overcharges (the over-$200 electric/gas split) ride in the
  // "other" bucket; 'utility' payments settle against it. The dormant
  // 'broker_fee' payment type also lands here so the summary stays in
  // lockstep with the running ledger (which counts every non-rent payment).
  const other: Bucket = (() => {
    const owed = cents(chargedOf("other") + chargedOf("utility_overage"));
    const paid = cents(
      paidOf("other") +
        allocOf("other") +
        paidOf("utility") +
        paidOf("broker_fee"),
    );
    return { owed, paid, balance: cents(owed - paid) };
  })();

  // One running balance across every bucket: rent, deposit, and fees share a
  // single pot, so an overpayment anywhere nets against what's owed elsewhere
  // and surfaces as account-wide credit. Negative `netBalance` == credit.
  // A refund is money returned to the tenant — it consumes credit / adds to
  // what's owed, mirroring the debit row in buildLedgerEntries.
  const refunded = paidOf("refund");
  const netBalance = cents(
    rent.balance + deposit.balance + lateFee.balance + other.balance + refunded,
  );
  const availableCredit = Math.max(0, -netBalance);

  return { rent, deposit, lateFee, other, netBalance, availableCredit };
}

// ---------------------------------------------------------------------------
// Chronological ledger entries — the line-by-line view on the tenant page.
// Every month's rent is auto-posted as a charge, ad-hoc charges (deposit /
// late fee) are charges too, and payments come through as negatives,
// with a running balance carried down the list so it visibly settles to zero.
// ---------------------------------------------------------------------------

/** Human label for a charge/payment kind. */
export const KIND_LABEL: Record<string, string> = {
  rent: "Rent",
  security_deposit: "Security deposit",
  late_fee: "Late fee",
  utility: "Utility",
  utility_overage: "Utility Overcharge",
  refund: "Refund",
  other: "Other",
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function monthLabel(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = ((idx % 12) + 12) % 12;
  return `${MONTH_NAMES[m]} ${y}`;
}

function firstOfMonthISO(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = ((idx % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export type LedgerEntryCharge = {
  id: string;
  kind: string;
  amount: number | string;
  charged_on: string;
  note: string | null;
};

export type LedgerEntryPayment = {
  id: string;
  amount: number | string;
  paid_on: string;
  payment_type: string;
  notes: string | null;
};

export type LedgerEntry = {
  id: string;
  date: string;
  description: string;
  /** Amount owed added by this line (0 for payments). */
  charge: number;
  /** Amount paid by this line (0 for charges). */
  payment: number;
  /** Running account balance after this line. */
  balance: number;
  /** Which delete action this row supports, or null for auto rent rows. */
  deletable: "charge" | "payment" | null;
  /** DB row id(s) this line deletes — more than one when charges consolidate. */
  refIds: string[];
};

/**
 * Build the chronological ledger for a tenancy: auto monthly rent + ad-hoc
 * charges + payments, oldest first, with a running balance. The final balance
 * matches {@link computeLedger}'s `netBalance` for the same inputs.
 */
export function buildLedgerEntries(
  t: LedgerTenancy,
  payments: LedgerEntryPayment[],
  charges: LedgerEntryCharge[],
  todayIso: string = todayISO(),
  rentChanges: RentChange[] = [],
): LedgerEntry[] {
  const rows: Omit<LedgerEntry, "balance">[] = [];

  // Auto rent: one charge per month from the anchor (or start, if later)
  // through the current month, capped at the move-out month. Each month
  // bills the rate in effect that month (rent changes reprice future months
  // only).
  const anchorIdx = monthIndex(LEDGER_ANCHOR);
  const startIdx = monthIndex(t.start_date);
  const effStart = Math.max(anchorIdx, startIdx);
  let end = monthIndex(todayIso);
  if (t.move_out_date) end = Math.min(end, monthIndex(t.move_out_date));
  for (let idx = effStart; idx <= end; idx++) {
    const amount =
      idx === startIdx && startIdx >= anchorIdx && t.first_month_rent !== null
        ? num(t.first_month_rent)
        : rateForMonth(idx, t, rentChanges);
    rows.push({
      id: `rent-${idx}`,
      date: firstOfMonthISO(idx),
      description: `Rent · ${monthLabel(idx)}`,
      charge: amount,
      payment: 0,
      deletable: null,
      refIds: [],
    });
  }

  // Ad-hoc charges (deposit / late fee / other). 'Other' charges that
  // share the same description text are consolidated into one summed line.
  const otherGroups = new Map<
    string,
    { note: string; date: string; amount: number; ids: string[] }
  >();
  for (const c of charges) {
    if (c.kind === "other") {
      const key = (c.note ?? "").trim().toLowerCase();
      const g = otherGroups.get(key);
      if (g) {
        g.amount += num(c.amount);
        g.ids.push(c.id);
        // Surface at the most recent date, keeping that row's note text.
        if (c.charged_on > g.date) {
          g.date = c.charged_on;
          g.note = c.note ?? g.note;
        }
      } else {
        otherGroups.set(key, {
          note: c.note ?? "",
          date: c.charged_on,
          amount: num(c.amount),
          ids: [c.id],
        });
      }
      continue;
    }
    rows.push({
      id: c.id,
      date: c.charged_on,
      description: (KIND_LABEL[c.kind] ?? c.kind) + (c.note ? ` · ${c.note}` : ""),
      charge: num(c.amount),
      payment: 0,
      // Utility overcharges are managed as a set per bill: deleting a single
      // tenant's line would desync the bill's "charged" state. Reverse them
      // via Unpost on the Utilities page instead.
      deletable: c.kind === "utility_overage" ? null : "charge",
      refIds: [c.id],
    });
  }
  for (const [key, g] of otherGroups) {
    rows.push({
      id: `other:${key}`,
      date: g.date,
      description: "Other" + (g.note ? ` · ${g.note}` : ""),
      charge: g.amount,
      payment: 0,
      deletable: "charge",
      refIds: g.ids,
    });
  }

  // Payments. Rent payments only count from the anchor forward (pre-anchor
  // months are treated as settled); other payments always count. A refund is
  // money returned to the tenant, so it posts on the charge (debit) side.
  // This mirrors computeLedger so the running balance lands on the same net
  // figure.
  for (const p of payments) {
    if (p.payment_type === "rent" && p.paid_on < LEDGER_PAYMENT_CUTOFF) continue;
    if (p.payment_type === "refund") {
      rows.push({
        id: p.id,
        date: p.paid_on,
        description: "Refund" + (p.notes ? ` · ${p.notes}` : ""),
        charge: num(p.amount),
        payment: 0,
        deletable: "payment",
        refIds: [p.id],
      });
      continue;
    }
    const label =
      p.payment_type === "rent"
        ? "Payment"
        : `Payment · ${KIND_LABEL[p.payment_type] ?? p.payment_type}`;
    rows.push({
      id: p.id,
      date: p.paid_on,
      description: label + (p.notes ? ` · ${p.notes}` : ""),
      charge: 0,
      payment: num(p.amount),
      deletable: "payment",
      refIds: [p.id],
    });
  }

  // Oldest first; within a day put charges before payments so a same-day rent
  // charge and its payment read as "+rent then −payment → settled".
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.payment > 0 ? 1 : 0) - (b.payment > 0 ? 1 : 0);
  });

  let balance = 0;
  return rows.map((r) => {
    balance = cents(balance + r.charge - r.payment);
    return { ...r, balance };
  });
}
