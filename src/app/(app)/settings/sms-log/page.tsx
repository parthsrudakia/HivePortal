import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SMS_TYPE_LABELS, type SmsType } from "@/lib/sms-log";
import { isMaster, isOperator } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { ClearLogButton } from "../clear-log-button";
import { clearSmsLog } from "../log-actions";

export const dynamic = "force-dynamic";

type LogRow = {
  id: string;
  type: string;
  recipient: string;
  body: string | null;
  status: "sent" | "failed" | "skipped";
  error: string | null;
  context: string | null;
  created_at: string;
};

const TYPES = Object.keys(SMS_TYPE_LABELS) as SmsType[];

function isType(v: string | undefined): v is SmsType {
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

export default async function SmsLogPage({ searchParams }: PageProps) {
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
          The text log is restricted to the operators.
        </p>
      </div>
    );
  }

  const sp = await searchParams;
  const typeFilter = isType(sp.type) ? sp.type : null;
  const statusFilter =
    sp.status === "sent" || sp.status === "failed" || sp.status === "skipped"
      ? sp.status
      : null;

  let query = supabase
    .from("sms_log")
    .select("id, type, recipient, body, status, error, context, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (typeFilter) query = query.eq("type", typeFilter);
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data, error } = await query;
  const rows = (data ?? []) as LogRow[];

  const hrefWith = (next: { type?: string | null; status?: string | null }) => {
    const t = next.type === undefined ? typeFilter : next.type;
    const s = next.status === undefined ? statusFilter : next.status;
    const params = new URLSearchParams();
    if (t) params.set("type", t);
    if (s) params.set("status", s);
    const qs = params.toString();
    return qs ? `/settings/sms-log?${qs}` : "/settings/sms-log";
  };

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium transition ${
      active ? "bg-ink text-white" : "border border-stone text-ink hover:bg-warm"
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
            Text <span className="font-display text-accent-text">log</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every text the portal has sent, newest first (last 200).
          </p>
        </div>
        {master && <ClearLogButton onClear={clearSmsLog} label="text log" />}
      </header>

      <div className="mt-6 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted">For</span>
          <Link href={hrefWith({ type: null })} className={chip(!typeFilter)}>
            All
          </Link>
          {TYPES.map((t) => (
            <Link key={t} href={hrefWith({ type: t })} className={chip(typeFilter === t)}>
              {SMS_TYPE_LABELS[t]}
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
          <Link href={hrefWith({ status: "skipped" })} className={chip(statusFilter === "skipped")}>
            Skipped
          </Link>
        </div>
      </div>

      {error && (
        <p className="mt-6 rounded-2xl bg-white px-6 py-8 text-center text-sm text-muted shadow-sm">
          The text log isn&apos;t available yet. Apply the <code>sms_log</code>{" "}
          migration (<code>npm run db:push</code>) to start recording sent texts.
        </p>
      )}

      {!error && rows.length === 0 && (
        <p className="mt-6 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          No texts logged{typeFilter || statusFilter ? " for this filter" : " yet"}.
        </p>
      )}

      {!error && rows.length > 0 && (
        <section className="mt-6 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-stone/40">
          <table className="w-full text-sm">
            <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Sent</th>
                <th className="px-4 py-2 font-medium">For</th>
                <th className="px-4 py-2 font-medium">To</th>
                <th className="px-4 py-2 font-medium">Message</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-stone/30 align-top">
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                    {fmtWhen(r.created_at)}
                  </td>
                  <td className="px-4 py-2.5 text-ink">
                    {SMS_TYPE_LABELS[r.type as SmsType] ?? r.type}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-ink">
                    {r.recipient}
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="max-w-md text-ink">{r.body ?? "—"}</p>
                    {r.context && (
                      <p className="mt-0.5 text-xs text-muted">{r.context}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.status === "sent" ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-green-900">
                        Sent
                      </span>
                    ) : r.status === "skipped" ? (
                      <span
                        title={r.error ?? undefined}
                        className="rounded-full bg-warm px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted"
                      >
                        Skipped
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
