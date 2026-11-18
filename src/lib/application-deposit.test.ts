import { beforeEach, describe, expect, it, vi } from "vitest";

const outlook = vi.fn();
const gmail = vi.fn();
const logEmail = vi.fn();
vi.mock("@/lib/graph-mail", () => ({ sendOutlookMessage: outlook }));
vi.mock("@/lib/google-mail", () => ({ sendGmailMessage: gmail }));
vi.mock("@/lib/email-log", () => ({ logEmail }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

const { FakeDb } = await import("./testing/fake-supabase");
const { halfDeposit, retryDepositRequestEmails, sendDepositRequestEmail } = await import(
  "./application-deposit"
);

const NOW = new Date("2026-11-18T15:00:00.000Z");
const MIN = 60_000;

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    status: "signed",
    tenant_name: "Applicant Typed Name",
    recipient_email: "invited@example.com",
    property_address: "505 Summit Ave, Apt 4B, Jersey City, NJ 07306",
    room_number: "3",
    channel: "outlook",
    signed_at: new Date(NOW.getTime() - 30 * MIN).toISOString(),
    input: { securityDeposit: "1850" },
    ...overrides,
  };
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    status: "used",
    agreement_request_id: "req-1",
    deposit_email_sent_at: null,
    expires_at: new Date(NOW.getTime() + 10 * 86_400_000).toISOString(),
    claimed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  outlook.mockReset();
  gmail.mockReset();
  logEmail.mockReset();
  outlook.mockResolvedValue({ ok: true, id: "msg-1" });
  gmail.mockResolvedValue({ ok: true, id: "msg-2" });
});

describe("half the deposit", () => {
  it.each([
    ["1850", "$925"],
    ["1875", "$937.50"],
    ["$1,875.00", "$937.50"],
    [2101, "$1,050.50"],
  ])("%s → %s", (deposit, expected) => {
    expect(halfDeposit(deposit)).toBe(expected);
  });

  it("is null without a usable deposit", () => {
    expect(halfDeposit(undefined)).toBeNull();
    expect(halfDeposit("0")).toBeNull();
    expect(halfDeposit("abc")).toBeNull();
  });
});

describe("deposit request after signing", () => {
  it("emails the invited applicant once, with half the deposit, on the agreement's mailbox", async () => {
    const fake = new FakeDb({ application_invites: [invite()], agreement_requests: [request()] });
    expect(await sendDepositRequestEmail(fake.client(), "req-1")).toEqual({ sent: true });
    expect(outlook).toHaveBeenCalledTimes(1);
    const mail = outlook.mock.calls[0][0];
    expect(mail.to).toBe("invited@example.com");
    expect(mail.text).toContain(
      "Thanks for signing. To reserve the room and take it off the market, please send half of the security deposit ($925) by Zelle to Vineet.Dutta@hiveNY.com. If you don't use Zelle, reach out to Vinny to discuss other payment options.",
    );
    expect(gmail).not.toHaveBeenCalled();
    expect(fake.rows("application_invites")[0].deposit_email_sent_at).toBeTruthy();
    expect(logEmail).toHaveBeenCalledWith(expect.objectContaining({ type: "application_deposit", status: "sent" }));

    expect(await sendDepositRequestEmail(fake.client(), "req-1")).toEqual({ sent: false, reason: "already_sent" });
    expect(outlook).toHaveBeenCalledTimes(1);
  });

  it("uses the Gmail mailbox when the agreement went from Gmail", async () => {
    const fake = new FakeDb({
      application_invites: [invite()],
      agreement_requests: [request({ channel: "gmail", input: { securityDeposit: "1875" } })],
    });
    expect(await sendDepositRequestEmail(fake.client(), "req-1")).toEqual({ sent: true });
    expect(gmail).toHaveBeenCalledTimes(1);
    expect(gmail.mock.calls[0][0].text).toContain("($937.50)");
    expect(outlook).not.toHaveBeenCalled();
  });

  it("skips agreements that didn't come from an invite", async () => {
    const fake = new FakeDb({ application_invites: [], agreement_requests: [request()] });
    expect(await sendDepositRequestEmail(fake.client(), "req-1")).toEqual({ sent: false, reason: "not_invite" });
    expect(outlook).not.toHaveBeenCalled();
  });

  it("skips unsigned agreements", async () => {
    const fake = new FakeDb({
      application_invites: [invite()],
      agreement_requests: [request({ status: "pending", signed_at: null })],
    });
    expect(await sendDepositRequestEmail(fake.client(), "req-1")).toEqual({ sent: false, reason: "not_signed" });
    expect(outlook).not.toHaveBeenCalled();
  });

  it("leaves a failed send unstamped, and the daily sweep sends it once", async () => {
    outlook.mockResolvedValueOnce({ ok: false, error: "Outlook is down" });
    const fake = new FakeDb({ application_invites: [invite()], agreement_requests: [request()] });
    const first = await sendDepositRequestEmail(fake.client(), "req-1");
    expect(first).toMatchObject({ sent: false, reason: "send_failed" });
    expect(fake.rows("application_invites")[0].deposit_email_sent_at).toBeNull();

    expect(await retryDepositRequestEmails(fake.client(), NOW)).toEqual({ sent: 1, pending: 0, expired: 0 });
    expect(outlook).toHaveBeenCalledTimes(2);
    expect(fake.rows("application_invites")[0].deposit_email_sent_at).toBeTruthy();

    expect(await retryDepositRequestEmails(fake.client(), NOW)).toEqual({ sent: 0, pending: 0, expired: 0 });
    expect(outlook).toHaveBeenCalledTimes(2);
  });

  it("leaves agreements signed in the last 10 minutes to the signing action", async () => {
    const fake = new FakeDb({
      application_invites: [invite()],
      agreement_requests: [request({ signed_at: new Date(NOW.getTime() - 2 * MIN).toISOString() })],
    });
    expect(await retryDepositRequestEmails(fake.client(), NOW)).toEqual({ sent: 0, pending: 0, expired: 0 });
    expect(outlook).not.toHaveBeenCalled();
  });

  it("marks open invites past 14 days as expired, but not one being completed", async () => {
    const past = new Date(NOW.getTime() - MIN).toISOString();
    const fake = new FakeDb({
      application_invites: [
        invite({ id: "old", status: "sent", agreement_request_id: null, expires_at: past }),
        invite({ id: "busy", status: "sent", agreement_request_id: null, expires_at: past, claimed_at: past }),
        invite({ id: "fresh", status: "sent", agreement_request_id: null }),
      ],
      agreement_requests: [],
    });
    const res = await retryDepositRequestEmails(fake.client(), NOW);
    expect(res.expired).toBe(1);
    expect(fake.rows("application_invites").map((i) => [i.id, i.status])).toEqual([
      ["old", "expired"],
      ["busy", "sent"],
      ["fresh", "sent"],
    ]);
  });
});
