import { cache, Suspense } from "react";
import { getCachedClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { one } from "@/lib/relations";
import { unitLabel as propertyLabel } from "@/lib/unit-label";
import { SearchInput } from "@/components/search-input";
import { TableSkeleton } from "@/components/section-skeletons";
import { AddCredential } from "./add-credential";
import {
  CredentialsExplorer,
  type CredentialExplorerRow,
} from "./credentials-explorer";
import { CATEGORY_LABELS, type PropertyOption } from "./constants";
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
  password_cipher: string | null;
  login_url: string | null;
  account_number: string | null;
  owner_label: string | null;
  notes: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};

const getPropertyOptions = cache(async (): Promise<PropertyOption[]> => {
  const supabase = await getCachedClient();
  const { data } = await supabase
    .from("properties")
    .select("id, building_name, street_address, unit_number")
    .order("street_address", { ascending: true });
  return (data ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
  }));
});

async function AddCredentialSlot() {
  const [user, propertyOptions] = await Promise.all([
    getSessionUser(),
    getPropertyOptions(),
  ]);
  if (!isMaster(user?.email)) return null;
  return <AddCredential properties={propertyOptions} />;
}

async function CredentialsSection() {
  const supabase = await getCachedClient();

  const [user, propertyOptions, { data: credentials }] = await Promise.all([
    getSessionUser(),
    getPropertyOptions(),
    supabase
      .from("credentials")
      .select(
        `id, category, service_name, property_id, username, password_cipher,
         login_url, account_number, owner_label, notes,
         properties(building_name, street_address, unit_number)`,
      )
      .order("category", { ascending: true })
      .order("service_name", { ascending: true })
      .returns<Row[]>(),
  ]);

  // Only admins (masters) can reveal/copy passwords or manage credentials;
  // the plaintext is fetched on demand and never shipped with the page.
  const admin = isMaster(user?.email);

  const all: CredentialExplorerRow[] = (credentials ?? []).map((c) => {
    const p = one(c.properties);
    const property_label = p ? propertyLabel(p) : null;
    return {
      id: c.id,
      category: c.category,
      service_name: c.service_name,
      property_id: c.property_id,
      property_label,
      username: c.username,
      hasPassword: !!c.password_cipher,
      login_url: c.login_url,
      account_number: c.account_number,
      owner_label: c.owner_label,
      notes: c.notes,
      haystack: [
        c.service_name,
        property_label,
        c.owner_label,
        c.username,
        c.account_number,
        c.login_url,
        c.notes,
        CATEGORY_LABELS[c.category],
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });

  return (
    <CredentialsExplorer
      all={all}
      properties={propertyOptions}
      admin={admin}
    />
  );
}

export default function CredentialsPage() {
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
        <Suspense fallback={null}>
          <AddCredentialSlot />
        </Suspense>
      </header>

      <div className="mt-4">
        <SearchInput
          placeholder="Search by service, property, username, account, owner…"
          ariaLabel="Search credentials"
        />
      </div>

      <Suspense
        fallback={
          <div className="mt-6">
            <TableSkeleton />
          </div>
        }
      >
        <CredentialsSection />
      </Suspense>
    </div>
  );
}
