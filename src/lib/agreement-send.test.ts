import { beforeEach, describe, expect, it, vi } from "vitest";

// Offline stubs — these modules are only reached past the guards under test.
vi.mock("@/lib/google-mail", () => ({ sendGmailMessage: vi.fn() }));
vi.mock("@/lib/graph-mail", () => ({ sendOutlookMessage: vi.fn() }));
vi.mock("@/lib/email-log", () => ({ logEmail: vi.fn() }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

const { sendAgreementRequest, signPageUrl } = await import("./agreement-send");

const nyInput = {
  tenantName: "Test Tenant",
  sublessorName: "Vineet Dutta",
  propertyAddress: "123 E 54th St, New York, NY 10022",
  roomNumber: "2",
  rent: "1650",
  securityDeposit: "1650",
  leaseStartDate: "2026-08-01",
  leaseEndDate: "2027-01-31",
  agreementDate: "2026-07-21",
  recipientEmail: "tenant@example.com",
  inNewYork: true,
};

describe("signing-link origin", () => {
  beforeEach(() => {
    delete process.env.SIGN_ORIGIN;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it("prefers the neutral SIGN_ORIGIN (trailing slash stripped)", () => {
    process.env.SIGN_ORIGIN = "https://neutral.example/";
    expect(signPageUrl("tok")).toBe("https://neutral.example/sign/tok");
  });

  it("falls back to the portal domain when SIGN_ORIGIN is unset", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://hive-portal-1485.vercel.app";
    expect(signPageUrl("tok")).toBe(
      "https://hive-portal-1485.vercel.app/sign/tok",
    );
  });

  it("refuses NY sends without SIGN_ORIGIN — the portal URL would leak branding", async () => {
    const result = await sendAgreementRequest(nyInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("SIGN_ORIGIN");
  });
});

describe("mandatory room", () => {
  beforeEach(() => {
    process.env.SIGN_ORIGIN = "https://neutral.example";
  });

  it("refuses a send with no room number before touching the property", async () => {
    const result = await sendAgreementRequest({ ...nyInput, roomNumber: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/room number is required/i);
  });
});
