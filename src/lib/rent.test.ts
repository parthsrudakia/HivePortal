import { describe, expect, it } from "vitest";
import {
  buildLedgerEntries,
  buildTenantLedgerEntries,
  computeLedger,
  computeTenantLedger,
  rateForMonthISO,
  type LedgerTenancy,
} from "@/lib/rent";

const tenancy = (overrides: Partial<LedgerTenancy> = {}): LedgerTenancy => ({
  start_date: "2026-06-01",
  move_out_date: null,
  monthly_rent: 1_325,
  first_month_rent: null,
  security_deposit: null,
  paused_at: null,
  ...overrides,
});

describe("rent ledger financial controls", () => {
  it("does not bill a tenancy before its actual start date", () => {
    const ledger = computeLedger(
      tenancy({ start_date: "2026-07-20" }),
      [],
      [],
      [],
      "2026-07-15",
    );

    expect(ledger.rent.owed).toBe(0);
    expect(ledger.netBalance).toBe(0);
    expect(
      buildLedgerEntries(
        tenancy({ start_date: "2026-07-20" }),
        [],
        [],
        "2026-07-15",
      ),
    ).toEqual([]);
  });

  it("stops accruing rent for months that begin after the pause date", () => {
    const paused = tenancy({ paused_at: "2026-07-15T12:00:00Z" });
    const ledger = computeLedger(paused, [], [], [], "2026-09-10");

    // June and July accrue (July was already underway when the pause landed);
    // August and September begin after it and bill nothing.
    expect(ledger.rent.owed).toBe(2 * 1_325);

    const rentLines = buildLedgerEntries(paused, [], [], "2026-09-10").filter(
      (e) => e.id.startsWith("rent-"),
    );
    expect(rentLines).toHaveLength(2);
  });

  it("keeps future-dated payments and charges out until their date", () => {
    const ledger = computeLedger(
      tenancy(),
      [
        { amount: 1_325, paid_on: "2026-06-05", payment_type: "rent" },
        { amount: 1_325, paid_on: "2026-07-20", payment_type: "rent" },
      ],
      [
        { kind: "late_fee", amount: 50, charged_on: "2026-07-10" },
        { kind: "other", amount: 99, charged_on: "2026-07-20" },
      ],
      [],
      "2026-07-15",
    );

    expect(ledger.rent.owed).toBe(2_650);
    expect(ledger.rent.paid).toBe(1_325);
    expect(ledger.lateFee.owed).toBe(50);
    expect(ledger.other.owed).toBe(0);
    expect(ledger.netBalance).toBe(1_375);
  });

  it("nets refunds against collected cash and shows them as ledger debits", () => {
    const ledger = computeLedger(
      tenancy(),
      [
        { amount: 1_325, paid_on: "2026-06-05", payment_type: "rent" },
        { amount: 200, paid_on: "2026-06-10", payment_type: "refund" },
      ],
      [],
      [],
      "2026-06-30",
    );
    expect(ledger.netBalance).toBe(200);

    const entries = buildLedgerEntries(
      tenancy(),
      [
        {
          id: "rent-payment",
          amount: 1_325,
          paid_on: "2026-06-05",
          payment_type: "rent",
          notes: null,
        },
        {
          id: "refund",
          amount: 200,
          paid_on: "2026-06-10",
          payment_type: "refund",
          notes: null,
        },
      ],
      [],
      "2026-06-30",
    );
    expect(entries.at(-1)).toMatchObject({
      id: "refund",
      charge: 200,
      payment: 0,
      balance: 200,
    });
  });

  it("uses the rate effective in each month without repricing history", () => {
    const changes = [
      { effective_month: "2026-06-01", monthly_rent: 1_325 },
      { effective_month: "2026-08-01", monthly_rent: 1_400 },
    ];

    expect(rateForMonthISO("2026-07-01", 1_400, changes)).toBe(1_325);
    expect(rateForMonthISO("2026-08-01", 1_400, changes)).toBe(1_400);
    expect(
      computeLedger(
        tenancy({ monthly_rent: 1_400 }),
        [],
        [],
        [],
        "2026-08-31",
        changes,
      ).rent.owed,
    ).toBe(4_050);
  });

  it("nets an 'adjustment' write-off as a credit that settles the account", () => {
    // Tenant paid all but a $3.40 residue; the month-end write-off posts an
    // adjustment for exactly that, settling the account.
    const payments = [
      { amount: 1_321.6, paid_on: "2026-06-05", payment_type: "rent" },
    ];
    const charge = {
      kind: "adjustment",
      amount: 3.4,
      charged_on: "2026-06-30",
    };
    const ledger = computeLedger(tenancy(), payments, [charge], [], "2026-06-30");
    expect(ledger.netBalance).toBe(0);

    const entries = buildLedgerEntries(
      tenancy(),
      [
        {
          id: "pay",
          amount: 1_321.6,
          paid_on: "2026-06-05",
          payment_type: "rent",
          notes: null,
        },
      ],
      [
        {
          id: "adj",
          kind: "adjustment",
          amount: 3.4,
          charged_on: "2026-06-30",
          note: "Small balance write-off (under $5)",
        },
      ],
      "2026-06-30",
    );
    expect(entries.at(-1)).toMatchObject({
      id: "adj",
      charge: 0,
      payment: 3.4,
      balance: 0,
      deletable: "charge",
    });
  });

  it("nets a NEGATIVE 'adjustment' as a debit that absorbs a credit residue", () => {
    // Tenant rounded their Zelle up ($1,325.35 against $1,325 owed), leaving
    // a 35¢ credit; a negative adjustment settles the account to exactly $0.
    const payments = [
      { amount: 1_325.35, paid_on: "2026-06-05", payment_type: "rent" },
    ];
    const charge = {
      kind: "adjustment",
      amount: -0.35,
      charged_on: "2026-06-30",
    };
    const ledger = computeLedger(tenancy(), payments, [charge], [], "2026-06-30");
    expect(ledger.netBalance).toBe(0);
    expect(ledger.availableCredit).toBe(0);

    const entries = buildLedgerEntries(
      tenancy(),
      [
        {
          id: "pay",
          amount: 1_325.35,
          paid_on: "2026-06-05",
          payment_type: "rent",
          notes: null,
        },
      ],
      [
        {
          id: "adj",
          kind: "adjustment",
          amount: -0.35,
          charged_on: "2026-06-30",
          note: "Credit residue settled",
        },
      ],
      "2026-06-30",
    );
    expect(entries.at(-1)).toMatchObject({
      id: "adj",
      charge: 0.35,
      payment: 0,
      balance: 0,
      deletable: "charge",
    });
  });

  it("rounds settled ledgers to exact cents", () => {
    const ledger = computeLedger(
      tenancy({ monthly_rent: 1_325 }),
      [
        { amount: 726.61, paid_on: "2026-06-01", payment_type: "rent" },
        { amount: 598.39, paid_on: "2026-06-02", payment_type: "rent" },
      ],
      [],
      [],
      "2026-06-30",
    );
    expect(ledger.netBalance).toBe(0);
  });
});

describe("tenant-wide ledger (one ledger per tenant across rooms)", () => {
  const oldRoom = {
    id: "old",
    unitLabel: "Newark Apt 202 · Room 2",
    tenancy: tenancy({
      start_date: "2026-07-01",
      move_out_date: "2026-08-31",
      monthly_rent: 1_500,
    }),
    payments: [
      {
        id: "p1",
        amount: 1_500,
        paid_on: "2026-07-03",
        payment_type: "rent",
        notes: null,
      },
      {
        id: "p2",
        amount: 1_500,
        paid_on: "2026-08-05",
        payment_type: "rent",
        notes: null,
      },
      {
        id: "d1",
        amount: 1_500,
        paid_on: "2026-06-22",
        payment_type: "security_deposit",
        notes: null,
      },
    ],
    charges: [
      {
        id: "c1",
        kind: "security_deposit",
        amount: 1_500,
        charged_on: "2026-07-01",
        note: null,
      },
    ],
  };
  const newRoom = {
    id: "new",
    unitLabel: "Singh Tower Apt 506 · Room 1",
    tenancy: tenancy({ start_date: "2026-09-01", monthly_rent: 1_650 }),
    payments: [
      {
        id: "p3",
        amount: 1_600,
        paid_on: "2026-09-04",
        payment_type: "rent",
        notes: null,
      },
    ],
    charges: [
      {
        id: "c2",
        kind: "security_deposit",
        amount: 150,
        charged_on: "2026-09-01",
        note: "Deposit top-up",
      },
    ],
  };

  it("carries one running balance straight through a room change", () => {
    const entries = buildTenantLedgerEntries([newRoom, oldRoom], "2026-09-06");
    expect(entries.map((e) => e.description)).toEqual([
      "Payment · Security deposit",
      "Rent · Jul 2026",
      "Security Deposit Charge",
      "Payment",
      "Rent · Aug 2026",
      "Payment",
      "Rent · Sep 2026",
      "Security Deposit Charge · Deposit top-up",
      "Payment",
    ]);
    // Every line is tagged with its room once the tenant has had more than one.
    expect(entries[1].unit).toBe("Newark Apt 202 · Room 2");
    expect(entries[6].unit).toBe("Singh Tower Apt 506 · Room 1");
    // $50 short on September rent + $150 deposit top-up.
    expect(entries.at(-1)?.balance).toBe(200);
    expect(computeTenantLedger([newRoom, oldRoom], "2026-09-06").netBalance).toBe(
      200,
    );
  });

  it("hides a transfer's offsetting carry pair, keeps an orphaned half", () => {
    const carried = {
      ...oldRoom,
      payments: oldRoom.payments.slice(0, 1), // Aug rent + deposit unpaid → $3,000 carried
      charges: [
        ...oldRoom.charges,
        {
          id: "s1",
          kind: "settlement",
          amount: 3_000,
          charged_on: "2026-08-31",
          note: "Balance carried to Singh Tower Apt 506 · Room 1",
        },
      ],
    };
    const receiving = {
      ...newRoom,
      charges: [
        ...newRoom.charges,
        {
          id: "a1",
          kind: "adjustment",
          amount: -3_000,
          charged_on: "2026-09-01",
          note: "Balance carried from Newark Apt 202 · Room 2",
        },
      ],
    };
    const entries = buildTenantLedgerEntries([carried, receiving], "2026-09-06");
    expect(entries.some((e) => e.description.includes("carried"))).toBe(false);
    expect(entries.at(-1)?.balance).toBe(3_200);
    expect(computeTenantLedger([carried, receiving], "2026-09-06").netBalance).toBe(
      3_200,
    );

    // If the operator deleted the adjustment, the settlement really does
    // change the balance — so it must stay visible.
    const orphaned = buildTenantLedgerEntries([carried, newRoom], "2026-09-06");
    expect(orphaned.some((e) => e.description.includes("carried"))).toBe(true);
    expect(orphaned.at(-1)?.balance).toBe(200);
  });

  it("carries a credit as a negative adjustment on the old room", () => {
    // Tenant overpaid the old room by $500 (both halves must be adjustments:
    // the DB only allows a negative amount on an adjustment, never a settlement).
    const carried = {
      ...oldRoom,
      payments: [
        ...oldRoom.payments,
        {
          id: "p-extra",
          payment_type: "rent",
          amount: 500,
          paid_on: "2026-08-20",
          notes: null,
        },
      ],
      charges: [
        ...oldRoom.charges,
        {
          id: "a0",
          kind: "adjustment",
          amount: -500,
          charged_on: "2026-08-31",
          note: "Balance carried to Singh Tower Apt 506 · Room 1",
        },
      ],
    };
    const receiving = {
      ...newRoom,
      charges: [
        ...newRoom.charges,
        {
          id: "a1",
          kind: "adjustment",
          amount: 500,
          charged_on: "2026-09-01",
          note: "Balance carried from Newark Apt 202 · Room 2",
        },
      ],
    };
    // Old room settles to exactly $0; the credit lands on the new room.
    expect(
      computeLedger(carried.tenancy, carried.payments, carried.charges, [], "2026-09-06")
        .netBalance,
    ).toBe(0);
    expect(
      computeLedger(receiving.tenancy, receiving.payments, receiving.charges, [], "2026-09-06")
        .netBalance,
    ).toBe(-300);
    const entries = buildTenantLedgerEntries([carried, receiving], "2026-09-06");
    expect(entries.some((e) => e.description.includes("carried"))).toBe(false);
    expect(entries.at(-1)?.balance).toBe(-300);
  });

  it("leaves lines untagged for a single-room tenant", () => {
    const entries = buildTenantLedgerEntries([newRoom], "2026-09-06");
    expect(entries.every((e) => e.unit === undefined)).toBe(true);
    expect(entries.at(-1)?.balance).toBe(200);
  });
});
