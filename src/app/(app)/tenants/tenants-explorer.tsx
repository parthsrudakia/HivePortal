"use client";

import { useSearchParams } from "next/navigation";
import { useDeferredValue, useMemo } from "react";
import {
  TenantGroups,
  type DisplayGroup,
  type DisplayRow,
} from "./tenant-groups";

export type TrackerRow = DisplayRow & {
  /** "Bldg Apt 4" | "Unassigned" — precomputed group key. */
  groupLabel: string;
  propertyId: string | null;
  /** Lowercased search haystack (tenant + contact + room + unit address). */
  haystack: string;
};

export type VacantProperty = {
  id: string;
  label: string;
  haystack: string;
};

/**
 * Client-side filter/group/sort over the full active roster. Reads ?q=,
 * ?owing= and ?sort= straight from the URL (written shallowly by the filter
 * controls), so typing re-filters instantly with zero server round trips.
 */
export function TenantsExplorer({
  rows,
  vacantProperties,
  admin,
}: {
  rows: TrackerRow[];
  vacantProperties: VacantProperty[];
  admin: boolean;
}) {
  const searchParams = useSearchParams();
  const query = useDeferredValue(searchParams.get("q") ?? "")
    .trim()
    .toLowerCase();
  const owingOnly = useDeferredValue(searchParams.get("owing")) === "1";
  const sortParam = useDeferredValue(searchParams.get("sort"));
  // Balance sort only applies inside the owing view.
  const balanceSort =
    owingOnly && (sortParam === "balance_desc" || sortParam === "balance_asc")
      ? sortParam
      : null;

  const groups: DisplayGroup[] = useMemo(() => {
    const visibleRows = rows.filter((r) => {
      if (owingOnly && r.balance <= 0) return false;
      if (!query) return true;
      return r.haystack.includes(query);
    });

    // Group active tenancies by property for the collapsible list. Capture the
    // property id so the group header can link to that property's page.
    const groupsMap = new Map<
      string,
      { propertyId: string | null; rows: DisplayRow[] }
    >();
    for (const r of visibleRows) {
      if (!groupsMap.has(r.groupLabel))
        groupsMap.set(r.groupLabel, { propertyId: r.propertyId, rows: [] });
      groupsMap.get(r.groupLabel)!.rows.push(r);
    }

    // Properties with no active tenancy still show up as empty groups, so the
    // tracker always lists the whole portfolio. They're omitted when the
    // owing-only filter is on (nothing owed on a vacant unit) and when a search
    // query doesn't match the unit itself.
    const seenPropertyIds = new Set(
      Array.from(groupsMap.values(), (g) => g.propertyId),
    );
    if (!owingOnly) {
      for (const p of vacantProperties) {
        if (seenPropertyIds.has(p.id)) continue;
        if (groupsMap.has(p.label)) continue;
        if (query && !p.haystack.includes(query)) continue;
        groupsMap.set(p.label, { propertyId: p.id, rows: [] });
      }
    }

    const grouped: DisplayGroup[] = Array.from(groupsMap.entries())
      .sort(([a], [b]) =>
        a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b),
      )
      .map(([label, g]) => {
        // Order rooms within a unit by room number (numeric-aware so "10"
        // sorts after "2"); rows missing a room number fall to the bottom.
        g.rows.sort((a, b) => {
          if (a.room_number == null) return b.room_number == null ? 0 : 1;
          if (b.room_number == null) return -1;
          return a.room_number.localeCompare(b.room_number, undefined, {
            numeric: true,
          });
        });
        const subDue = g.rows.reduce((s, r) => s + r.due, 0);
        const subPaid = g.rows.reduce((s, r) => s + r.paid, 0);
        const subBalance = g.rows.reduce((s, r) => s + r.balance, 0);
        return {
          label,
          propertyId: g.propertyId,
          rows: g.rows,
          subDue,
          subPaid,
          subBalance,
        };
      });

    // Reorder the owing view by balance: tenants within each group and the
    // groups themselves (by subtotal), so the biggest debtors surface first
    // (or last, ascending).
    if (balanceSort) {
      const dir = balanceSort === "balance_asc" ? 1 : -1;
      for (const g of grouped) {
        g.rows.sort((a, b) => dir * (a.balance - b.balance));
      }
      grouped.sort((a, b) => dir * (a.subBalance - b.subBalance));
    }

    return grouped;
  }, [rows, vacantProperties, owingOnly, query, balanceSort]);

  if (groups.length === 0) {
    return (
      <p className="mt-10 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
        {owingOnly && !query ? (
          "No tenants have an outstanding balance."
        ) : owingOnly ? (
          `No tenants with a balance match “${query}”.`
        ) : query ? (
          `No tenants or units match “${query}”.`
        ) : (
          <>
            No properties yet. Click <em>Add property</em> to start.
          </>
        )}
      </p>
    );
  }

  return (
    // key forces a remount when the filter toggles so the expand/collapse
    // state re-initializes (collapsed by default, expanded when owing-only).
    <TenantGroups
      key={owingOnly ? "owing" : "all"}
      groups={groups}
      defaultExpanded={owingOnly}
      admin={admin}
    />
  );
}
