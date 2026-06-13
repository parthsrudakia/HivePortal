import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import { EMAIL_TYPE_LABELS, type EmailType } from "@/lib/email-log";

export const dynamic = "force-dynamic";

type LogRow = {
  id: string;
  type: string;
  recipient: string;
  subject: string | null;
  status: "sent" | "failed";
  error: string | null;
  context: string | null;
  created_at: string;
};

const TYPES = Object.keys(EMAIL_TYPE_LABELS) as EmailType[];

function isType(v: string | undefined): v is EmailType {
  return !!v && (TYPES as string[]).includes(v);
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type PageProps = {
  searchParams: Promise<{ type?: string; status?: string }>;
};

export default async function EmailLogPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isMaster(user?.email)) redirect("/");

  const sp = await searchParams;
  const typeFilter = isType(sp.type) ? sp.type : null;
  const statusFilter =
    sp.status === "sent" || sp.status === "failed" ? sp.status : null;

  // email_log is new; types.ts is regenerated after the migration push.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabase as any)
    .from("email_log")
    .select("id, type, recipient, subject, status, error, context, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (typeFilter) query = query.eq("type", typeFilter);
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data, error } = await query;
  const rows = (data ?? []) as LogRow[];

  // Build a filter href that swaps one param while keeping the other.
  const hrefWith = (next: { type?: string | null; status?: string | null }) => {
    const t = next.type === undefined ? typeFilter : next.type;
    const s = next.status === undefined ? statusFilter : next.status;
    const params = new URLSearchParams();
    if (t) params.set("type", t);
    if (s) params.set("status", s);
    const qs = params.toString();
    return qs ? `/settings/email-log?${qs}` : "/settings/email-log";
  };

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium transition ${
      active
        ? "bg-ink text-white"
        : "border border-stone text-ink hover:bg-warm"
    }`;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="border-b border-stone/60 pb-4">
        <Link
          href="/settings"
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          ← Admin Settings
        </Link>
        <h1 className="mt-2 text-3xl tracking-tight text-ink">
          Email <span className="font-display text-accent-text">log</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Every email the portal has sent, newest first (last 200).
        </p>
      </header>

      <div className="mt-6 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            For
          </span>
          <Link href={hrefWith({ type: null })} className={chip(!typeFilter)}>
            All
          </Link>
          {TYPES.map((t) => (
            <Link key={t} href={hrefWith({ type: t })} className={chip(typeFilter === t)}>
              {EMAIL_TYPE_LABELS[t]}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            Status
          </span>
          <Link href={hrefWith({ status: null })} className={chip(!statusFilter)}>
            All
          </Link>
          <Link href={hrefWith({ status: "sent" })} className={chip(statusFilter === "sent")}>
            Sent
          </Link>
          <Link href={hrefWith({ status: "failed" })} className={chip(statusFilter === "failed")}>
            Failed
          </Link>
        </div>
      </div>

      {error && (
        <p className="mt-6 rounded-2xl bg-white px-6 py-8 text-center text-sm text-muted shadow-sm">
          The email log isn&apos;t available yet. Apply the{" "}
          <code>email_log</code> migration (<code>npm run db:push</code>) to start
          recording sent emails.
        </p>
      )}

      {!error && rows.length === 0 && (
        <p className="mt-6 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          No emails logged{typeFilter || statusFilter ? " for this filter" : " yet"}.
        </p>
      )}

      {!error && rows.length > 0 && (
        <section className="mt-6 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-stone/40">
          <table className="w-full text-sm">
            <thead className="bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Sent</th>
                <th className="px-4 py-2 font-medium">For</th>
                <th className="px-4 py-2 font-medium">To</th>
                <th className="px-4 py-2 font-medium">Subject</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-stone/30">
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                    {fmtWhen(r.created_at)}
                  </td>
                  <td className="px-4 py-2.5 text-ink">
                    {EMAIL_TYPE_LABELS[r.type as EmailType] ?? r.type}
                  </td>
                  <td className="px-4 py-2.5 text-ink">{r.recipient}</td>
                  <td className="px-4 py-2.5">
                    <p className="text-ink">{r.subject ?? "—"}</p>
                    {r.context && (
                      <p className="text-[11px] text-muted">{r.context}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.status === "sent" ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-green-900">
                        Sent
                      </span>
                    ) : (
                      <span
                        title={r.error ?? undefined}
                        className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-red-900"
                      >
                        Failed
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
