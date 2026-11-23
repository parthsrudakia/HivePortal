import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/section-access";
import { KPI_DICTIONARY } from "@/lib/sales-kpis";
import { SalesKpis } from "./sales-kpis";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "KPIs" };

type PageProps = {
  // Filters (k_acct, k_range, …) — see KPI_PARAMS in @/lib/sales-kpis.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * KPIs module. Not a section: nobody sees it until Vineet grants the
 * 'sales_kpis' permission at Settings → Access control (RLS on the KPI
 * tables enforces the same permission).
 */
export default async function KpisPage({ searchParams }: PageProps) {
  if (!(await hasPermission("sales_kpis"))) notFound();
  const params = await searchParams;

  return (
    <div className="mx-auto w-full max-w-none">
      <header className="border-b border-stone/60 pb-6">
        <h1 className="text-3xl tracking-tight text-ink">
          Sales <span className="font-display text-accent-text">KPIs</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          How each account and each day is handling leads, as reported by the sales agents.
        </p>
      </header>

      {/* What each number means — closed until someone needs it. */}
      <details className="group mt-6 rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
        <summary className="flex cursor-pointer select-none list-none items-center gap-2 rounded-xl px-4 py-3 transition hover:bg-cream/60 [&::-webkit-details-marker]:hidden">
          <span className="text-xs text-accent-text transition-transform group-open:rotate-90" aria-hidden>
            ▶
          </span>
          <h2 className="text-sm uppercase tracking-wide text-muted">
            KPI <span className="font-display text-base normal-case italic text-accent-text">dictionary</span>
          </h2>
          <span className="ml-auto text-xs text-muted">What each KPI means</span>
        </summary>
        <div className="grid gap-6 border-t border-stone/30 px-4 py-4 lg:grid-cols-2">
          {KPI_DICTIONARY.map((g) => (
            <section key={g.group}>
              <h3 className="text-sm font-semibold text-ink">{g.group}</h3>
              <p className="text-xs text-muted">{g.about}</p>
              <dl className="mt-2 space-y-2 text-sm">
                {g.items.map((k) => (
                  <div key={k.name} className="rounded-lg bg-cream px-3 py-2">
                    <dt className="font-medium text-ink">{k.name}</dt>
                    <dd className="mt-0.5 text-ink/80">{k.meaning}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </details>

      <SalesKpis params={params} />
    </div>
  );
}
