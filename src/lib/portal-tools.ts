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
import { todayISO } from "@/lib/date";
import { generateAgreementPdf } from "@/lib/agreements";
import { sendGmailMessage } from "@/lib/google-mail";
import { sendOutlookMessage } from "@/lib/graph-mail";
import {
  agreementEmailTemplate,
  gmailAgreementBody,
  inventorySheetEmailTemplate,
} from "@/lib/email";
import { buildInventorySheet } from "@/lib/inventory-sheet";
import { sendDocument } from "@/lib/telegram";

/**
 * Per-request context for tools that need to know which Telegram chat they're
 * acting in (e.g. to deliver a file). The webhook wraps the tool runner in
 * `runWithToolContext` so handlers can read the active chat id.
 */
type ToolContext = { chatId: number };
const toolContext = new AsyncLocalStorage<ToolContext>();

export function runWithToolContext<T>(ctx: ToolContext, fn: () => T): T {
  return toolContext.run(ctx, fn);
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

function monthBounds(yyyymm: string): { start: string; end: string } {
  const [y, m] = yyyymm.slice(0, 7).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
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
       has_gym, has_elevator, has_parking, has_doorman,
       laundry_in_building, in_unit_laundry, amenities_notes, notes,
       leaseholders(name)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!property) throw new Error("Property not found.");

  const { data: rooms, error: rErr } = await supabase
    .from("rooms")
    .select(
      `id, room_number, has_ac, has_private_bathroom, base_rent, bundle_fee,
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
      gym: property.has_gym,
      elevator: property.has_elevator,
      parking: property.has_parking,
      doorman: property.has_doorman,
      laundry_in_building: property.laundry_in_building,
      in_unit_laundry: property.in_unit_laundry,
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
        has_ac: r.has_ac,
        has_private_bathroom: r.has_private_bathroom,
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
       ad_url, ad_boosted, has_ac, has_private_bathroom,
       marketing_description, photos_url,
       properties(id, building_name, street_address, unit_number, neighborhood)`,
    )
    .or(`status.eq.available,and(status.eq.occupied,available_from.gte.${today})`)
    .order("available_from", { ascending: true, nullsFirst: true });
  if (error) throw new Error(error.message);
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
      ad: { url: r.ad_url, boosted: r.ad_boosted },
      has_ac: r.has_ac,
      has_private_bathroom: r.has_private_bathroom,
      description: r.marketing_description,
      photos_url: r.photos_url,
    };
  });
}

export async function listActiveTenants(args: {
  month?: string;
  only_overdue?: boolean;
}) {
  const supabase = admin();
  const yyyymm = args.month ?? todayISO().slice(0, 7);
  const { start, end } = monthBounds(yyyymm);

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

  return {
    month: yyyymm,
    tenants: args.only_overdue ? rows.filter((r) => r.balance_due > 0) : rows,
  };
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
  "tool_login",
  "marketing",
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
}) {
  const pdf = await generateAgreementPdf({
    tenantName: args.tenant_name,
    sublessorName: args.sublessor_name?.trim() || "Vineet Dutta",
    propertyAddress: args.property_address,
    rent: args.rent,
    securityDeposit: args.security_deposit,
    leaseStartDate: args.lease_start_date,
    leaseEndDate: args.lease_end_date,
    agreementDate: args.agreement_date || todayISO(),
    includeLetterhead: !args.in_new_york,
    proRateRent: args.pro_rate_rent,
  });

  const attachment = {
    filename: pdf.filename,
    base64: pdf.base64,
    mimeType: "application/pdf",
  };

  const mailbox = args.in_new_york ? "gmail" : "outlook";

  let result;
  if (args.in_new_york) {
    // New York: plain, unbranded email from Vineet's personal Gmail (no Hive, no HTML).
    const { subject, text } = gmailAgreementBody({ tenantName: args.tenant_name });
    result = await sendGmailMessage({
      to: args.recipient_email,
      subject,
      text,
      attachment,
    });
  } else {
    // Non-NY: branded email sent from the Outlook work account.
    const { subject, text, html } = agreementEmailTemplate({
      tenantName: args.tenant_name,
    });
    result = await sendOutlookMessage({
      to: args.recipient_email,
      subject,
      text,
      html,
      attachment,
    });
  }

  if (!result.ok) {
    return { ok: false, mailbox, error: result.error };
  }
  return {
    ok: true,
    mailbox,
    letterhead: !args.in_new_york,
    sent: true,
    recipient: args.recipient_email,
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

// ----- Tool definitions for the Anthropic tool runner -----

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

export const tools = [
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
      "Active tenants with monthly rent, paid amount, and balance for a given month. " +
      'Defaults to current month. Pass only_overdue: true to filter to balance_due > 0.',
    inputSchema: z.object({
      month: z
        .string()
        .optional()
        .describe('Month as "YYYY-MM"; defaults to the current month'),
      only_overdue: z.boolean().optional(),
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
      "building_login, tool_login, marketing, other.",
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
    }),
    run: async (args) => JSON.stringify(await sendAgreement(args)),
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
];
