"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

/**
 * Sort control shown only while the "Balance due only" filter is active.
 * Cycles ?sort= through balance high→low, low→high, and off (property
 * order); the server component reads it and orders both the tenants inside
 * each property group and the groups themselves.
 */
export function BalanceSort() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const sort = searchParams.get("sort");
  const active = sort === "balance_desc" || sort === "balance_asc";

  function cycle() {
    const next = new URLSearchParams(searchParams.toString());
    if (sort === "balance_desc") {
      next.set("sort", "balance_asc");
    } else if (sort === "balance_asc") {
      next.delete("sort");
    } else {
      next.set("sort", "balance_desc");
    }
    const qs = next.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  return (
    <button
      type="button"
      onClick={cycle}
      aria-pressed={active}
      className={`rounded-full border px-4 py-2 text-sm shadow-sm transition ${
        active
          ? "border-accent bg-accent text-white hover:bg-accent-dark"
          : "border-stone bg-white text-ink hover:bg-warm"
      }`}
    >
      {sort === "balance_desc"
        ? "Balance: high → low"
        : sort === "balance_asc"
          ? "Balance: low → high"
          : "Sort by balance"}
    </button>
  );
}
