import { beforeEach, describe, expect, it, vi } from "vitest";

const resend = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resend.send };
  },
}));
vi.mock("./email-log", () => ({ logEmail: vi.fn() }));

// Same retry decisions, minus the real waits and the shared budget.
vi.mock("./send-retry", async (importOriginal) => {
  const real = await importOriginal<typeof import("./send-retry")>();
  return {
    ...real,
    withSendRetry: <T>(fn: () => Promise<T>, opts: Parameters<typeof real.withSendRetry>[1]) =>
      real.withSendRetry(fn, { ...opts, budget: { reserve: () => true }, sleep: async () => {} }),
  };
});

import { logEmail } from "./email-log";
import { sendViaResend } from "./resend-quota";

const FROM = "Hive <hello@example.com>";
const sent = (id: string) => ({ data: { id }, error: null, headers: null });
const failed = (name: string, statusCode: number | null) => ({
  data: null,
  error: { name, statusCode, message: name },
  headers: null,
});
const dispatch = () =>
  sendViaResend(
    { to: "tenant@example.com", from: FROM, subject: "Rent", text: "Hi" },
    { type: "rent_balance", context: "October 2026" },
  );

beforeEach(() => {
  // No service-role env: sendViaResend skips the quota check and dispatches.
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM = FROM;
  resend.send.mockReset();
  vi.mocked(logEmail).mockReset();
});

describe("Resend dispatch retries", () => {
  it("retries a 5xx with the same idempotency key, and logs one row", async () => {
    resend.send
      .mockResolvedValueOnce(failed("internal_server_error", 500))
      .mockResolvedValueOnce(sent("email-1"));
    expect(await dispatch()).toEqual({ ok: true, id: "email-1" });
    expect(resend.send).toHaveBeenCalledTimes(2);
    const keys = resend.send.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
    expect(logEmail).toHaveBeenCalledTimes(1);
    expect(logEmail).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent", resend_id: "email-1", attempts: 2 }),
    );
  });

  it("retries a network failure and rate limiting", async () => {
    resend.send
      .mockResolvedValueOnce(failed("application_error", null))
      .mockResolvedValueOnce(failed("rate_limit_exceeded", 429))
      .mockResolvedValueOnce(sent("email-2"));
    expect(await dispatch()).toEqual({ ok: true, id: "email-2" });
    expect(resend.send).toHaveBeenCalledTimes(3);
  });

  it("never retries a 4xx validation error", async () => {
    resend.send.mockResolvedValue(failed("validation_error", 422));
    expect(await dispatch()).toEqual({ ok: false, error: "validation_error" });
    expect(resend.send).toHaveBeenCalledTimes(1);
    expect(logEmail).toHaveBeenCalledTimes(1);
    expect(logEmail).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", attempts: 1 }),
    );
  });

  it("does not retry a daily quota 429", async () => {
    resend.send.mockResolvedValue(failed("daily_quota_exceeded", 429));
    expect(await dispatch()).toMatchObject({ ok: false });
    expect(resend.send).toHaveBeenCalledTimes(1);
  });

  it("logs the final failure once after the retries run out", async () => {
    resend.send.mockResolvedValue(failed("internal_server_error", 503));
    expect(await dispatch()).toEqual({ ok: false, error: "internal_server_error" });
    expect(resend.send).toHaveBeenCalledTimes(3);
    expect(logEmail).toHaveBeenCalledTimes(1);
    expect(logEmail).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", attempts: 3 }),
    );
  });
});
