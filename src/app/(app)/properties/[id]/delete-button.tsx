"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { deleteProperty } from "../actions";
import { useHydrated } from "@/lib/use-hydrated";

export type ActiveTenantForDelete = {
  tenancyId: string;
  name: string;
  roomNumber: string | null;
  startDate: string;
  moveOutDate: string | null;
};

type Props = {
  id: string;
  label: string;
  activeTenants: ActiveTenantForDelete[];
};

/** Delete-property confirm dialog. When the property still has active
 *  tenants, it requires a move-out date for each before submitting — the
 *  server then either winds the tenancies down (tenant still here / payment
 *  history) or deletes the property outright. */
export function DeletePropertyButton({ id, label, activeTenants }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      activeTenants.map((t) => [t.tenancyId, t.moveOutDate ?? ""]),
    ),
  );
  const mounted = useHydrated();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleConfirm() {
    if (activeTenants.some((t) => !dates[t.tenancyId])) {
      setError("Enter a move-out date for every tenant.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("id", id);
      for (const t of activeTenants) {
        fd.set(`moveout_${t.tenancyId}`, dates[t.tenancyId]);
      }
      const result = await deleteProperty(fd);
      if (result?.error) {
        setError(result.error);
      } else if (result?.notice) {
        toast.success(result.notice);
        setOpen(false);
      }
      // No result → the server deleted the property and redirected.
    } finally {
      setBusy(false);
    }
  }

  const modal =
    open && mounted
      ? createPortal(
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
          >
            <div
              className="absolute inset-0 bg-ink/40"
              onClick={() => !busy && setOpen(false)}
            />
            <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
              <h3 className="text-lg tracking-tight text-ink">
                Delete this property?
              </h3>
              <div className="mt-2 text-sm text-muted">
                <strong>{label}</strong> will be removed from the portfolio.
                If any rent was ever collected here, the property is retired
                instead of erased: it leaves the Rent Tracker once the last
                tenant is out, and its full history stays on the Past Tenants
                page (restorable). Only a property where no money ever moved
                is permanently deleted.
              </div>

              {activeTenants.length > 0 && (
                <div className="mt-4 rounded-xl bg-warm p-4">
                  <p className="text-sm text-ink">
                    {activeTenants.length === 1
                      ? "One tenant still lives here."
                      : `${activeTenants.length} tenants still live here.`}{" "}
                    Enter each tenant&apos;s last day. If a date is today or
                    later, the property is kept until they&apos;ve moved out.
                  </p>
                  <div className="mt-3 space-y-3">
                    {activeTenants.map((t) => (
                      <label
                        key={t.tenancyId}
                        className="flex items-center justify-between gap-3 text-sm text-ink"
                      >
                        <span>
                          {t.name}
                          {t.roomNumber ? (
                            <span className="text-muted"> — {t.roomNumber}</span>
                          ) : null}
                        </span>
                        <input
                          type="date"
                          value={dates[t.tenancyId] ?? ""}
                          min={t.startDate}
                          onChange={(e) =>
                            setDates((d) => ({
                              ...d,
                              [t.tenancyId]: e.target.value,
                            }))
                          }
                          className="rounded-lg border border-stone bg-white px-2 py-1 text-sm text-ink"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => !busy && setOpen(false)}
                  className="rounded-full px-3 py-1.5 text-sm text-muted hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={busy} aria-busy={busy}
                  className="rounded-full bg-red-700 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-red-800 disabled:opacity-50"
                >
                  {busy ? "Working…" : "Yes, delete"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="rounded-full border border-red-200 bg-white px-4 py-2 text-sm text-red-700 transition hover:border-red-300 hover:bg-red-50"
      >
        Delete
      </button>
      {modal}
    </>
  );
}
