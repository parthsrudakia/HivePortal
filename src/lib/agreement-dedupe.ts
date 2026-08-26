/**
 * Auto-supersede duplicate signing requests. When the same person was sent
 * two or more agreements within 15 days of each other, only the LATEST copy
 * survives — the others are deleted outright (row + stored PDFs), even if
 * signed and even if already attached to a tenant profile:
 *   - the newest send wins; older copies within the window are deleted;
 *   - safety guard: a copy that was signed (or assigned to a tenancy) can
 *     only be superseded by a newer copy that is itself SIGNED — a pending
 *     resend that might expire unsigned never destroys a signed contract;
 *   - when a deleted copy was assigned to a tenancy, the winning signed copy
 *     takes over: its PDF is copied into the leases bucket and the tenancy's
 *     lease_pdf_path is repointed (the old profile copy is removed);
 *   - previously dismissed duplicates in the window are cleaned up too.
 * Requests more than 15 days apart are separate events (e.g. a renewal) and
 * all kept. Runs from the daily ops cron. Deletions are permanent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { AGREEMENTS_BUCKET } from "@/lib/agreement-send";

const WINDOW_DAYS = 15;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type DedupeRow = {
  id: string;
  status: string;
  tenant_name: string;
  recipient_email: string;
  sent_at: string;
  signed_at: string | null;
  assigned_tenancy_id: string | null;
  unsigned_pdf_path: string | null;
  signed_pdf_path: string | null;
};

export type Supersession = {
  /** Row to delete. */
  id: string;
  tenantName: string;
  /** Newer copy that wins. */
  keptId: string;
  /** Tenancy the kept (signed) copy must take over, if the deleted copy held one. */
  reassignTenancyId: string | null;
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
 * Pure planning step: given every request (dismissed included), return the
 * rows a newer kept copy supersedes within the 15-day window, plus any
 * profile assignment the winner must take over. Signed/assigned rows only
 * fall to a newer SIGNED winner; dismissed rows never win, only lose.
 */
export function planSupersessions(rows: DedupeRow[]): Supersession[] {
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

  const isProtected = (r: DedupeRow) =>
    r.signed_at !== null || r.assigned_tenancy_id !== null;

  const out: Supersession[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at),
    );
    const kept: DedupeRow[] = [];
    // A winner can absorb at most one tenancy assignment.
    const claimed = new Set<string>();
    for (const row of sorted) {
      const winner = kept.find(
        (k) =>
          Date.parse(k.sent_at) - Date.parse(row.sent_at) <= WINDOW_MS &&
          (!isProtected(row) || k.signed_at !== null),
      );
      if (winner) {
        const canTakeOver =
          row.assigned_tenancy_id !== null &&
          winner.assigned_tenancy_id === null &&
          !claimed.has(winner.id);
        if (canTakeOver) claimed.add(winner.id);
        out.push({
          id: row.id,
          tenantName: row.tenant_name,
          keptId: winner.id,
          reassignTenancyId: canTakeOver ? row.assigned_tenancy_id : null,
        });
      } else if (row.status !== "dismissed") {
        kept.push(row);
      }
    }
  }
  return out;
}

/**
 * Execute the plan: repoint any profile assignment at the winning signed
 * copy, then hard-delete the superseded rows and their PDFs. A failed
 * takeover skips that row's deletion so a profile is never left pointing at
 * a lost agreement.
 */
export async function dedupeAgreementRequests(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("agreement_requests")
    .select(
      "id, status, tenant_name, recipient_email, sent_at, signed_at, assigned_tenancy_id, unsigned_pdf_path, signed_pdf_path",
    );
  if (error) return { deleted: [], reassigned: 0, error: error.message };

  const rows = (data ?? []) as DedupeRow[];
  const plan = planSupersessions(rows);
  if (plan.length === 0) return { deleted: [], reassigned: 0 };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const errors: string[] = [];
  let reassigned = 0;
  const deletable: DedupeRow[] = [];

  for (const step of plan) {
    const row = byId.get(step.id);
    if (!row) continue;

    if (step.reassignTenancyId) {
      const winner = byId.get(step.keptId);
      if (!winner?.signed_pdf_path) {
        errors.push(`${step.keptId}: winner has no signed PDF; kept ${step.id}`);
        continue;
      }
      const { data: tenancy } = await supabase
        .from("tenancies")
        .select("id, tenant_id, lease_pdf_path")
        .eq("id", step.reassignTenancyId)
        .maybeSingle();
      if (!tenancy) {
        errors.push(`${step.id}: assigned tenancy not found; kept`);
        continue;
      }
      const { data: pdfBlob, error: downloadError } = await supabase.storage
        .from(AGREEMENTS_BUCKET)
        .download(winner.signed_pdf_path);
      if (downloadError || !pdfBlob) {
        errors.push(`${step.keptId}: signed PDF unreadable; kept ${step.id}`);
        continue;
      }
      const leasePath = `${tenancy.tenant_id}/${Date.now()}-signed-agreement.pdf`;
      const { error: uploadError } = await supabase.storage
        .from("leases")
        .upload(leasePath, Buffer.from(await pdfBlob.arrayBuffer()), {
          contentType: "application/pdf",
        });
      if (uploadError) {
        errors.push(`${step.id}: lease upload failed (${uploadError.message}); kept`);
        continue;
      }
      const { error: tenancyError } = await supabase
        .from("tenancies")
        .update({ lease_pdf_path: leasePath })
        .eq("id", tenancy.id);
      if (tenancyError) {
        await supabase.storage.from("leases").remove([leasePath]);
        errors.push(`${step.id}: tenancy update failed (${tenancyError.message}); kept`);
        continue;
      }
      await supabase
        .from("agreement_requests")
        .update({
          assigned_tenancy_id: tenancy.id,
          assigned_at: new Date().toISOString(),
        })
        .eq("id", winner.id);
      // The superseded profile copy in the leases bucket is now orphaned.
      if (tenancy.lease_pdf_path && tenancy.lease_pdf_path !== leasePath) {
        await supabase.storage.from("leases").remove([tenancy.lease_pdf_path]);
      }
      reassigned++;
    }

    deletable.push(row);
  }

  if (deletable.length > 0) {
    // Files first (best-effort), then rows — matching clearRequests.
    const paths = deletable.flatMap((r) =>
      [r.unsigned_pdf_path, r.signed_pdf_path].filter(
        (p): p is string => p != null,
      ),
    );
    if (paths.length > 0) {
      await supabase.storage.from(AGREEMENTS_BUCKET).remove(paths);
    }
    const { error: deleteError } = await supabase
      .from("agreement_requests")
      .delete()
      .in(
        "id",
        deletable.map((r) => r.id),
      );
    if (deleteError) errors.push(deleteError.message);
  }

  return {
    deleted: deletable.map((r) => ({ id: r.id, tenantName: r.tenant_name })),
    reassigned,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}
