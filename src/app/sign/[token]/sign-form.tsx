"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Caveat } from "next/font/google";
import { toast } from "sonner";
import { useHydrated } from "@/lib/use-hydrated";
import {
  SignaturePad,
  SIGNATURE_WIDTH,
  SIGNATURE_HEIGHT,
  type SignaturePadHandle,
} from "@/components/signature-pad";
import { submitSignature } from "./actions";

// Script font for the "type your name" signature style.
const caveat = Caveat({ subsets: ["latin"], weight: "500" });

// Server actions cap the request body at ~1MB; a normal signature PNG is a few
// KB, so anything near this limit is not a signature.
const MAX_DATA_URL_CHARS = 400_000;

/** Render a typed name in the script font onto a 4:1 transparent canvas. */
async function typedNameToPng(name: string): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = SIGNATURE_WIDTH;
  canvas.height = SIGNATURE_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  const fontFor = (px: number) => `500 ${px}px ${caveat.style.fontFamily}`;
  await document.fonts.load(fontFor(120), name);
  // Shrink to fit long names inside the box with a little margin.
  let size = 120;
  ctx.font = fontFor(size);
  const maxWidth = SIGNATURE_WIDTH - 60;
  const width = ctx.measureText(name).width;
  if (width > maxWidth) {
    size = Math.max(40, Math.floor((size * maxWidth) / width));
    ctx.font = fontFor(size);
  }
  ctx.fillStyle = "#1a1a18";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(name, SIGNATURE_WIDTH / 2, SIGNATURE_HEIGHT / 2 + 8, maxWidth);
  return canvas.toDataURL("image/png");
}

/**
 * The sublessee signature row under the embedded agreement: an empty
 * signature line with a Sign button on it. The button opens a modal with the
 * draw/type pad; once signed, the ink lands on the line right here.
 */
export function SignArea({
  token,
  tenantName,
  branded,
}: {
  token: string;
  tenantName: string;
  /** false = New York: no Hive brand colors anywhere, ink-only styling. */
  branded: boolean;
}) {
  const [open, setOpen] = useState(false);
  // PNG of the accepted signature — doubles as the "signed" flag.
  const [appliedSignature, setAppliedSignature] = useState<string | null>(null);

  return (
    <div className="mt-6 border-t border-stone/40 pt-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="w-full max-w-sm">
          <p className="text-sm text-ink">
            Sublessee: <strong>{tenantName}</strong>
          </p>
          <div className="flex h-16 items-end">
            {appliedSignature ? (
              // eslint-disable-next-line @next/next/no-img-element -- data URL of the just-drawn signature
              <img
                src={appliedSignature}
                alt="Your signature"
                className="h-14 w-auto"
              />
            ) : (
              <button
                type="button"
                onClick={() => setOpen(true)}
                className={`mb-1 rounded-full px-8 py-2.5 text-sm font-medium uppercase tracking-wide text-white transition ${
                  branded
                    ? "bg-accent hover:bg-accent-dark"
                    : "bg-ink hover:bg-ink/80"
                }`}
              >
                Sign
              </button>
            )}
          </div>
          <div className="border-b border-ink" />
          <p className="mt-1.5 text-xs text-muted">
            {appliedSignature
              ? "Signed — a copy of the fully signed agreement is on its way to your email."
              : "Sign here, above the line."}
          </p>
        </div>
      </div>

      {open && (
        <SignModal
          token={token}
          tenantName={tenantName}
          branded={branded}
          onClose={() => setOpen(false)}
          onSigned={(png) => {
            setAppliedSignature(png);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function SignModal({
  token,
  tenantName,
  branded,
  onClose,
  onSigned,
}: {
  token: string;
  tenantName: string;
  branded: boolean;
  onClose: () => void;
  onSigned: (pngDataUrl: string) => void;
}) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [mode, setMode] = useState<"drawn" | "typed">("drawn");
  const [hasInk, setHasInk] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const mounted = useHydrated();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ready =
    agreed && (mode === "drawn" ? hasInk : typedName.trim().length >= 2);

  const submit = async () => {
    if (submitting) return;
    let pngDataUrl: string | null = null;
    try {
      pngDataUrl =
        mode === "drawn"
          ? (padRef.current?.toDataUrl() ?? null)
          : await typedNameToPng(typedName.trim());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not capture the signature.");
      return;
    }
    if (!pngDataUrl) {
      toast.error("Add your signature first.");
      return;
    }
    if (pngDataUrl.length > MAX_DATA_URL_CHARS) {
      toast.error("That signature is too detailed — clear it and try a simpler one.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitSignature(token, { pngDataUrl, kind: mode });
      if (res.ok) {
        onSigned(pngDataUrl);
      } else {
        toast.error(res.error ?? "Something went wrong — please try again.");
      }
    } catch {
      toast.error("Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const tabClass = (active: boolean) =>
    `rounded-full px-4 py-1.5 text-xs font-medium uppercase tracking-wide transition ${
      active ? "bg-ink text-white" : "border border-stone bg-white text-ink hover:bg-warm"
    }`;

  // Honey-gold is part of the Hive visual identity — unbranded pages stay ink.
  const linkAccent = branded
    ? "text-accent-text hover:text-accent-dark"
    : "text-muted hover:text-ink";

  if (!mounted) return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <div
        className="absolute inset-0 bg-ink/40"
        onClick={() => !submitting && onClose()}
      />
      <div className="relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg tracking-tight text-ink">
              Sign as {tenantName}
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Your signature will be placed above your name on the agreement.
            </p>
          </div>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            aria-label="Close"
            className="rounded-full px-2 text-lg leading-none text-muted hover:text-ink"
          >
            ×
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setMode("drawn")}
            className={tabClass(mode === "drawn")}
          >
            Draw
          </button>
          <button
            type="button"
            onClick={() => setMode("typed")}
            className={tabClass(mode === "typed")}
          >
            Type instead
          </button>
        </div>

        {mode === "drawn" ? (
          <div className="mt-4">
            <SignaturePad ref={padRef} onChange={setHasInk} />
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-muted">
                Draw your signature above with your finger or mouse.
              </p>
              <button
                type="button"
                onClick={() => padRef.current?.clear()}
                className={`text-xs font-semibold uppercase tracking-wider ${linkAccent}`}
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <input
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="Type your full name"
              className="w-full rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <div className="mt-3 flex h-24 items-center justify-center overflow-hidden rounded-xl border border-stone bg-white px-4">
              {typedName.trim() ? (
                <span
                  className={`${caveat.className} whitespace-nowrap text-4xl text-ink`}
                >
                  {typedName.trim()}
                </span>
              ) : (
                <span className="text-sm text-muted">
                  Your signature preview appears here
                </span>
              )}
            </div>
          </div>
        )}

        <label className="mt-5 flex items-start gap-3 text-sm text-ink">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className={`mt-0.5 h-4 w-4 ${branded ? "accent-accent" : "accent-ink"}`}
          />
          <span>
            I have read the agreement and agree to its terms. I understand this
            electronic signature is as binding as a handwritten one.
          </span>
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={!ready || submitting} aria-busy={submitting}
          className={`mt-5 w-full rounded-full px-6 py-3 text-sm font-medium uppercase tracking-wide text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${
            branded
              ? "bg-accent hover:bg-accent-dark"
              : "bg-ink hover:bg-ink/80"
          }`}
        >
          {submitting ? "Signing…" : "Sign agreement"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
