"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  SignaturePad,
  type SignaturePadHandle,
} from "@/components/signature-pad";
import { saveOperatorSignature } from "./actions";

export function OperatorSignatureCard({
  signatureUrl,
}: {
  /** Short-lived signed URL to the current signature PNG, or null if none. */
  signatureUrl: string | null;
}) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [drawing, setDrawing] = useState(signatureUrl === null);
  const [hasInk, setHasInk] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const pngDataUrl = padRef.current?.toDataUrl();
    if (!pngDataUrl) {
      toast.error("Draw your signature first.");
      return;
    }
    setSaving(true);
    try {
      const res = await saveOperatorSignature(pngDataUrl);
      if (res.ok) {
        toast.success("Signature saved — it now goes on every agreement you send.");
        setDrawing(false);
        setHasInk(false);
      } else {
        toast.error(res.error ?? "Failed to save the signature.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Your signature
          </h2>
          <p className="mt-1 text-xs text-muted">
            Pre-loaded onto every agreement before it goes out — tenants see the
            agreement already signed by you.
          </p>
        </div>
        {!drawing && (
          <button
            type="button"
            onClick={() => setDrawing(true)}
            className="rounded-full border border-stone bg-white px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-ink transition hover:bg-warm"
          >
            {signatureUrl ? "Replace" : "Draw signature"}
          </button>
        )}
      </div>

      {!drawing ? (
        signatureUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not a static asset
          <img
            src={signatureUrl}
            alt="Your signature"
            className="dark-invert-img mt-4 h-16 w-auto"
          />
        ) : (
          <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            No signature on file yet — agreements can&rsquo;t be emailed for
            signing until you draw one.
          </p>
        )
      ) : (
        <div className="mt-4 max-w-xl">
          <SignaturePad ref={padRef} onChange={setHasInk} />
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={!hasInk || saving}
              className="rounded-full bg-accent px-5 py-2 text-xs font-medium uppercase tracking-wide text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save signature"}
            </button>
            <button
              type="button"
              onClick={() => padRef.current?.clear()}
              className="text-xs font-semibold uppercase tracking-wider text-accent-text hover:text-accent-dark"
            >
              Clear
            </button>
            {signatureUrl && (
              <button
                type="button"
                onClick={() => setDrawing(false)}
                className="text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
