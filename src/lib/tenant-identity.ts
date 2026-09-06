/**
 * Tenant identity: a tenant is unique by email address.
 *
 * Every path that creates a tenant (the Add Tenant form, the Telegram bot)
 * first asks {@link findExistingTenant}: if a tenant with the same email
 * (case-insensitive) already exists and the name fuzzy-matches, that record is
 * reused — a returning tenant keeps their one ledger, history, and profile
 * instead of becoming a second person. Same email but a clearly different
 * name (a partner sharing an inbox, a typo'd address) still creates a new
 * record, so the match never silently merges two people.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** Lowercase, strip accents/punctuation, collapse whitespace → word tokens. */
function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 string similarity (1 = identical). */
function similarity(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  return len === 0 ? 1 : 1 - levenshtein(a, b) / len;
}

/**
 * Do two names plausibly belong to the same person? True when, after
 * normalising:
 *  • the token sets overlap by half or more ("Marcel Prabu Dwipayana" vs
 *    "Marcel Dwipayana"), or one is contained in the other ("Sam Lee" vs
 *    "Samuel Lee" fails this but passes the next rule), or
 *  • the joined strings are ≥ 80% similar (typos, missing middle name), or
 *  • first and last tokens match and every shared token is a near-match.
 */
export function namesFuzzyMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const ja = ta.join("");
  const jb = tb.join("");
  if (ja === jb) return true;

  const setA = new Set(ta);
  const setB = new Set(tb);
  const shared = [...setA].filter((t) => setB.has(t)).length;
  const smaller = Math.min(setA.size, setB.size);
  const union = new Set([...setA, ...setB]).size;
  // Every token of the shorter name appears in the longer one, or at least
  // half of all distinct tokens are shared.
  if (shared === smaller || shared / union >= 0.5) return true;

  if (similarity(ja, jb) >= 0.8) return true;

  // First + last name close enough (each ≥ 80% similar) — catches a typo in
  // one part of the name.
  const firstOk = similarity(ta[0], tb[0]) >= 0.8;
  const lastOk = similarity(ta[ta.length - 1], tb[tb.length - 1]) >= 0.8;
  return firstOk && lastOk;
}

export type ExistingTenant = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  pays_as: string | null;
  notes: string | null;
  social_links: string[];
};

// Either the cookie-session server client or the service-role client.
type TenantClient = Pick<SupabaseClient<Database>, "from">;

/**
 * The existing tenant record this (email, name) pair refers to, if any:
 * same email (case-insensitive) AND a fuzzy name match. With several
 * candidates the most recently updated wins.
 */
export async function findExistingTenant(
  supabase: TenantClient,
  input: { email: string | null | undefined; full_name: string },
): Promise<ExistingTenant | null> {
  const email = normalizeEmail(input.email);
  if (!email) return null;
  const { data } = await supabase
    .from("tenants")
    .select("id, full_name, email, phone, pays_as, notes, social_links, updated_at")
    .ilike("email", email)
    .order("updated_at", { ascending: false });
  for (const t of data ?? []) {
    if (normalizeEmail(t.email) !== email) continue;
    if (namesFuzzyMatch(t.full_name, input.full_name)) return t;
  }
  return null;
}

/**
 * Bring a reused record up to date with what was just entered: a fresh phone
 * or pays-as replaces the old value, new social links are merged in, and new
 * notes are appended (never overwriting what the operator wrote before).
 * The stored name is kept — the new one is the same person by construction.
 */
export function mergeTenantProfile(
  existing: ExistingTenant,
  incoming: {
    phone?: string | null;
    pays_as?: string | null;
    notes?: string | null;
    social_links?: string[] | null;
  },
): Partial<Database["public"]["Tables"]["tenants"]["Update"]> {
  const patch: Partial<Database["public"]["Tables"]["tenants"]["Update"]> = {};
  const phone = incoming.phone?.trim();
  if (phone && phone !== existing.phone) patch.phone = phone;
  const paysAs = incoming.pays_as?.trim();
  if (paysAs && paysAs !== existing.pays_as) patch.pays_as = paysAs;
  const notes = incoming.notes?.trim();
  if (notes && notes !== existing.notes?.trim()) {
    patch.notes = existing.notes?.trim()
      ? `${existing.notes.trim()}\n${notes}`
      : notes;
  }
  const links = (incoming.social_links ?? []).map((l) => l.trim()).filter(Boolean);
  if (links.length) {
    const merged = Array.from(new Set([...(existing.social_links ?? []), ...links]));
    if (merged.length !== (existing.social_links ?? []).length)
      patch.social_links = merged;
  }
  return patch;
}
