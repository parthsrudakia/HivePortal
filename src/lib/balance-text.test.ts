import { afterEach, describe, expect, it, vi } from "vitest";
import {
  balanceReminderEmail,
  balanceReminderGmailEmail,
  balanceReminderText,
  greeting,
  warnsOfLateFee,
  monthEndBalanceEmail,
  monthEndBalanceText,
} from "@/lib/email";

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
      /^Hi Aviral,\n\nMy records show an outstanding rent balance of \$850 on your account\. Please/,
    );
    expect(balanceReminderText(900, "October 2026", true, "Aviral Bansal")).toMatch(/^Hi Aviral,/);
    expect(monthEndBalanceText(850, "Aviral Bansal")).toMatch(/^Hi Aviral,\n\n.*\$850/);
  });

  it("greets by first name in every balance email", () => {
    const branded = balanceReminderEmail(850, "October 2026", undefined, false, "Aviral Bansal");
    expect(branded.text).toMatch(/^Hi Aviral,\n/);
    expect(branded.html).toContain(">Hi Aviral,</p>");
    expect(balanceReminderGmailEmail(850, "October 2026", undefined, false, "Aviral Bansal").text).toMatch(/^Hi Aviral,\n/);
    const monthEnd = monthEndBalanceEmail(850, "October 2026", "November", undefined, "Aviral Bansal");
    expect(monthEnd.text).toMatch(/^Hi Aviral,\n/);
    expect(monthEnd.html).toContain(">Hi Aviral,</p>");
  });

  it("names no month in the balance sentence, text or email", () => {
    const all = [
      balanceReminderText(850, "October 2026", false, "A"),
      balanceReminderText(900, "October 2026", true, "A"),
      balanceReminderEmail(850, "October 2026", undefined, false, "A").text,
      balanceReminderEmail(900, "October 2026", undefined, true, "A").text,
      balanceReminderGmailEmail(850, "October 2026", undefined, false, "A").text,
    ];
    for (const t of all) {
      expect(t).toMatch(/records show an outstanding rent balance of \$\d+ on your account[.,]/);
      expect(t).not.toContain("October 2026");
    }
  });

  it("escapes a name in the HTML card", () => {
    expect(balanceReminderEmail(1, "Oct", undefined, false, "<b>X").html).toContain("Hi &lt;b&gt;X,");
  });

  it("falls back to Hi, when there is no name", () => {
    expect(balanceReminderText(850, "October 2026")).toMatch(/^Hi,\n/);
    expect(balanceReminderEmail(850, "October 2026").html).toContain(">Hi,</p>");
  });

  describe("late-fee warning", () => {
    afterEach(() => vi.useRealTimers());

    it("warns through the 5th only", () => {
      expect(warnsOfLateFee("2026-10-05")).toBe(true);
      expect(warnsOfLateFee("2026-10-06")).toBe(false);
    });

    it("drops the warning from every balance reminder after the 5th", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-20T15:00:00Z"));
      const all = [
        balanceReminderText(850, "October 2026", false, "A"),
        balanceReminderEmail(850, "October 2026", undefined, false, "A").text,
        balanceReminderEmail(850, "October 2026", undefined, false, "A").html,
        balanceReminderGmailEmail(850, "October 2026", undefined, false, "A").text,
      ];
      for (const t of all) expect(t).not.toMatch(/avoid a/);
    });

    it("keeps the warning on or before the 5th", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-03T15:00:00Z"));
      expect(balanceReminderText(850, "October 2026", false, "A")).toContain("to avoid a $50 late fee");
    });
  });
});
