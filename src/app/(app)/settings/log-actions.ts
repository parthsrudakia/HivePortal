"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";
import { isMaster } from "@/lib/access";

type Result = { ok: true; deleted: number } | { error: string };

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Master-only: confirm the caller is the master operator. */
async function requireMaster(): Promise<string | null> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isMaster(user?.email) ? null : "Not authorized.";
}

/** Wipe every row from a log table. These tables are read-only under RLS, so
 *  the delete runs with the service role after a master check. */
async function clearTable(
  table: "email_log" | "sms_log" | "audit_log" | "telegram_activity_log",
): Promise<Result> {
  const denied = await requireMaster();
  if (denied) return { error: denied };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error, count } = await (admin() as any)
    .from(table)
    .delete({ count: "exact" })
    .not("id", "is", null);
  if (error) return { error: error.message };
  return { ok: true, deleted: count ?? 0 };
}

export async function clearEmailLog(): Promise<Result> {
  const res = await clearTable("email_log");
  if ("ok" in res) revalidatePath("/settings/email-log");
  return res;
}

export async function clearSmsLog(): Promise<Result> {
  const res = await clearTable("sms_log");
  if ("ok" in res) revalidatePath("/settings/sms-log");
  return res;
}

export async function clearAuditLog(): Promise<Result> {
  const res = await clearTable("audit_log");
  if ("ok" in res) revalidatePath("/settings/audit-log");
  return res;
}

export async function clearTelegramLog(): Promise<Result> {
  const res = await clearTable("telegram_activity_log");
  if ("ok" in res) revalidatePath("/settings/telegram-log");
  return res;
}
