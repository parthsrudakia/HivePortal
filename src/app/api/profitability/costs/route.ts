/**
 * Monthly cost intake for the costs agent — feeds the Profitability tab.
 *
 *   POST   /api/profitability/costs           send cost lines (upsert by ref)
 *   GET    /api/profitability/costs?from&to   units to match against + what's stored
 *   DELETE /api/profitability/costs?ref=…     remove one line the agent sent
 *
 * The agent reads rent portals (rent paid, amenity and other fees) and sends
 * one line per charge. A unit is named by `property_id` or by its address
 * (matched like utility statements). Re-sending a line with the same `ref`
 * replaces it, so a weekly run can safely re-send a whole month.
 *
 * Auth: static bearer token `PROFIT_COSTS_API_KEY` — its own key, so the
 * agent's token can't read tenant PII. Writes go through the service role
 * and only ever touch rows with source 'agent' (operator-entered costs stay
 * untouched). Nothing here charges tenants.
 *
 * Docs: /developers (Profit costs tab) — keep in sync when this changes.
 */

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { requireBearer } from "@/lib/api-auth";
import { loadUnits } from "@/lib/utility-ingest";
import {
  CostBatchSchema,
  CostLineSchema,
  MONTH_RE,
  resolveCostUnit,
  type CostResult,
} from "@/lib/profit-costs";

export const dynamic = "force-dynamic";

const API_KEY = "PROFIT_COSTS_API_KEY";
const PAGE = 1000;

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
    return fail(400, "Body must be JSON: { \"costs\": [ … ] }.");
  }
  const batch = CostBatchSchema.safeParse(json);
  if (!batch.success)
    return fail(400, "Body must be { \"costs\": [ … ] } with 1 to 500 lines.", {
      issues: batch.error.issues,
    });

  const sb = admin();
  let units;
  try {
    units = await loadUnits(sb);
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : "Failed to load units.");
  }
  const labelById = new Map(units.map((u) => [u.id, u.label]));

  const results: CostResult[] = [];
  const rows: Database["public"]["Tables"]["profit_costs"]["Insert"][] = [];
  const seenRefs = new Set<string>();
  const now = new Date().toISOString();

  for (const raw of batch.data.costs) {
    const parsed = CostLineSchema.safeParse(raw);
    if (!parsed.success) {
      const ref =
        raw && typeof raw === "object" && typeof (raw as { ref?: unknown }).ref === "string"
          ? (raw as { ref: string }).ref
          : null;
      results.push({
        ref,
        status: "invalid",
        error: parsed.error.issues
          .map((i) => `${i.path.join(".") || "line"}: ${i.message}`)
          .join("; "),
      });
      continue;
    }
    const line = parsed.data;
    if (seenRefs.has(line.ref)) {
      results.push({ ref: line.ref, status: "invalid", error: "duplicate ref in this request" });
      continue;
    }
    seenRefs.add(line.ref);

    const { propertyId, error } = resolveCostUnit(line, units);
    if (error) {
      results.push({
        ref: line.ref,
        status: line.type === "company" || line.property_id ? "invalid" : "unmatched",
        error,
      });
      continue;
    }
    rows.push({
      property_id: propertyId,
      month: line.month,
      cost_type: line.type,
      amount: Math.round(line.amount * 100) / 100,
      label: line.label ?? null,
      notes: line.notes ?? null,
      source: "agent",
      ref: line.ref,
      created_by: "costs-api",
      updated_at: now,
    });
    results.push({
      ref: line.ref,
      status: "saved",
      property_id: propertyId,
      unit_label: propertyId ? labelById.get(propertyId) ?? null : null,
    });
  }

  if (rows.length > 0) {
    const { error } = await sb
      .from("profit_costs")
      .upsert(rows, { onConflict: "source,ref" });
    if (error) return fail(500, `Failed to save costs: ${error.message}`);
    revalidatePath("/profitability");
  }

  const count = (s: CostResult["status"]) => results.filter((r) => r.status === s).length;
  return NextResponse.json({
    saved: count("saved"),
    unmatched: count("unmatched"),
    invalid: count("invalid"),
    results,
  });
}

export async function GET(req: Request) {
  const denied = requireBearer(req, API_KEY);
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const year = new Date().toISOString().slice(0, 4);
  const from = params.get("from") ?? `${year}-01`;
  const to = params.get("to") ?? `${year}-12`;
  if (!MONTH_RE.test(from) || !MONTH_RE.test(to) || from > to)
    return fail(400, "from and to must be YYYY-MM, with from <= to.");

  const sb = admin();
  const { data: props, error: unitsError } = await sb
    .from("properties")
    .select("id, building_name, street_address, unit_number")
    .is("archived_at", null)
    .order("street_address");
  if (unitsError) return fail(500, `Failed to load units: ${unitsError.message}`);

  type Row = {
    ref: string;
    source: string;
    property_id: string | null;
    month: string;
    cost_type: string;
    amount: number;
    label: string | null;
    updated_at: string;
  };
  const costs: Row[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await sb
      .from("profit_costs")
      .select("ref, source, property_id, month, cost_type, amount, label, updated_at")
      .gte("month", from)
      .lte("month", to)
      .order("month")
      .order("id")
      .range(start, start + PAGE - 1);
    if (error) return fail(500, `Failed to load costs: ${error.message}`);
    costs.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) break;
  }

  return NextResponse.json({
    from,
    to,
    units: (props ?? []).map((p) => ({
      property_id: p.id,
      label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
      street_address: p.street_address,
      unit_number: p.unit_number,
    })),
    costs: costs.map((c) => ({
      ref: c.ref,
      source: c.source,
      property_id: c.property_id,
      month: c.month,
      type: c.cost_type,
      amount: Number(c.amount),
      label: c.label,
      updated_at: c.updated_at,
    })),
  });
}

export async function DELETE(req: Request) {
  const denied = requireBearer(req, API_KEY);
  if (denied) return denied;

  const ref = new URL(req.url).searchParams.get("ref")?.trim();
  if (!ref) return fail(400, "Pass the line's ref: ?ref=…");

  const { data, error } = await admin()
    .from("profit_costs")
    .delete()
    .eq("source", "agent")
    .eq("ref", ref)
    .select("id");
  if (error) return fail(500, `Failed to delete: ${error.message}`);
  if (data && data.length > 0) revalidatePath("/profitability");
  return NextResponse.json({ deleted: data?.length ?? 0 });
}
