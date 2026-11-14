import { describe, expect, it } from "vitest";
import { depositReturn, type TenancyLedgerInput } from "./rent";

function inputWith(
  charges: { kind: string; amount: number; charged_on?: string }[],
): TenancyLedgerInput[] {
  return [
    {
      id: "t1",
      unitLabel: "Unit",
      payments: [],
      tenancy: {} as TenancyLedgerInput["tenancy"],
      charges: charges.map((c, i) => ({
        id: `c${i}`,
        kind: c.kind,
        amount: c.amount,
        charged_on: c.charged_on ?? "2026-09-01",
        note: null,
      })) as TenancyLedgerInput["charges"],
    },
  ];
}

const today = "2026-11-15";

describe("depositReturn", () => {
  it("returns the full deposit when the account is square", () => {
    expect(depositReturn(inputWith([{ kind: "security_deposit", amount: 1500 }]), 0, today))
      .toEqual({ deposit: 1500, balance: 0, toReturn: 1500 });
  });

  it("deducts what they still owe and adds any credit", () => {
    const inputs = inputWith([{ kind: "security_deposit", amount: 1500 }]);
    expect(depositReturn(inputs, 200, today).toReturn).toBe(1300);
    expect(depositReturn(inputs, -100, today).toReturn).toBe(1600);
  });

  it("goes negative when they owe more than the deposit", () => {
    const inputs = inputWith([{ kind: "security_deposit", amount: 1000 }]);
    expect(depositReturn(inputs, 1250, today).toReturn).toBe(-250);
  });

  it("returns nothing for a deposit that was charged but never paid", () => {
    // The unpaid deposit charge is itself part of the balance.
    const inputs = inputWith([{ kind: "security_deposit", amount: 1500 }]);
    expect(depositReturn(inputs, 1500, today).toReturn).toBe(0);
  });

  it("counts a deposit already applied to the balance", () => {
    const inputs = inputWith([
      { kind: "security_deposit", amount: 1500 },
      { kind: "security_deposit", amount: -300 },
    ]);
    expect(depositReturn(inputs, 0, today).toReturn).toBe(1200);
  });

  it("treats a move-out settlement as the deposit being applied", () => {
    const inputs = inputWith([
      { kind: "security_deposit", amount: 1500 },
      { kind: "settlement", amount: 400 },
    ]);
    // Settle wrote off $400 against the deposit — $1,100 is left to return.
    expect(depositReturn(inputs, 0, today)).toEqual({
      deposit: 1500,
      balance: 400,
      toReturn: 1100,
    });
  });

  it("ignores future-dated charges", () => {
    const inputs = inputWith([
      { kind: "security_deposit", amount: 1500, charged_on: "2026-12-01" },
    ]);
    expect(depositReturn(inputs, 0, today).toReturn).toBe(0);
  });
});
