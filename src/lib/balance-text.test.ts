import { describe, expect, it } from "vitest";
import { balanceReminderText, greeting, monthEndBalanceText } from "@/lib/email";

describe("balance text greeting", () => {
  it("greets by first name", () => {
    expect(greeting("Mirielle V Marc")).toBe("Hi Mirielle,");
    expect(greeting("  Aviral Bansal ")).toBe("Hi Aviral,");
  });

  it("falls back to a plain Hi without a name", () => {
    expect(greeting(null)).toBe("Hi,");
    expect(greeting("   ")).toBe("Hi,");
  });

  it("puts the tenant's name and amount in both balance texts", () => {
    expect(balanceReminderText(850, "October 2026", false, "Aviral Bansal")).toMatch(
      /^Hi Aviral,\n\nMy records show an outstanding rent balance of \$850 for October 2026\./,
    );
    expect(balanceReminderText(900, "October 2026", true, "Aviral Bansal")).toMatch(/^Hi Aviral,/);
    expect(monthEndBalanceText(850, "Aviral Bansal")).toMatch(/^Hi Aviral,\n\n.*\$850/);
  });

  it("leaves the email copy (no name passed) unchanged", () => {
    expect(balanceReminderText(850, "October 2026")).toMatch(/^Hi,\n/);
  });
});
