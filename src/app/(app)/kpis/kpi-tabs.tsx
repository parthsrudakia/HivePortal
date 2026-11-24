"use client";

import { useState } from "react";

export type KpiTab = {
  key: string;
  label: string;
  /** Shown muted beside the label, e.g. how many rows the tab holds. */
  count?: number;
  content: React.ReactNode;
};

/**
 * The tab row under an account's figures: one view at a time (graph, reply
 * queue, units, day by day). Every panel stays mounted so the graph keeps
 * its metric when you come back to it.
 */
export function KpiTabs({ tabs }: { tabs: KpiTab[] }) {
  const [active, setActive] = useState(tabs[0]?.key);
  const current = tabs.some((t) => t.key === active) ? active : tabs[0]?.key;

  return (
    <div>
      <div className="-mx-1 flex flex-wrap items-center gap-1" role="tablist">
        {tabs.map((t) => {
          const on = t.key === current;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setActive(t.key)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                on ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              {t.label}
              {t.count !== undefined && (
                <span className={`ml-1.5 font-normal tabular-nums ${on ? "text-white/70" : "text-muted/70"}`}>
                  {t.count.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" hidden={t.key !== current} className="mt-6">
          {t.content}
        </div>
      ))}
    </div>
  );
}
