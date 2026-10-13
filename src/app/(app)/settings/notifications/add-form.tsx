"use client";

import { useActionState, useEffect, useRef } from "react";
import { addRecipient, type RecipientFormState } from "./actions";

export function AddRecipientForm({
  users,
}: {
  users: { email: string; name: string | null }[];
}) {
  const [state, action, pending] = useActionState<RecipientFormState, FormData>(
    addRecipient,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (submittedRef.current && !pending && !state?.error) {
      formRef.current?.reset();
    }
    submittedRef.current = pending;
  }, [pending, state]);

  if (users.length === 0) {
    return (
      <p className="text-sm text-muted">
        Everyone with a portal account is already a recipient. Invite more people
        from{" "}
        <a href="/settings/users" className="text-accent-text underline">
          Users
        </a>{" "}
        to add them here.
      </p>
    );
  }

  return (
    <form
      ref={formRef}
      action={action}
      className="flex flex-wrap items-end gap-3"
    >
      <label className="flex flex-1 min-w-[200px] flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-muted">
          Portal user
        </span>
        <select
          name="email"
          required
          defaultValue=""
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        >
          <option value="" disabled>
            Select a user…
          </option>
          {users.map((u) => (
            <option key={u.email} value={u.email}>
              {u.name ? `${u.name} — ${u.email}` : u.email}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-1 min-w-[160px] flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-muted">
          Name <span className="normal-case">(optional)</span>
        </span>
        <input
          type="text"
          name="label"
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          placeholder="Defaults to their profile name"
        />
      </label>
      <button
        type="submit"
        disabled={pending} aria-busy={pending}
        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add recipient"}
      </button>
      {state?.error && (
        <p className="basis-full text-sm text-red-700">{state.error}</p>
      )}
    </form>
  );
}
