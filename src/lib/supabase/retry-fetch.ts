/**
 * fetch for the server-side Supabase client that retries READS which failed
 * in transit.
 *
 * A server function that sat idle can hand its first request to a keep-alive
 * socket the other side already closed: the call rejects with "fetch failed"
 * although nothing is wrong with the database, and the very next attempt
 * works. That showed up as pages erroring on the first try after a save.
 *
 * Only GET/HEAD are retried — they are idempotent. A write (POST, PATCH,
 * PUT, DELETE) is never re-sent: a request that failed in transit may still
 * have been applied, and sending it twice could book a payment twice.
 */

const READ_METHODS = new Set(["GET", "HEAD"]);
/** Gateway answers that mean "try again", not "your query is wrong". */
const RETRY_STATUS = new Set([502, 503, 504]);
/** Pause before each extra attempt. */
export const READ_RETRY_DELAYS_MS = [100, 400];

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const fromRequest =
    typeof Request !== "undefined" && input instanceof Request ? input.method : undefined;
  return (init?.method ?? fromRequest ?? "GET").toUpperCase();
}

export function createRetryFetch(
  baseFetch: typeof fetch = fetch,
  delays: readonly number[] = READ_RETRY_DELAYS_MS,
): typeof fetch {
  return async (input, init) => {
    if (!READ_METHODS.has(methodOf(input, init))) return baseFetch(input, init);

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= delays.length;
      try {
        const res = await baseFetch(input, init);
        if (last || !RETRY_STATUS.has(res.status)) return res;
        // Free the socket before trying again.
        await res.body?.cancel().catch(() => {});
      } catch (e) {
        // A caller that gave up (abort/timeout) must not be retried.
        if (last || init?.signal?.aborted) throw e;
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  };
}

export const retryFetch = createRetryFetch();
