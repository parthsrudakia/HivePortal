/**
 * Bounded retries for the single step that hands an email to its provider
 * (Gmail SMTP, Graph /send, Resend POST /emails). Callers decide what is safe
 * to retry: a retry must never follow an attempt the provider may have
 * accepted, or the recipient gets the email twice.
 *
 * Waiting is capped by a shared retry budget so a cron loop that sends many
 * emails (balance reminders, the queue flush) can't wait its way past the
 * function timeout: once the budget is spent, failures return immediately.
 */

export type RetryBudget = {
  /** Claims `ms` of waiting; false (and nothing claimed) when that would exceed the budget. */
  reserve(ms: number): boolean;
};

/**
 * At most `maxWaitMs` of retry waiting within any `windowMs` span. With the
 * window at least as long as the longest request, that caps every request.
 */
export function createRetryBudget(
  maxWaitMs: number,
  windowMs: number,
  now: () => number = Date.now,
): RetryBudget {
  const waits: { at: number; ms: number }[] = [];
  return {
    reserve(ms) {
      const t = now();
      while (waits.length > 0 && waits[0].at <= t - windowMs) waits.shift();
      const used = waits.reduce((sum, w) => sum + w.ms, 0);
      if (used + ms > maxWaitMs) return false;
      waits.push({ at: t, ms });
      return true;
    },
  };
}

// 15s of retry waiting per 5 minutes per server instance. No function in this
// app runs longer than 300s (the longest maxDuration, and Vercel's default),
// so no single request can wait more than 15s, without threading a budget
// through every route and server action. Concurrent requests on one instance
// share it, which only makes each of them stricter.
export const sendRetryBudget = createRetryBudget(15_000, 300_000);

/**
 * Thrown inside an attempt to retry a failure the provider *returned* rather
 * than threw (an HTTP status, a Resend error object). `result` carries it out
 * if the retries run out; `retryAfterMs` overrides the backoff delay.
 */
export class RetryableFailure<T = unknown> extends Error {
  constructor(
    readonly result: T,
    readonly retryAfterMs?: number,
  ) {
    super("Retryable send failure");
  }
}

export type RetryOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; attempts: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` until it resolves, up to `attempts` times. A thrown error is
 * retried only if `isRetryable` says so, the budget covers the wait, and
 * `beforeRetry` (run after the wait) agrees. Never throws: the last error
 * comes back in the outcome, with how many attempts were made.
 */
export async function withSendRetry<T>(
  fn: () => Promise<T>,
  opts: {
    isRetryable: (error: unknown) => boolean;
    attempts?: number;
    /** Wait before retry 1, 2, …; the last entry repeats. */
    delaysMs?: number[];
    /** Last check before resending, e.g. "is the draft still unsent?". */
    beforeRetry?: (error: unknown) => Promise<boolean>;
    budget?: RetryBudget;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<RetryOutcome<T>> {
  const attempts = opts.attempts ?? 3;
  const delaysMs = opts.delaysMs ?? [2_000, 8_000];
  const budget = opts.budget ?? sendRetryBudget;
  const wait = opts.sleep ?? sleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, value: await fn(), attempts: attempt };
    } catch (error) {
      if (attempt >= attempts || !opts.isRetryable(error)) {
        return { ok: false, error, attempts: attempt };
      }
      const delay =
        error instanceof RetryableFailure && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
      if (!budget.reserve(delay)) return { ok: false, error, attempts: attempt };
      await wait(delay);
      if (opts.beforeRetry && !(await opts.beforeRetry(error))) {
        return { ok: false, error, attempts: attempt };
      }
    }
  }
}
