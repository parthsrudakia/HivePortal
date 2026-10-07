"use client";

import { useActionState, useState } from "react";
import {
  deleteTenant,
  type DeleteTenantState,
  endTenancy,
  deletePayment,
  deleteCharge,
  reactivateTenancy,
} from "../actions";
import { todayISO } from "@/lib/date";

export function EndTenancyForm({
  tenancyId,
  tenantId,
}: {
  tenancyId: string;
  tenantId: string;
}) {
  const today = todayISO();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-stone bg-white px-4 py-2 text-sm font-medium text-ink shadow-sm transition hover:border-red-300 hover:bg-red-50 hover:text-red-700"
      >
        Move out
      </button>
    );
  }

  return (
    <form
      action={endTenancy}
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        const fd = new FormData(e.currentTarget);
        const endDate = String(fd.get("move_out_date") ?? "");
        const todayStr = todayISO();
        const isFuture = endDate > todayStr;
        const msg = isFuture
          ? `Move out on ${endDate}? Tenant stays in the room until that date; the room will be listed as "Available from ${endDate}" on Inventory.`
          : "Move out now? The room will be marked Available.";
        if (!confirm(msg)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="tenancy_id" value={tenancyId} />
      <input type="hidden" name="tenant_id" value={tenantId} />
      <input
        type="date"
        name="move_out_date"
        defaultValue={today}
        required
        className="rounded-lg border border-stone bg-white px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        className="rounded-full bg-ink px-3 py-1 text-xs font-medium text-white hover:bg-accent-dark"
      >
        Confirm
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-xs uppercase tracking-wide text-muted hover:text-ink"
      >
        Cancel
      </button>
    </form>
  );
}

export function ReactivateTenancyButton({
  tenancyId,
  tenantId,
  label = "Cancel move out",
  variant = "subtle",
}: {
  tenancyId: string;
  tenantId: string;
  label?: string;
  variant?: "subtle" | "primary";
}) {
  const className =
    variant === "primary"
      ? "rounded-full border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-medium text-accent-text shadow-sm transition hover:bg-accent/20"
      : "text-xs uppercase tracking-wide text-muted hover:text-accent-text";

  return (
    <form action={reactivateTenancy}>
      <input type="hidden" name="tenancy_id" value={tenancyId} />
      <input type="hidden" name="tenant_id" value={tenantId} />
      <button type="submit" className={className}>
        {label}
      </button>
    </form>
  );
}

export function DeleteTenantButton({ id, name }: { id: string; name: string }) {
  const [state, action, pending] = useActionState<DeleteTenantState, FormData>(
    deleteTenant,
    undefined,
  );
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="text-xs uppercase tracking-wide text-muted hover:text-red-700 disabled:opacity-50"
        onClick={(e) => {
          if (
            !confirm(
              `Delete tenant "${name}"? Their tenancies will be deleted and their rooms freed. Any signed agreement stays on the Agreements page. This cannot be undone.`,
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        {pending ? "Deleting…" : "Delete tenant"}
      </button>
      {state?.error && (
        <p role="alert" className="max-w-xs text-right text-xs text-red-700">
          {state.error}
        </p>
      )}
    </form>
  );
}

export function DeletePaymentButton({
  paymentId,
  tenantId,
}: {
  paymentId: string;
  tenantId: string;
}) {
  return (
    <form action={deletePayment}>
      <input type="hidden" name="payment_id" value={paymentId} />
      <input type="hidden" name="tenant_id" value={tenantId} />
      <button
        type="submit"
        className="text-xs uppercase tracking-wide text-muted hover:text-red-700"
        onClick={(e) => {
          if (!confirm("Delete this payment record? This cannot be undone.")) {
            e.preventDefault();
          }
        }}
      >
        Delete
      </button>
    </form>
  );
}

export function DeleteChargeButton({
  chargeIds,
  tenantId,
}: {
  chargeIds: string[];
  tenantId: string;
}) {
  // A consolidated "Other" line stands in for several charge rows, so deleting
  // it removes all of them.
  const many = chargeIds.length > 1;
  return (
    <form action={deleteCharge}>
      <input type="hidden" name="charge_ids" value={chargeIds.join(",")} />
      <input type="hidden" name="tenant_id" value={tenantId} />
      <button
        type="submit"
        className="text-xs uppercase tracking-wide text-muted hover:text-red-700"
        onClick={(e) => {
          const msg = many
            ? `Delete all ${chargeIds.length} charges in this line? This cannot be undone.`
            : "Delete this charge? This cannot be undone.";
          if (!confirm(msg)) {
            e.preventDefault();
          }
        }}
      >
        Delete
      </button>
    </form>
  );
}

