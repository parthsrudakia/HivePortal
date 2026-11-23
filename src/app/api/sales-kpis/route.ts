/**
 * Sales KPI intake for the lead-handling agents (Grok and others).
 *
 *   POST /api/sales-kpis   one account per call: daily history + open threads
 *   GET  /api/sales-kpis   accounts on file, each with the last day stored
 *                          (?account= narrows to one name), so an agent knows
 *                          where to resume its incremental sends
 *
 * Accounts are told apart by `account_name` (case-insensitive). The first
 * call dumps every past day the agent has; later calls send only new or
 * corrected days — a day re-sent for the same account + platform + agent
 * replaces the stored one. `open` (threads waiting on us, leads never
 * answered) is "right now" state and replaces the previous `open` for that
 * account + platform + agent; omit it to leave it unchanged.
 *
 * Auth: static bearer token `SALES_KPIS_API_KEY` — its own key, so agents
 * holding it can't read tenant PII or anything else. Writes go through the
 * service role and only touch sales_kpi_days / sales_kpi_streams.
 *
 * Docs: /developers (Sales KPIs tab) — keep in sync when this changes.
 */

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { requireBearer } from "@/lib/api-auth";
import { SalesKpiPayloadSchema, accountKey, streamOf, toDayRows } from "@/lib/sales-kpis";

export const dynamic = "force-dynamic";

const API_KEY = "SALES_KPIS_API_KEY";
const CHUNK = 500;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const fail = (status: number, error: string, extra?: Record<string, unknown>) =>
  NextResponse.json({ error, ...extra }, { status });

export async function POST(req: Request) {
  const denied = requireBearer(req, API_KEY);
  if (denied) return denied;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail(400, "Body must be JSON.");
  }
  const parsed = SalesKpiPayloadSchema.safeParse(json);
  if (!parsed.success)
    return fail(400, "Payload is invalid; nothing was saved.", {
      issues: parsed.error.issues.map((x) => ({ path: x.path.join("."), message: x.message })),
    });

  const payload = parsed.data;
  const sb = admin();
  const now = new Date().toISOString();
  const stream = streamOf(payload);

  const dayRows = toDayRows(payload, now);
  for (let i = 0; i < dayRows.length; i += CHUNK) {
    const { error } = await sb
      .from("sales_kpi_days")
      .upsert(dayRows.slice(i, i + CHUNK), { onConflict: "account_key,platform,agent,day" });
    if (error)
      return fail(500, `Failed to save days: ${error.message}`, {
        // Chunks before this one are stored; re-sending the call is safe.
        saved_days: i,
      });
  }

  const { error: streamError } = await sb.from("sales_kpi_streams").upsert(
    {
      ...stream,
      last_received_at: now,
      ...(payload.open
        ? {
            waiting_on_us: [...(payload.open.waiting_on_us ?? [])].sort(
              (a, b) => b.days_waiting - a.days_waiting,
            ),
            never_answered_leads: payload.open.never_answered_leads ?? [],
            open_as_of: payload.open.as_of ?? now,
          }
        : {}),
    },
    { onConflict: "account_key,platform,agent" },
  );
  if (streamError)
    return fail(500, `Failed to save account: ${streamError.message}`, { saved_days: dayRows.length });

  revalidatePath("/inventory");
  const sortedDays = dayRows.map((d) => d.day).sort();
  return NextResponse.json({
    account_name: stream.account_name,
    platform: stream.platform || null,
    agent: stream.agent,
    saved_days: dayRows.length,
    first_day: sortedDays[0] ?? null,
    last_day: sortedDays.at(-1) ?? null,
    open_updated: !!payload.open,
  });
}

export async function GET(req: Request) {
  const denied = requireBearer(req, API_KEY);
  if (denied) return denied;

  const account = new URL(req.url).searchParams.get("account")?.trim();
  const sb = admin();
  let q = sb
    .from("sales_kpi_streams")
    .select("account_key, account_name, platform, agent, open_as_of, last_received_at")
    .order("account_key");
  if (account) q = q.eq("account_key", accountKey(account));
  const { data: streams, error } = await q;
  if (error) return fail(500, `Failed to load accounts: ${error.message}`);

  const accounts = [];
  for (const s of streams) {
    const { data: last, error: dayError } = await sb
      .from("sales_kpi_days")
      .select("day")
      .eq("account_key", s.account_key)
      .eq("platform", s.platform)
      .eq("agent", s.agent)
      .order("day", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dayError) return fail(500, `Failed to load coverage: ${dayError.message}`);
    accounts.push({
      account_name: s.account_name,
      platform: s.platform || null,
      agent: s.agent,
      last_day: last?.day ?? null,
      open_as_of: s.open_as_of,
      last_received_at: s.last_received_at,
    });
  }
  return NextResponse.json({ accounts });
}
