#!/usr/bin/env node
/**
 * Hive Portal MCP server.
 *
 * Exposes the operational queries and write actions an AI agent would need
 * to inspect and operate the Hive portal — properties, rooms, vacancies,
 * tenants, rent, cleaning, and credentials.
 *
 * Transport: stdio (works with Claude Desktop, Claude Code, and any MCP client).
 * Auth: uses the Supabase service-role key — bypasses RLS, so this server
 * should only be exposed to clients you trust.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "[hive-portal-mcp] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- helpers ----------

function ok(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthBounds(yyyymm: string): { start: string; end: string } {
  // Accepts "YYYY-MM" or "YYYY-MM-DD"; returns first and last day ISO.
  const [y, m] = yyyymm.slice(0, 7).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function unwrapOne<T>(rel: T | T[] | null | undefined): T | null {
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

// ---------- server ----------

const server = new McpServer({
  name: "hive-portal",
  version: "0.1.0",
});

// ---------- read tools ----------

server.registerTool(
  "list_properties",
  {
    title: "List properties",
    description:
      "Lists every property (apartment unit) with its rooms summary, " +
      "leaseholder, and neighborhood. Use this as a starting point when " +
      "answering questions about the portfolio.",
    inputSchema: {},
  },
  async () => {
    const { data, error } = await supabase
      .from("properties")
      .select(
        `id, building_name, street_address, unit_number, neighborhood, bedrooms,
         leaseholders(name),
         rooms(id, status)`,
      )
      .order("street_address");
    if (error) return err(error.message);

    const result = (data ?? []).map((p: any) => ({
      id: p.id,
      name: propertyLabel(p),
      neighborhood: p.neighborhood,
      bedrooms: p.bedrooms,
      leaseholder: unwrapOne(p.leaseholders)?.name ?? null,
      rooms_total: p.rooms?.length ?? 0,
      rooms_available:
        p.rooms?.filter((r: any) => r.status === "available").length ?? 0,
    }));
    return ok(result);
  },
);

server.registerTool(
  "get_property",
  {
    title: "Get property",
    description:
      "Full property details by id: address, amenities, leaseholder, " +
      "and every room with its current tenant (if occupied).",
    inputSchema: { id: z.string().describe("UUID of the property") },
  },
  async ({ id }) => {
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
    if (pErr) return err(pErr.message);
    if (!property) return err("Property not found.");

    const { data: rooms, error: rErr } = await supabase
      .from("rooms")
      .select(
        `id, room_number, has_ac, has_private_bathroom, base_rent, bundle_fee,
         total_rent, status, available_from, listing_action,
         tenancies!left(id, status, monthly_rent, start_date, end_date,
                        tenants(id, full_name, email, phone))`,
      )
      .eq("property_id", id);
    if (rErr) return err(rErr.message);

    const enriched = (rooms ?? []).map((r: any) => {
      const active = (r.tenancies ?? []).find(
        (t: any) => t.status === "active",
      );
      const tenant = active ? unwrapOne(active.tenants) : null;
      return {
        id: r.id,
        room_number: r.room_number,
        status: r.status,
        listing_action: r.listing_action,
        rent: { base: r.base_rent, bundle: r.bundle_fee, total: r.total_rent },
        has_ac: r.has_ac,
        has_private_bathroom: r.has_private_bathroom,
        available_from: r.available_from,
        current_tenant: tenant
          ? {
              id: tenant.id,
              full_name: tenant.full_name,
              email: tenant.email,
              phone: tenant.phone,
              tenancy_id: active.id,
              start_date: active.start_date,
              end_date: active.end_date,
              monthly_rent: active.monthly_rent,
            }
          : null,
      };
    });

    return ok({
      id: property.id,
      name: propertyLabel(property),
      address: property.street_address,
      unit_number: property.unit_number,
      cross_street: property.cross_street,
      neighborhood: property.neighborhood,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      leaseholder: unwrapOne(property.leaseholders)?.name ?? null,
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
      rooms: enriched,
    });
  },
);

server.registerTool(
  "list_vacancies",
  {
    title: "List vacancies",
    description:
      "Listable rooms — currently vacant OR with a scheduled future move-out. " +
      "Returns price, available date, amenities, listing-action priority, and " +
      "ad URL / boost status.",
    inputSchema: {},
  },
  async () => {
    const today = todayISO();
    const { data, error } = await supabase
      .from("rooms")
      .select(
        `id, room_number, total_rent, available_from, status, listing_action,
         ad_url, ad_boosted, has_ac, has_private_bathroom,
         marketing_description, photos_url,
         properties(id, building_name, street_address, unit_number, neighborhood,
                    has_gym, has_elevator, has_parking, has_doorman,
                    laundry_in_building, in_unit_laundry)`,
      )
      .or(
        `status.eq.available,and(status.eq.occupied,available_from.gte.${today})`,
      )
      .order("available_from", { ascending: true, nullsFirst: true });
    if (error) return err(error.message);

    const result = (data ?? []).map((r: any) => {
      const p = unwrapOne(r.properties);
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
        amenities: {
          gym: p?.has_gym,
          elevator: p?.has_elevator,
          parking: p?.has_parking,
          doorman: p?.has_doorman,
          laundry_in_building: p?.laundry_in_building,
          in_unit_laundry: p?.in_unit_laundry,
          ac_in_room: r.has_ac,
          private_bathroom: r.has_private_bathroom,
        },
        description: r.marketing_description,
        photos_url: r.photos_url,
      };
    });

    return ok(result);
  },
);

server.registerTool(
  "list_active_tenants",
  {
    title: "List active tenants with current-month rent status",
    description:
      "Every tenant whose tenancy is active, with monthly rent, amount paid " +
      "for the requested month, and outstanding balance.",
    inputSchema: {
      month: z
        .string()
        .optional()
        .describe(
          'Month in "YYYY-MM" format. Defaults to the current month.',
        ),
      only_overdue: z
        .boolean()
        .optional()
        .describe("If true, only return tenants with balance_due > 0."),
    },
  },
  async ({ month, only_overdue }) => {
    const now = new Date();
    const yyyymm =
      month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
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
    if (error) return err(error.message);

    const rows = (data ?? []).map((t: any) => {
      const paid = (t.payments ?? [])
        .filter(
          (p: any) =>
            p.payment_type === "rent" &&
            p.paid_on >= start &&
            p.paid_on <= end,
        )
        .reduce((sum: number, p: any) => sum + Number(p.amount), 0);
      const tenant = unwrapOne(t.tenants);
      const room = unwrapOne(t.rooms);
      const property = unwrapOne(room?.properties ?? null);
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

    const filtered = only_overdue
      ? rows.filter((r) => r.balance_due > 0)
      : rows;
    return ok({ month: yyyymm, count: filtered.length, tenants: filtered });
  },
);

server.registerTool(
  "list_overdue_cleanings",
  {
    title: "List overdue / due-soon cleanings",
    description:
      "Properties whose cleaning is overdue or coming up within 7 days, using a 35-day cadence.",
    inputSchema: {},
  },
  async () => {
    const today = todayISO();
    const { data: properties, error: pErr } = await supabase
      .from("properties")
      .select("id, building_name, street_address, unit_number");
    if (pErr) return err(pErr.message);

    const { data: cleanings, error: cErr } = await supabase
      .from("cleaning_records")
      .select("property_id, cleaning_date")
      .order("cleaning_date", { ascending: false });
    if (cErr) return err(cErr.message);

    const lastBy = new Map<string, string>();
    for (const c of cleanings ?? []) {
      if (!lastBy.has(c.property_id)) lastBy.set(c.property_id, c.cleaning_date);
    }

    const result: Array<{
      property_id: string;
      name: string;
      last_cleaning: string | null;
      next_due: string | null;
      days_until: number | null;
      status: "never" | "overdue" | "due_soon" | "scheduled";
    }> = [];

    for (const p of properties ?? []) {
      const last = lastBy.get(p.id) ?? null;
      if (!last) {
        result.push({
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
      let status: "overdue" | "due_soon" | "scheduled";
      if (daysUntil < 0) status = "overdue";
      else if (daysUntil <= 7) status = "due_soon";
      else status = "scheduled";
      if (status === "scheduled") continue;
      result.push({
        property_id: p.id,
        name: propertyLabel(p),
        last_cleaning: last,
        next_due: nextDue,
        days_until: daysUntil,
        status,
      });
    }

    result.sort((a, b) => (a.days_until ?? -9999) - (b.days_until ?? -9999));
    return ok(result);
  },
);

server.registerTool(
  "get_credentials",
  {
    title: "Get credentials",
    description:
      "Fetch credentials, optionally filtered by property or category. " +
      "Categories: payment_portal, maintenance_portal, utility, internet, " +
      "building_login, tool_login, marketing, other.",
    inputSchema: {
      property_id: z
        .string()
        .optional()
        .describe("UUID of the property to filter to"),
      category: z
        .enum([
          "payment_portal",
          "maintenance_portal",
          "utility",
          "internet",
          "building_login",
          "tool_login",
          "marketing",
          "other",
        ])
        .optional()
        .describe("Credential category to filter to"),
    },
  },
  async ({ property_id, category }) => {
    let q = supabase
      .from("credentials")
      .select(
        `id, category, service_name, property_id, username, password,
         login_url, account_number, owner_label, notes,
         properties(building_name, street_address, unit_number)`,
      )
      .order("service_name");
    if (property_id) q = q.eq("property_id", property_id);
    if (category) q = q.eq("category", category);

    const { data, error } = await q;
    if (error) return err(error.message);
    return ok(
      (data ?? []).map((c: any) => ({
        id: c.id,
        category: c.category,
        service_name: c.service_name,
        property: c.properties ? propertyLabel(unwrapOne(c.properties)!) : null,
        username: c.username,
        password: c.password,
        login_url: c.login_url,
        account_number: c.account_number,
        owner_label: c.owner_label,
        notes: c.notes,
      })),
    );
  },
);

// ---------- write tools ----------

server.registerTool(
  "record_payment",
  {
    title: "Record a payment",
    description:
      "Add a payment record against a tenancy. Use list_active_tenants to find the tenancy_id.",
    inputSchema: {
      tenancy_id: z.string().describe("UUID of the tenancy"),
      amount: z.number().positive(),
      paid_on: z.string().describe('Date the payment landed, "YYYY-MM-DD"'),
      payment_type: z
        .enum([
          "rent",
          "security_deposit",
          "late_fee",
          "utility",
          "other",
          "refund",
        ])
        .optional()
        .describe("Defaults to 'rent'"),
      method: z
        .string()
        .optional()
        .describe("Zelle, ClickPay, Bilt, check, etc."),
      notes: z.string().optional(),
    },
  },
  async ({ tenancy_id, amount, paid_on, payment_type, method, notes }) => {
    const { error } = await supabase.from("payments").insert({
      tenancy_id,
      amount,
      paid_on,
      payment_type: payment_type ?? "rent",
      method: method ?? null,
      notes: notes ?? null,
    });
    if (error) return err(error.message);
    return ok({ ok: true });
  },
);

server.registerTool(
  "log_cleaning",
  {
    title: "Log a cleaning",
    description: "Record that a unit was cleaned.",
    inputSchema: {
      property_id: z.string().describe("UUID of the property"),
      cleaning_date: z.string().describe('Date cleaned, "YYYY-MM-DD"'),
      assigned_to: z.string().optional().describe("Who did the clean"),
      notes: z.string().optional(),
    },
  },
  async ({ property_id, cleaning_date, assigned_to, notes }) => {
    const { error } = await supabase.from("cleaning_records").insert({
      property_id,
      cleaning_date,
      assigned_to: assigned_to ?? null,
      notes: notes ?? null,
    });
    if (error) return err(error.message);
    return ok({ ok: true });
  },
);

server.registerTool(
  "set_listing_action",
  {
    title: "Set listing action / VA priority",
    description:
      "Update a room's VA priority flag. " +
      "Values: new_ad (blue), update_price_or_date (yellow), " +
      "delete_listing (red), boost_post (orange), priority (purple).",
    inputSchema: {
      room_id: z.string(),
      action: z.enum([
        "new_ad",
        "update_price_or_date",
        "delete_listing",
        "boost_post",
        "priority",
      ]),
    },
  },
  async ({ room_id, action }) => {
    const { error } = await supabase
      .from("rooms")
      .update({ listing_action: action })
      .eq("id", room_id);
    if (error) return err(error.message);
    return ok({ ok: true });
  },
);

server.registerTool(
  "update_room_rent",
  {
    title: "Update room rent",
    description: "Change a room's base rent and (optionally) bundle fee.",
    inputSchema: {
      room_id: z.string(),
      base_rent: z.number().nonnegative(),
      bundle_fee: z.number().nonnegative().optional(),
    },
  },
  async ({ room_id, base_rent, bundle_fee }) => {
    const update: Record<string, unknown> = { base_rent };
    if (bundle_fee !== undefined) update.bundle_fee = bundle_fee;
    const { error } = await supabase
      .from("rooms")
      .update(update)
      .eq("id", room_id);
    if (error) return err(error.message);
    return ok({ ok: true });
  },
);

server.registerTool(
  "end_tenancy",
  {
    title: "End (or schedule the end of) a tenancy",
    description:
      "Set a tenancy's end_date. If end_date is today or earlier the " +
      "tenancy becomes 'ended' and the room flips to 'available'. " +
      "If end_date is in the future the tenancy stays 'active' until " +
      "that day, the room stays 'occupied', but rooms.available_from " +
      "is set so the room appears on the Vacancies page as " +
      "'Available from <date>'.",
    inputSchema: {
      tenancy_id: z.string().describe("UUID of the tenancy to end"),
      end_date: z
        .string()
        .describe('When the tenant moves out, "YYYY-MM-DD"'),
    },
  },
  async ({ tenancy_id, end_date }) => {
    const today = todayISO();
    const isPastOrToday = end_date <= today;

    const { data: tenancy, error: lookupErr } = await supabase
      .from("tenancies")
      .select("room_id")
      .eq("id", tenancy_id)
      .single();
    if (lookupErr || !tenancy) {
      return err(lookupErr?.message ?? "Tenancy not found.");
    }

    const { error: tErr } = await supabase
      .from("tenancies")
      .update({
        end_date,
        status: isPastOrToday ? "ended" : "active",
      })
      .eq("id", tenancy_id);
    if (tErr) return err(tErr.message);

    if (tenancy.room_id) {
      const { error: rErr } = await supabase
        .from("rooms")
        .update({
          status: isPastOrToday ? "available" : "occupied",
          available_from: end_date,
        })
        .eq("id", tenancy.room_id);
      if (rErr) return err(rErr.message);
    }

    return ok({
      ok: true,
      tenancy_id,
      end_date,
      tenancy_status: isPastOrToday ? "ended" : "active",
      room_status: isPastOrToday ? "available" : "occupied",
    });
  },
);

server.registerTool(
  "set_room_status",
  {
    title: "Set a room's status",
    description:
      "Manually flip a room's status. Use end_tenancy instead when there's an " +
      "active tenancy — that handles the tenancy + room in one shot. " +
      "Statuses: occupied, available, reserved, maintenance.",
    inputSchema: {
      room_id: z.string(),
      status: z.enum(["occupied", "available", "reserved", "maintenance"]),
      available_from: z
        .string()
        .optional()
        .describe(
          'Optional date the room becomes free, "YYYY-MM-DD". Useful for "reserved" and "maintenance" statuses.',
        ),
    },
  },
  async ({ room_id, status, available_from }) => {
    const update: Record<string, unknown> = { status };
    if (available_from !== undefined) update.available_from = available_from;
    const { error } = await supabase
      .from("rooms")
      .update(update)
      .eq("id", room_id);
    if (error) return err(error.message);
    return ok({ ok: true, room_id, status, available_from: available_from ?? null });
  },
);

// ---------- start ----------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr (stdout is reserved for MCP messages).
  console.error("[hive-portal-mcp] connected");
}

main().catch((e) => {
  console.error("[hive-portal-mcp] fatal:", e);
  process.exit(1);
});
