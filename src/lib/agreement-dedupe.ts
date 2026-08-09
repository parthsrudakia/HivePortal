/**
 * Auto-dismiss stale duplicate signing requests. When the same person was
 * sent two or more agreements within 15 days of each other, only one should
 * stay actionable on the /agreements tally:
 *   - a signed copy always wins over pending duplicates, even ones sent
 *     minutes later (double-sends where the earlier copy got signed);
 *   - otherwise the newest pending send wins.
 * Requests more than 15 days apart are treated as separate events (e.g. a
 * renewal) and all kept. Runs from the daily ops cron; dismissals are
 * reversible from the tally via undismiss.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const WINDOW_DAYS = 15;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type DedupeRow = {
  id: string;
  status: string;
  tenant_name: string;
  recipient_email: string;
  sent_at: string;
  assigned_tenancy_id: string | null;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Lowercase, strip diacritics, keep letter tokens only. */
function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // capped — callers only ask "≤ 2?"
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

/**
 * Same person? Exact email match, or fuzzy name match: identical token sets,
 * one name's tokens a subset of the other's ("Ralph Rivas" ⊂ "Ralph Martin
 * Rivas"), or small edit distance on the joined name (typos).
 */
export function samePerson(a: DedupeRow, b: DedupeRow): boolean {
  if (normalizeEmail(a.recipient_email) === normalizeEmail(b.recipient_email))
    return true;
  const ta = nameTokens(a.tenant_name);
  const tb = nameTokens(b.tenant_name);
  if (ta.length === 0 || tb.length === 0) return false;
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const largeSet = new Set(large);
  if (small.length >= 2 && small.every((t) => largeSet.has(t))) return true;
  return levenshtein(ta.join(" "), tb.join(" ")) <= 2;
}

/**
 * Pure planning step: given all non-dismissed requests, return the ids of
 * pending, unassigned rows that a kept row (signed, or a newer kept pending)
 * supersedes within the 15-day window. Signed and assigned rows are never
 * dismissed.
 */
export function planDismissals(
  rows: DedupeRow[],
): { id: string; tenantName: string; keptId: string }[] {
  // Union-find person grouping via pairwise fuzzy match (n is small: the
  // tally caps at ~100 live rows).
  const groups: DedupeRow[][] = [];
  for (const row of rows) {
    const matches = groups.filter((g) => g.some((r) => samePerson(r, row)));
    if (matches.length === 0) {
      groups.push([row]);
    } else {
      matches[0].push(row);
      // A new row can bridge previously separate groups — merge them.
      for (const other of matches.slice(1)) {
        matches[0].push(...other);
        groups.splice(groups.indexOf(other), 1);
      }
    }
  }

  const out: { id: string; tenantName: string; keptId: string }[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at),
    );
    // Signed/assigned rows are unconditionally kept; pending rows newest-first
    // are kept only if no already-kept row sits within the window.
    const kept = sorted.filter(
      (r) => r.status === "signed" || r.assigned_tenancy_id !== null,
    );
    for (const row of sorted) {
      if (kept.includes(row)) continue;
      if (row.status !== "pending") continue;
      const winner = kept.find(
        (k) =>
          Math.abs(Date.parse(k.sent_at) - Date.parse(row.sent_at)) <=
          WINDOW_MS,
      );
      if (winner) {
        out.push({ id: row.id, tenantName: row.tenant_name, keptId: winner.id });
      } else {
        kept.push(row);
      }
    }
  }
  return out;
}

export async function dedupeAgreementRequests(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("agreement_requests")
    .select("id, status, tenant_name, recipient_email, sent_at, assigned_tenancy_id")
    .neq("status", "dismissed");
  if (error) return { dismissed: [], error: error.message };

  const plan = planDismissals((data ?? []) as DedupeRow[]);
  if (plan.length === 0) return { dismissed: [] };

  const { error: updateError } = await supabase
    .from("agreement_requests")
    .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
    .in(
      "id",
      plan.map((p) => p.id),
    )
    .eq("status", "pending"); // re-check: never flip a row signed since the read
  if (updateError) return { dismissed: [], error: updateError.message };

  return { dismissed: plan };
}
