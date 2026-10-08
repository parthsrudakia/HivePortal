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
  /**
   * When set, the tenancy is paused: months that BEGIN on or after this
   * timestamp accrue no rent (months already underway stay billed). Required
   * — not optional — so every query feeding the ledger is forced to select
   * it; an optional field would let a forgotten select silently bill paused
   * tenants on one page and not another.
   */
  paused_at: string | null;
};

export type LedgerPayment = {
  amount: number | string;
  paid_on: string;
  payment_type: string;
};

export type LedgerCharge = {
  kind: string;
  amount: number | string;
  charged_on?: string;
};
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
  // A tenancy is not billable until its actual move-in date. Comparing only
  // month indexes previously charged an upcoming tenant from the first day of
  // their start month.
  if (t.start_date > todayIso) return 0;
  const anchorIdx = monthIndex(LEDGER_ANCHOR);
  const startIdx = monthIndex(t.start_date);
  const effStart = Math.max(anchorIdx, startIdx);
  let end = monthIndex(todayIso);
  if (t.move_out_date) end = Math.min(end, monthIndex(t.move_out_date));
  if (end < effStart) return 0;

  const pausedDay = t.paused_at ? t.paused_at.slice(0, 10) : null;
  let total = 0;
  for (let idx = effStart; idx <= end; idx++) {
    // Paused tenancies accrue nothing for months that begin on/after the
    // pause date; a month already underway when the pause landed stays billed.
    if (pausedDay && firstOfMonthISO(idx) >= pausedDay) continue;
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
    .filter(
      (p) => p.paid_on <= todayIso,
    )
    .reduce((s, p) => s + num(p.amount), 0);
  const allocatedAway = allocations.reduce((s, a) => s + num(a.amount), 0);
  const rentPaid = cents(rentPaidGross - allocatedAway);
  const due = cents(rentDue(t, todayIso, rentChanges));
  const rent: Bucket = { owed: due, paid: rentPaid, balance: cents(due - rentPaid) };

  const paidOf = (type: string) =>
    payments
      .filter((p) => p.payment_type === type && p.paid_on <= todayIso)
      .reduce((s, p) => s + num(p.amount), 0);
  const allocOf = (kind: string) =>
    allocations
      .filter((a) => a.kind === kind)
      .reduce((s, a) => s + num(a.amount), 0);
  const chargedOf = (kind: string) =>
    charges
      .filter(
        (c) => c.kind === kind && (!c.charged_on || c.charged_on <= todayIso),
      )
      .reduce((s, c) => s + num(c.amount), 0);

  const bucket = (owed: number, key: string): Bucket => {
    const paid = cents(paidOf(key) + allocOf(key));
    return { owed: cents(owed), paid, balance: cents(owed - paid) };
  };

  // The security deposit is now an ad-hoc charge (kind 'security_deposit') like
  // late fees, so the tenancy's deposit field is purely informational. A
  // NEGATIVE deposit charge is a reduction (deposit applied to rent, or a
  // transfer to a room with a smaller deposit): it lowers `owed` so the bucket
  // always reads as the deposit actually held, and credits the balance.
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
  // A 'settlement' charge is the move-out write-off (deposit applied,
  // remainder forgiven): it credits the account without recording money
  // received, so collections analytics stay truthful. An 'adjustment' is the
  // same mechanic for an operator-posted residue write-off; a NEGATIVE
  // adjustment runs the other way, absorbing a small credit residue
  // (rounded-up payment) so the account settles to exactly $0.
  const refunded = paidOf("refund");
  const settled = chargedOf("settlement") + chargedOf("adjustment");
  const netBalance = cents(
    rent.balance +
      deposit.balance +
      lateFee.balance +
      other.balance +
      refunded -
      settled,
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
  settlement: "Settlement",
  adjustment: "Adjustment",
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
  /** Source utility bill, when the charge was posted from one. */
  bill_id?: string | null;
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
  /** Utility bill behind this line (utility overcharges) — linked in the UI. */
  billId?: string | null;
  /** Tenancy this line belongs to (set by the tenant-wide ledger). */
  tenancyId?: string;
  /** Unit label for this line, set when the tenant has had more than one room. */
  unit?: string;
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
  // Mirror rentDue's pause rule so the chronological view matches netBalance.
  const pausedDay = t.paused_at ? t.paused_at.slice(0, 10) : null;
  for (let idx = effStart; t.start_date <= todayIso && idx <= end; idx++) {
    if (pausedDay && firstOfMonthISO(idx) >= pausedDay) continue;
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
    if (c.charged_on > todayIso) continue;
    // Settlement and adjustment are credit lines: they reduce the running
    // balance like a payment does, but record forgiveness (move-out write-off
    // / residue write-off), not money received. Mirrors the `- settled`
    // term in computeLedger. A NEGATIVE adjustment is the mirror image — it
    // absorbs a small credit residue (tenant rounded a payment up), so it
    // posts on the charge (debit) side.
    if (c.kind === "settlement" || c.kind === "adjustment") {
      const amt = num(c.amount);
      rows.push({
        id: c.id,
        date: c.charged_on,
        description: KIND_LABEL[c.kind] + (c.note ? ` · ${c.note}` : ""),
        charge: amt < 0 ? -amt : 0,
        payment: amt < 0 ? 0 : amt,
        deletable: "charge",
        refIds: [c.id],
      });
      continue;
    }
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
    // A deposit reduction is a credit line: the money already held covers it,
    // so it posts on the payment side like a settlement does.
    if (c.kind === "security_deposit" && num(c.amount) < 0) {
      rows.push({
        id: c.id,
        date: c.charged_on,
        description:
          "Security Deposit Applied" + (c.note ? ` · ${c.note}` : ""),
        charge: 0,
        payment: -num(c.amount),
        deletable: "charge",
        refIds: [c.id],
      });
      continue;
    }
    rows.push({
      id: c.id,
      date: c.charged_on,
      // The deposit CHARGE line says "Charge" explicitly so it can't be
      // misread as a received deposit; the payment row ("Payment · Security
      // deposit") keeps the plain KIND_LABEL.
      description:
        (c.kind === "security_deposit"
          ? "Security Deposit Charge"
          : (KIND_LABEL[c.kind] ?? c.kind)) + (c.note ? ` · ${c.note}` : ""),
      charge: num(c.amount),
      payment: 0,
      // Utility overcharges are managed as a set per bill: deleting a single
      // tenant's line would desync the bill's "charged" state. Reverse them
      // via Unpost on the Utilities page instead.
      deletable: c.kind === "utility_overage" ? null : "charge",
      refIds: [c.id],
      billId: c.bill_id ?? null,
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
    if (p.paid_on > todayIso) continue;
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

// ---------------------------------------------------------------------------
// Tenant-wide ledger — ONE running balance per tenant across every tenancy.
// A tenant who moves rooms keeps a single ledger: the old room's rent, deposit
// and payments stay on the same statement and the balance simply carries
// through into the new room, instead of each tenancy owning a separate ledger.
// ---------------------------------------------------------------------------

/** One tenancy's inputs to the tenant-wide ledger. */
export type TenancyLedgerInput = {
  id: string;
  tenancy: LedgerTenancy;
  /** "Building Apt 5 · Room 2" — tags each line when the tenant had >1 room. */
  unitLabel: string;
  payments: LedgerEntryPayment[];
  charges: LedgerEntryCharge[];
  allocations?: LedgerAllocation[];
  rentChanges?: RentChange[];
};

/** Bucket-by-bucket sum of several ledgers (the tenant-wide position). */
export function sumLedgers(ledgers: Ledger[]): Ledger {
  const add = (a: Bucket, b: Bucket): Bucket => ({
    owed: cents(a.owed + b.owed),
    paid: cents(a.paid + b.paid),
    balance: cents(a.balance + b.balance),
  });
  const zero = (): Bucket => ({ owed: 0, paid: 0, balance: 0 });
  const out: Ledger = {
    rent: zero(),
    deposit: zero(),
    lateFee: zero(),
    other: zero(),
    netBalance: 0,
    availableCredit: 0,
  };
  for (const l of ledgers) {
    out.rent = add(out.rent, l.rent);
    out.deposit = add(out.deposit, l.deposit);
    out.lateFee = add(out.lateFee, l.lateFee);
    out.other = add(out.other, l.other);
    out.netBalance = cents(out.netBalance + l.netBalance);
  }
  out.availableCredit = Math.max(0, -out.netBalance);
  return out;
}

/** The tenant-wide ledger position: every tenancy's buckets summed. */
export function computeTenantLedger(
  inputs: TenancyLedgerInput[],
  todayIso: string = todayISO(),
): Ledger {
  return sumLedgers(
    inputs.map((i) =>
      computeLedger(
        i.tenancy,
        i.payments,
        i.charges,
        i.allocations ?? [],
        todayIso,
        i.rentChanges ?? [],
      ),
    ),
  );
}

/** Note prefix the room-transfer action stamps on its carry rows. */
const CARRY_NOTE = /^Balance carried (to|from) /;

/**
 * Chronological ledger across ALL of a tenant's tenancies, oldest first, with
 * one running balance carried straight through room changes. Lines carry the
 * tenancy's `unit` so the room each charge belongs to stays visible.
 *
 * A room transfer books the carried balance as a 'settlement' on the old
 * tenancy and an equal-and-opposite 'adjustment' on the new one so the
 * per-tenancy figures (Rent Tracker, reminders) stay right. On one unified
 * statement that pair is pure bookkeeping — it nets to zero and would read as
 * "balance vanishes, balance reappears" — so it is dropped here whenever it
 * still nets to zero. If either half was deleted the survivor is kept, since
 * it then genuinely changes the balance.
 */
export function buildTenantLedgerEntries(
  inputs: TenancyLedgerInput[],
  todayIso: string = todayISO(),
): LedgerEntry[] {
  const carryTotal = inputs
    .flatMap((i) => i.charges)
    .filter(
      (c) =>
        (c.kind === "settlement" || c.kind === "adjustment") &&
        c.note != null &&
        CARRY_NOTE.test(c.note) &&
        c.charged_on <= todayIso,
    )
    .reduce((s, c) => s + num(c.amount), 0);
  const hideCarry = Math.abs(cents(carryTotal)) < 0.005;

  const tag = inputs.length > 1;
  const rows: Omit<LedgerEntry, "balance">[] = [];
  for (const i of inputs) {
    const charges = hideCarry
      ? i.charges.filter(
          (c) =>
            !(
              (c.kind === "settlement" || c.kind === "adjustment") &&
              c.note != null &&
              CARRY_NOTE.test(c.note)
            ),
        )
      : i.charges;
    for (const e of buildLedgerEntries(
      i.tenancy,
      i.payments,
      charges,
      todayIso,
      i.rentChanges ?? [],
    )) {
      rows.push({
        ...e,
        // Auto rent ids are per-tenancy ("rent-<month>"); keep them unique
        // across the merged list.
        id: e.refIds.length ? e.id : `${i.id}:${e.id}`,
        tenancyId: i.id,
        unit: tag ? i.unitLabel : undefined,
      });
    }
  }

  // Same ordering rule as the per-tenancy list: by date, charges before
  // payments within a day; ties broken by tenancy start so an old room's
  // final month sorts before the new room's first month.
  const startOf = new Map(inputs.map((i) => [i.id, i.tenancy.start_date]));
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ap = a.payment > 0 ? 1 : 0;
    const bp = b.payment > 0 ? 1 : 0;
    if (ap !== bp) return ap - bp;
    const as = startOf.get(a.tenancyId ?? "") ?? "";
    const bs = startOf.get(b.tenancyId ?? "") ?? "";
    return as < bs ? -1 : as > bs ? 1 : 0;
  });

  let balance = 0;
  return rows.map((r) => {
    balance = cents(balance + r.charge - r.payment);
    return { ...r, balance };
  });
}
