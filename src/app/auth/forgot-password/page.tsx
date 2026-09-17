"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset, type ForgotPasswordState } from "./actions";

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState<ForgotPasswordState, FormData>(
    requestPasswordReset,
    undefined,
  );

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-md rounded-2xl bg-white p-10 shadow-sm">
        <h1 className="text-3xl tracking-tight text-ink">
          Reset <span className="font-display text-accent-text">password</span>
        </h1>
        <p className="mt-2 text-sm text-muted">
          Enter your email and we&apos;ll send you a link to set a new password.
        </p>

        {state?.success ? (
          <p className="mt-8 text-sm text-ink">{state.success}</p>
        ) : (
          <form action={action} className="mt-8 flex flex-col gap-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Email
              </span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                className="rounded-lg border border-stone bg-white px-3 py-2.5 text-sm text-ink shadow-sm focus:border-accent focus:outline-none"
              />
            </label>

            {state?.error && (
              <p className="text-sm text-red-700">{state.error}</p>
            )}

            <button
              type="submit"
              disabled={pending} aria-busy={pending}
              className="mt-2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
            >
              {pending ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}

        <p className="mt-6 text-sm text-muted">
          <Link href="/login" className="text-accent-text hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
