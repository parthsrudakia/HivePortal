"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { uploadStatement } from "./actions";

const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";

export function UploadForm() {
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(file: File) {
    setFileName(file.name);
    const fd = new FormData();
    fd.set("statement", file);
    startTransition(async () => {
      const r = await uploadStatement(undefined, fd);
      if (r?.error) toast.error(r.error);
      if (r?.success) toast.success(r.success);
      if (r?.warning) toast.warning(r.warning);
      setFileName("");
      if (inputRef.current) inputRef.current.value = "";
    });
  }

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file && !pending) submit(file);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed bg-white px-6 py-12 text-center shadow-sm transition ${
        dragging ? "border-accent bg-accent/5" : "border-stone hover:border-accent/60"
      } ${pending ? "pointer-events-none opacity-70" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        disabled={pending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) submit(file);
        }}
      />
      {pending ? (
        <>
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-stone border-t-accent" />
          <p className="text-sm text-ink">
            Reading {fileName || "statement"}… extracting unit, dates, and charges
          </p>
          <p className="text-xs text-muted">This usually takes a few seconds.</p>
        </>
      ) : (
        <>
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </span>
          <p className="text-sm font-medium text-ink">
            Drop a utility statement here, or click to browse
          </p>
          <p className="text-xs text-muted">
            PDF or photo, any unit, any month — up to 20 MB.
          </p>
        </>
      )}
    </label>
  );
}
