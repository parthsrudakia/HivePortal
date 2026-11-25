import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/google-mail", () => ({ sendGmailMessage: vi.fn() }));
vi.mock("@/lib/graph-mail", () => ({ sendOutlookMessage: vi.fn() }));
vi.mock("@/lib/email-log", () => ({ logEmail: vi.fn() }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

const { FakeDb } = await import("./testing/fake-supabase");
const {
  NY_INVITE_ERROR,
  cancelInvite,
  completeInvite,
  createInvite,
  effectiveStatus,
  lookupInvite,
  newInviteToken,
} = await import("./application-invites");

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const NY_PROPERTY = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const NY_ROOM = "44444444-4444-4444-8444-444444444444";
const STREET = "505 Summit Ave";
const UNIT = "4B";

const NOW = new Date("2026-11-18T15:00:00.000Z");
const TODAY = "2026-11-18";
const DAY = 86_400_000;

function db(invites: Record<string, unknown>[] = []) {
  return new FakeDb({
    properties: [
      { id: PROPERTY, street_address: STREET, unit_number: UNIT, neighborhood: "JSQ", is_new_york: false },
      { id: NY_PROPERTY, street_address: "123 E 54th St", unit_number: "2", neighborhood: "UES", is_new_york: true },
    ],
    rooms: [
      { id: ROOM, property_id: PROPERTY, room_number: "3", total_rent: 1850 },
      { id: NY_ROOM, property_id: NY_PROPERTY, room_number: "1", total_rent: 2100 },
    ],
    agreement_addresses: [
      { property_id: PROPERTY, full_address: `${STREET}, Apt ${UNIT}, Jersey City, NJ 07306` },
    ],
    application_invites: invites,
    agreement_requests: [],
  });
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    token: newInviteToken(),
    property_id: PROPERTY,
    room_id: ROOM,
    applicant_email: "invited@example.com",
    applicant_name: "Invited Person",
    rent: 1850,
    security_deposit: 1850,
    status: "sent",
    expires_at: new Date(NOW.getTime() + 14 * DAY).toISOString(),
    used_at: null,
    agreement_request_id: null,
    website_application_id: null,
    tenant_email: null,
    claimed_at: null,
    deposit_email_sent_at: null,
    ...overrides,
  };
}

function body(token: string, overrides: Record<string, unknown> = {}) {
  return {
    token,
    full_name: "Applicant Typed Name",
    email: "invited@example.com",
    phone: "555-0100",
    start_date: "2026-12-01",
    end_date: "2027-05-31",
    website_application_id: "42",
    ...overrides,
  };
}

/** A sendAgreementRequest stand-in that records the agreement like the real one. */
function fakeSend(fake: InstanceType<typeof FakeDb>, opts: { fail?: boolean; gate?: Promise<void> } = {}) {
  return vi.fn(async (input: Record<string, unknown>) => {
    if (opts.gate) await opts.gate;
    if (opts.fail) return { ok: false as const, error: "Outlook is down" };
    const id = `req-${fake.rows("agreement_requests").length + 1}`;
    fake.rows("agreement_requests").push({
      id,
      room_id: input.roomId,
      recipient_email: input.recipientEmail,
      created_at: new Date().toISOString(),
    });
    return {
      ok: true as const,
      requestId: id,
      mailbox: "outlook" as const,
      transfer: { status: "skipped" as const, reason: "new tenant (no profile with this email)" },
    };
  });
}

const deps = (send: ReturnType<typeof fakeSend>) => ({
  send,
  now: () => NOW,
  today: () => TODAY,
});

describe("invite lookup (public, keyed)", () => {
  it("returns only the room label, neighborhood and rent for a valid invite", async () => {
    const row = invite();
    const res = await lookupInvite(db([row]).client(), row.token, NOW);
    expect(res.httpStatus).toBe(200);
    expect(res.body).toEqual({
      status: "valid",
      invite: {
        room_label: "Room 3",
        neighborhood: "JSQ",
        monthly_rent: 1850,
        expires_at: row.expires_at,
      },
    });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(STREET);
    expect(json).not.toContain("Summit");
    expect(json).not.toContain(UNIT);
    expect(json).not.toContain("invited@example.com");
  });

  it.each([
    ["expired", { expires_at: new Date(NOW.getTime() - 1000).toISOString() }],
    ["expired", { status: "expired" }],
    ["used", { status: "used" }],
    ["cancelled", { status: "cancelled" }],
  ])("reports %s with a clear status", async (status, overrides) => {
    const row = invite(overrides);
    const res = await lookupInvite(db([row]).client(), row.token, NOW);
    expect(res.httpStatus).toBe(410);
    expect(res.body).toEqual({ status });
  });

  it("404s an unknown or malformed token", async () => {
    const fake = db([invite()]);
    expect((await lookupInvite(fake.client(), newInviteToken(), NOW)).body).toEqual({ status: "not_found" });
    expect((await lookupInvite(fake.client(), "short", NOW)).httpStatus).toBe(404);
  });

  it("treats a sent invite past its expiry as expired", () => {
    expect(effectiveStatus({ status: "sent", expires_at: "2026-11-01T00:00:00.000Z" }, NOW)).toBe("expired");
    expect(effectiveStatus({ status: "sent", expires_at: "2026-12-01T00:00:00.000Z" }, NOW)).toBe("sent");
  });
});

describe("completing an application", () => {
  it("sends the agreement with the invite's terms to the invite email", async () => {
    const row = invite();
    const fake = db([row]);
    const send = fakeSend(fake);
    const res = await completeInvite(
      fake.client(),
      // The applicant can't change rent, deposit or room: extra fields are ignored.
      body(row.token, { rent: "1", security_deposit: "1", room_id: NY_ROOM, property_id: NY_PROPERTY }),
      deps(send),
    );
    expect(res.httpStatus).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: "sent", agreement_request_id: "req-1", email_differs: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      tenantName: "Applicant Typed Name",
      sublessorName: "Vineet Dutta",
      propertyAddress: `${STREET}, Apt ${UNIT}, Jersey City, NJ 07306`,
      roomNumber: "3",
      roomId: ROOM,
      propertyId: PROPERTY,
      rent: "1850",
      securityDeposit: "1850",
      leaseStartDate: "2026-12-01",
      leaseEndDate: "2027-05-31",
      agreementDate: TODAY,
      recipientEmail: "invited@example.com",
      inNewYork: false,
    });
    const stored = fake.rows("application_invites")[0];
    expect(stored).toMatchObject({
      status: "used",
      agreement_request_id: "req-1",
      website_application_id: "42",
      claimed_at: null,
      rent: 1850,
      security_deposit: 1850,
      room_id: ROOM,
    });
    expect(stored.used_at).toBeTruthy();
  });

  it("is idempotent: a repeat call never sends a second agreement", async () => {
    const row = invite();
    const fake = db([row]);
    const send = fakeSend(fake);
    await completeInvite(fake.client(), body(row.token), deps(send));
    const again = await completeInvite(fake.client(), body(row.token), deps(send));
    expect(again.httpStatus).toBe(200);
    expect(again.body).toMatchObject({ ok: true, status: "already_sent", agreement_request_id: "req-1" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends once when two calls race, and the loser is told to retry", async () => {
    const row = invite();
    const fake = db([row]);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const send = fakeSend(fake, { gate });
    const first = completeInvite(fake.client(), body(row.token), deps(send));
    const second = completeInvite(fake.client(), body(row.token), deps(send));
    const loser = await second;
    open();
    const winner = await first;
    expect(winner.body).toMatchObject({ status: "sent" });
    expect(loser.httpStatus).toBe(409);
    expect(loser.body).toMatchObject({ status: "in_progress" });
    expect(send).toHaveBeenCalledTimes(1);
    const retry = await completeInvite(fake.client(), body(row.token), deps(send));
    expect(retry.body).toMatchObject({ status: "already_sent" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses a used invite for a different application", async () => {
    const row = invite({ status: "used", website_application_id: "7", agreement_request_id: "req-9" });
    const fake = db([row]);
    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(row.token, { website_application_id: "42" }), deps(send));
    expect(res.httpStatus).toBe(410);
    expect(res.body).toMatchObject({ status: "used" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", { expires_at: new Date(NOW.getTime() - 1000).toISOString() }],
    ["cancelled", { status: "cancelled" }],
  ])("refuses a %s invite", async (status, overrides) => {
    const row = invite(overrides);
    const fake = db([row]);
    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(row.token), deps(send));
    expect(res.httpStatus).toBe(410);
    expect(res.body).toMatchObject({ status });
    expect(send).not.toHaveBeenCalled();
  });

  it("404s an unknown token", async () => {
    const fake = db([invite()]);
    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(newInviteToken()), deps(send));
    expect(res.httpStatus).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["a start date before today", { start_date: "2026-11-17" }, "invalid_dates"],
    ["an end date on the start date", { end_date: "2026-12-01" }, "invalid_dates"],
    ["an end date before the start", { end_date: "2026-11-30" }, "invalid_dates"],
    ["a date that isn't real", { start_date: "2026-02-30" }, "invalid_request"],
    ["a non-ISO date", { end_date: "05/31/2027" }, "invalid_request"],
    ["a bad email", { email: "nope" }, "invalid_request"],
    ["a missing application id", { website_application_id: "" }, "invalid_request"],
  ])("rejects %s", async (_label, overrides, status) => {
    const row = invite();
    const fake = db([row]);
    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(row.token, overrides), deps(send));
    expect(res.httpStatus).toBe(400);
    expect(res.body).toMatchObject({ ok: false, status });
    expect(send).not.toHaveBeenCalled();
    expect(fake.rows("application_invites")[0]).toMatchObject({ status: "sent", claimed_at: null });
  });

  it("accepts a start date of today", async () => {
    const row = invite();
    const fake = db([row]);
    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(row.token, { start_date: TODAY }), deps(send));
    expect(res.body).toMatchObject({ status: "sent" });
  });

  it("still sends to the invite email when the applicant typed another, and flags it", async () => {
    const row = invite();
    const fake = db([row]);
    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(row.token, { email: "Other@Example.com" }), deps(send));
    expect(res.body).toMatchObject({ status: "sent", email_differs: true });
    expect(send.mock.calls[0][0].recipientEmail).toBe("invited@example.com");
    expect(fake.rows("application_invites")[0].tenant_email).toBe("Other@Example.com");
    const again = await completeInvite(fake.client(), body(row.token, { email: "Other@Example.com" }), deps(send));
    expect(again.body).toMatchObject({ status: "already_sent", email_differs: true });
  });

  it("releases the claim when the send fails, so a retry can send", async () => {
    const row = invite();
    const fake = db([row]);
    const failing = fakeSend(fake, { fail: true });
    const res = await completeInvite(fake.client(), body(row.token), deps(failing));
    expect(res.httpStatus).toBe(502);
    expect(res.body).toMatchObject({ status: "send_failed" });
    expect(fake.rows("application_invites")[0]).toMatchObject({ status: "sent", claimed_at: null });

    const send = fakeSend(fake);
    const retry = await completeInvite(fake.client(), body(row.token), deps(send));
    expect(retry.body).toMatchObject({ status: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("adopts the agreement of a completion that died after sending", async () => {
    const claimedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    const row = invite({ claimed_at: claimedAt });
    const fake = db([row]);
    fake.rows("agreement_requests").push({
      id: "req-earlier",
      room_id: ROOM,
      recipient_email: "INVITED@example.com",
      created_at: new Date(NOW.getTime() - 9 * 60_000).toISOString(),
    });
    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(row.token), deps(send));
    expect(res.body).toMatchObject({ status: "already_sent", agreement_request_id: "req-earlier" });
    expect(send).not.toHaveBeenCalled();
    expect(fake.rows("application_invites")[0]).toMatchObject({ status: "used", agreement_request_id: "req-earlier" });
  });

  it("waits out a fresh claim instead of taking it over", async () => {
    const row = invite({ claimed_at: new Date(NOW.getTime() - 60_000).toISOString() });
    const fake = db([row]);
    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(row.token), deps(send));
    expect(res.httpStatus).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a unit that became New York after the invite went out", async () => {
    const row = invite({ property_id: NY_PROPERTY, room_id: NY_ROOM });
    const fake = db([row]);
    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(row.token), deps(send));
    expect(res.httpStatus).toBe(400);
    expect(res.body).toMatchObject({ error: NY_INVITE_ERROR });
    expect(send).not.toHaveBeenCalled();
    expect(fake.rows("application_invites")[0].claimed_at).toBeNull();
  });
});

describe("creating and cancelling invites", () => {
  const mail = vi.fn();
  beforeEach(() => {
    mail.mockReset();
    mail.mockResolvedValue({ ok: true, id: "msg-1" });
  });

  const input = {
    propertyId: PROPERTY,
    roomId: ROOM,
    applicantEmail: " invited@example.com ",
    applicantName: "Invited Person",
    rent: "$1,850",
    securityDeposit: "1850",
  };

  it("stores the team's terms with a 14-day unguessable token and emails the link", async () => {
    const fake = db();
    const res = await createInvite(fake.client(), input, { mail, now: () => NOW });
    expect(res.ok).toBe(true);
    const [row] = fake.rows("application_invites");
    expect(row).toMatchObject({
      property_id: PROPERTY,
      room_id: ROOM,
      applicant_email: "invited@example.com",
      rent: 1850,
      security_deposit: 1850,
      status: "sent",
      expires_at: new Date(NOW.getTime() + 14 * DAY).toISOString(),
    });
    expect(String(row.token)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.email_sent_at).toBeTruthy();
    if (res.ok) expect(res.url).toBe(`https://hiveny.com/apply-now?invite=${row.token}`);

    expect(mail).toHaveBeenCalledTimes(1);
    const sent = mail.mock.calls[0][0];
    expect(sent.to).toBe("invited@example.com");
    expect(sent.text).toContain(`https://hiveny.com/apply-now?invite=${row.token}`);
    expect(sent.text).toContain("Room 3 in JSQ");
    expect(sent.text).toContain("$1,850");
    expect(sent.text).not.toContain(STREET);
    expect(sent.html).not.toContain(STREET);
  });

  it("refuses New York units with the manual-flow message", async () => {
    const fake = db();
    const res = await createInvite(fake.client(), { ...input, propertyId: NY_PROPERTY, roomId: NY_ROOM }, { mail });
    expect(res).toEqual({ ok: false, error: NY_INVITE_ERROR });
    expect(fake.rows("application_invites")).toHaveLength(0);
    expect(mail).not.toHaveBeenCalled();
  });

  it("refuses a room from another unit", async () => {
    const fake = db();
    const res = await createInvite(fake.client(), { ...input, roomId: NY_ROOM }, { mail });
    expect(res.ok).toBe(false);
    expect(mail).not.toHaveBeenCalled();
  });

  it("refuses bad amounts", async () => {
    const fake = db();
    expect((await createInvite(fake.client(), { ...input, rent: "0" }, { mail })).ok).toBe(false);
    expect((await createInvite(fake.client(), { ...input, securityDeposit: "abc" }, { mail })).ok).toBe(false);
    expect(fake.rows("application_invites")).toHaveLength(0);
  });

  it("removes the invite again when the email fails", async () => {
    mail.mockResolvedValue({ ok: false, error: "Outlook is down" });
    const fake = db();
    const res = await createInvite(fake.client(), input, { mail });
    expect(res.ok).toBe(false);
    expect(fake.rows("application_invites")).toHaveLength(0);
  });

  it("cancels only open invites", async () => {
    const open = invite();
    const used = invite({ id: "66666666-6666-4666-8666-666666666666", status: "used" });
    const fake = db([open, used]);
    expect(await cancelInvite(fake.client(), open.id)).toEqual({ ok: true });
    expect(fake.rows("application_invites")[0]).toMatchObject({ status: "cancelled" });
    expect((await cancelInvite(fake.client(), used.id)).ok).toBe(false);
    expect(fake.rows("application_invites")[1]).toMatchObject({ status: "used" });

    const send = fakeSend(fake);
    const res = await completeInvite(fake.client(), body(open.token), deps(send));
    expect(res.body).toMatchObject({ status: "cancelled" });
    expect(send).not.toHaveBeenCalled();
  });
});
