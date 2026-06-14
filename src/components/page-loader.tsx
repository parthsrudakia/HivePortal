/**
 * Brand-aligned skeleton shown instantly on every in-app navigation (via the
 * shared `(app)/loading.tsx` Suspense boundary) while the server page streams
 * in. Mirrors the common page shape — header, a row of stat cards, and a table
 * block — so it reads as the real screen warming up rather than a blank wait.
 *
 * Uses Tailwind's built-in `animate-pulse` and the cream/warm palette so it
 * blends with the surrounding shell.
 */
export function PageLoader() {
  return (
    <div
      className="mx-auto w-full max-w-6xl animate-pulse"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {/* Header: title + subtitle, with a primary-action chip on the right. */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/40 pb-6">
        <div className="space-y-3">
          <div className="h-7 w-56 rounded-lg bg-warm" />
          <div className="h-3 w-72 max-w-full rounded bg-warm/70" />
        </div>
        <div className="h-9 w-28 rounded-full bg-warm" />
      </div>

      {/* Stat cards. */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="h-3 w-24 rounded bg-warm/70" />
            <div className="mt-3 h-7 w-20 rounded-lg bg-warm" />
          </div>
        ))}
      </div>

      {/* Table / list block. */}
      <div className="mt-6 overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="h-11 bg-warm/40" />
        <div className="divide-y divide-stone/20">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <div className="h-4 flex-1 rounded bg-warm/80" />
              <div className="hidden h-4 w-24 rounded bg-warm/60 sm:block" />
              <div className="h-4 w-16 rounded bg-warm/60" />
              <div className="h-4 w-16 rounded bg-warm/60" />
            </div>
          ))}
        </div>
      </div>

      <span className="sr-only">Loading…</span>
    </div>
  );
}
