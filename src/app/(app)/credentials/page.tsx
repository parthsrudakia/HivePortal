import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { SearchInput } from "@/components/search-input";
import { AddCredential } from "./add-credential";
import {
  CredentialRow,
  type CredentialRowData,
} from "./credential-row";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type PropertyOption,
} from "./constants";
import type { Database } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

type Category = Database["public"]["Enums"]["credential_category"];

type PropertyRel = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
};

type Row = {
  id: string;
  category: Category;
  service_name: string;
  property_id: string | null;
  username: string | null;
  password: string | null;
  login_url: string | null;
  account_number: string | null;
  owner_label: string | null;
  notes: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};

function propertyLabel(p: PropertyRel) {
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

function isCategory(v: string | undefined): v is Category {
  return !!v && CATEGORY_ORDER.includes(v as Category);
}

type PageProps = {
  searchParams: Promise<{ q?: string; category?: string }>;
};

export default async function CredentialsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = (params.q ?? "").trim().toLowerCase();
  const activeCategory = isCategory(params.category) ? params.category : null;

  const supabase = await createClient();

  const [{ data: credentials }, { data: properties }] = await Promise.all([
    supabase
      .from("credentials")
      .select(
        `id, category, service_name, property_id, username, password,
         login_url, account_number, owner_label, notes,
         properties(building_name, street_address, unit_number)`,
      )
      .order("category", { ascending: true })
      .order("service_name", { ascending: true })
      .returns<Row[]>(),
    supabase
      .from("properties")
      .select("id, building_name, street_address, unit_number")
      .order("street_address", { ascending: true }),
  ]);

  const propertyOptions: PropertyOption[] = (properties ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
  }));

  const all: CredentialRowData[] = (credentials ?? []).map((c) => {
    const p = one(c.properties);
    return {
      id: c.id,
      category: c.category,
      service_name: c.service_name,
      property_id: c.property_id,
      property_label: p ? propertyLabel(p) : null,
      username: c.username,
      password: c.password,
      login_url: c.login_url,
      account_number: c.account_number,
      owner_label: c.owner_label,
      notes: c.notes,
    };
  });

  const countsByCategory = CATEGORY_ORDER.reduce(
    (acc, c) => {
      acc[c] = all.filter((r) => r.category === c).length;
      return acc;
    },
    {} as Record<Category, number>,
  );

  const filtered = all.filter((r) => {
    if (activeCategory && r.category !== activeCategory) return false;
    if (!query) return true;
    const haystack = [
      r.service_name,
      r.property_label,
      r.owner_label,
      r.username,
      r.account_number,
      r.login_url,
      r.notes,
      CATEGORY_LABELS[r.category],
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  return (
    <div className="mx-auto w-full max-w-7xl">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-4">
        <div>
          <h1 className="text-3xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Credentials</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            All logins and account numbers in one place. Per-property
            credentials also surface on each property&apos;s detail page.
          </p>
        </div>
        <AddCredential properties={propertyOptions} />
      </header>

      <div className="mt-4">
        <SearchInput
          placeholder="Search by service, property, username, account, owner…"
          ariaLabel="Search credentials"
        />
      </div>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        <li>
          <Link
            href="/credentials"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition ${
              activeCategory === null
                ? "border-ink bg-ink text-white"
                : "border-stone bg-white text-ink hover:bg-warm"
            }`}
          >
            All ({all.length})
          </Link>
        </li>
        {CATEGORY_ORDER.map((c) => {
          const isActive = activeCategory === c;
          const count = countsByCategory[c];
          if (count === 0 && !isActive) return null;
          return (
            <li key={c}>
              <Link
                href={
                  isActive ? "/credentials" : `/credentials?category=${c}`
                }
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition ${
                  isActive
                    ? "border-ink bg-ink text-white"
                    : "border-stone bg-white text-ink hover:bg-warm"
                }`}
              >
                {CATEGORY_LABELS[c]} ({count})
              </Link>
            </li>
          );
        })}
      </ul>

      {all.length === 0 && (
        <p className="mt-10 rounded-xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
          No credentials yet. Click <em>Add credential</em> to enter one.
        </p>
      )}

      {all.length > 0 && filtered.length === 0 && (
        <p className="mt-10 rounded-xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
          No credentials match the filter.{" "}
          <Link href="/credentials" className="text-accent-text">
            Clear
          </Link>
          .
        </p>
      )}

      {filtered.length > 0 && (() => {
        // Group filtered rows by property label. Properties appear first
        // alphabetically; "General (no property)" goes last.
        const byProperty = new Map<string, CredentialRowData[]>();
        for (const c of filtered) {
          const key = c.property_label ?? "__general__";
          if (!byProperty.has(key)) byProperty.set(key, []);
          byProperty.get(key)!.push(c);
        }
        const groups = Array.from(byProperty.entries())
          .sort(([a], [b]) => {
            if (a === "__general__") return 1;
            if (b === "__general__") return -1;
            return a.localeCompare(b);
          })
          .map(([key, items]) => ({
            label: key === "__general__" ? "General (no property)" : key,
            items,
          }));

        return (
          <div className="mt-4 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="sticky top-0 z-10 bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Service</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Username</th>
                  <th className="px-3 py-2 font-medium">Password</th>
                  <th className="px-3 py-2 font-medium">Account #</th>
                  <th className="px-3 py-2 font-medium">Link</th>
                  <th className="px-3 py-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupBlock
                    key={g.label}
                    label={g.label}
                    items={g.items}
                    properties={propertyOptions}
                  />
                ))}
              </tbody>
            </table>
          </div>
        );
      })()}
    </div>
  );
}

function GroupBlock({
  label,
  items,
  properties,
}: {
  label: string;
  items: CredentialRowData[];
  properties: PropertyOption[];
}) {
  return (
    <>
      <tr className="border-t border-stone/40 bg-warm/40">
        <td
          colSpan={8}
          className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink/80"
        >
          {label}{" "}
          <span className="text-muted">({items.length})</span>
        </td>
      </tr>
      {items.map((c, i) => (
        <CredentialRow
          key={c.id}
          credential={c}
          properties={properties}
          striped={i % 2 === 1}
        />
      ))}
    </>
  );
}
