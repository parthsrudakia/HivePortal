import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { todayISO } from "@/lib/date";
import { enqueueCleanerScheduleChange } from "@/lib/cleaner-reminders";
import type { Database } from "@/lib/supabase/types";
import { admin, one, propertyLabel } from "./helpers";

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
  const patch: Database["public"]["Tables"]["cleaning_records"]["Update"] = {};
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

export const cleaningTools = [
  betaZodTool({
    name: "list_overdue_cleanings",
    description:
      "Properties overdue or due-soon for cleaning (35-day cadence).",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await listOverdueCleanings()),
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
