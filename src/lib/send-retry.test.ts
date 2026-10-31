import { describe, expect, it, vi } from "vitest";
import { createRetryBudget, RetryableFailure, withSendRetry } from "./send-retry";

const transient = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
const permanent = Object.assign(new Error("Invalid recipient"), { code: "EENVELOPE" });
const isRetryable = (e: unknown) => (e as { code?: string }).code === "ETIMEDOUT";

/** A budget big enough to never get in the way, plus a sleep that records instead of waiting. */
function harness(budgetMs = 60_000) {
  const waits: number[] = [];
  return {
    waits,
    budget: createRetryBudget(budgetMs, 300_000),
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("withSendRetry", () => {
  it("retries a transient error, then succeeds", async () => {
    const h = harness();
    const send = vi.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce("250 OK");
    const out = await withSendRetry(send, { isRetryable, ...h });
    expect(out).toEqual({ ok: true, value: "250 OK", attempts: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.waits).toEqual([2_000]);
  });

  it("does not retry a permanent error", async () => {
    const h = harness();
    const send = vi.fn().mockRejectedValue(permanent);
    const out = await withSendRetry(send, { isRetryable, ...h });
    expect(out).toEqual({ ok: false, error: permanent, attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.waits).toEqual([]);
  });

  it("gives up after the last attempt with the last error", async () => {
    const h = harness();
    const send = vi.fn().mockRejectedValue(transient);
    const out = await withSendRetry(send, { isRetryable, ...h });
    expect(out).toEqual({ ok: false, error: transient, attempts: 3 });
    expect(h.waits).toEqual([2_000, 8_000]);
  });

  it("never sends again after a success", async () => {
    const h = harness();
    const send = vi.fn().mockResolvedValue("250 OK");
    const out = await withSendRetry(send, { isRetryable: () => true, ...h });
    expect(out).toEqual({ ok: true, value: "250 OK", attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops without waiting once the budget is used up", async () => {
    // 5s budget: the 2s wait fits, the 8s one doesn't.
    const h = harness(5_000);
    const send = vi.fn().mockRejectedValue(transient);
    const out = await withSendRetry(send, { isRetryable, ...h });
    expect(out).toMatchObject({ ok: false, attempts: 2 });
    expect(h.waits).toEqual([2_000]);

    // The budget is shared, so the next email in the same request fails fast.
    const next = vi.fn().mockRejectedValue(transient);
    const out2 = await withSendRetry(next, { isRetryable, ...h });
    expect(out2).toMatchObject({ ok: false, attempts: 2 });
    expect(next).toHaveBeenCalledTimes(2);
    expect(h.waits).toEqual([2_000, 2_000]);

    const third = vi.fn().mockRejectedValue(transient);
    const out3 = await withSendRetry(third, { isRetryable, ...h });
    expect(out3).toMatchObject({ ok: false, attempts: 1 });
    expect(h.waits).toEqual([2_000, 2_000]);
  });

  it("uses a RetryableFailure's Retry-After instead of the backoff", async () => {
    const h = harness();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new RetryableFailure({ status: 429 }, 5_000))
      .mockResolvedValueOnce("ok");
    const out = await withSendRetry(send, { isRetryable: () => true, ...h });
    expect(out).toMatchObject({ ok: true, attempts: 2 });
    expect(h.waits).toEqual([5_000]);
  });

  it("does not resend when the pre-retry check says the message already left", async () => {
    const h = harness();
    const send = vi.fn().mockRejectedValue(transient);
    const beforeRetry = vi.fn().mockResolvedValue(false);
    const out = await withSendRetry(send, { isRetryable, beforeRetry, ...h });
    expect(out).toMatchObject({ ok: false, attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(beforeRetry).toHaveBeenCalledWith(transient);
  });
});

describe("createRetryBudget", () => {
  it("frees waiting again once it falls outside the window", () => {
    let now = 0;
    const budget = createRetryBudget(10_000, 300_000, () => now);
    expect(budget.reserve(8_000)).toBe(true);
    expect(budget.reserve(8_000)).toBe(false); // would be 16s in one window
    expect(budget.reserve(2_000)).toBe(true);
    now = 299_999;
    expect(budget.reserve(1)).toBe(false); // still inside the first 5 minutes
    now = 300_000;
    expect(budget.reserve(8_000)).toBe(true);
  });
});
