/**
 * Past utility bills — `GET /api/utilities/bills`.
 *
 * Every logged bill with its line items, newest billing period first.
 * Filters (all optional, combinable):
 *   ?source=pseg|coned|other   statement source
 *   ?property_id=<uuid>        one unit (`unassigned` for bills with no unit)
 *   ?utility_type=electric|…   one utility type
 *   ?account=<number>          account number, compared digits-only
 *   ?from=YYYY-MM-DD / ?to=    billing period end within the range (inclusive)
 *
 * Same `UTILITIES_API_KEY` as the intake endpoint. Read-only; returns no
 * tenant data. Docs: /developers (Utilities tab) — keep in sync.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { requireBearer } from "@/lib/api-auth";
import { one } from "@/lib/relations";
import { STATEMENT_SOURCES } from "@/lib/utility-ingest";

export const dynamic = "force-dynamic";

const UTILITY_TYPES = ["electric", "gas", "water", "internet", "trash", "other"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET(req: Request) {
  const denied = requireBearer(req, "UTILITIES_API_KEY");
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const source = params.get("source");
  const propertyId = params.get("property_id");
  const utilityType = params.get("utility_type");
  const account = params.get("account")?.replace(/\D/g, "") || null;
  const from = params.get("from");
  const to = params.get("to");

  if (source !== null && !(STATEMENT_SOURCES as readonly string[]).includes(source))
    return bad(`source must be one of: ${STATEMENT_SOURCES.join(", ")}`);
  if (utilityType !== null && !UTILITY_TYPES.includes(utilityType))
    return bad(`utility_type must be one of: ${UTILITY_TYPES.join(", ")}`);
  if ((from !== null && !ISO_DATE.test(from)) || (to !== null && !ISO_DATE.test(to)))
    return bad("from and to must be YYYY-MM-DD");
  if (params.get("account") !== null && !account)
    return bad("account must contain digits");

  const sb = admin();

  // Page through every matching bill — PostgREST caps a single response.
  const PAGE = 1000;
  const rows = [];
  for (let start = 0; ; start += PAGE) {
    let q = sb
      .from("utility_bills")
      .select(
        `id, source, provider, utility_type, account_number, service_address,
         statement_date, period_start, period_end, total_amount, notes, created_at, property_id,
         properties(building_name, street_address, unit_number),
         utility_bill_charges(kind, description, amount)`,
      );
    if (source) q = q.eq("source", source);
    if (propertyId === "unassigned") q = q.is("property_id", null);
    else if (propertyId) q = q.eq("property_id", propertyId);
    if (utilityType) q = q.eq("utility_type", utilityType);
    if (from) q = q.gte("period_end", from);
    if (to) q = q.lte("period_end", to);
    const { data, error } = await q
      .order("period_end", { ascending: false, nullsFirst: false })
      .order("id")
      .range(start, start + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const bills = rows
    .filter((b) => !account || b.account_number?.replace(/\D/g, "") === account)
    .map((b) => {
      const p = one(b.properties);
      return {
        id: b.id,
        unit: p ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}` : null,
        property_id: b.property_id,
        source: b.source,
        provider: b.provider,
        utility_type: b.utility_type,
        account_number: b.account_number,
        service_address: b.service_address,
        statement_date: b.statement_date,
        period_start: b.period_start,
        period_end: b.period_end,
        total: Number(b.total_amount),
        charges: b.utility_bill_charges.map((c) => ({
          kind: c.kind,
          description: c.description,
          amount: Number(c.amount),
        })),
        notes: b.notes,
        logged_at: b.created_at,
      };
    });

  return NextResponse.json({ count: bills.length, bills });
}
