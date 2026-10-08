"use client";

import { useActionState, useMemo, useState } from "react";
import { transferTenancy, type TransferFormState } from "../actions";
import { RoomCombobox } from "../new/room-combobox";
import type { RoomOption } from "../room-options";
import { addDaysISO, proratedMonthRemainder, todayISO } from "@/lib/date";

function money(n: number) {
  return `$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Move an active tenant to a different room: ends the current tenancy on
 * the transfer date, starts a new one in the destination the next day, and
 * carries the ledger's net position across so the tenant owes (or is owed)
 * the same total in the new room.
 */
export function TransferDialog({
  tenancyId,
  tenantId,
  tenantName,
  currentRoomLabel,
  netBalance,
  currentDeposit,
  rooms,
}: {
  tenancyId: string;
  tenantId: string;
  tenantName: string;
  currentRoomLabel: string;
  /** The current ledger balance shown in the carry preview (+ owed, − credit). */
  netBalance: number;
  /** Deposit held on the current room; it carries over, only a change posts. */
  currentDeposit: number | null;
  rooms: RoomOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<
    TransferFormState,
    FormData
  >(async (prev, formData) => {
    const result = await transferTenancy(prev, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  const [transferDate, setTransferDate] = useState(todayISO());
  const [rent, setRent] = useState("");
  const [deposit, setDeposit] = useState(
    currentDeposit !== null ? String(currentDeposit) : "",
  );
  const depositDelta = useMemo(() => {
    if (deposit.trim() === "") return 0;
    const next = Number(deposit);
    if (!Number.isFinite(next) || next < 0) return 0;
    return Math.round((next - (currentDeposit ?? 0)) * 100) / 100;
  }, [deposit, currentDeposit]);

  const newStartDate = useMemo(
    () => (transferDate ? addDaysISO(transferDate, 1) : ""),
    [transferDate],
  );
  const proratedHint = useMemo(() => {
    const monthly = Number(rent);
    if (!newStartDate || newStartDate.endsWith("-01")) return null;
    if (!Number.isFinite(monthly) || monthly <= 0) return null;
    return proratedMonthRemainder(newStartDate, monthly);
  }, [newStartDate, rent]);

  if (!open) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full border border-stone bg-white px-4 py-2 text-sm font-medium text-ink shadow-sm transition hover:border-accent hover:text-accent-text"
        >
          Transfer room
        </button>
        {state?.warning && (
          <p className="w-full rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {state.warning}
          </p>
        )}
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-lg tracking-tight text-ink">
          Transfer{" "}
          <span className="font-display text-accent-text">{tenantName}</span> to
          another room
        </h3>
        <p className="mt-1 text-xs text-muted">
          Ends their stay in {currentRoomLabel} on the transfer date and starts
          the new room the next day. Their balance moves with them.
        </p>
        <form action={formAction} className="mt-4 flex flex-col gap-3 text-sm">
          <input type="hidden" name="tenancy_id" value={tenancyId} />
          <input type="hidden" name="tenant_id" value={tenantId} />
          <input type="hidden" name="new_start_date" value={newStartDate} />
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">
              Destination room
            </span>
            <RoomCombobox rooms={rooms} name="dest_room_id" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">
                Last day in {currentRoomLabel.split("·").pop()?.trim() || "old room"}
              </span>
              <input
                type="date"
                name="transfer_date"
                required
                value={transferDate}
                onChange={(e) => setTransferDate(e.target.value)}
                className="rounded-lg border border-stone bg-white px-3 py-2 text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">
                New monthly rent
              </span>
              <input
                type="number"
                name="new_monthly_rent"
                required
                min="1"
                step="0.01"
                value={rent}
                onChange={(e) => setRent(e.target.value)}
                placeholder="0.00"
                className="rounded-lg border border-stone bg-white px-3 py-2 text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">
                First month in the new room
              </span>
              <input
                type="number"
                name="first_month_rent"
                min="0"
                step="0.01"
                placeholder={
                  proratedHint !== null
                    ? `${proratedHint.toFixed(2)} (prorated from ${newStartDate})`
                    : "full month"
                }
                className="rounded-lg border border-stone bg-white px-3 py-2 text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">
                Deposit in the new room
              </span>
              <input
                type="number"
                name="new_security_deposit"
                min="0"
                step="0.01"
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
                placeholder={
                  currentDeposit !== null
                    ? `${currentDeposit.toFixed(2)} (unchanged)`
                    : "0.00"
                }
                className="rounded-lg border border-stone bg-white px-3 py-2 text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </div>

          <div className="rounded-lg bg-cream/60 px-3 py-2 text-xs text-ink">
            <p className="font-medium uppercase tracking-wide text-muted">
              What posts
            </p>
            <ul className="mt-1 list-disc pl-4 leading-relaxed">
              <li>
                Old room bills its full final month; the new room starts at{" "}
                {proratedHint !== null
                  ? `a prorated ${money(proratedHint)}`
                  : "the amount above"}
                {" "}unless you override it.
              </li>
              <li>
                {Math.abs(netBalance) > 0.005
                  ? netBalance > 0
                    ? `${money(netBalance)} currently owed will carry to the new room.`
                    : `A credit of ${money(netBalance)} will carry to the new room.`
                  : "Nothing to carry — the ledger is settled."}
              </li>
              <li>
                {Math.abs(depositDelta) > 0.005
                  ? depositDelta > 0
                    ? `The ${money(currentDeposit ?? 0)} deposit carries over; a ${money(depositDelta)} top-up is charged on the new room.`
                    : `The ${money(currentDeposit ?? 0)} deposit carries over; ${money(depositDelta)} is credited back on the new room.`
                  : currentDeposit
                    ? `The ${money(currentDeposit)} deposit carries over — nothing new is charged.`
                    : "No deposit on file to carry."}
              </li>
            </ul>
          </div>

          {state?.error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {state.error}
            </p>
          )}
          <div className="mt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs uppercase tracking-wide text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending} aria-busy={pending}
              className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:opacity-60"
            >
              {pending ? "Transferring…" : "Transfer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
