"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

type Option = { value: string; label: string };

type Props = {
  typeOptions: Option[];
  statusOptions: Option[];
  type: string | null;
  status: string | null;
};

// Type + status dropdowns for the email / text logs. Each change navigates
// immediately (no Apply button) and keeps the other filter's value in the
// URL so the pages stay shareable and back-button friendly.
export function LogFilters({ typeOptions, statusOptions, type, status }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  const go = (next: { type?: string | null; status?: string | null }) => {
    const t = next.type === undefined ? type : next.type;
    const s = next.status === undefined ? status : next.status;
    const params = new URLSearchParams();
    if (t) params.set("type", t);
    if (s) params.set("status", s);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const select =
    "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4 shadow-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-muted">For</span>
        <select
          value={type ?? ""}
          onChange={(e) => go({ type: e.target.value || null })}
          className={select}
        >
          <option value="">All</option>
          {typeOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-muted">Status</span>
        <select
          value={status ?? ""}
          onChange={(e) => go({ status: e.target.value || null })}
          className={select}
        >
          <option value="">All</option>
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {(type || status) && (
        <Link
          href={pathname}
          className="pb-2.5 text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          Clear
        </Link>
      )}
    </div>
  );
}
