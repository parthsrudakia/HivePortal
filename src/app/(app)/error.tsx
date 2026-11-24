"use client";

// Error boundary for the authenticated portal. It tells three situations
// apart, because they need different things from the operator:
//
//  1. The portal was redeployed while this tab was open, so the action the
//     tab tried to call no longer exists. Reload once to pick up the new
//     build — nothing is wrong with the data.
//  2. A ledger read failed (LedgerDataError in @/lib/rent-data, recognised by
//     its digest). Balances are never shown from a partial picture, so the
//     page refuses to render; the reference names the read that failed.
//  3. Anything else: a plain error with a retry.
//
// Production strips server error messages, so (2) is recognised by digest;
// (1) is thrown in the browser, where the message survives.

import { useEffect } from "react";
import Link from "next/link";

const LEDGER_DIGEST_PREFIX = "LEDGER_DATA:";
const STALE_BUILD =
  /Failed to find Server Action|was not found on the server|older or newer deployment/i;
const RELOAD_KEY = "hive:stale-build-reload";
/** Never auto-reload twice within this window — it must not loop. */
const RELOAD_GUARD_MS = 60_000;

export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const staleBuild = STALE_BUILD.test(error.message ?? "");
  const ledger = (error.digest ?? "").startsWith(LEDGER_DIGEST_PREFIX);

  useEffect(() => {
    console.error(error);
    if (!staleBuild) return;
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
      if (Date.now() - last < RELOAD_GUARD_MS) return;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
      // No session storage: leave the manual button instead of risking a loop.
      return;
    }
    window.location.reload();
  }, [error, staleBuild]);

  const eyebrow = staleBuild
    ? "The portal was updated"
    : ledger
      ? "Couldn’t load this page"
      : "Something went wrong";

  return (
    <div className="mx-auto w-full max-w-2xl py-16">
      <div className="rounded-2xl bg-white px-8 py-10 shadow-sm">
        <p className="text-xs uppercase tracking-wide text-muted">{eyebrow}</p>
        {staleBuild ? (
          <>
            <h1 className="mt-2 text-2xl tracking-tight text-ink">
              This tab was open from before the latest{" "}
              <span className="font-display italic text-accent-text">update</span>
            </h1>
            <p className="mt-3 text-sm text-muted">
              The page reloads itself to pick up the new version. Your last
              change was not saved — once it has reloaded, please make it
              again.
            </p>
          </>
        ) : ledger ? (
          <>
            <h1 className="mt-2 text-2xl tracking-tight text-ink">
              The data behind this page didn&rsquo;t come back{" "}
              <span className="font-display italic text-accent-text">
                complete
              </span>
            </h1>
            <p className="mt-3 text-sm text-muted">
              Nothing was shown from a partial picture: balances, charges, and
              payments only render when every record loads. The read was
              already retried — try again in a moment.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-2xl tracking-tight text-ink">
              This page ran into a{" "}
              <span className="font-display italic text-accent-text">problem</span>
            </h1>
            <p className="mt-3 text-sm text-muted">
              It isn&rsquo;t a data problem — the page itself failed. Try
              again; if it keeps happening, pass on the reference below.
            </p>
          </>
        )}
        {error.digest && (
          <p className="mt-3 font-mono text-xs text-muted">
            Reference {error.digest}
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() =>
              staleBuild ? window.location.reload() : unstable_retry()
            }
            className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-dark"
          >
            {staleBuild ? "Reload" : "Try again"}
          </button>
          <Link
            href="/"
            className="rounded-full border border-ink px-5 py-2 text-sm font-medium text-ink transition hover:bg-warm"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
