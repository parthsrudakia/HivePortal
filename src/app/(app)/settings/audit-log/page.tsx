import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";

export const dynamic = "force-dynamic";

const ACTION_LABEL: Record<string, string> = {
  insert: "Created",
  update: "Updated",
  delete: "Deleted",
};

const ACTION_PILL: Record<string, string> = {
  insert: "bg-green-100 text-green-900",
  update: "bg-warm text-ink/70",
  delete: "bg-red-100 text-red-900",
};

const TABLE_LABEL: Record<string, string> = {
  properties: "Properties",
  rooms: "Rooms",
  tenants: "Tenants",
  tenancies: "Tenancies",
  payments: "Payments",
  cleaning_records: "Cleaning records",
  credentials: "Credentials",
  leaseholders: "Leaseholders",
  cleaners: "Cleaners",
  notification_recipients: "Notification recipients",
};

const KNOWN_TABLES = Object.keys(TABLE_LABEL);
const KNOWN_ACTIONS = ["insert", "update", "delete"] as const;

const PAGE_SIZE = 50;

type AuditRow = {
  id: string;
  user_id: string | null;
  user_email: string | null;
  action: "insert" | "update" | "delete";
  table_name: string;
  record_id: string | null;
  changed_columns: string[] | null;
  created_at: string;
};

type SearchParams = Promise<{
  table?: string;
  action?: string;
  page?: string;
}>;

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isMaster(user?.email)) {
    redirect("/");
  }

  const sp = await searchParams;
  const tableFilter =
    typeof sp.table === "string" && KNOWN_TABLES.includes(sp.table)
      ? sp.table
      : null;
  const actionFilter =
    typeof sp.action === "string" &&
    (KNOWN_ACTIONS as readonly string[]).includes(sp.action)
      ? (sp.action as (typeof KNOWN_ACTIONS)[number])
      : null;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let q = supabase
    .from("audit_log")
    .select(
      "id, user_id, user_email, action, table_name, record_id, changed_columns, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (tableFilter) q = q.eq("table_name", tableFilter);
  if (actionFilter) q = q.eq("action", actionFilter);

  const { data, count } = await q;
  const rows = (data ?? []) as AuditRow[];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const baseHref = (overrides: Record<string, string | null>): string => {
    const params = new URLSearchParams();
    const t = "table" in overrides ? overrides.table : tableFilter;
    const a = "action" in overrides ? overrides.action : actionFilter;
    const p = "page" in overrides ? overrides.page : null;
    if (t) params.set("table", t);
    if (a) params.set("action", a);
    if (p) params.set("page", p);
    const qs = params.toString();
    return qs ? `/settings/audit-log?${qs}` : "/settings/audit-log";
  };

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="border-b border-stone/60 pb-4">
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Audit log</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Every insert, update, and delete across the operational tables.
          Captures who made the change via Supabase Auth.
        </p>
      </header>

      <form
        method="get"
        className="mt-6 flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4 shadow-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            Table
          </span>
          <select
            name="table"
            defaultValue={tableFilter ?? ""}
            className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
            <option value="">All tables</option>
            {KNOWN_TABLES.map((t) => (
              <option key={t} value={t}>
                {TABLE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            Action
          </span>
          <select
            name="action"
            defaultValue={actionFilter ?? ""}
            className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
            <option value="">Any</option>
            {KNOWN_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-accent-dark"
        >
          Apply
        </button>
        {(tableFilter || actionFilter) && (
          <Link
            href="/settings/audit-log"
            className="text-xs uppercase tracking-wide text-muted hover:text-ink"
          >
            Clear
          </Link>
        )}
        <span className="ml-auto text-xs text-muted">
          {total.toLocaleString()} event{total === 1 ? "" : "s"}
        </span>
      </form>

      <section className="mt-6 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Table</th>
              <th className="px-3 py-2 font-medium">Record id</th>
              <th className="px-3 py-2 font-medium">Fields changed</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-sm text-muted"
                >
                  No audit entries match this filter.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr
                key={r.id}
                className={`border-t border-stone/30 ${i % 2 === 1 ? "bg-cream/40" : "bg-white"}`}
              >
                <td className="px-3 py-2 text-muted tabular-nums">
                  {fmtWhen(r.created_at)}
                </td>
                <td className="px-3 py-2 text-ink">
                  {r.user_email ?? (
                    <span className="text-muted">system</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${ACTION_PILL[r.action]}`}
                  >
                    {ACTION_LABEL[r.action]}
                  </span>
                </td>
                <td className="px-3 py-2 text-ink">
                  {TABLE_LABEL[r.table_name] ?? r.table_name}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted">
                  {r.record_id ? r.record_id.slice(0, 8) : "—"}
                </td>
                <td className="px-3 py-2 text-[12px] text-ink">
                  {r.action === "update" && r.changed_columns?.length
                    ? r.changed_columns.join(", ")
                    : r.action === "insert"
                      ? <span className="text-muted">(new row)</span>
                      : <span className="text-muted">(deleted)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-xs text-muted">
          <div>
            Page {page} of {totalPages}
          </div>
          <div className="flex items-center gap-3">
            {page > 1 && (
              <Link
                href={baseHref({ page: String(page - 1) })}
                className="rounded-full border border-stone bg-white px-3 py-1 text-ink hover:bg-warm"
              >
                ← Newer
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={baseHref({ page: String(page + 1) })}
                className="rounded-full border border-stone bg-white px-3 py-1 text-ink hover:bg-warm"
              >
                Older →
              </Link>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
