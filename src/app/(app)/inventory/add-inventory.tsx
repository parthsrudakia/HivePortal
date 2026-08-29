"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useHydrated } from "@/lib/use-hydrated";
import { makeRoomAvailable } from "./actions";
import { endTenancy, cancelUpcomingTenancy } from "../tenants/actions";

export type AddableRoom = {
  id: string;
  label: string;
  status: "occupied" | "available" | "reserved" | "maintenance";
  tenancyId: string | null;
  tenantId: string | null;
  tenantName: string | null;
  upcomingTenantName: string | null;
  upcomingStart: string | null;
};

const STATUS_LABEL: Record<AddableRoom["status"], string> = {
  occupied: "Occupied",
  available: "Available",
  reserved: "Reserved",
  maintenance: "Maintenance",
};

export function AddInventory({
  rooms,
  today,
}: {
  rooms: AddableRoom[];
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const mounted = useHydrated();
  const [roomId, setRoomId] = useState("");
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [date, setDate] = useState("");
  const [cancelMoveIn, setCancelMoveIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selected = rooms.find((r) => r.id === roomId) ?? null;
  // A "filled" room we must vacate before it can be listed.
  const occupied = selected?.status === "occupied" && !!selected.tenancyId;
  // A room already promised to a future tenant — listing it needs a warning.
  const upcoming = selected?.upcomingStart
    ? { name: selected.upcomingTenantName, start: selected.upcomingStart }
    : null;

  const q = query.trim().toLowerCase();
  const matches = q
    ? rooms.filter((r) =>
        `${r.label} ${r.tenantName ?? ""} ${r.upcomingTenantName ?? ""} ${STATUS_LABEL[r.status]}`
          .toLowerCase()
          .includes(q),
      )
    : rooms;

  function reset() {
    setRoomId("");
    setQuery("");
    setListOpen(false);
    setDate("");
    setCancelMoveIn(false);
    setError(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  function pickRoom(id: string) {
    setRoomId(id);
    setError(null);
    setCancelMoveIn(false);
    const r = rooms.find((x) => x.id === id);
    setQuery(r?.label ?? "");
    setListOpen(false);
    // Default a move-out date to today for occupied rooms; leave blank
    // (available now) for everything else.
    setDate(r?.status === "occupied" && r.tenancyId ? today : "");
  }

  function submit() {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      if (occupied) {
        if (!date) {
          setError("Pick a move-out date.");
          return;
        }
        const fd = new FormData();
        fd.set("tenancy_id", selected.tenancyId ?? "");
        fd.set("tenant_id", selected.tenantId ?? "");
        fd.set("move_out_date", date);
        await endTenancy(fd);
      } else if (upcoming && cancelMoveIn) {
        const res = await cancelUpcomingTenancy(selected.id, date || null);
        if ("error" in res) {
          setError(res.error);
          return;
        }
      } else {
        // listAnyway only once the operator has seen the warning box for the
        // upcoming move-in; on stale page data the server bounces it back.
        const res = await makeRoomAvailable(selected.id, date || null, {
          listAnyway: !!upcoming,
        });
        if (res && "error" in res) {
          setError(res.error);
          return;
        }
        if (res && "upcoming" in res) {
          setError(
            `${res.upcoming.tenantName ?? "A tenant"} is scheduled to move into this room on ${res.upcoming.startDate}. Refresh the page and try again.`,
          );
          return;
        }
      }
      close();
      router.refresh();
    });
  }

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
    >
      + Add
    </button>
  );

  if (!open || !mounted) return trigger;

  return (
    <>
      {trigger}
      {createPortal(
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
        >
          <div
            className="absolute inset-0 bg-ink/40"
            onClick={() => !pending && close()}
          />
          <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg tracking-tight text-ink">
              Add to <span className="font-display text-accent-text">inventory</span>
            </h3>
            <p className="mt-1 text-sm text-muted">
              Pick a room that isn&rsquo;t listed yet.
            </p>

            {rooms.length === 0 ? (
              <p className="mt-5 rounded-lg bg-warm/50 px-3 py-4 text-center text-sm text-muted">
                Every room is already in the inventory.
              </p>
            ) : (
              <div className="mt-5 flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted">
                    Room
                  </span>
                  <div className="relative">
                    <input
                      type="text"
                      value={query}
                      placeholder="Search rooms…"
                      autoComplete="off"
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setRoomId("");
                        setError(null);
                        setListOpen(true);
                      }}
                      onFocus={() => setListOpen(true)}
                      onBlur={() => setTimeout(() => setListOpen(false), 120)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setListOpen(false);
                      }}
                      className="w-full rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                    />
                    {listOpen && (
                      <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-stone bg-white py-1 shadow-lg">
                        {matches.length === 0 ? (
                          <li className="px-3 py-2 text-sm text-muted">
                            No rooms found.
                          </li>
                        ) : (
                          matches.map((r) => (
                            <li key={r.id}>
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  pickRoom(r.id);
                                }}
                                className={`flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-warm/60 ${
                                  r.id === roomId ? "bg-warm/40" : ""
                                }`}
                              >
                                <span className="text-sm text-ink">
                                  {r.label}
                                </span>
                                <span className="text-xs text-muted">
                                  {STATUS_LABEL[r.status]}
                                  {r.tenantName
                                    ? ` · ${r.tenantName}`
                                    : r.upcomingTenantName
                                      ? ` · ${r.upcomingTenantName} (moves in ${r.upcomingStart})`
                                      : ""}
                                </span>
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    )}
                  </div>
                </label>

                {selected && occupied && (
                  <div className="flex flex-col gap-1 rounded-lg bg-warm/40 p-3">
                    <p className="text-sm text-ink">
                      {selected.tenantName ?? "This room"} currently occupies this
                      room. Set a move-out date to move them out and list it.
                    </p>
                    <label className="mt-1 flex flex-col gap-1">
                      <span className="text-xs uppercase tracking-wide text-muted">
                        Move-out date
                      </span>
                      <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                      />
                    </label>
                  </div>
                )}

                {selected && upcoming && (
                  <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/10 p-3">
                    <p className="text-sm text-ink">
                      <span className="font-medium">
                        {upcoming.name ?? "A tenant"}
                      </span>{" "}
                      is scheduled to move into this room on{" "}
                      {upcoming.start}. Listing it will advertise it as open.
                    </p>
                    {!occupied && (
                      <label className="flex items-center gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          checked={cancelMoveIn}
                          onChange={(e) => setCancelMoveIn(e.target.checked)}
                          className="h-4 w-4 rounded border-stone accent-accent"
                        />
                        Cancel the move-in and remove the reservation
                      </label>
                    )}
                  </div>
                )}

                {selected && !occupied && (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs uppercase tracking-wide text-muted">
                      Available from{" "}
                      <span className="normal-case text-muted/70">
                        (optional — blank means now)
                      </span>
                    </span>
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                    />
                  </label>
                )}

                {error && <p className="text-sm text-red-700">{error}</p>}
              </div>
            )}

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => !pending && close()}
                className="rounded-full px-3 py-1.5 text-sm text-muted hover:text-ink"
              >
                Cancel
              </button>
              {rooms.length > 0 && (
                <button
                  type="button"
                  onClick={submit}
                  disabled={pending || !selected}
                  className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
                >
                  {pending
                    ? "Working…"
                    : occupied
                      ? "Move out & list"
                      : upcoming && cancelMoveIn
                        ? "Cancel move-in & list"
                        : upcoming
                          ? "List anyway"
                          : "Add to inventory"}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
