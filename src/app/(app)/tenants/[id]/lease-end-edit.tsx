"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setTenancyLeaseEndDate, setTenancyStartDate } from "../actions";

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s + "T00:00:00");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Inline editor for a tenancy's lease start or end date. */
export function LeaseDateEdit({
  field,
  tenancyId,
  tenantId,
  value,
}: {
  field: "start" | "end";
  tenancyId: string;
  tenantId: string;
  value: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  // The lease start date is required; the lease end date may be cleared.
  const required = field === "start";

  function commit(next: string) {
    const value = next || null;
    if (required && !value) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      if (field === "start") {
        await setTenancyStartDate(tenancyId, tenantId, value);
      } else {
        await setTenancyLeaseEndDate(tenancyId, tenantId, value);
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <input
        type="date"
        autoFocus
        required={required}
        defaultValue={value ?? ""}
        disabled={pending}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        className="rounded-lg border border-accent bg-white px-2 py-1 text-sm text-ink focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`rounded px-1.5 py-0.5 text-left text-ink hover:bg-warm/60 focus:outline-none focus:ring-1 focus:ring-accent ${
        pending ? "opacity-60" : ""
      }`}
    >
      {value ? (
        fmtDate(value)
      ) : (
        <span className="text-accent-text">+ Set date</span>
      )}
    </button>
  );
}
