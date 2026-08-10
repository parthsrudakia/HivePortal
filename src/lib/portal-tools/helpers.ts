import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// PostgREST object-or-array join normalizer, shared with the rest of the app.
export { one } from "@/lib/relations";

/** Service-role client for the bot's privileged reads and writes. */
export function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function propertyLabel(p: {
  building_name: string | null;
  street_address: string;
  unit_number: string;
}): string {
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

// One address only — no commas/semicolons, so a tool-supplied list can never
// fan an agreement out to multiple recipients.
export const SINGLE_EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "$2,050" / "2050.00" → "2050"/"2050.00"; null when not a positive amount. */
export function normalizeMoney(value: string): string | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned) || Number(cleaned) <= 0) return null;
  return cleaned;
}
