/**
 * Monthly rent-reminder cron.
 *
 * Vercel cron hits this on the 1st of each month. We email every active
 * tenant a generic reminder. The rent_reminder_emails table enforces
 * idempotency via a unique (tenancy_id, period_month) constraint, so a
 * retry (or accidental re-run) won't double-send.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendRentReminder } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function todayMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const supabase = admin();
  const period = todayMonth();
  const today = new Date().toISOString().slice(0, 10);

  // Active tenancies whose tenant has an email and whose end_date (if set)
  // is after today.
  const { data: tenancies, error } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, end_date, status,
       tenants!inner(id, email)`,
    )
    .eq("status", "active");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type Row = {
    id: string;
    tenant_id: string;
    end_date: string | null;
    tenants: { id: string; email: string | null } | { id: string; email: string | null }[] | null;
  };

  const rows = (tenancies ?? []) as Row[];
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ tenancy_id: string; error: string }> = [];

  for (const row of rows) {
    const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
    const email = tenant?.email?.trim();
    if (!email) {
      skipped++;
      continue;
    }
    if (row.end_date && row.end_date <= today) {
      skipped++;
      continue;
    }

    // Reserve the slot first — relies on the unique (tenancy_id, period_month)
    // constraint to prevent double-sends from concurrent runs.
    const { error: lockErr } = await supabase
      .from("rent_reminder_emails")
      .insert({
        tenancy_id: row.id,
        tenant_id: row.tenant_id,
        period_month: period,
        email_to: email,
      });
    if (lockErr) {
      // 23505 = unique_violation → already sent this month, skip silently.
      if ((lockErr as { code?: string }).code === "23505") {
        skipped++;
        continue;
      }
      failed++;
      errors.push({ tenancy_id: row.id, error: lockErr.message });
      continue;
    }

    const result = await sendRentReminder(email);

    await supabase
      .from("rent_reminder_emails")
      .update({
        sent_at: result.ok ? new Date().toISOString() : null,
        resend_id: result.ok ? result.id : null,
        error_text: result.ok ? null : result.error,
      })
      .eq("tenancy_id", row.id)
      .eq("period_month", period);

    if (result.ok) {
      sent++;
    } else {
      failed++;
      errors.push({ tenancy_id: row.id, error: result.error });
    }
  }

  return NextResponse.json({
    period,
    total: rows.length,
    sent,
    skipped,
    failed,
    errors,
    debug: {
      has_RESEND_API_KEY: !!process.env.RESEND_API_KEY,
      RESEND_API_KEY_length: process.env.RESEND_API_KEY?.length ?? 0,
      has_CRON_SECRET: !!process.env.CRON_SECRET,
      has_RESEND_FROM: !!process.env.RESEND_FROM,
      has_RESEND_REPLY_TO: !!process.env.RESEND_REPLY_TO,
      vercel_env: process.env.VERCEL_ENV ?? null,
      vercel_git_commit_sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
  });
}
