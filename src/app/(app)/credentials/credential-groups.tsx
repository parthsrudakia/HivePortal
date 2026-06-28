"use client";

import { Fragment, useState } from "react";
import { CredentialRow, type CredentialRowData } from "./credential-row";
import type { PropertyOption } from "./constants";

export type CredentialGroup = {
  label: string;
  items: CredentialRowData[];
};

/** Credentials table grouped by property (or "General"), with each group
 *  collapsible — same interaction as the Rent Tracker. Starts fully collapsed
 *  each time the page opens. */
export function CredentialGroups({
  groups,
  properties,
  canReveal = false,
}: {
  groups: CredentialGroup[];
  properties: PropertyOption[];
  canReveal?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(groups.map((g) => g.label)),
  );

  const collapseAll = () => setCollapsed(new Set(groups.map((g) => g.label)));
  const expandAll = () => setCollapsed(new Set());
  const toggle = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return (
    <section className="mt-4">
      <div className="mb-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={collapseAll}
          className="rounded-full border border-stone px-3 py-1 text-sm font-medium text-ink transition hover:bg-warm"
        >
          Collapse all
        </button>
        <button
          type="button"
          onClick={expandAll}
          className="rounded-full border border-stone px-3 py-1 text-sm font-medium text-ink transition hover:bg-warm"
        >
          Expand all
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-stone/40 md:overflow-x-visible">
        <table className="w-full min-w-[1100px] text-sm [&_td]:border-r [&_td]:border-stone/30 [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-stone/30 [&_th:last-child]:border-r-0">
          <thead className="sticky top-0 z-10 bg-warm text-left text-xs uppercase tracking-wide text-muted shadow-sm md:top-14">
            <tr>
              <th className="rounded-tl-xl bg-warm px-3 py-2 font-medium">
                Unit/Category
              </th>
              <th className="bg-warm px-3 py-2 font-medium">Service</th>
              <th className="bg-warm px-3 py-2 font-medium">Owner</th>
              <th className="bg-warm px-3 py-2 font-medium">Username</th>
              <th className="bg-warm px-3 py-2 font-medium">Password</th>
              <th className="bg-warm px-3 py-2 font-medium">Account #</th>
              <th className="bg-warm px-3 py-2 font-medium">Link</th>
              <th className="rounded-tr-xl bg-warm px-3 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isCollapsed = collapsed.has(g.label);
              return (
                <Fragment key={g.label}>
                  <tr className="border-t border-stone/40 bg-warm/40">
                    <td colSpan={8} className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggle(g.label)}
                          aria-expanded={!isCollapsed}
                          aria-label={
                            isCollapsed
                              ? `Expand ${g.label}`
                              : `Collapse ${g.label}`
                          }
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink transition hover:bg-warm"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                            aria-hidden="true"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                        <span className="text-xs font-semibold uppercase tracking-wide text-ink/80">
                          {g.label}
                        </span>
                        <span className="text-xs text-muted">
                          ({g.items.length})
                        </span>
                      </div>
                    </td>
                  </tr>
                  {!isCollapsed &&
                    g.items.map((c, i) => (
                      <CredentialRow
                        key={c.id}
                        credential={c}
                        properties={properties}
                        striped={i % 2 === 1}
                        canReveal={canReveal}
                      />
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
