import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import {
  TELEGRAM_KIND_LABELS,
  type TelegramLogKind,
} from "@/lib/telegram-log";
import { ClearLogButton } from "../clear-log-button";
import { clearTelegramLog } from "../log-actions";

export const dynamic = "force-dynamic";

type LogRow = {
  id: number;
  turn_id: string | null;
  chat_id: number;
  telegram_user_id: number | null;
  username: string | null;
  kind: TelegramLogKind;
  tool_name: string | null;
  ok: boolean | null;
  latency_ms: number | null;
  error: string | null;
  text: string | null;
  detail: unknown;
  created_at: string;
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtLatency(ms: number | null): string | null {
  if (ms == null) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function isFailure(r: LogRow): boolean {
  return r.kind === "agent_error" || (r.kind === "tool_call" && r.ok === false);
}

/** A collapsible pretty-printed JSON block for a row's structured detail. */
function DetailBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  const json =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-accent-text hover:underline">
        {label}
      </summary>
      <pre className="mt-1 max-h-96 overflow-auto rounded-lg bg-ink/[0.03] p-3 text-[11px] leading-relaxed text-ink ring-1 ring-stone/40">
        {json}
      </pre>
    </details>
  );
}

const KIND_BADGE: Record<TelegramLogKind, string> = {
  user_message: "bg-warm text-ink",
  assistant_reply: "bg-accent/15 text-accent-text",
  tool_call: "bg-blue-100 text-blue-900",
  agent_error: "bg-red-100 text-red-900",
  slash_command: "bg-stone/30 text-ink",
  rejected: "bg-red-100 text-red-900",
};

function EventRow({ r }: { r: LogRow }) {
  const latency = fmtLatency(r.latency_ms);
  const failed = isFailure(r);
  return (
    <li
      className={`rounded-lg px-3 py-2 ${
        failed ? "bg-red-50 ring-1 ring-red-200" : "bg-white"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 font-medium ${KIND_BADGE[r.kind]}`}
        >
          {r.tool_name
            ? r.tool_name
            : TELEGRAM_KIND_LABELS[r.kind] ?? r.kind}
        </span>
        {r.kind === "tool_call" && r.ok === false && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold uppercase tracking-wide text-red-900">
            failed
          </span>
        )}
        {r.kind === "tool_call" && r.ok === true && (
          <span className="rounded-full bg-green-100 px-2 py-0.5 font-semibold uppercase tracking-wide text-green-900">
            ok
          </span>
        )}
        {latency && <span className="text-muted">{latency}</span>}
        <span className="ml-auto text-muted">{fmtWhen(r.created_at)}</span>
      </div>

      {r.text && (
        <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{r.text}</p>
      )}
      {r.error && (
        <p className="mt-1 whitespace-pre-wrap text-sm font-medium text-red-900">
          {r.error}
        </p>
      )}
      <DetailBlock label="Details" value={r.detail} />
    </li>
  );
}

type PageProps = {
  searchParams: Promise<{ failed?: string }>;
};

export default async function TelegramLogPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const master = isMaster(user?.email);

  if (!master) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Link
          href="/settings"
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          ← Admin Settings
        </Link>
        <p className="mt-6 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          The Telegram bot log is restricted to the master operator.
        </p>
      </div>
    );
  }

  const sp = await searchParams;
  const failedOnly = sp.failed === "1";

  // telegram_activity_log post-dates the generated types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("telegram_activity_log")
    .select(
      "id, turn_id, chat_id, telegram_user_id, username, kind, tool_name, ok, latency_ms, error, text, detail, created_at",
    )
    .order("id", { ascending: false })
    .limit(500);
  const rows = (data ?? []) as LogRow[];

  // Group rows into turns (shared turn_id). Rows without a turn_id (e.g. a
  // rejected sender) each stand alone. Turns are ordered newest-first by their
  // most recent event; events within a turn read top-to-bottom in order.
  const groups = new Map<string, LogRow[]>();
  for (const r of rows) {
    const key = r.turn_id ?? `solo-${r.id}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  let turns = Array.from(groups.values()).map((evs) =>
    evs.slice().sort((a, b) => a.id - b.id),
  );
  if (failedOnly) turns = turns.filter((evs) => evs.some(isFailure));

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium transition ${
      active ? "bg-ink text-white" : "border border-stone text-ink hover:bg-warm"
    }`;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone/60 pb-4">
        <div>
          <Link
            href="/settings"
            className="text-xs uppercase tracking-wide text-muted hover:text-ink"
          >
            ← Admin Settings
          </Link>
          <h1 className="mt-2 text-3xl tracking-tight text-ink">
            Telegram bot{" "}
            <span className="font-display text-accent-text">log</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every bot turn grouped by conversation exchange, newest first — the
            operator&apos;s message, each tool call with its input and result,
            the reply, and any error. Use this to see exactly what the bot did.
          </p>
        </div>
        <ClearLogButton onClear={clearTelegramLog} label="Telegram bot log" />
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted">Show</span>
        <Link href="/settings/telegram-log" className={chip(!failedOnly)}>
          All turns
        </Link>
        <Link
          href="/settings/telegram-log?failed=1"
          className={chip(failedOnly)}
        >
          Only turns with errors
        </Link>
      </div>

      {error && (
        <p className="mt-6 rounded-2xl bg-white px-6 py-8 text-center text-sm text-muted shadow-sm">
          The Telegram bot log isn&apos;t available yet. Apply the{" "}
          <code>telegram_activity_log</code> migration (
          <code>npm run db:push</code>) to start recording bot activity.
        </p>
      )}

      {!error && turns.length === 0 && (
        <p className="mt-6 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          No bot activity logged
          {failedOnly ? " with errors" : " yet"}.
        </p>
      )}

      {!error && turns.length > 0 && (
        <div className="mt-6 space-y-4">
          {turns.map((evs) => {
            const first = evs[0];
            const hasFailure = evs.some(isFailure);
            const who =
              first.username != null
                ? `@${first.username}`
                : first.telegram_user_id != null
                  ? `user ${first.telegram_user_id}`
                  : `chat ${first.chat_id}`;
            return (
              <section
                key={first.turn_id ?? `solo-${first.id}`}
                className={`overflow-hidden rounded-2xl bg-white p-4 shadow-sm ring-1 ${
                  hasFailure ? "ring-red-200" : "ring-stone/40"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 border-b border-stone/30 pb-2 text-xs text-muted">
                  <span className="font-medium text-ink">{who}</span>
                  <span>·</span>
                  <span>{fmtWhen(first.created_at)}</span>
                  {hasFailure && (
                    <span className="ml-auto rounded-full bg-red-100 px-2 py-0.5 font-semibold uppercase tracking-wide text-red-900">
                      had an error
                    </span>
                  )}
                </div>
                <ul className="mt-2 space-y-2">
                  {evs.map((r) => (
                    <EventRow key={r.id} r={r} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
