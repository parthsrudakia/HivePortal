"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { resendRequest } from "../../agreements/actions";

/**
 * The signing tally's Resend / Renew button, on the tenant profile: re-sends
 * the unsigned agreement with a fresh 48-hour signing link.
 */
export function AgreementResend({
  requestId,
  expired,
}: {
  requestId: string;
  expired: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      aria-busy={pending}
      onClick={async () => {
        setPending(true);
        const res = await resendRequest(requestId);
        setPending(false);
        if (res.ok) {
          toast.success("Agreement re-sent with a fresh 48-hour link.");
          router.refresh();
        } else {
          toast.error(res.error ?? "Something went wrong.");
        }
      }}
      className="rounded-full bg-accent px-4 py-2 text-xs font-medium uppercase tracking-wide text-white transition hover:bg-accent-dark disabled:opacity-50"
    >
      {pending
        ? "Sending…"
        : expired
          ? "Renew & send for signing"
          : "Resend for signing"}
    </button>
  );
}
