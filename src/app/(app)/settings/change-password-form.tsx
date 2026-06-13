"use client";

import { useActionState, useEffect, useRef } from "react";
import { changePassword, type PasswordFormState } from "./actions";

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<PasswordFormState, FormData>(
    changePassword,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (submittedRef.current && !pending && state?.success) {
      formRef.current?.reset();
    }
    submittedRef.current = pending;
  }, [pending, state]);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Current password
        </span>
        <input
          type="password"
          name="current_password"
          autoComplete="current-password"
          required
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          New password
        </span>
        <input
          type="password"
          name="new_password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="At least 8 characters"
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Confirm new password
        </span>
        <input
          type="password"
          name="confirm_password"
          autoComplete="new-password"
          required
          minLength={8}
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />
      </label>
      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Updating…" : "Update password"}
        </button>
        {state?.error && (
          <p className="text-sm text-red-700">{state.error}</p>
        )}
        {state?.success && (
          <p className="text-sm text-accent-text">{state.success}</p>
        )}
      </div>
    </form>
  );
}
