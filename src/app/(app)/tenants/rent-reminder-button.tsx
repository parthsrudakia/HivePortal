"use client";

import { useActionState } from "react";
import { sendBalanceReminders, type ReminderState } from "./actions";

export function RentReminderButton({
  outstandingCount,
  lastGeneralText,
  lastBalanceText,
}: {
  outstandingCount: number;
  lastGeneralText: string | null;
  lastBalanceText: string | null;
}) {
  const [state, action, pending] = useActionState<ReminderState, FormData>(
    sendBalanceReminders,
    undefined,
  );

  return (
    <section className="mt-4 rounded-2xl bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">
            Rent balance reminders
          </h2>
          <p className="mt-1 max-w-md text-xs text-muted">
            Emails the {outstandingCount} tenant
            {outstandingCount === 1 ? "" : "s"} who still owe rent this month.
            Run after posting this month&apos;s reconciliation so balances are
            up to date.
          </p>
        </div>
        <form
          action={action}
          onSubmit={(e) => {
            if (
              outstandingCount === 0 ||
              !window.confirm(
                `Send rent balance reminders to ${outstandingCount} tenant${outstandingCount === 1 ? "" : "s"}?`,
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <button
            type="submit"
            disabled={pending || outstandingCount === 0}
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
          >
            {pending
              ? "Sending…"
              : `Send balance reminders${outstandingCount ? ` (${outstandingCount})` : ""}`}
          </button>
        </form>
      </div>

      <div className="mt-3 space-y-1 border-t border-stone/30 pt-3 text-xs text-muted">
        <p>
          General reminder to all tenants — last sent:{" "}
          <span className="text-ink">{lastGeneralText ?? "never"}</span>
        </p>
        <p>
          Balance reminders to tenants with a balance — last sent:{" "}
          <span className="text-ink">{lastBalanceText ?? "never"}</span>
        </p>
      </div>

      {state?.error && (
        <p className="mt-2 text-sm text-red-700">{state.error}</p>
      )}
      {state?.success && (
        <p className="mt-2 text-sm text-accent-text">{state.success}</p>
      )}
    </section>
  );
}
