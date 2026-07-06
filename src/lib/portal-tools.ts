/**
 * Tool handlers shared between the Telegram bot and (eventually) any other
 * agent host. Same operations as the MCP server in mcp/, but written for
 * the Next.js + Supabase environment.
 *
 * Each handler returns a JSON-serialisable result. The Claude tool runner
 * stringifies these into tool_result content blocks.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { updateRoomsWithNotification } from "@/lib/notifications";
import { enqueueCleanerScheduleChange } from "@/lib/cleaner-reminders";
import { todayISO, currentRentCycle, rentCycleForMonth } from "@/lib/date";
import { generateAgreementPdf } from "@/lib/agreements";
import { sendGmailMessage } from "@/lib/google-mail";
import { sendOutlookMessage } from "@/lib/graph-mail";
import {
  agreementEmailTemplate,
  gmailAgreementBody,
  inventorySheetEmailTemplate,
  sendBalanceReminder,
  sendBalanceReminderGmail,
  balanceReminderText,
} from "@/lib/email";
import { logEmail } from "@/lib/email-log";
import { sendSms } from "@/lib/sms";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import {
  billMonth,
  isOverThreshold,
  usageTotal,
  OVERAGE_THRESHOLD,
  monthLabel as utilityMonthLabel,
  type BillRow,
} from "@/lib/utility-bills";
import { buildInventorySheet } from "@/lib/inventory-sheet";
import { sendDocument } from "@/lib/telegram";

/**
 * Per-request context for tools that need to know which Telegram chat they're
 * acting in (e.g. to deliver a file). The webhook wraps the tool runner in
 * `runWithToolContext` so handlers can read the active chat id.
 */
type ToolContext = {
  chatId: number;
  /** Diagnostic-log correlation for the current turn (see telegram-log.ts). */
  turnId?: string;
  telegramUserId?: number;
  username?: string;
  /**
   * Mutated by instrumentTool: name + ok of every tool called during this
   * turn. The webhook reads it after the agent loop to verify that a reply
   * claiming an email was sent is backed by a real send-tool call.
   */
  calledTools?: { name: string; ok: boolean }[];
};
const toolContext = new AsyncLocalStorage<ToolContext>();

export function runWithToolContext<T>(ctx: ToolContext, fn: () => T): T {
  return toolContext.run(ctx, fn);
}

export function getToolContext(): ToolContext | undefined {
  return toolContext.getStore();
}

function requireChatId(): number {
  const ctx = toolContext.getStore();
  if (!ctx) {
    throw new Error(
      "No Telegram chat context — this tool must run inside runWithToolContext.",
    );
  }
  return ctx.chatId;
}

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}


function one<T>(rel: T | T[] | null | undefined): T | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

function propertyLabel(p: {
  building_name: string | null;
  street_address: string;
  unit_number: string;
}): string {
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

// ----- Read tools -----

export async function listProperties() {
  const supabase = admin();
  const { data, error } = await supabase
    .from("properties")
    .select(
      `id, building_name, street_address, unit_number, neighborhood, bedrooms,
       leaseholders(name),
       rooms(id, status)`,
    )
    .order("street_address");
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => ({
    id: p.id,
    name: propertyLabel(p),
    neighborhood: p.neighborhood,
    bedrooms: p.bedrooms,
    leaseholder: one(p.leaseholders)?.name ?? null,
    rooms_total: p.rooms?.length ?? 0,
    rooms_available:
      p.rooms?.filter((r) => r.status === "available").length ?? 0,
  }));
}

export async function getProperty(id: string) {
  const supabase = admin();
  const { data: property, error: pErr } = await supabase
    .from("properties")
    .select(
      `id, building_name, street_address, unit_number, cross_street,
       neighborhood, bedrooms, bathrooms,
       unit_amenities, building_amenities, amenities_notes, notes,
       leaseholders(name)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!property) throw new Error("Property not found.");

  const { data: rooms, error: rErr } = await supabase
    .from("rooms")
    .select(
      `id, room_number, has_private_bathroom, has_ac, base_rent, bundle_fee,
       total_rent, status, available_from, listing_action,
       tenancies!left(id, status, monthly_rent, start_date, move_out_date,
                      tenants(id, full_name, email, phone))`,
    )
    .eq("property_id", id);
  if (rErr) throw new Error(rErr.message);

  return {
    id: property.id,
    name: propertyLabel(property),
    address: property.street_address,
    unit_number: property.unit_number,
    cross_street: property.cross_street,
    neighborhood: property.neighborhood,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    leaseholder: one(property.leaseholders)?.name ?? null,
    amenities: {
      unit: property.unit_amenities,
      building: property.building_amenities,
      notes: property.amenities_notes,
    },
    notes: property.notes,
    rooms: (rooms ?? []).map((r) => {
      const active = (r.tenancies ?? []).find(
        (t: { status: string }) => t.status === "active",
      );
      const tenant = active ? one(active.tenants) : null;
      return {
        id: r.id,
        room_number: r.room_number,
        status: r.status,
        listing_action: r.listing_action,
        rent: { base: r.base_rent, bundle: r.bundle_fee, total: r.total_rent },
        has_private_bathroom: r.has_private_bathroom,
        has_ac: r.has_ac,
        available_from: r.available_from,
        current_tenant: active && tenant
          ? {
              id: tenant.id,
              full_name: tenant.full_name,
              email: tenant.email,
              phone: tenant.phone,
              tenancy_id: active.id,
              monthly_rent: active.monthly_rent,
              move_out_date: active.move_out_date,
            }
          : null,
      };
    }),
  };
}

export async function listInventory() {
  const supabase = admin();
  const today = todayISO();
  const { data, error } = await supabase
    .from("rooms")
    .select(
      `id, room_number, total_rent, available_from, status, listing_action,
       has_private_bathroom, has_ac,
       marketing_description, photos_url,
       properties(id, building_name, street_address, unit_number, neighborhood)`,
    )
    .or(`status.eq.available,and(status.eq.occupied,available_from.gte.${today})`)
    .order("available_from", { ascending: true, nullsFirst: true });
  if (error) throw new Error(error.message);

  // Each room can carry several ads (room_ads post-dates the generated types).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: adRowsData } = await (supabase as any)
    .from("room_ads")
    .select("room_id, url, posted_by")
    .order("created_at", { ascending: true });
  const adsByRoom = new Map<string, { url: string; posted_by: string | null }[]>();
  for (const a of (adRowsData ?? []) as {
    room_id: string;
    url: string;
    posted_by: string | null;
  }[]) {
    const list = adsByRoom.get(a.room_id) ?? [];
    list.push({ url: a.url, posted_by: a.posted_by });
    adsByRoom.set(a.room_id, list);
  }

  return (data ?? []).map((r) => {
    const p = one(r.properties);
    return {
      id: r.id,
      room_number: r.room_number,
      unit: p ? propertyLabel(p) : null,
      property_id: p?.id ?? null,
      neighborhood: p?.neighborhood,
      total_rent: r.total_rent,
      available_from: r.available_from,
      status: r.status,
      listing_action: r.listing_action,
      ads: adsByRoom.get(r.id) ?? [],
      has_private_bathroom: r.has_private_bathroom,
      has_ac: r.has_ac,
      description: r.marketing_description,
      photos_url: r.photos_url,
    };
  });
}

export async function listActiveTenants(args: {
  month?: string;
  only_overdue?: boolean;
  unpaid_only?: boolean;
}) {
  const supabase = admin();
  // Rent is collected on a 27th→26th cycle. With an explicit month, use that
  // month's cycle; otherwise the cycle containing today (rolls on the 27th).
  const { start, end } = args.month
    ? rentCycleForMonth(args.month)
    : currentRentCycle();
  const yyyymm = end.slice(0, 7); // rent month (the cycle's 26th)

  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, tenant_id,
       tenants(id, full_name, email, phone),
       rooms(room_number,
             properties(id, building_name, street_address, unit_number)),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "active");
  if (error) throw new Error(error.message);

  const rows = (data ?? []).map((t) => {
    const paid = (t.payments ?? [])
      .filter(
        (p: { payment_type: string; paid_on: string }) =>
          p.payment_type === "rent" && p.paid_on >= start && p.paid_on <= end,
      )
      .reduce(
        (sum: number, p: { amount: number | string }) => sum + Number(p.amount),
        0,
      );
    const tenant = one(t.tenants);
    const room = one(t.rooms);
    const property = one(room?.properties ?? null);
    return {
      tenancy_id: t.id,
      tenant_id: tenant?.id ?? null,
      full_name: tenant?.full_name ?? null,
      email: tenant?.email ?? null,
      phone: tenant?.phone ?? null,
      unit: property ? propertyLabel(property) : null,
      room: room?.room_number ?? null,
      monthly_rent: Number(t.monthly_rent),
      paid_this_month: paid,
      balance_due: Number(t.monthly_rent) - paid,
    };
  });

  // unpaid_only: no rent payment dated in this month (by transaction date),
  // regardless of whether they're paid ahead. only_overdue: still owes a
  // balance. unpaid_only takes precedence when both are set.
  let tenants = rows;
  if (args.unpaid_only) tenants = tenants.filter((r) => r.paid_this_month === 0);
  else if (args.only_overdue) tenants = tenants.filter((r) => r.balance_due > 0);

  return { month: yyyymm, tenants };
}

export async function listOverdueCleanings() {
  const supabase = admin();
  const today = todayISO();
  const { data: properties } = await supabase
    .from("properties")
    .select("id, building_name, street_address, unit_number");
  const { data: cleanings } = await supabase
    .from("cleaning_records")
    .select("property_id, cleaning_date")
    .order("cleaning_date", { ascending: false });

  const lastBy = new Map<string, string>();
  for (const c of cleanings ?? []) {
    if (!lastBy.has(c.property_id)) lastBy.set(c.property_id, c.cleaning_date);
  }

  const out: Array<{
    property_id: string;
    name: string;
    last_cleaning: string | null;
    next_due: string | null;
    days_until: number | null;
    status: "never" | "overdue" | "due_soon";
  }> = [];
  for (const p of properties ?? []) {
    const last = lastBy.get(p.id) ?? null;
    if (!last) {
      out.push({
        property_id: p.id,
        name: propertyLabel(p),
        last_cleaning: null,
        next_due: null,
        days_until: null,
        status: "never",
      });
      continue;
    }
    const next = new Date(last + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 35);
    const nextDue = next.toISOString().slice(0, 10);
    const daysUntil = Math.round(
      (new Date(nextDue + "T00:00:00Z").getTime() -
        new Date(today + "T00:00:00Z").getTime()) /
        (24 * 60 * 60 * 1000),
    );
    if (daysUntil > 7) continue;
    out.push({
      property_id: p.id,
      name: propertyLabel(p),
      last_cleaning: last,
      next_due: nextDue,
      days_until: daysUntil,
      status: daysUntil < 0 ? "overdue" : "due_soon",
    });
  }
  out.sort((a, b) => (a.days_until ?? -9999) - (b.days_until ?? -9999));
  return out;
}

const CREDENTIAL_CATEGORIES = [
  "payment_portal",
  "maintenance_portal",
  "utility",
  "internet",
  "building_login",
  "other",
] as const;
type CredentialCategory = (typeof CREDENTIAL_CATEGORIES)[number];

export async function getCredentials(args: {
  property_id?: string;
  category?: CredentialCategory;
}) {
  const supabase = admin();
  let q = supabase
    .from("credentials")
    .select(
      `id, category, service_name, property_id, username, password,
       login_url, account_number, owner_label, notes,
       properties(building_name, street_address, unit_number)`,
    )
    .order("service_name");
  if (args.property_id) q = q.eq("property_id", args.property_id);
  if (args.category) q = q.eq("category", args.category);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((c) => ({
    id: c.id,
    category: c.category,
    service_name: c.service_name,
    property: c.properties ? propertyLabel(one(c.properties)!) : null,
    username: c.username,
    password: c.password,
    login_url: c.login_url,
    account_number: c.account_number,
    owner_label: c.owner_label,
    notes: c.notes,
  }));
}

type UtilityType = "electric" | "gas" | "water" | "internet" | "trash" | "other";

export async function getUtilityBills(args: {
  month?: string;
  property_id?: string;
  utility_type?: UtilityType;
  over_threshold_only?: boolean;
  months_back?: number;
}) {
  const supabase = admin();

  if (args.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(args.month)) {
    throw new Error('month must be "YYYY-MM".');
  }

  // utility_bills post-dates the generated types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("utility_bills")
    .select(
      `id, property_id, provider, utility_type, statement_date,
       period_start, period_end, total_amount, overage_dismissed, notes,
       created_at,
       utility_bill_charges(id, kind, description, amount),
       properties(building_name, street_address, unit_number)`,
    )
    .order("statement_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  // A bill's month is where the majority of its billing period falls, so
  // month filtering happens here rather than in SQL.
  const rows = ((data ?? []) as (BillRow & {
    properties: {
      building_name: string | null;
      street_address: string;
      unit_number: string;
    } | null;
  })[]).map((b) => ({ bill: b, month: billMonth(b) }));

  // Default window when no single month is requested, so the payload (and
  // the model's context) stays bounded.
  const monthsBack = args.months_back ?? 6;
  // Month arithmetic on a year*12+month index — setUTCMonth on a day-29..31
  // date overflows into the next month and silently drops the oldest month.
  const now = new Date();
  const cutoffIdx =
    now.getUTCFullYear() * 12 + now.getUTCMonth() - (monthsBack - 1);
  const cutoffYm = `${Math.floor(cutoffIdx / 12)}-${String((cutoffIdx % 12) + 1).padStart(2, "0")}`;

  const filtered = rows.filter(({ bill, month }) => {
    if (args.month ? month !== args.month : month < cutoffYm) return false;
    if (args.property_id === "unmatched") {
      if (bill.property_id) return false;
    } else if (args.property_id && bill.property_id !== args.property_id) {
      return false;
    }
    if (args.utility_type && bill.utility_type !== args.utility_type)
      return false;
    if (args.over_threshold_only && !isOverThreshold(bill)) return false;
    return true;
  });

  const monthly = new Map<string, { total: number; count: number }>();
  for (const { bill, month } of filtered) {
    const m = monthly.get(month) ?? { total: 0, count: 0 };
    m.total += Number(bill.total_amount);
    m.count += 1;
    monthly.set(month, m);
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    window: args.month
      ? utilityMonthLabel(args.month)
      : `last ${monthsBack} months`,
    bill_count: filtered.length,
    total_amount: round(
      filtered.reduce((s, { bill }) => s + Number(bill.total_amount), 0),
    ),
    monthly_totals: [...monthly.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([ym, m]) => ({
        month: ym,
        label: utilityMonthLabel(ym),
        bill_count: m.count,
        total: round(m.total),
      })),
    bills: filtered.map(({ bill, month }) => {
      const usage = usageTotal(bill);
      const over = isOverThreshold(bill);
      return {
        id: bill.id,
        unit: bill.properties ? propertyLabel(one(bill.properties)!) : "unmatched",
        provider: bill.provider,
        utility_type: bill.utility_type,
        month,
        statement_date: bill.statement_date,
        period: `${bill.period_start ?? "?"} → ${bill.period_end ?? "?"}`,
        total_amount: round(Number(bill.total_amount)),
        usage_total: round(usage),
        late_fees_and_other: round(Number(bill.total_amount) - usage),
        over_200_usage_threshold: over,
        excess_over_200: over ? round(usage - OVERAGE_THRESHOLD) : 0,
        overage_dismissed: bill.overage_dismissed,
        notes: bill.notes,
      };
    }),
  };
}

// ----- Write tools -----

export async function recordPayment(args: {
  tenancy_id: string;
  amount: number;
  paid_on: string;
  payment_type?:
    | "rent"
    | "security_deposit"
    | "late_fee"
    | "utility"
    | "other"
    | "refund";
  method?: string;
  notes?: string;
}) {
  const supabase = admin();
  const { error } = await supabase.from("payments").insert({
    tenancy_id: args.tenancy_id,
    amount: args.amount,
    paid_on: args.paid_on,
    payment_type: args.payment_type ?? "rent",
    method: args.method ?? null,
    notes: args.notes ?? null,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function logCleaning(args: {
  property_id: string;
  cleaning_date: string;
  assigned_to?: string;
  notes?: string;
}) {
  const supabase = admin();
  const { error } = await supabase.from("cleaning_records").insert({
    property_id: args.property_id,
    cleaning_date: args.cleaning_date,
    assigned_to: args.assigned_to ?? null,
    notes: args.notes ?? null,
  });
  if (error) throw new Error(error.message);
  // Same side effect as the portal's addCleaning: let assigned cleaners know
  // when this week's schedule changed.
  await enqueueCleanerScheduleChange(
    supabase,
    args.property_id,
    [args.cleaning_date],
    "telegram",
  );
  return { ok: true };
}

export async function setListingAction(args: {
  room_id: string;
  action:
    | "no_action"
    | "update_price_or_date"
    | "delete_listing"
    | "boost_post"
    | "priority";
}) {
  const supabase = admin();
  const { error } = await updateRoomsWithNotification(supabase, args.room_id, {
    listing_action: args.action,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function updateRoomRent(args: {
  room_id: string;
  base_rent: number;
  bundle_fee?: number;
}) {
  const supabase = admin();
  const update: Record<string, unknown> = { base_rent: args.base_rent };
  if (args.bundle_fee !== undefined) update.bundle_fee = args.bundle_fee;
  const { error } = await supabase
    .from("rooms")
    .update(update)
    .eq("id", args.room_id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function endTenancy(args: {
  tenancy_id: string;
  move_out_date: string;
}) {
  const supabase = admin();
  const today = todayISO();
  const isPastOrToday = args.move_out_date <= today;

  const { data: tenancy, error: lookupErr } = await supabase
    .from("tenancies")
    .select("room_id")
    .eq("id", args.tenancy_id)
    .single();
  if (lookupErr || !tenancy) {
    throw new Error(lookupErr?.message ?? "Tenancy not found.");
  }

  await supabase
    .from("tenancies")
    .update({
      move_out_date: args.move_out_date,
      status: isPastOrToday ? "ended" : "active",
    })
    .eq("id", args.tenancy_id);

  if (tenancy.room_id) {
    // Re-entering the vacancy queue — reset the VA workflow flag to "no action"
    // so the room doesn't inherit the previous tenancy's color.
    await updateRoomsWithNotification(supabase, tenancy.room_id, {
      status: isPastOrToday ? "available" : "occupied",
      available_from: args.move_out_date,
      listing_action: "no_action",
    });
  }

  return {
    ok: true,
    tenancy_status: isPastOrToday ? "ended" : "active",
    room_status: isPastOrToday ? "available" : "occupied",
    listing_action_reset: true,
  };
}

// City lookup for composing a full mailing address. Every NY unit is New
// York, NY; NJ units are identified by their neighborhood tag.
const NJ_NEIGHBORHOOD_CITY: Record<string, string> = {
  hoboken: "Hoboken",
  jsq: "Jersey City",
  "journal square": "Jersey City",
  "jersey city heights": "Jersey City",
  "the heights": "Jersey City",
};

function composeFullAddress(p: {
  street_address: string;
  unit_number: string;
  neighborhood: string | null;
  is_new_york: boolean | null;
}): { full_address: string; needs_city_state: boolean } {
  // Some street_address values already carry city/state ("505 Summit Ave,
  // Jersey City, NJ 07306") — slot the Apt in after the street part.
  if (/,\s*[A-Za-z .]+,\s*[A-Z]{2}\b/.test(p.street_address)) {
    const [street, ...rest] = p.street_address.split(",");
    return {
      full_address: `${street.trim()}, Apt ${p.unit_number}, ${rest
        .join(",")
        .trim()}`,
      needs_city_state: false,
    };
  }
  const base = `${p.street_address}, Apt ${p.unit_number}`;
  if (p.is_new_york) {
    return { full_address: `${base}, New York, NY`, needs_city_state: false };
  }
  const city = NJ_NEIGHBORHOOD_CITY[(p.neighborhood ?? "").trim().toLowerCase()];
  if (city) {
    return { full_address: `${base}, ${city}, NJ`, needs_city_state: false };
  }
  return { full_address: base, needs_city_state: true };
}

// Autocomplete a property address from a fragment the operator typed
// ("3516 jfk 203", "normandie 32F", "the epic"). Matches against building
// name, street, unit, and neighborhood; returns composed full addresses
// ready for send_agreement.
export async function resolvePropertyAddress(args: { query: string }) {
  const supabase = admin();
  const [{ data: props, error }, { data: saved }] = await Promise.all([
    supabase
      .from("properties")
      .select(
        "id, building_name, street_address, unit_number, neighborhood, is_new_york",
      ),
    // Addresses the operator has already confirmed on a sent agreement —
    // these are exact and win over anything we could compose.
    supabase.from("agreement_addresses").select("property_id, full_address"),
  ]);
  if (error) throw new Error(error.message);
  const confirmedById = new Map(
    (saved ?? []).map((s) => [s.property_id as string, s.full_address as string]),
  );

  const tokens = args.query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) throw new Error("Give me part of an address to match.");

  const scored = (props ?? [])
    .map((p) => {
      const hay = [
        p.building_name,
        p.street_address,
        p.unit_number,
        p.neighborhood,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return { p, hits: tokens.filter((t) => hay.includes(t)).length };
    })
    .filter((s) => s.hits > 0);

  // Prefer units matching every token; otherwise fall back to best partials
  // so a typo'd fragment still surfaces candidates to pick from.
  const full = scored.filter((s) => s.hits === tokens.length);
  const pool = (full.length > 0 ? full : scored)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 5);

  return pool.map(({ p, hits }) => {
    const confirmed = confirmedById.get(p.id);
    return {
      property_id: p.id,
      label: propertyLabel(p),
      neighborhood: p.neighborhood,
      is_new_york: p.is_new_york,
      matched_all_terms: hits === tokens.length,
      ...(confirmed
        ? {
            full_address: confirmed,
            needs_city_state: false,
            // Exact address the operator confirmed on a previous agreement —
            // use verbatim, no re-composing needed.
            operator_confirmed: true,
          }
        : { ...composeFullAddress(p), operator_confirmed: false }),
    };
  });
}

// Undo a scheduled (or accidental) move-out: tenancy back to active with no
// move-out date, room back to plain occupied. Mirrors reactivateTenancy().
export async function cancelMoveOut(args: { tenancy_id: string }) {
  const supabase = admin();
  const { data: tenancy, error } = await supabase
    .from("tenancies")
    .select("room_id, move_out_date")
    .eq("id", args.tenancy_id)
    .single();
  if (error || !tenancy) throw new Error(error?.message ?? "Tenancy not found.");
  if (!tenancy.move_out_date) {
    return { ok: true, note: "No move-out was scheduled on this tenancy." };
  }

  await supabase
    .from("tenancies")
    .update({ move_out_date: null, status: "active" })
    .eq("id", args.tenancy_id);

  if (tenancy.room_id) {
    await updateRoomsWithNotification(supabase, tenancy.room_id, {
      status: "occupied",
      available_from: null,
    });
  }
  return { ok: true, cancelled_move_out: tenancy.move_out_date };
}

// Patch tenant profile fields. Only the fields provided change; pass null to
// clear a clearable field.
export async function updateTenant(args: {
  tenant_id: string;
  full_name?: string;
  email?: string | null;
  phone?: string | null;
  pays_as?: string | null;
  profession?: string | null;
  age?: number | null;
  notes?: string | null;
}) {
  const patch: Record<string, unknown> = {};
  for (const key of [
    "full_name",
    "email",
    "phone",
    "pays_as",
    "profession",
    "age",
    "notes",
  ] as const) {
    if (args[key] !== undefined) patch[key] = args[key];
  }
  if (typeof patch.full_name === "string" && !patch.full_name.trim()) {
    throw new Error("full_name cannot be blank.");
  }
  if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");

  const supabase = admin();
  const { error } = await supabase
    .from("tenants")
    .update(patch)
    .eq("id", args.tenant_id);
  if (error) throw new Error(error.message);
  return { ok: true, updated_fields: Object.keys(patch) };
}

// Patch tenancy money/date fields. The rent ledger recomputes from these on
// every read, so changing monthly_rent or first_month_rent immediately
// reprices the auto rent charges (first_month_rent only affects the calendar
// month the tenancy starts in).
export async function updateTenancy(args: {
  tenancy_id: string;
  monthly_rent?: number;
  first_month_rent?: number | null;
  security_deposit?: number | null;
  start_date?: string;
  lease_end_date?: string | null;
}) {
  const patch: Record<string, unknown> = {};
  if (args.monthly_rent !== undefined) {
    if (!(args.monthly_rent > 0))
      throw new Error("monthly_rent must be greater than 0.");
    patch.monthly_rent = args.monthly_rent;
  }
  if (args.first_month_rent !== undefined) {
    if (args.first_month_rent !== null && !(args.first_month_rent >= 0))
      throw new Error("first_month_rent must be a non-negative number or null.");
    patch.first_month_rent = args.first_month_rent;
  }
  if (args.security_deposit !== undefined) {
    if (args.security_deposit !== null && !(args.security_deposit >= 0))
      throw new Error("security_deposit must be a non-negative number or null.");
    patch.security_deposit = args.security_deposit;
  }
  if (args.start_date !== undefined) {
    if (!args.start_date) throw new Error("start_date cannot be blank.");
    patch.start_date = args.start_date;
  }
  if (args.lease_end_date !== undefined) {
    patch.lease_end_date = args.lease_end_date;
    // Changing the lease end re-arms the lease-ending reminder crons.
    patch.lease_end_reminded_at = null;
    patch.lease_end_reminded_30_at = null;
  }
  if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");

  const supabase = admin();
  const { error } = await supabase
    .from("tenancies")
    .update(patch)
    .eq("id", args.tenancy_id);
  if (error) throw new Error(error.message);
  return { ok: true, updated_fields: Object.keys(patch) };
}

// Post an ad-hoc charge to the ledger (owed side). Distinct from
// record_payment, which records money received.
export async function addTenancyCharge(args: {
  tenancy_id: string;
  kind: "security_deposit" | "late_fee" | "other";
  amount: number;
  note?: string;
  charged_on?: string;
}) {
  if (!(args.amount > 0)) throw new Error("Amount must be a positive number.");
  if (args.kind === "other" && !args.note?.trim())
    throw new Error("An 'other' charge needs a note describing it.");

  const supabase = admin();
  const { error } = await supabase.from("tenancy_charges").insert({
    tenancy_id: args.tenancy_id,
    kind: args.kind,
    amount: args.amount,
    charged_on: args.charged_on ?? todayISO(),
    note: args.note?.trim() || null,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

// Short-lived signed download link for the lease PDF on file.
export async function getLeaseUrl(args: { tenancy_id: string }) {
  const supabase = admin();
  const { data: tenancy, error } = await supabase
    .from("tenancies")
    .select("lease_pdf_path")
    .eq("id", args.tenancy_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!tenancy?.lease_pdf_path)
    throw new Error("No lease PDF on file for this tenancy.");

  const { data, error: signErr } = await supabase.storage
    .from("leases")
    .createSignedUrl(tenancy.lease_pdf_path, 600);
  if (signErr) throw new Error(signErr.message);
  return { url: data.signedUrl, expires_in_minutes: 10 };
}

// ----- Cleaning management -----

export async function listCleaners() {
  const supabase = admin();
  const [{ data: cleaners, error }, { data: links }, { data: props }] =
    await Promise.all([
      supabase
        .from("cleaners")
        .select("id, name, email, phone, enabled")
        .order("name"),
      supabase.from("property_cleaners").select("property_id, cleaner_id"),
      supabase
        .from("properties")
        .select("id, building_name, street_address, unit_number"),
    ]);
  if (error) throw new Error(error.message);

  const labelById = new Map(
    (props ?? []).map((p) => [p.id, propertyLabel(p)]),
  );
  return (cleaners ?? []).map((c) => ({
    ...c,
    properties: (links ?? [])
      .filter((l) => l.cleaner_id === c.id)
      .map((l) => ({
        property_id: l.property_id,
        label: labelById.get(l.property_id) ?? l.property_id,
      })),
  }));
}

// Recent cleaning records (with ids) so a wrong log can be fixed or deleted.
export async function listCleanings(args: {
  property_id?: string;
  limit?: number;
}) {
  const supabase = admin();
  let q = supabase
    .from("cleaning_records")
    .select(
      `id, cleaning_date, assigned_to, notes,
       properties(id, building_name, street_address, unit_number)`,
    )
    .order("cleaning_date", { ascending: false })
    .limit(Math.min(args.limit ?? 20, 100));
  if (args.property_id) q = q.eq("property_id", args.property_id);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  return (data ?? []).map((c) => {
    const p = one(c.properties);
    return {
      record_id: c.id,
      property: p ? propertyLabel(p) : null,
      property_id: p?.id ?? null,
      cleaning_date: c.cleaning_date,
      assigned_to: c.assigned_to,
      notes: c.notes,
    };
  });
}

export async function addCleaner(args: {
  name: string;
  email: string;
  phone?: string;
}) {
  const name = args.name.trim();
  const email = args.email.trim();
  if (!name) throw new Error("Cleaner name is required.");
  if (!email.includes("@")) throw new Error("A valid email is required.");

  const supabase = admin();
  const { data, error } = await supabase
    .from("cleaners")
    .insert({ name, email, phone: args.phone?.trim() || null, enabled: true })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { ok: true, cleaner_id: data.id };
}

export async function setCleanerEnabled(args: {
  cleaner_id: string;
  enabled: boolean;
}) {
  const supabase = admin();
  const { error } = await supabase
    .from("cleaners")
    .update({ enabled: args.enabled })
    .eq("id", args.cleaner_id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function assignCleaner(args: {
  property_id: string;
  cleaner_id: string;
  assigned: boolean;
}) {
  const supabase = admin();
  if (args.assigned) {
    const { error } = await supabase
      .from("property_cleaners")
      .upsert(
        { property_id: args.property_id, cleaner_id: args.cleaner_id },
        { onConflict: "property_id,cleaner_id" },
      );
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase
      .from("property_cleaners")
      .delete()
      .eq("property_id", args.property_id)
      .eq("cleaner_id", args.cleaner_id);
    if (error) throw new Error(error.message);
  }
  return { ok: true };
}

export async function updateCleaningRecord(args: {
  record_id: string;
  cleaning_date?: string;
  assigned_to?: string | null;
  notes?: string | null;
}) {
  const patch: Record<string, unknown> = {};
  if (args.cleaning_date !== undefined) {
    if (!args.cleaning_date) throw new Error("cleaning_date cannot be blank.");
    patch.cleaning_date = args.cleaning_date;
  }
  if (args.assigned_to !== undefined) patch.assigned_to = args.assigned_to;
  if (args.notes !== undefined) patch.notes = args.notes;
  if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");

  const supabase = admin();
  const { data: old, error: lookupErr } = await supabase
    .from("cleaning_records")
    .select("property_id, cleaning_date")
    .eq("id", args.record_id)
    .single();
  if (lookupErr || !old)
    throw new Error(lookupErr?.message ?? "Cleaning record not found.");

  const { error } = await supabase
    .from("cleaning_records")
    .update(patch)
    .eq("id", args.record_id);
  if (error) throw new Error(error.message);

  await enqueueCleanerScheduleChange(
    supabase,
    old.property_id,
    [old.cleaning_date, args.cleaning_date],
    "telegram",
  );
  return { ok: true };
}

export async function deleteCleaningRecord(args: { record_id: string }) {
  const supabase = admin();
  const { data: old, error: lookupErr } = await supabase
    .from("cleaning_records")
    .select("property_id, cleaning_date")
    .eq("id", args.record_id)
    .single();
  if (lookupErr || !old)
    throw new Error(lookupErr?.message ?? "Cleaning record not found.");

  const { error } = await supabase
    .from("cleaning_records")
    .delete()
    .eq("id", args.record_id);
  if (error) throw new Error(error.message);

  await enqueueCleanerScheduleChange(
    supabase,
    old.property_id,
    [old.cleaning_date],
    "telegram",
  );
  return { ok: true };
}

export async function setRoomStatus(args: {
  room_id: string;
  status: "occupied" | "available" | "reserved" | "maintenance";
  available_from?: string;
}) {
  const supabase = admin();
  const update: Record<string, unknown> = { status: args.status };
  if (args.available_from !== undefined)
    update.available_from = args.available_from;
  const { error } = await updateRoomsWithNotification(
    supabase,
    args.room_id,
    update,
  );
  if (error) throw new Error(error.message);
  return { ok: true };
}

// Create a tenant and place them in a room (an active tenancy) in one shot —
// the Telegram counterpart of the /tenants/new form. Mirrors createTenant():
// inserts the tenant, opens the tenancy, then flips the room to occupied. The
// tenant insert is rolled back if the tenancy fails so we never leave an
// orphaned, room-less tenant behind.
export async function addTenant(args: {
  full_name: string;
  email: string;
  phone: string;
  room_id: string;
  monthly_rent: number;
  start_date: string;
  lease_end_date: string;
  first_month_rent?: number;
  pays_as?: string;
  notes?: string;
}) {
  const supabase = admin();

  const full_name = args.full_name.trim();
  const email = args.email.trim();
  const phone = args.phone.trim();
  if (!full_name) throw new Error("Tenant name is required.");
  if (!email) throw new Error("Tenant email is required.");
  if (!phone) throw new Error("Tenant phone is required.");
  if (!args.room_id) throw new Error("A room must be chosen for the tenant.");
  if (!(args.monthly_rent > 0)) throw new Error("Monthly rent must be greater than 0.");
  if (!args.start_date) throw new Error("Lease start date is required.");
  if (!args.lease_end_date) throw new Error("Lease end date is required.");
  if (args.lease_end_date < args.start_date) {
    throw new Error("Lease end date cannot be before the start date.");
  }

  // Guard against double-booking: refuse if the room already has an active
  // tenancy. Also gives us a friendly room label for the confirmation.
  const { data: room, error: roomErr } = await supabase
    .from("rooms")
    .select(
      `id, room_number, status,
       properties(building_name, street_address, unit_number),
       tenancies!left(id, status, tenants(full_name))`,
    )
    .eq("id", args.room_id)
    .maybeSingle();
  if (roomErr) throw new Error(roomErr.message);
  if (!room) throw new Error("Room not found.");
  const occupant = (room.tenancies ?? []).find(
    (t: { status: string }) => t.status === "active",
  );
  if (occupant) {
    const who = one(occupant.tenants)?.full_name ?? "another tenant";
    throw new Error(
      `That room already has an active tenancy (${who}). End it first, or pick a different room.`,
    );
  }
  const property = one(room.properties);
  const roomLabel = `${property ? propertyLabel(property) : "room"} room ${room.room_number}`;

  // 1. Insert the tenant record.
  const { data: tenant, error: tErr } = await supabase
    .from("tenants")
    .insert({
      full_name,
      email,
      phone,
      pays_as: args.pays_as?.trim() || null,
      notes: args.notes?.trim() || null,
    })
    .select("id")
    .single();
  if (tErr) throw new Error(tErr.message);

  // 2. Open the tenancy. Roll the tenant back if this fails so we don't leave
  //    an orphaned contact with no room.
  const { data: tenancy, error: leErr } = await supabase
    .from("tenancies")
    .insert({
      room_id: args.room_id,
      tenant_id: tenant.id,
      start_date: args.start_date,
      lease_end_date: args.lease_end_date,
      monthly_rent: args.monthly_rent,
      // Security deposit is intentionally never recorded here, even if the
      // operator's message includes one — left null on the tenancy.
      security_deposit: null,
      first_month_rent: args.first_month_rent ?? null,
      status: "active",
    })
    .select("id")
    .single();
  if (leErr) {
    await supabase.from("tenants").delete().eq("id", tenant.id);
    throw new Error(leErr.message);
  }

  // 3. Mark the room occupied and clear any "pending tenant" listing flag.
  await updateRoomsWithNotification(supabase, args.room_id, {
    status: "occupied",
    pending_tenant: false,
  });

  return {
    ok: true,
    tenant_id: tenant.id,
    tenancy_id: tenancy.id,
    full_name,
    room: roomLabel,
    monthly_rent: args.monthly_rent,
    lease: { start: args.start_date, end: args.lease_end_date },
  };
}

// One address only — no commas/semicolons, so a tool-supplied list can never
// fan an agreement out to multiple recipients.
const SINGLE_EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "$2,050" / "2050.00" → "2050"/"2050.00"; null when not a positive amount. */
function normalizeMoney(value: string): string | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned) || Number(cleaned) <= 0) return null;
  return cleaned;
}

// Generate a sublease agreement PDF and send it from the right mailbox. New York
// → no letterhead, sent from personal Gmail (From "Vineet", unbranded). Otherwise
// → with letterhead, sent from the M365 (Outlook) work account. Sends straight
// to the tenant — no draft step.
export async function sendAgreement(args: {
  tenant_name: string;
  recipient_email: string;
  property_address: string;
  rent: string;
  security_deposit: string;
  lease_start_date: string;
  lease_end_date: string;
  in_new_york: boolean;
  sublessor_name?: string;
  pro_rate_rent?: string;
  agreement_date?: string;
  confirm_mailbox_mismatch?: boolean;
  property_id?: string;
}) {
  // Validate everything up front: a lease PDF with a malformed date or amount,
  // or sent to a mistyped address, is worse than an error the operator can fix.
  const recipient = args.recipient_email.trim();
  if (!SINGLE_EMAIL_RE.test(recipient)) {
    return {
      ok: false,
      error: `"${args.recipient_email}" is not a valid single email address — double-check it with the operator.`,
    };
  }
  const rent = normalizeMoney(args.rent);
  if (!rent) {
    return { ok: false, error: `Rent "${args.rent}" is not a valid amount.` };
  }
  const deposit = normalizeMoney(args.security_deposit);
  if (!deposit) {
    return {
      ok: false,
      error: `Security deposit "${args.security_deposit}" is not a valid amount.`,
    };
  }
  const proRate = args.pro_rate_rent?.trim()
    ? normalizeMoney(args.pro_rate_rent)
    : undefined;
  if (args.pro_rate_rent?.trim() && !proRate) {
    return {
      ok: false,
      error: `Prorated rent "${args.pro_rate_rent}" is not a valid amount.`,
    };
  }
  const start = parseIsoDate(args.lease_start_date);
  const end = parseIsoDate(args.lease_end_date);
  if (!start || !end) {
    return {
      ok: false,
      error: 'Lease dates must be real dates in "YYYY-MM-DD" format.',
    };
  }
  if (end <= start) {
    return {
      ok: false,
      error: `Lease end (${args.lease_end_date}) must be after lease start (${args.lease_start_date}).`,
    };
  }
  if (args.agreement_date && !parseIsoDate(args.agreement_date)) {
    return {
      ok: false,
      error: 'agreement_date must be a real date in "YYYY-MM-DD" format.',
    };
  }
  // in_new_york picks the mailbox, branding, and letterhead. If the address
  // ends in a two-letter state that contradicts the flag, stop and ask rather
  // than silently send a mis-branded agreement from the wrong account. The
  // operator's word wins: a retry with confirm_mailbox_mismatch=true (set only
  // after they explicitly insist) sends exactly as instructed.
  const stateMatch = args.property_address.match(
    /,\s*([A-Za-z]{2})\.?(?:\s+\d{5}(?:-\d{4})?)?\s*$/,
  );
  const state = stateMatch?.[1]?.toUpperCase();
  if (
    state &&
    (state === "NY") !== args.in_new_york &&
    !args.confirm_mailbox_mismatch
  ) {
    return {
      ok: false,
      error:
        `The address ends in "${state}" but in_new_york=${args.in_new_york} — ` +
        "that combination would send from the " +
        (args.in_new_york
          ? "personal Gmail without letterhead"
          : "Outlook work account with letterhead") +
        ". Double-check with the operator; if they confirm this is intended, " +
        "call send_agreement again with confirm_mailbox_mismatch=true.",
    };
  }

  const pdf = await generateAgreementPdf({
    tenantName: args.tenant_name,
    sublessorName: args.sublessor_name?.trim() || "Vineet Dutta",
    propertyAddress: args.property_address,
    rent,
    securityDeposit: deposit,
    leaseStartDate: args.lease_start_date,
    leaseEndDate: args.lease_end_date,
    agreementDate: args.agreement_date || todayISO(),
    includeLetterhead: !args.in_new_york,
    proRateRent: proRate ?? undefined,
  });

  const attachment = {
    filename: pdf.filename,
    base64: pdf.base64,
    mimeType: "application/pdf",
  };

  const mailbox = args.in_new_york ? "gmail" : "outlook";

  let result;
  let subject: string;
  if (args.in_new_york) {
    // New York: plain, unbranded email from Vineet's personal Gmail (no Hive, no HTML).
    const body = gmailAgreementBody({ tenantName: args.tenant_name });
    subject = body.subject;
    result = await sendGmailMessage({
      to: recipient,
      subject: body.subject,
      text: body.text,
      attachment,
      // Agreements are one-off and high-stakes: require the message to show
      // up in the Gmail Sent folder before reporting success.
      verifySent: true,
    });
  } else {
    // Non-NY: branded email sent from the Outlook work account.
    const body = agreementEmailTemplate({ tenantName: args.tenant_name });
    subject = body.subject;
    result = await sendOutlookMessage({
      to: recipient,
      subject: body.subject,
      text: body.text,
      html: body.html,
      attachment,
    });
  }

  // Durable audit row for every attempt — the Telegram activity log is
  // diagnostic, but email_log is where "was this tenant actually emailed?"
  // gets answered.
  await logEmail({
    type: "agreement",
    recipient,
    subject,
    context: `${args.tenant_name} · ${args.property_address}`,
    channel: mailbox,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id || null : null,
  });

  if (!result.ok) {
    return { ok: false, mailbox, error: result.error, diag: result.diag };
  }

  // The operator confirmed this exact address and it went out on a real
  // agreement — remember it so future agreements for this property reuse it
  // verbatim. Best-effort: a save failure must not taint the send report.
  if (args.property_id) {
    await admin()
      .from("agreement_addresses")
      .upsert(
        {
          property_id: args.property_id,
          full_address: args.property_address.trim(),
          confirmed_at: new Date().toISOString(),
        },
        { onConflict: "property_id" },
      );
  }

  return {
    ok: true,
    mailbox,
    letterhead: !args.in_new_york,
    sent: true,
    recipient,
    diag: result.diag,
  };
}

const SHEET_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Build the public "Shareable Sheet" of listable inventory and deliver it to
// the current Telegram chat as an .xlsx file attachment.
export async function shareInventorySheet() {
  const chatId = requireChatId();
  const { buffer, filename, count } = await buildInventorySheet(admin());
  const res = await sendDocument(
    chatId,
    { buffer, filename, mimeType: SHEET_MIME },
    { caption: `Hive inventory — ${count} room${count === 1 ? "" : "s"}` },
  );
  if (!res.ok) {
    return { ok: false, error: res.error ?? "Failed to send the sheet." };
  }
  return { ok: true, filename, count };
}

// Build the public "Shareable Sheet" of listable inventory and email it as an
// .xlsx attachment from the personal Gmail account. Requires a recipient
// address — the operator is asked for it before this runs.
export async function emailInventorySheet(args: { recipient_email: string }) {
  const to = args.recipient_email.trim();
  if (!to) return { ok: false, error: "No recipient email address provided." };

  const { buffer, filename, count } = await buildInventorySheet(admin());
  const { subject, text } = inventorySheetEmailTemplate({ roomCount: count });
  const result = await sendGmailMessage({
    to,
    subject,
    text,
    attachment: { filename, base64: buffer.toString("base64"), mimeType: SHEET_MIME },
  });

  if (!result.ok) {
    return { ok: false, mailbox: "gmail", error: result.error };
  }
  return { ok: true, mailbox: "gmail", recipient: to, filename, count };
}

// Send rent balance reminders (email and/or text) to tenants who still owe rent
// this month. Omit tenancy_id to remind everyone owing; pass it to remind a
// single tenant. Texts use the same wording as the emails. Mirrors the Rent
// Tracker buttons but runs under the bot's service-role client.
export async function sendBalanceReminders(args: {
  channel: "email" | "text" | "both";
  tenancy_id?: string;
}) {
  const supabase = admin();
  const doEmail = args.channel === "email" || args.channel === "both";
  const doSms = args.channel === "text" || args.channel === "both";

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthEnd = new Date(y, m + 1, 0).toISOString().slice(0, 10);
  const period = `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthLabel = now.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const today = todayISO();

  type PropertyRel = { is_new_york: boolean };
  type ReminderRow = {
    id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    security_deposit: number | null;
    start_date: string;
    move_out_date: string | null;
    tenants:
      | { full_name: string; email: string | null; phone: string | null }
      | { full_name: string; email: string | null; phone: string | null }[]
      | null;
    rooms:
      | { properties: PropertyRel | PropertyRel[] | null }
      | { properties: PropertyRel | PropertyRel[] | null }[]
      | null;
    payments: { amount: number; paid_on: string; payment_type: string }[];
  };

  let query = supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date,
       tenants(full_name, email, phone),
       rooms(properties(is_new_york)),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "active");
  if (args.tenancy_id) query = query.eq("id", args.tenancy_id);
  const { data, error } = await query.returns<ReminderRow[]>();
  if (error) throw new Error(error.message);
  if (args.tenancy_id && (!data || data.length === 0)) {
    return { ok: false, error: "No active tenancy found for that id." };
  }

  const { charges, allocations, rentChanges } =
    await fetchLedgerSidecars(supabase);

  let owing = 0;
  let emailed = 0;
  let texted = 0;
  let failed = 0;
  const recipients: string[] = [];
  const noContactOnChannel: string[] = [];

  for (const row of data ?? []) {
    if (row.move_out_date && row.move_out_date <= today) continue;
    if (row.start_date > monthEnd) continue;

    const { netBalance } = computeLedger(
      row,
      row.payments ?? [],
      charges.get(row.id) ?? [],
      allocations.get(row.id) ?? [],
      today,
      rentChanges.get(row.id) ?? [],
    );
    if (netBalance <= 0.01) continue;
    owing++;

    const tenant = one(row.tenants);
    const name = tenant?.full_name ?? "Tenant";
    const email = tenant?.email?.trim();
    const phone = tenant?.phone?.trim();
    let delivered = false;

    if (doEmail && email) {
      const isNewYork = one(one(row.rooms)?.properties ?? null)?.is_new_york ?? false;
      const res = isNewYork
        ? await sendBalanceReminderGmail(email, netBalance, monthLabel)
        : await sendBalanceReminder(email, netBalance, monthLabel);
      if (res.ok) {
        emailed++;
        delivered = true;
      } else failed++;
    }
    if (doSms && phone) {
      const res = await sendSms(phone, balanceReminderText(netBalance, monthLabel), {
        type: "rent_balance",
        context: `${name} · ${monthLabel}`,
      });
      if (res.ok) {
        texted++;
        delivered = true;
      }
    }

    if (delivered) recipients.push(name);
    else noContactOnChannel.push(name);
  }

  if (emailed + texted > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("rent_reminder_batches").insert({
      kind: "balance",
      channel: doEmail && doSms ? "both" : doEmail ? "email" : "sms",
      period_month: period,
      recipient_count: doEmail ? emailed : texted,
    });
  }

  return {
    ok: true,
    channel: args.channel,
    month: monthLabel,
    owing,
    emailed,
    texted,
    failed,
    recipients,
    no_contact_on_channel: noContactOnChannel,
  };
}

// ----- Tool definitions for the Anthropic tool runner -----

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  logTelegramEvent,
  normalizeToolResult,
  okFromResult,
} from "./telegram-log";

const rawTools = [
  betaZodTool({
    name: "list_properties",
    description:
      "List every property (apartment unit) with rooms-total / rooms-available / leaseholder.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await listProperties()),
  }),
  betaZodTool({
    name: "get_property",
    description: "Full property detail by id, including each room's current tenant.",
    inputSchema: z.object({ id: z.string().describe("UUID of the property") }),
    run: async (args) => JSON.stringify(await getProperty(args.id)),
  }),
  betaZodTool({
    name: "list_inventory",
    description:
      "Listable rooms (the inventory queue) — currently vacant or with a scheduled future move-out.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await listInventory()),
  }),
  betaZodTool({
    name: "list_active_tenants",
    description:
      "Active tenants with monthly rent, paid-this-cycle amount (by payment " +
      "transaction date), and balance. Rent is collected on a 27th→26th cycle " +
      "(tenants pay from the 27th), so 'this month' = the 27th of the prior " +
      "month through the 26th. Defaults to the current cycle. Pass only_overdue: " +
      "true to filter to balance_due > 0. Pass unpaid_only: true to list tenants " +
      "who have made NO rent payment dated in the cycle (paid = 0) — i.e. who " +
      "hasn't paid anything this month, regardless of whether they're paid ahead.",
    inputSchema: z.object({
      month: z
        .string()
        .optional()
        .describe(
          'Rent month as "YYYY-MM" (its 27th→26th cycle); defaults to the current cycle',
        ),
      only_overdue: z.boolean().optional(),
      unpaid_only: z
        .boolean()
        .optional()
        .describe("Only tenants with $0 paid this cycle (by transaction date)."),
    }),
    run: async (args) => JSON.stringify(await listActiveTenants(args)),
  }),
  betaZodTool({
    name: "list_overdue_cleanings",
    description:
      "Properties overdue or due-soon for cleaning (35-day cadence).",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await listOverdueCleanings()),
  }),
  betaZodTool({
    name: "get_credentials",
    description:
      "Fetch credentials filtered by property and/or category. " +
      "Categories: payment_portal, maintenance_portal, utility, internet, " +
      "building_login, other.",
    inputSchema: z.object({
      property_id: z.string().optional(),
      category: z.enum(CREDENTIAL_CATEGORIES).optional(),
    }),
    run: async (args) =>
      JSON.stringify(
        await getCredentials({
          property_id: args.property_id,
          category: args.category,
        }),
      ),
  }),
  betaZodTool({
    name: "get_utility_bills",
    description:
      "Utility bills logged in the portal (extracted from uploaded statements), " +
      "with per-month totals. A bill belongs to the calendar month holding the " +
      "majority of its billing-period days (Apr 7–May 6 → April). Defaults to " +
      "the last 6 months; pass month for a single month. Lease clause: when a " +
      "unit's electric or gas usage charges exceed $200 in a month, the excess " +
      "is split among the occupants — over_200_usage_threshold / excess_over_200 " +
      "flag those bills (late fees don't count toward the $200). Bills the " +
      "extractor couldn't match to a unit have unit: 'unmatched'.",
    inputSchema: z.object({
      month: z
        .string()
        .optional()
        .describe('Single month as "YYYY-MM". Omit for the recent window.'),
      property_id: z
        .string()
        .optional()
        .describe(
          'Filter to one unit (UUID from list_properties), or "unmatched" ' +
            "for bills not linked to a unit.",
        ),
      utility_type: z
        .enum(["electric", "gas", "water", "internet", "trash", "other"])
        .optional(),
      over_threshold_only: z
        .boolean()
        .optional()
        .describe("Only electric/gas bills whose usage exceeds $200."),
      months_back: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .describe("Window size when month is omitted (default 6)."),
    }),
    run: async (args) => JSON.stringify(await getUtilityBills(args)),
  }),
  betaZodTool({
    name: "record_payment",
    description:
      "Add a payment row against a tenancy. Use list_active_tenants to find the tenancy_id.",
    inputSchema: z.object({
      tenancy_id: z.string(),
      amount: z.number().positive(),
      paid_on: z.string().describe('"YYYY-MM-DD"'),
      payment_type: z
        .enum([
          "rent",
          "security_deposit",
          "late_fee",
          "utility",
          "other",
          "refund",
        ])
        .optional(),
      method: z.string().optional(),
      notes: z.string().optional(),
    }),
    run: async (args) => JSON.stringify(await recordPayment(args)),
  }),
  betaZodTool({
    name: "send_balance_reminders",
    description:
      "Send rent balance reminders to tenant(s) who still owe rent this month. " +
      "ALWAYS ask the operator which channel first — email, text, or both — " +
      "never assume, and read back what you're about to do (channel + how many / " +
      "which tenant) and get an explicit confirmation before calling this; it " +
      "sends immediately. Omit tenancy_id to remind EVERY owing tenant; pass a " +
      "tenancy_id (find it via list_active_tenants) to remind just one tenant. " +
      "Texts go only to tenants with a phone on file and use the same wording as " +
      "the emails. After it runs, report how many were emailed/texted (and note " +
      "anyone owing who had no address/phone for the chosen channel).",
    inputSchema: z.object({
      channel: z
        .enum(["email", "text", "both"])
        .describe("Which channel to send on. Ask the operator each time."),
      tenancy_id: z
        .string()
        .optional()
        .describe(
          "Send to just this tenancy (via list_active_tenants). Omit to send to all owing tenants.",
        ),
    }),
    run: async (args) => JSON.stringify(await sendBalanceReminders(args)),
  }),
  betaZodTool({
    name: "log_cleaning",
    description: "Record that a unit was cleaned.",
    inputSchema: z.object({
      property_id: z.string(),
      cleaning_date: z.string().describe('"YYYY-MM-DD"'),
      assigned_to: z.string().optional(),
      notes: z.string().optional(),
    }),
    run: async (args) => JSON.stringify(await logCleaning(args)),
  }),
  betaZodTool({
    name: "set_listing_action",
    description: "Update a room's VA priority flag.",
    inputSchema: z.object({
      room_id: z.string(),
      action: z.enum([
        "no_action",
        "update_price_or_date",
        "delete_listing",
        "boost_post",
        "priority",
      ]),
    }),
    run: async (args) => JSON.stringify(await setListingAction(args)),
  }),
  betaZodTool({
    name: "update_room_rent",
    description: "Change a room's base rent and (optionally) bundle fee.",
    inputSchema: z.object({
      room_id: z.string(),
      base_rent: z.number().nonnegative(),
      bundle_fee: z.number().nonnegative().optional(),
    }),
    run: async (args) => JSON.stringify(await updateRoomRent(args)),
  }),
  betaZodTool({
    name: "end_tenancy",
    description:
      "Set a tenancy's move_out_date. Past/today → tenancy ends, room becomes Available. " +
      "Future date → tenancy stays Active until that day, room stays Occupied, but " +
      "rooms.available_from is set so the room appears on Inventory as 'Available from X'.",
    inputSchema: z.object({
      tenancy_id: z.string(),
      move_out_date: z.string().describe('"YYYY-MM-DD"'),
    }),
    run: async (args) => JSON.stringify(await endTenancy(args)),
  }),
  betaZodTool({
    name: "set_room_status",
    description:
      "Manually flip a room status (occupied / available / reserved / maintenance). " +
      "Use end_tenancy instead when there's an active tenancy.",
    inputSchema: z.object({
      room_id: z.string(),
      status: z.enum(["occupied", "available", "reserved", "maintenance"]),
      available_from: z.string().optional(),
    }),
    run: async (args) => JSON.stringify(await setRoomStatus(args)),
  }),
  betaZodTool({
    name: "send_agreement",
    description:
      "Generate a sublease agreement PDF and SEND it straight to the tenant. New " +
      "York apartments → no letterhead, sent from the personal Gmail account (From " +
      "\"Vineet\", unbranded). Non-New-York → with letterhead, sent from the " +
      "Outlook/M365 work account. This sends immediately — there is no draft to " +
      "review. Only call this once you have all required fields and the operator " +
      "has confirmed; ask for anything missing first.",
    inputSchema: z.object({
      tenant_name: z.string().describe("Tenant's full name"),
      recipient_email: z.string().describe("Tenant email address to send the agreement to"),
      property_address: z
        .string()
        .describe("Full property address (include city/state for non-NY units)"),
      rent: z.string().describe('Monthly rent, e.g. "1650"'),
      security_deposit: z.string().describe("Security deposit amount"),
      lease_start_date: z.string().describe('Lease start "YYYY-MM-DD"'),
      lease_end_date: z.string().describe('Lease end "YYYY-MM-DD"'),
      in_new_york: z
        .boolean()
        .describe(
          "True if the apartment is in New York (→ no letterhead, Gmail). " +
            "False otherwise (→ letterhead, Outlook).",
        ),
      sublessor_name: z
        .string()
        .optional()
        .describe('Sublessor name; defaults to "Vineet Dutta"'),
      pro_rate_rent: z
        .string()
        .optional()
        .describe("Prorated first-month rent, if any"),
      agreement_date: z
        .string()
        .optional()
        .describe('Agreement date "YYYY-MM-DD"; defaults to today'),
      confirm_mailbox_mismatch: z
        .boolean()
        .optional()
        .describe(
          "Set true ONLY after the operator explicitly insists on sending even " +
            "though the property address's state contradicts in_new_york. " +
            "Never set it on the first attempt.",
        ),
      property_id: z
        .string()
        .optional()
        .describe(
          "UUID from resolve_property_address. Always pass it when known: on " +
            "a successful send the confirmed property_address is saved and " +
            "reused verbatim for future agreements at this property.",
        ),
    }),
    run: async (args) => JSON.stringify(await sendAgreement(args)),
  }),
  betaZodTool({
    name: "add_tenant",
    description:
      "Add a new tenant and place them in a room (creates the tenant record AND " +
      "an active tenancy). Use this when the operator asks to add / create / " +
      "onboard a tenant — typically right after sending their agreement, by " +
      "re-sending the agreement details. Required: full name, email, phone, " +
      "monthly rent, lease start date, lease end date, and the room to place " +
      "them in. You must resolve room_id first. If the operator named the unit/" +
      "room, call list_properties to find the unit by address, then get_property " +
      "to list its rooms and pick the vacant one (ask which room if ambiguous). " +
      "If no unit + room is given, call list_inventory and ask the operator which " +
      "room to use — never guess. ALWAYS confirm the " +
      "full details — name, email, phone, room, rent, and lease dates — with the " +
      "operator before calling this. Ask for any missing required field; do not " +
      "guess. Do NOT collect or record a security deposit here, even if the " +
      "message includes one. This does not send an agreement (use send_agreement " +
      "for that).",
    inputSchema: z.object({
      full_name: z.string().describe("Tenant's full name"),
      email: z.string().describe("Tenant email address"),
      phone: z.string().describe("Tenant phone number"),
      room_id: z
        .string()
        .describe(
          "UUID of the room to place the tenant in. Resolve via list_properties → get_property.",
        ),
      monthly_rent: z.number().positive().describe("Monthly rent amount"),
      start_date: z.string().describe('Lease start date "YYYY-MM-DD"'),
      lease_end_date: z.string().describe('Lease end date "YYYY-MM-DD"'),
      first_month_rent: z
        .number()
        .nonnegative()
        .optional()
        .describe("Prorated first-month rent, if different from monthly rent"),
      pays_as: z
        .string()
        .optional()
        .describe("Name the tenant's payments arrive under, if different"),
      notes: z.string().optional().describe("Free-form notes about the tenant"),
    }),
    run: async (args) => JSON.stringify(await addTenant(args)),
  }),
  betaZodTool({
    name: "share_inventory_sheet",
    description:
      "Generate the public 'Shareable Sheet' of listable inventory — rooms " +
      "available now plus rooms scheduled to open up — as an .xlsx file and send " +
      "it to this Telegram chat as a document attachment. Use this whenever the " +
      "operator asks to share, send, export, or get the inventory sheet/list. " +
      "After it succeeds, just confirm it was sent; the file itself is delivered " +
      "separately as an attachment.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await shareInventorySheet()),
  }),
  betaZodTool({
    name: "email_inventory_sheet",
    description:
      "Email the public 'Shareable Sheet' of listable inventory as an .xlsx " +
      "attachment, sent from the personal Gmail account. Use when the " +
      "operator wants the inventory sheet emailed to someone (a prospect, broker, " +
      "or themselves). You MUST have a recipient email address first — if the " +
      "operator hasn't given one, ask for it before calling this. After it " +
      "succeeds, confirm it was emailed and to whom.",
    inputSchema: z.object({
      recipient_email: z
        .string()
        .describe("Email address to send the inventory sheet to"),
    }),
    run: async (args) => JSON.stringify(await emailInventorySheet(args)),
  }),
  betaZodTool({
    name: "get_collection_summary",
    description:
      "Headline rent-collection KPIs: this-month expected/collected/outstanding, " +
      "year-to-date expected/collected, and lifetime collected + payment count.",
    inputSchema: z.object({}),
    run: async () => {
      const { getCollectionSummary } = await import(
        "@/lib/analytics/collections"
      );
      return JSON.stringify(await getCollectionSummary());
    },
  }),
  betaZodTool({
    name: "get_monthly_collections",
    description:
      "Per-month timeline of expected vs collected rent across the portfolio. " +
      "Defaults to all months from the earliest tenancy start through the current month.",
    inputSchema: z.object({
      from_month: z
        .string()
        .optional()
        .describe('Start month "YYYY-MM"; defaults to earliest tenancy start'),
      to_month: z
        .string()
        .optional()
        .describe('End month "YYYY-MM"; defaults to current month'),
    }),
    run: async (args) => {
      const { getMonthlyCollections } = await import(
        "@/lib/analytics/collections"
      );
      return JSON.stringify(
        await getMonthlyCollections(args.from_month, args.to_month),
      );
    },
  }),
  betaZodTool({
    name: "get_property_collections",
    description:
      "Lifetime rent collected per property, sorted descending. " +
      "Optionally bounded by date range (paid_on between from and to).",
    inputSchema: z.object({
      from: z.string().optional().describe('Start date "YYYY-MM-DD" (optional)'),
      to: z.string().optional().describe('End date "YYYY-MM-DD" (optional)'),
    }),
    run: async (args) => {
      const { getPropertyCollections } = await import(
        "@/lib/analytics/collections"
      );
      return JSON.stringify(await getPropertyCollections(args.from, args.to));
    },
  }),
  betaZodTool({
    name: "resolve_property_address",
    description:
      "Autocomplete a full property address from a fragment the operator " +
      "gave (building name, street, unit, or neighborhood — e.g. '3516 jfk " +
      "203' or 'normandie 32F'). Returns up to 5 matching units, each with a " +
      "full_address ready for send_agreement plus the property's is_new_york " +
      "flag. When operator_confirmed is true the address was used on a " +
      "previously sent agreement — it is exact; use it verbatim. Otherwise " +
      "full_address is composed from portal data: auto-correct it to the " +
      "exact postal address (expand abbreviated street names, add the ZIP " +
      "code if you know it) before reading it back. If needs_city_state is " +
      "true, ask the operator for the city/state. Always read the final " +
      "address back for confirmation before sending an agreement.",
    inputSchema: z.object({
      query: z.string().describe("Address fragment as the operator typed it"),
    }),
    run: async (args) => JSON.stringify(await resolvePropertyAddress(args)),
  }),
  betaZodTool({
    name: "update_tenant",
    description:
      "Update a tenant's profile fields (name, email, phone, pays_as, " +
      "profession, age, notes). Only the fields provided change; pass null " +
      "to clear a field. Does not touch the tenancy or ledger.",
    inputSchema: z.object({
      tenant_id: z.string(),
      full_name: z.string().optional(),
      email: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      pays_as: z
        .string()
        .nullable()
        .optional()
        .describe("Name on Zelle deposits, used by reconciliation matching"),
      profession: z.string().nullable().optional(),
      age: z.number().int().min(0).max(150).nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    run: async (args) => JSON.stringify(await updateTenant(args)),
  }),
  betaZodTool({
    name: "update_tenancy",
    description:
      "Update a tenancy's rent amounts and lease dates: monthly_rent, " +
      "first_month_rent (prorated amount charged only for the calendar month " +
      "the tenancy starts in; null = full monthly rent), security_deposit " +
      "(informational), start_date, lease_end_date. The ledger recomputes " +
      "from these, so rent changes reprice the auto monthly charges " +
      "immediately. Use end_tenancy / cancel_move_out for move-outs.",
    inputSchema: z.object({
      tenancy_id: z.string(),
      monthly_rent: z.number().positive().optional(),
      first_month_rent: z.number().min(0).nullable().optional(),
      security_deposit: z.number().min(0).nullable().optional(),
      start_date: z.string().optional().describe('"YYYY-MM-DD"'),
      lease_end_date: z
        .string()
        .nullable()
        .optional()
        .describe('"YYYY-MM-DD"; changing it re-arms lease-ending reminders'),
    }),
    run: async (args) => JSON.stringify(await updateTenancy(args)),
  }),
  betaZodTool({
    name: "cancel_move_out",
    description:
      "Cancel a scheduled move-out: clears the tenancy's move_out_date, sets " +
      "it back to active, and returns the room to plain Occupied (no " +
      "available-from date on Inventory). The undo of end_tenancy.",
    inputSchema: z.object({ tenancy_id: z.string() }),
    run: async (args) => JSON.stringify(await cancelMoveOut(args)),
  }),
  betaZodTool({
    name: "add_charge",
    description:
      "Post an ad-hoc charge a tenant owes on their ledger: security_deposit, " +
      "late_fee (~$50), or other (note required). This is the owed side — use " +
      "record_payment when money is received.",
    inputSchema: z.object({
      tenancy_id: z.string(),
      kind: z.enum(["security_deposit", "late_fee", "other"]),
      amount: z.number().positive(),
      note: z.string().optional().describe("Required when kind is 'other'"),
      charged_on: z
        .string()
        .optional()
        .describe('"YYYY-MM-DD", defaults to today'),
    }),
    run: async (args) => JSON.stringify(await addTenancyCharge(args)),
  }),
  betaZodTool({
    name: "get_lease_url",
    description:
      "Get a download link for the lease PDF on file for a tenancy. The link " +
      "is signed and expires after 10 minutes.",
    inputSchema: z.object({ tenancy_id: z.string() }),
    run: async (args) => JSON.stringify(await getLeaseUrl(args)),
  }),
  betaZodTool({
    name: "list_cleanings",
    description:
      "Recent logged cleanings (newest first) with their record ids — use " +
      "this to find the record to fix with update_cleaning_record or " +
      "delete_cleaning_record. Optionally filter to one property.",
    inputSchema: z.object({
      property_id: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
    }),
    run: async (args) => JSON.stringify(await listCleanings(args)),
  }),
  betaZodTool({
    name: "list_cleaners",
    description:
      "All cleaners with contact info, enabled flag, and which properties " +
      "each is assigned to.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await listCleaners()),
  }),
  betaZodTool({
    name: "add_cleaner",
    description: "Add a cleaner (name + email, optional phone), enabled by default.",
    inputSchema: z.object({
      name: z.string(),
      email: z.string(),
      phone: z.string().optional(),
    }),
    run: async (args) => JSON.stringify(await addCleaner(args)),
  }),
  betaZodTool({
    name: "set_cleaner_enabled",
    description:
      "Enable or disable a cleaner. Disabled cleaners drop out of the " +
      "'Cleaned by' options and schedule-change notifications.",
    inputSchema: z.object({
      cleaner_id: z.string(),
      enabled: z.boolean(),
    }),
    run: async (args) => JSON.stringify(await setCleanerEnabled(args)),
  }),
  betaZodTool({
    name: "assign_cleaner",
    description:
      "Assign a cleaner to a property (assigned: true) or remove the " +
      "assignment (assigned: false).",
    inputSchema: z.object({
      property_id: z.string(),
      cleaner_id: z.string(),
      assigned: z.boolean(),
    }),
    run: async (args) => JSON.stringify(await assignCleaner(args)),
  }),
  betaZodTool({
    name: "update_cleaning_record",
    description:
      "Fix a logged cleaning: change its date, who cleaned, or notes. Only " +
      "the fields provided change; pass null to clear assigned_to/notes.",
    inputSchema: z.object({
      record_id: z.string(),
      cleaning_date: z.string().optional().describe('"YYYY-MM-DD"'),
      assigned_to: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    run: async (args) => JSON.stringify(await updateCleaningRecord(args)),
  }),
  betaZodTool({
    name: "delete_cleaning_record",
    description: "Delete a wrongly logged cleaning record.",
    inputSchema: z.object({ record_id: z.string() }),
    run: async (args) => JSON.stringify(await deleteCleaningRecord(args)),
  }),
];

/**
 * Wrap a tool's `run` so every invocation is written to the diagnostic activity
 * log: the tool name, its input, the result (or thrown error), whether it
 * reported ok, and how long it took. This is what makes "the bot said it did X
 * but nothing happened" investigable — the raw tool result is captured here,
 * before the model gets a chance to summarize (or misreport) it.
 *
 * Best-effort and non-blocking: logging is fire-and-forget and can never change
 * what the tool returns or throws.
 */
function instrumentTool<
  // Tools have heterogeneous, zod-derived run signatures; wrap them generically.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends { name: string; run: (...args: any[]) => any },
>(tool: T): T {
  const original = tool.run.bind(tool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = async (...args: any[]) => {
    const ctx = getToolContext();
    const base = {
      kind: "tool_call" as const,
      chatId: ctx?.chatId ?? 0,
      turnId: ctx?.turnId,
      telegramUserId: ctx?.telegramUserId,
      username: ctx?.username,
      toolName: tool.name,
    };
    const startedAt = Date.now();
    try {
      const result = await original(...args);
      const ok = okFromResult(result) ?? true;
      ctx?.calledTools?.push({ name: tool.name, ok });
      void logTelegramEvent({
        ...base,
        ok,
        latencyMs: Date.now() - startedAt,
        detail: { input: args[0], result: normalizeToolResult(result) },
      });
      return result;
    } catch (e) {
      ctx?.calledTools?.push({ name: tool.name, ok: false });
      void logTelegramEvent({
        ...base,
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
        detail: { input: args[0] },
      });
      throw e;
    }
  };
  // Mutate in place so the runnable-tool object keeps its identity/prototype;
  // only the run implementation is swapped for the instrumented one.
  (tool as { run: typeof wrapped }).run = wrapped;
  return tool;
}

export const tools = rawTools.map(instrumentTool);
