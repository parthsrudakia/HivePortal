import Link from "next/link";
import { TenantsApiDocs } from "@/components/docs/tenants-api-docs";
import { InventoryApiDocs } from "@/components/docs/inventory-api-docs";
import { UtilitiesApiDocs } from "@/components/docs/utilities-api-docs";
import { DevelopersTabs } from "./tabs";

export const metadata = {
  title: "Developers — Hive",
  description:
    "API reference for Hive's JSON APIs: tenants, inventory, and utility statement intake.",
};

/**
 * Public API reference hub — no login required ("/developers" is whitelisted
 * in src/lib/supabase/proxy.ts, like "/docs"). Docs only: keys live in the
 * server environment and example payloads are fictional. Content components
 * in src/components/docs/ are shared with /docs/inventory-api; the tab
 * switcher lives in ./tabs.tsx.
 */
export default function DevelopersPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="border-b border-stone/60 pb-4">
        <p className="text-xs uppercase tracking-wide text-muted">
          Hive / API reference
        </p>
        <h1 className="mt-1 text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Developers</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          JSON APIs for internal tools and scripts. Every API needs
          its own bearer token, issued by Hive — tokens are never shown here.
        </p>
      </header>

      <DevelopersTabs
        tenants={
          <>
            <h2 className="mt-8 text-2xl tracking-tight text-ink">
              Tenants <span className="font-display text-accent-text">API</span>
            </h2>
            <p className="mt-1 text-sm text-muted">
              Tenant contact info — name, email, phone, unit, room — for
              active tenancies. Returns PII; its token is separate from the
              inventory token on purpose.
            </p>
            <TenantsApiDocs />
          </>
        }
        inventory={
          <>
            <h2 className="mt-8 text-2xl tracking-tight text-ink">
              Inventory{" "}
              <span className="font-display text-accent-text">API</span>
            </h2>
            <p className="mt-1 text-sm text-muted">
              Rooms currently in inventory with core listing data (no tenant
              data). Also documented at{" "}
              <Link
                href="/docs/inventory-api"
                className="text-accent-text underline decoration-accent/40 underline-offset-2 hover:text-accent-dark"
              >
                /docs/inventory-api
              </Link>
              .
            </p>
            <InventoryApiDocs />
          </>
        }
        utilities={
          <>
            <h2 className="mt-8 text-2xl tracking-tight text-ink">
              Utilities{" "}
              <span className="font-display text-accent-text">API</span>
            </h2>
            <p className="mt-1 text-sm text-muted">
              Statement intake for the statements agent: send a utility
              statement with the fields you read from it, and it lands in
              the utilities log. Write access to that log only.
            </p>
            <UtilitiesApiDocs />
          </>
        }
      />
    </div>
  );
}
