"use client";

import { useActionState, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useHydrated } from "@/lib/use-hydrated";
import { setDisplayName, type NameFormState } from "./profile-actions";

/**
 * Blocking prompt shown to signed-in users who have not yet set a display
 * name. There is intentionally no dismiss/cancel — a name is required.
 * Mounted in the app layout; renders nothing once a name exists.
 */
export function NamePrompt() {
  const router = useRouter();
  const mounted = useHydrated();
  const [done, setDone] = useState(false);
  const [state, action, pending] = useActionState<NameFormState, FormData>(
    async (prev, formData) => {
      const result = await setDisplayName(prev, formData);
      if (result?.success) {
        setDone(true);
        router.refresh();
      }
      return result;
    },
    undefined,
  );

  if (!mounted || done) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="name-prompt-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <div className="absolute inset-0 bg-ink/40" />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3
          id="name-prompt-title"
          className="text-lg tracking-tight text-ink"
        >
          What&rsquo;s your <span className="font-display text-accent-text">name</span>?
        </h3>
        <p className="mt-2 text-sm text-muted">
          Add your name so teammates know who&rsquo;s who across the portal.
        </p>
        <form action={action} className="mt-5 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">
              Full name
            </span>
            <input
              type="text"
              name="name"
              autoFocus
              required
              minLength={2}
              maxLength={80}
              autoComplete="name"
              placeholder="e.g. Jordan Mehta"
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <div className="flex items-center justify-end gap-3 pt-1">
            {state?.error && (
              <p className="mr-auto text-sm text-red-700">{state.error}</p>
            )}
            <button
              type="submit"
              disabled={pending} aria-busy={pending}
              className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save name"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
