"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ConfirmModal } from "@/components/confirm-modal";
import { sendBalanceReminders } from "../actions";

const btn =
  "rounded-full border border-stone bg-white px-3 py-1 text-xs uppercase tracking-wide text-ink hover:bg-warm disabled:opacity-50";

/**
 * Balance reminder for this one tenant — the Rent Tracker's bulk reminder,
 * narrowed to a single profile. Same wording and the same sender rules (New
 * York tenants from the personal Gmail, everyone else from the work account).
 */
export function BalanceReminderButtons({
  tenantId,
  tenantName,
  hasEmail,
  hasPhone,
}: {
  tenantId: string;
  tenantName: string;
  hasEmail: boolean;
  hasPhone: boolean;
}) {
  const [busy, setBusy] = useState<"email" | "sms" | null>(null);

  const send = async (channel: "email" | "sms") => {
    setBusy(channel);
    const fd = new FormData();
    fd.set("channel", channel);
    fd.set("tenant_id", tenantId);
    const res = await sendBalanceReminders(undefined, fd);
    setBusy(null);
    if (res?.error) toast.error(res.error);
    else toast.success(res?.success ?? "Reminder sent.");
  };

  return (
    <>
      <ConfirmModal
        trigger={
          <button
            type="button"
            disabled={!hasEmail || busy !== null}
            aria-busy={busy === "email"}
            title={hasEmail ? undefined : "No email address on file"}
            className={btn}
          >
            {busy === "email" ? "Sending…" : "Email balance reminder"}
          </button>
        }
        title="Email a balance reminder?"
        message={`${tenantName} will be emailed their current outstanding balance.`}
        confirmLabel="Send email"
        onConfirm={() => send("email")}
      />
      <ConfirmModal
        trigger={
          <button
            type="button"
            disabled={!hasPhone || busy !== null}
            aria-busy={busy === "sms"}
            title={hasPhone ? undefined : "No phone number on file"}
            className={btn}
          >
            {busy === "sms" ? "Sending…" : "Text balance reminder"}
          </button>
        }
        title="Text a balance reminder?"
        message={`${tenantName} will be texted their current outstanding balance.`}
        confirmLabel="Send text"
        onConfirm={() => send("sms")}
      />
    </>
  );
}
