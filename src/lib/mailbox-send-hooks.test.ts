import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ report: vi.fn(), sendMail: vi.fn() }));
vi.mock("./mailbox-health", () => ({ reportMailboxAuthFailure: mocks.report }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mocks.sendMail }) },
}));

import { sendGmailMessage } from "./google-mail";
import { sendOutlookMessage } from "./graph-mail";

const message = { to: "tenant@example.com", subject: "Lease", text: "Hi" };
const smtpError = (text: string, props: Record<string, unknown>) =>
  Object.assign(new Error(text), props);
const REFUSED = smtpError(
  "Invalid login: 535-5.7.8 Username and Password not accepted.",
  { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" },
);
const tokenResponse = (status: number, body: object) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  process.env.GMAIL_USER = "ny@example.com";
  process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
  process.env.MS_CLIENT_ID = "client";
  process.env.MS_CLIENT_SECRET = "secret";
  process.env.MS_TENANT_ID = "tenant";
  process.env.MS_REFRESH_TOKEN = "refresh";
  mocks.report.mockReset().mockResolvedValue(undefined);
  mocks.sendMail.mockReset();
  vi.unstubAllGlobals();
});

describe("Gmail send", () => {
  it("reports a refused login and returns the failure unchanged", async () => {
    mocks.sendMail.mockRejectedValue(REFUSED);
    expect(await sendGmailMessage(message)).toEqual({ ok: false, error: REFUSED.message });
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith("gmail");
  });

  it("doesn't report failures that aren't about the login", async () => {
    mocks.sendMail.mockRejectedValue(smtpError("Connection reset", { code: "ECONNRESET" }));
    expect(await sendGmailMessage(message)).toMatchObject({ ok: false });
    mocks.sendMail.mockReset().mockResolvedValue({ rejected: ["tenant@example.com"], messageId: "<m1>" });
    expect(await sendGmailMessage(message)).toMatchObject({ ok: false });
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it("returns the same result even if the reporter throws", async () => {
    mocks.sendMail.mockRejectedValue(REFUSED);
    mocks.report.mockRejectedValue(new Error("reporter blew up"));
    expect(await sendGmailMessage(message)).toEqual({ ok: false, error: REFUSED.message });
  });
});

describe("Outlook send", () => {
  it("reports a rejected sign-in (invalid_grant) and returns the failure unchanged", async () => {
    vi.stubGlobal("fetch", tokenResponse(400, { error: "invalid_grant" }));
    const result = await sendOutlookMessage(message);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok || result.error).toMatch(/^Outlook token refresh failed \(400\)/);
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith("outlook");
  });

  it("reports a rejected client secret (401)", async () => {
    vi.stubGlobal("fetch", tokenResponse(401, { error: "invalid_client" }));
    await sendOutlookMessage(message);
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith("outlook");
  });

  it("doesn't report a Microsoft outage", async () => {
    vi.stubGlobal("fetch", tokenResponse(500, { error: "server_error" }));
    expect(await sendOutlookMessage(message)).toMatchObject({ ok: false });
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it("returns the same result even if the reporter throws", async () => {
    vi.stubGlobal("fetch", tokenResponse(400, { error: "invalid_grant" }));
    const expected = await sendOutlookMessage(message);
    mocks.report.mockRejectedValue(new Error("reporter blew up"));
    expect(await sendOutlookMessage(message)).toEqual(expected);
  });
});
