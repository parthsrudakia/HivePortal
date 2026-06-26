import Link from "next/link";
import { RunReconciliationForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default function NewReconciliationPage() {
  // Default to the current month.
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-stone/60 pb-6">
        <Link
          href="/reconciliation"
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          ← Reconciliation
        </Link>
        <h1 className="mt-2 text-3xl tracking-tight text-ink">
          New <span className="font-display text-accent-text">reconciliation</span> run
        </h1>
        <p className="mt-1 text-sm text-muted">
          Matches deposits against each tenant&apos;s expected rent using the{" "}
          <code>pays as</code> name. Tenants without a <code>pays as</code> value
          fall back to their full name.
        </p>
      </header>

      <div className="mt-8">
        <RunReconciliationForm defaultMonth={defaultMonth} />
      </div>
    </div>
  );
}
