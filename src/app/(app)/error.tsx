"use client";

// Error boundary for the authenticated portal. Ledger reads throw instead of
// degrading to empty data (see LedgerDataError in @/lib/rent-data), so this
// is what an operator sees when a balance could not be computed from a
// complete picture — never a wrong number. Production strips server error
// messages, so the copy stays generic and offers a retry.

import { useEffect } from "react";
import Link from "next/link";

export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-2xl py-16">
      <div className="rounded-2xl bg-white px-8 py-10 shadow-sm">
        <p className="text-xs uppercase tracking-wide text-muted">
          Couldn&rsquo;t load this page
        </p>
        <h1 className="mt-2 text-2xl tracking-tight text-ink">
          The data behind this page didn&rsquo;t come back{" "}
          <span className="font-display italic text-accent-text">
            complete
          </span>
        </h1>
        <p className="mt-3 text-sm text-muted">
          Nothing was shown from a partial picture: balances, charges, and
          payments only render when every record loads. This is usually a
          brief database hiccup — try again in a moment.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-xs text-muted">
            Reference {error.digest}
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-dark"
          >
            Try again
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
