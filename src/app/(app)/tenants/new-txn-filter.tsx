"use client";

import { useSearchParams } from "next/navigation";
import { useSetUrlParams } from "@/lib/use-url-param";
import { formatDate } from "@/lib/date";

/**
 * Pill toggle that filters the tracker to tenancies which received a payment
 * from the most recent reconciliation statement — a quick "what just came in"
 * review. Writes ?new=1 shallowly (TenantsExplorer reads it), preserving ?q=.
 */
export function NewTxnFilter({
  count,
  statementDate,
}: {
  count: number;
  statementDate: string | null;
}) {
  const searchParams = useSearchParams();
  const setParams = useSetUrlParams();
  const active = searchParams.get("new") === "1";

  return (
    <button
      type="button"
      onClick={() => setParams(active ? { new: null } : { new: "1" })}
      aria-pressed={active}
      title={
        statementDate
          ? `Tenancies paid on the latest statement (through ${formatDate(statementDate)})`
          : "Tenancies paid on the latest statement"
      }
      className={`rounded-full border px-4 py-2 text-sm shadow-sm transition ${
        active
          ? "border-accent bg-accent text-white hover:bg-accent-dark"
          : "border-stone bg-white text-ink hover:bg-warm"
      }`}
    >
      {active ? "✓ " : ""}New ({count})
    </button>
  );
}
