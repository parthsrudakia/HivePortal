/**
 * Utility coverage for the statements agent — `GET /api/utilities/coverage`.
 *
 * Tells the agent, per unit and per utility account, the last billing period
 * already in the log, so it downloads only statements that end after it.
 * Units with nothing logged come back with an empty `coverage` list; bills
 * not yet assigned to a unit are listed under `unassigned`.
 *
 * Same `UTILITIES_API_KEY` as the intake endpoint. Read-only; returns no
 * tenant data. Docs: /developers (Utilities tab) — keep in sync.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { requireBearer } from "@/lib/api-auth";
import { todayISO } from "@/lib/date";

export const dynamic = "force-dynamic";

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type BillLite = {
  property_id: string | null;
  provider: string | null;
  utility_type: string;
  account_number: string | null;
  period_end: string | null;
  statement_date: string | null;
};

type Coverage = {
  provider: string | null;
  utility_type: string;
  account_number: string | null;
  last_period_end: string | null;
  last_statement_date: string | null;
  bills_logged: number;
};

const maxDate = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a > b ? a : b;

/** One entry per (account, utility type); bills with no account number
 *  group by provider instead. */
function summarize(bills: BillLite[]): Coverage[] {
  const groups = new Map<string, Coverage>();
  for (const b of bills) {
    const acct = b.account_number?.replace(/\D/g, "") || null;
    const key = `${acct ?? `provider:${b.provider ?? ""}`}|${b.utility_type}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        provider: b.provider,
        utility_type: b.utility_type,
        account_number: b.account_number,
        last_period_end: b.period_end,
        last_statement_date: b.statement_date,
        bills_logged: 1,
      });
    } else {
      g.last_period_end = maxDate(g.last_period_end, b.period_end);
      g.last_statement_date = maxDate(g.last_statement_date, b.statement_date);
      g.bills_logged += 1;
    }
  }
  return [...groups.values()].sort((a, b) =>
    `${a.provider}${a.utility_type}`.localeCompare(`${b.provider}${b.utility_type}`),
  );
}

export async function GET(req: Request) {
  const denied = requireBearer(req, "UTILITIES_API_KEY");
  if (denied) return denied;

  const sb = admin();

  const { data: props, error: propErr } = await sb
    .from("properties")
    .select("id, building_name, street_address, unit_number")
    .is("archived_at", null);
  if (propErr) return NextResponse.json({ error: propErr.message }, { status: 500 });

  // Page through every bill — PostgREST caps a single response.
  const PAGE = 1000;
  const bills: BillLite[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("utility_bills")
      .select("property_id, provider, utility_type, account_number, period_end, statement_date")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    bills.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const byUnit = new Map<string, BillLite[]>();
  const unassigned: BillLite[] = [];
  for (const b of bills) {
    if (!b.property_id) unassigned.push(b);
    else byUnit.set(b.property_id, [...(byUnit.get(b.property_id) ?? []), b]);
  }

  const units = (props ?? [])
    .map((p) => ({
      unit: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
      service_address: `${p.street_address} Apt ${p.unit_number}`,
      coverage: summarize(byUnit.get(p.id) ?? []),
    }))
    .sort((a, b) => a.unit.localeCompare(b.unit));

  return NextResponse.json({
    as_of: todayISO(),
    units,
    unassigned: summarize(unassigned),
  });
}
