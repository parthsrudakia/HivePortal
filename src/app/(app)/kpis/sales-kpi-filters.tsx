"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  KPI_PARAMS,
  OVERALL,
  RANGES,
  filtersToParams,
  sameFilters,
  type KpiFilters,
  type RangeKey,
} from "@/lib/sales-kpis";
import { saveSalesKpiDefaults } from "./actions";

const selectCls =
  "rounded-full border border-stone bg-white px-3 py-1 text-xs text-ink shadow-sm transition hover:border-accent focus:border-accent focus:outline-none";

/**
 * Filter bar for the Sales KPIs panel. Every change writes ALL the k_*
 * params to the URL (so the view is reproducible and the saved default no
 * longer applies); "Set as default" stores the current filters for this
 * user, and "Back to default" drops the k_* params so the default applies.
 */
export function SalesKpiFilters({
  filters,
  savedDefault,
  accounts,
  platforms,
  agents,
}: {
  filters: KpiFilters;
  savedDefault: KpiFilters;
  accounts: { key: string; name: string }[];
  platforms: string[];
  agents: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [saving, startSaving] = useTransition();
  const [navigating, startNav] = useTransition();

  const isDefault = sameFilters(filters, savedDefault);

  const go = (next: KpiFilters | null) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const k of Object.values(KPI_PARAMS)) params.delete(k);
    if (next) for (const [k, v] of Object.entries(filtersToParams(next))) params.set(k, v);
    const qs = params.toString();
    startNav(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };

  const set = (patch: Partial<KpiFilters>) => {
    const next = { ...filters, ...patch };
    if (patch.range === "custom" && !next.from && !next.to) {
      // Seed a custom range with the dates the user is already looking at.
      next.to = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }
    go(next);
  };

  const save = () =>
    startSaving(async () => {
      const res = await saveSalesKpiDefaults(filters);
      if (res.ok) toast.success("Saved — these filters now load by default.");
      else toast.error(res.error);
    });

  return (
    <div
      className={`mt-3 flex flex-wrap items-center gap-2 ${
        navigating ? "opacity-70" : ""
      }`}
    >
      <select
        aria-label="Account"
        value={filters.account}
        onChange={(e) => set({ account: e.target.value })}
        className={selectCls}
      >
        <option value="all">All accounts</option>
        <option value={OVERALL}>All accounts — Summary</option>
        {accounts.map((a) => (
          <option key={a.key} value={a.key}>
            {a.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Date range"
        value={filters.range}
        onChange={(e) => set({ range: e.target.value as RangeKey })}
        className={selectCls}
      >
        {RANGES.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>

      {filters.range === "custom" && (
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          <input
            type="date"
            aria-label="From"
            value={filters.from ?? ""}
            max={filters.to}
            onChange={(e) => set({ from: e.target.value || undefined })}
            className={selectCls}
          />
          to
          <input
            type="date"
            aria-label="To"
            value={filters.to ?? ""}
            min={filters.from}
            onChange={(e) => set({ to: e.target.value || undefined })}
            className={selectCls}
          />
        </span>
      )}

      {platforms.length > 1 && (
        <select
          aria-label="Platform"
          value={filters.platform}
          onChange={(e) => set({ platform: e.target.value })}
          className={selectCls}
        >
          <option value="all">All platforms</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p || "No platform"}
            </option>
          ))}
        </select>
      )}

      {agents.length > 1 && (
        <select
          aria-label="Agent"
          value={filters.agent}
          onChange={(e) => set({ agent: e.target.value })}
          className={selectCls}
        >
          <option value="all">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      )}

      <span className="ml-auto flex items-center gap-2">
        {isDefault ? (
          <span className="rounded-full bg-warm px-3 py-1 text-xs text-muted">
            ★ Your default
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => go(null)}
              className="text-xs uppercase tracking-wide text-accent-text hover:text-accent-dark"
            >
              Back to default
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-60"
            >
              {saving ? "Saving…" : "Set as default"}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
