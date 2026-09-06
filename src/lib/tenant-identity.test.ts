import { describe, expect, it } from "vitest";
import { mergeTenantProfile, namesFuzzyMatch, normalizeEmail } from "@/lib/tenant-identity";

describe("tenant identity", () => {
  it("normalises email case and whitespace", () => {
    expect(normalizeEmail("  MarcelPrabu@Gmail.com ")).toBe("marcelprabu@gmail.com");
    expect(normalizeEmail(null)).toBe("");
  });

  it("matches the same person written differently", () => {
    expect(namesFuzzyMatch("Marcel Prabu Dwipayana", "Marcel Dwipayana")).toBe(true);
    expect(namesFuzzyMatch("Marcel Prabu Dwipayana", "marcel prabu dwipayana")).toBe(true);
    expect(namesFuzzyMatch("Marcel Dwipayana", "Marcel Dwipayanna")).toBe(true); // typo
    expect(namesFuzzyMatch("José García", "Jose Garcia")).toBe(true); // accents
    expect(namesFuzzyMatch("Ankush Sinha", "Sinha, Ankush")).toBe(true); // reordered
    expect(namesFuzzyMatch("Teah Marcelo", "Teah Micaela Marcelo")).toBe(true);
  });

  it("does not merge clearly different people who share an inbox", () => {
    expect(namesFuzzyMatch("Marcel Dwipayana", "Priya Sharma")).toBe(false);
    expect(namesFuzzyMatch("Ankush Sinha", "Anita Sinha")).toBe(false);
    expect(namesFuzzyMatch("John Smith", "")).toBe(false);
  });

  it("fills in the reused profile without overwriting operator notes", () => {
    const existing = {
      id: "t1",
      full_name: "Marcel Prabu Dwipayana",
      email: "marcelprabu@gmail.com",
      phone: "617-000-0000",
      pays_as: null,
      notes: "Prefers Zelle",
      social_links: ["https://ig.com/marcel"],
    };
    expect(
      mergeTenantProfile(existing, {
        phone: "617-870-9445",
        pays_as: "Marcel D",
        notes: "Returning tenant",
        social_links: ["https://ig.com/marcel", "https://li.com/marcel"],
      }),
    ).toEqual({
      phone: "617-870-9445",
      pays_as: "Marcel D",
      notes: "Prefers Zelle\nReturning tenant",
      social_links: ["https://ig.com/marcel", "https://li.com/marcel"],
    });
    expect(mergeTenantProfile(existing, { phone: "617-000-0000", notes: "Prefers Zelle" })).toEqual({});
  });
});
