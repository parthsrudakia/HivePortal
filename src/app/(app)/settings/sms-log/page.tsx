import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SMS_TYPE_LABELS, type SmsType } from "@/lib/sms-log";
import { getSmsOptStatus, smsConfigured, type SmsOptResult } from "@/lib/sms";
import { resolveRecipientPhone } from "@/lib/sms-recipient";
import { isMaster, isOperator } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { ClearLogButton } from "../clear-log-button";
import { LogFilters } from "../log-filters";
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
  searchParams: Promise<{ type?: string; status?: string; check?: string }>;
};

type OptCheck =
  | { input: string; tenantName: string | null; result: SmsOptResult }
  | { input: string; tenantName: null; result: { ok: false; error: string } };

/** Page URL keeping the current filters, with the opt-out lookup set or cleared. */
function pageHref(
  type: SmsType | null,
  status: string | null,
  check?: string,
): string {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (status) params.set("status", status);
  if (check) params.set("check", check);
  const qs = params.toString();
  return qs ? `/settings/sms-log?${qs}` : "/settings/sms-log";
}

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

  // Opt-out lookup: `?check=<phone or tenant name>` asks Zoom whether that
  // number replied STOP. Zoom blocks opted-out numbers itself, so their texts
  // still log as "sent" here — this is how an operator finds out.
  const checkInput = sp.check?.trim() ?? "";
  let optCheck: OptCheck | null = null;
  if (checkInput) {
    const resolved = await resolveRecipientPhone(supabase, checkInput);
    optCheck = resolved.ok
      ? {
          input: checkInput,
          tenantName: resolved.tenantName,
          result: await getSmsOptStatus(resolved.phone),
        }
      : { input: checkInput, tenantName: null, result: { ok: false, error: resolved.error } };
  }


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

      <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-sm font-medium text-ink">
          Check <span className="font-display italic text-accent-text">opt-out</span> status
        </h2>
        <p className="mt-1 text-xs text-muted">
          Zoom blocks any number that replied STOP to our texts, and those sends still show as
          &ldquo;sent&rdquo; below. Look a number or tenant up to see whether Zoom is delivering to them.
          Only the tenant can lift a block, by texting START to our number.
        </p>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
          {typeFilter && <input type="hidden" name="type" value={typeFilter} />}
          {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
          <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">Phone or tenant name</span>
            <input
              type="text"
              name="check"
              defaultValue={checkInput}
              placeholder="(609) 555-0123 or Jane Doe"
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={!smsConfigured()}
            className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            Check
          </button>
          {checkInput && (
            <Link
              href={pageHref(typeFilter, statusFilter)}
              className="pb-2.5 text-xs uppercase tracking-wide text-muted hover:text-ink"
            >
              Clear
            </Link>
          )}
        </form>
        {!smsConfigured() && (
          <p className="mt-2 text-xs text-muted">Texting isn&apos;t configured on this deployment.</p>
        )}
        {optCheck && <OptCheckResult check={optCheck} />}
      </section>

      <div className="mt-6">
        <LogFilters
          typeOptions={TYPES.map((t) => ({ value: t, label: SMS_TYPE_LABELS[t] }))}
          statusOptions={[
            { value: "sent", label: "Sent" },
            { value: "failed", label: "Failed" },
            { value: "skipped", label: "Skipped" },
          ]}
          type={typeFilter}
          status={statusFilter}
        />
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
        <section className="mt-6 overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-stone/40">
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
                    {r.recipient.includes(",") ? (
                      r.recipient
                    ) : (
                      <Link
                        href={pageHref(typeFilter, statusFilter, r.recipient)}
                        title="Check opt-out status with Zoom"
                        className="underline decoration-stone underline-offset-2 hover:text-accent-text"
                      >
                        {r.recipient}
                      </Link>
                    )}
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

function OptCheckResult({ check }: { check: OptCheck }) {
  const { result } = check;
  const who = check.tenantName ? `${check.tenantName} · ` : "";
  if (!result.ok) {
    return (
      <div className="mt-4 rounded-xl bg-warm/60 px-4 py-3 text-sm text-ink">
        <p>
          <span className="font-medium">{who}{check.input}</span>
        </p>
        <p className="mt-0.5 text-muted">{result.error}</p>
      </div>
    );
  }
  return (
    <div
      className={`mt-4 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm ${
        result.optedOut ? "bg-red-50 text-red-900" : "bg-green-50 text-green-900"
      }`}
    >
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${
          result.optedOut ? "bg-red-100" : "bg-green-100"
        }`}
      >
        {result.optedOut ? "Opted out" : "Opted in"}
      </span>
      <span className="font-medium">{who}{result.phone}</span>
      <span className="text-xs opacity-80">
        {result.optedOut
          ? `Replied STOP to ${result.sender}. Zoom is blocking our texts to this number until they text START.`
          : `Zoom is delivering our texts from ${result.sender} to this number.`}
      </span>
    </div>
  );
}
