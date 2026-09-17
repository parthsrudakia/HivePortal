"use client";

import { useState } from "react";
import { getLeaseDownloadUrl } from "../actions";

export function LeaseDownload({ tenancyId }: { tenancyId: string }) {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending} aria-busy={pending}
      onClick={async () => {
        setPending(true);
        const result = await getLeaseDownloadUrl(tenancyId);
        setPending(false);
        if (result.error) {
          alert(result.error);
          return;
        }
        if (result.url) {
          window.open(result.url, "_blank", "noopener,noreferrer");
        }
      }}
      className="rounded-full border border-stone bg-white px-3 py-1 text-xs uppercase tracking-wide text-ink hover:bg-warm disabled:opacity-50"
    >
      {pending ? "Opening…" : "Lease PDF ↗"}
    </button>
  );
}
