"use client";

import { useState } from "react";
import {
  deleteTenant,
  endTenancy,
  deletePayment,
  deleteCharge,
  deleteAllocation,
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
        End tenancy
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
          ? `End on ${endDate}? Tenant stays in the room until that date; the room will be listed as "Available from ${endDate}" on Inventory.`
          : "End this tenancy now? The room will be marked Available.";
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
  label = "Undo end / reactivate",
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
  return (
    <form action={deleteTenant}>
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="text-xs uppercase tracking-wide text-muted hover:text-red-700"
        onClick={(e) => {
          if (
            !confirm(
              `Delete tenant "${name}"? All their tenancies and payment history will be deleted. This cannot be undone.`,
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        Delete tenant
      </button>
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
  chargeId,
  tenantId,
}: {
  chargeId: string;
  tenantId: string;
}) {
  return (
    <form action={deleteCharge}>
      <input type="hidden" name="charge_id" value={chargeId} />
      <input type="hidden" name="tenant_id" value={tenantId} />
      <button
        type="submit"
        className="text-xs uppercase tracking-wide text-muted hover:text-red-700"
        onClick={(e) => {
          if (!confirm("Delete this charge? This cannot be undone.")) {
            e.preventDefault();
          }
        }}
      >
        Delete
      </button>
    </form>
  );
}

export function DeleteAllocationButton({
  allocationId,
  tenantId,
}: {
  allocationId: string;
  tenantId: string;
}) {
  return (
    <form action={deleteAllocation}>
      <input type="hidden" name="allocation_id" value={allocationId} />
      <input type="hidden" name="tenant_id" value={tenantId} />
      <button
        type="submit"
        className="text-xs uppercase tracking-wide text-muted hover:text-red-700"
        onClick={(e) => {
          if (
            !confirm("Reverse this credit allocation? The amount returns to rent credit.")
          ) {
            e.preventDefault();
          }
        }}
      >
        Reverse
      </button>
    </form>
  );
}
