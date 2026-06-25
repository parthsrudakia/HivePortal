"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Neighborhood dropdown for the inventory table. Writes the choice to the
 * `hood` search param (preserving the active filter/sort) so the Server
 * Component can narrow + re-render. "All" clears the param.
 */
export function NeighborhoodFilter({
  neighborhoods,
}: {
  neighborhoods: string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get("hood") ?? "";

  return (
    <label className="inline-flex items-center gap-1.5 text-[12px] text-muted">
      <span className="uppercase tracking-wide">Neighborhood</span>
      <select
        value={current}
        onChange={(e) => {
          const params = new URLSearchParams(searchParams.toString());
          if (e.target.value) params.set("hood", e.target.value);
          else params.delete("hood");
          router.push(`/inventory?${params.toString()}`);
        }}
        className="rounded-full border border-stone bg-white px-3 py-1 text-[12px] text-ink shadow-sm transition hover:border-accent focus:border-accent focus:outline-none"
      >
        <option value="">All neighborhoods</option>
        {neighborhoods.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
