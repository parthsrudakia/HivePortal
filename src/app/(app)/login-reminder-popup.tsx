"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { dismissLoginReminders } from "./reminder-actions";

export type LoginReminder = { id: string; message: string };

/**
 * Blocking one-time reminder popup, rendered by LoginRemindersSlot only
 * when the signed-in user has due, undismissed reminders. "Got it"
 * dismisses everything shown; until then it reappears on every load.
 */
export function LoginReminderPopup({
  reminders,
}: {
  reminders: LoginReminder[];
}) {
  const [open, setOpen] = useState(true);
  const [pending, startTransition] = useTransition();
  if (!open || reminders.length === 0) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Reminder"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent-text">
          Reminder
        </p>
        <ul className="mt-3 space-y-3">
          {reminders.map((r) => (
            <li key={r.id} className="text-sm leading-relaxed text-ink">
              {r.message}
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={pending} aria-busy={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await dismissLoginReminders(
                  reminders.map((r) => r.id),
                );
                if (res?.error) {
                  toast.error(res.error);
                  return;
                }
                setOpen(false);
              })
            }
            className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:opacity-60"
          >
            {pending ? "Dismissing…" : "Got it"}
          </button>
        </div>
      </div>
    </div>
  );
}
