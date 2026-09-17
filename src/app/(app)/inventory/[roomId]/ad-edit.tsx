"use client";

import { useActionState, useTransition } from "react";
import { setRoomAd, deleteRoomAd, type AdFormState } from "../actions";
import type { AdRow } from "../constants";

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

export function AdEdit({ roomId, ads }: { roomId: string; ads: AdRow[] }) {
  const bound = setRoomAd.bind(null, roomId) as (
    state: AdFormState,
    formData: FormData,
  ) => Promise<AdFormState>;
  const [state, action, pending] = useActionState<AdFormState, FormData>(
    bound,
    undefined,
  );
  const [removing, startRemove] = useTransition();

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
        Ad posts
      </h2>

      {ads.length > 0 ? (
        <ul className={`mt-3 space-y-2 ${removing ? "opacity-60" : ""}`}>
          {ads.map((ad) => (
            <li key={ad.id} className="flex items-center gap-3 text-sm">
              <a
                href={ad.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-700 underline hover:text-purple-900"
              >
                Open
              </a>
              <span className="min-w-0 flex-1 truncate text-muted">
                {ad.posted_by?.trim() || "—"}
              </span>
              <button
                type="button"
                onClick={() =>
                  startRemove(async () => {
                    await deleteRoomAd(ad.id, roomId);
                  })
                }
                className="rounded-full px-2 py-0.5 text-xs uppercase tracking-wide text-muted hover:bg-warm hover:text-red-700"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">No ads posted yet.</p>
      )}

      <form
        action={action}
        className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
      >
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Add ad URL</span>
          <input
            type="url"
            name="ad_url"
            placeholder="https://www.facebook.com/marketplace/item/…"
            className={fieldInput}
          />
        </label>
        <button
          type="submit"
          disabled={pending} aria-busy={pending}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </form>
      {state?.error && <p className="mt-3 text-sm text-red-700">{state.error}</p>}
    </div>
  );
}
