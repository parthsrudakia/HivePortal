"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelMoveOut, deleteListing } from "./actions";

/**
 * Red bin that removes a room's listing from Inventory. Clicking it opens a
 * prompt asking *why*:
 *  - "Cancel move-out" — the outgoing tenant is staying; clears the scheduled
 *    move-out so the room returns to occupied (only offered when a tenancy is
 *    actually scheduled to move out).
 *  - "Add a new tenant" — the room needs a replacement; queues it on the Add
 *    Tenant page to be filled in.
 */
export function DeleteListingButton({
  roomId,
  label,
  tenancyId,
}: {
  roomId: string;
  label: string;
  tenancyId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onCancelMoveOut() {
    if (!tenancyId) return;
    startTransition(async () => {
      await cancelMoveOut(tenancyId, roomId);
      setOpen(false);
      router.refresh();
    });
  }

  function onAddTenant() {
    startTransition(async () => {
      await deleteListing(roomId);
      setOpen(false);
      router.push(`/tenants/new?room_id=${roomId}`);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending}
        aria-label="Remove listing"
        title="Remove listing"
        className="rounded-md p-1.5 text-red-600 transition hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={() => !pending && setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-white p-6 text-left shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-ink">Remove listing</h2>
            <p className="mt-1 text-sm text-muted">
              Why is <span className="font-medium text-ink">{label}</span> coming
              off Inventory?
            </p>

            <div className="mt-5 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={onCancelMoveOut}
                disabled={pending || !tenancyId}
                className="rounded-lg border border-stone bg-white px-4 py-2.5 text-left text-sm font-medium text-ink transition hover:bg-warm disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel move-out
                <span className="mt-0.5 block text-xs font-normal text-muted">
                  {tenancyId
                    ? "The tenant is staying — clear the scheduled move-out."
                    : "No scheduled move-out on this room."}
                </span>
              </button>

              <button
                type="button"
                onClick={onAddTenant}
                disabled={pending}
                className="rounded-lg bg-ink px-4 py-2.5 text-left text-sm font-medium text-white transition hover:bg-accent-dark disabled:opacity-50"
              >
                Add a new tenant
                <span className="mt-0.5 block text-xs font-normal text-white/70">
                  Queue it on the Add Tenant page to be filled in.
                </span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="mt-4 w-full rounded-lg px-4 py-2 text-sm text-muted transition hover:text-ink disabled:opacity-50"
            >
              Never mind
            </button>
          </div>
        </div>
      )}
    </>
  );
}
