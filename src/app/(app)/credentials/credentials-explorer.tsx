"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useDeferredParam, useUrlParamState } from "@/lib/use-url-param";
import { type CredentialRowData } from "./credential-row";
import { CredentialGroups } from "./credential-groups";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type PropertyOption,
} from "./constants";
import type { Database } from "@/lib/supabase/types";

type Category = Database["public"]["Enums"]["credential_category"];

export type CredentialExplorerRow = CredentialRowData & {
  /** Lowercased search haystack, precomputed on the server. */
  haystack: string;
};

function isCategory(v: string): v is Category {
  return CATEGORY_ORDER.includes(v as Category);
}

export function CredentialsExplorer({
  all,
  properties,
  admin,
}: {
  all: CredentialExplorerRow[];
  properties: PropertyOption[];
  admin: boolean;
}) {
  const query = useDeferredParam("q").trim().toLowerCase();
  const [categoryParam, setCategoryParam] = useUrlParamState("category");
  const activeCategory = isCategory(categoryParam) ? categoryParam : null;

  const countsByCategory = useMemo(
    () =>
      CATEGORY_ORDER.reduce(
        (acc, c) => {
          acc[c] = all.filter((r) => r.category === c).length;
          return acc;
        },
        {} as Record<Category, number>,
      ),
    [all],
  );

  const groups = useMemo(() => {
    const filtered = all.filter((r) => {
      if (activeCategory && r.category !== activeCategory) return false;
      if (!query) return true;
      return r.haystack.includes(query);
    });

    // Group filtered rows by property label. Properties appear first
    // alphabetically; "General (no property)" goes last.
    const byProperty = new Map<string, CredentialRowData[]>();
    for (const c of filtered) {
      const key = c.property_label ?? "__general__";
      if (!byProperty.has(key)) byProperty.set(key, []);
      byProperty.get(key)!.push(c);
    }
    return Array.from(byProperty.entries())
      .sort(([a], [b]) => {
        if (a === "__general__") return 1;
        if (b === "__general__") return -1;
        return a.localeCompare(b);
      })
      .map(([key, items]) => ({
        label: key === "__general__" ? "General (no property)" : key,
        items,
      }));
  }, [all, activeCategory, query]);

  const hasMatches = groups.length > 0;

  return (
    <>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {CATEGORY_ORDER.map((c) => {
          const isActive = activeCategory === c;
          const count = countsByCategory[c];
          if (count === 0 && !isActive) return null;
          return (
            <li key={c}>
              <button
                type="button"
                onClick={() => setCategoryParam(isActive ? "" : c)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
                  isActive
                    ? "border-ink bg-ink text-white"
                    : "border-stone bg-white text-ink hover:bg-warm"
                }`}
              >
                {CATEGORY_LABELS[c]} ({count})
              </button>
            </li>
          );
        })}
      </ul>

      {all.length === 0 && (
        <p className="mt-10 rounded-xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
          No credentials yet. Click <em>Add credential</em> to enter one.
        </p>
      )}

      {all.length > 0 && !hasMatches && (
        <p className="mt-10 rounded-xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
          No credentials match the filter.{" "}
          <Link href="/credentials" className="text-accent-text">
            Clear
          </Link>
          .
        </p>
      )}

      {hasMatches && (
        <CredentialGroups
          groups={groups}
          properties={properties}
          canReveal={admin}
        />
      )}
    </>
  );
}
