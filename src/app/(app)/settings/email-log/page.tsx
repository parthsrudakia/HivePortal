import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EMAIL_TYPE_LABELS, type EmailType } from "@/lib/email-log";
import { resendUsage } from "@/lib/resend-quota";
import { isMaster, isOperator } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { ClearLogButton } from "../clear-log-button";
import { clearEmailLog } from "../log-actions";

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
  const user = await getSessionUser();
  const master = isMaster(user?.email);
  if (!isOperator(user?.email)) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Link
          href="/settings"
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          ← Admin Settings
        </Link>
        <p className="mt-6 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          The email log is restricted to the operators.
        </p>
      </div>
    );
  }

  const sp = await searchParams;
  const typeFilter = isType(sp.type) ? sp.type : null;
  const statusFilter =
    sp.status === "sent" || sp.status === "failed" ? sp.status : null;

  let query = supabase
    .from("email_log")
    .select("id, type, recipient, subject, status, error, context, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (typeFilter) query = query.eq("type", typeFilter);
  if (statusFilter) query = query.eq("status", statusFilter);

  // Resend free-tier usage: today's & this month's sends vs the caps, plus the
  // number of emails currently deferred to the queue. Counting fails open before
  // the migration is applied, so these read as 0 until db:push.
  const [usage, backlogRes, { data, error }] = await Promise.all([
    resendUsage(),
    supabase
      .from("email_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    query,
  ]);
  const backlog = (backlogRes?.count as number | null) ?? 0;
  const dailyPct = Math.min(
    100,
    Math.round((usage.today / Math.max(1, usage.dailyCap)) * 100),
  );
  const atDaily = usage.today >= usage.dailyCap;
  const atMonthly = usage.month >= usage.monthlyCap;

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
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone/60 pb-4">
        <div>
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
        </div>
        {master && <ClearLogButton onClear={clearEmailLog} label="email log" />}
      </header>

      <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-ink">Resend free-tier usage</h2>
            <p className="mt-1 max-w-md text-xs text-muted">
              Once a cap is hit, the rest of the day&apos;s emails are queued and
              sent the next day. Gmail (New York) sends don&apos;t count.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-5 text-right">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">Today</p>
              <p className={`text-lg font-semibold ${atDaily ? "text-accent-text" : "text-ink"}`}>
                {usage.today}
                <span className="text-sm font-normal text-muted"> / {usage.dailyCap}</span>
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">This month</p>
              <p className={`text-lg font-semibold ${atMonthly ? "text-accent-text" : "text-ink"}`}>
                {usage.month}
                <span className="text-sm font-normal text-muted"> / {usage.monthlyCap}</span>
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">Queued</p>
              <p className={`text-lg font-semibold ${backlog > 0 ? "text-accent-text" : "text-ink"}`}>
                {backlog}
              </p>
            </div>
          </div>
        </div>
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-warm">
          <div
            className={`h-full rounded-full ${atDaily ? "bg-accent-dark" : "bg-accent"}`}
            style={{ width: `${dailyPct}%` }}
          />
        </div>
        {(atDaily || atMonthly) && (
          <p className="mt-2 text-xs text-accent-text">
            {atDaily ? "Daily" : "Monthly"} limit reached — further emails are
            being queued{backlog > 0 ? ` (${backlog} waiting)` : ""} and will send
            on the next daily run.
          </p>
        )}
      </section>

      <div className="mt-6 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted">
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
          <span className="text-xs uppercase tracking-wide text-muted">
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
        <section className="mt-6 overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-stone/40">
          <table className="w-full text-sm">
            <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
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
                      <p className="text-xs text-muted">{r.context}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.status === "sent" ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-green-900">
                        Sent
                      </span>
                    ) : (
                      <span
                        title={r.error ?? undefined}
                        className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-red-900"
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
