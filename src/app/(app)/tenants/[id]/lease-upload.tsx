"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { uploadLeasePdf } from "../actions";

// Keep in sync with MAX_LEASE_PDF_BYTES in ../actions.ts.
const MAX_BYTES = 20 * 1024 * 1024;

export function LeaseUpload({
  tenancyId,
  hasLease,
}: {
  tenancyId: string;
  /** A PDF is already on file — the button replaces it. */
  hasLease: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      toast.error("Lease file must be a PDF.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("Lease PDF must be 20 MB or smaller.");
      return;
    }
    if (
      hasLease &&
      !window.confirm("Replace the lease PDF on file with this one?")
    )
      return;
    setPending(true);
    const fd = new FormData();
    fd.set("tenancy_id", tenancyId);
    fd.set("lease_pdf", file);
    try {
      const res = await uploadLeasePdf(fd);
      if (res.error) toast.error(res.error);
      else toast.success(hasLease ? "Lease PDF replaced." : "Lease PDF uploaded.");
    } catch {
      toast.error("Upload failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void onFile(file);
        }}
      />
      <button
        type="button"
        disabled={pending}
        aria-busy={pending}
        onClick={() => inputRef.current?.click()}
        className="rounded-full border border-stone bg-white px-3 py-1 text-xs uppercase tracking-wide text-ink hover:bg-warm disabled:opacity-50"
      >
        {pending
          ? "Uploading…"
          : hasLease
            ? "Replace lease PDF"
            : "Upload lease PDF"}
      </button>
    </>
  );
}
