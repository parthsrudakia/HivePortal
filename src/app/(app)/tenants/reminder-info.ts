import { createClient } from "@/lib/supabase/server";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

export type ReminderInfo = {
  /** Active tenants who still owe rent for the current month. */
  outstandingCount: number;
  /** When the monthly "to all" reminder last went out (cron). */
  lastGeneralText: string | null;
  /** When balance reminders last went out, with recipient count. */
  lastBalanceText: string | null;
};

function fmtWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Shared by the Tenants & Rent page and the reconciliation run page so the
 * "Send balance reminders" button shows the same count and last-sent note in
 * both places. Mirrors the send action: a tenant is "outstanding" when their
 * current-month due (first_month_rent in the starting month, else monthly_rent)
 * exceeds rent paid this month, skipping tenancies already ended or not started.
 */
export async function getReminderInfo(
  supabase: SupabaseServer,
): Promise<ReminderInfo> {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthStart = new Date(y, m, 1).toISOString().slice(0, 10);
  const monthEnd = new Date(y, m + 1, 0).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  type ReminderTenancy = {
    monthly_rent: number;
    first_month_rent: number | null;
    start_date: string;
    end_date: string | null;
    payments: { amount: number; paid_on: string; payment_type: string }[];
  };

  const [{ data: tenancies }, { data: lastGeneral }, lastBalanceRes] =
    await Promise.all([
      supabase
        .from("tenancies")
        .select(
          `monthly_rent, first_month_rent, start_date, end_date,
           payments(amount, paid_on, payment_type)`,
        )
        .eq("status", "active")
        .returns<ReminderTenancy[]>(),
      supabase
        .from("rent_reminder_emails")
        .select("sent_at")
        .not("sent_at", "is", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("rent_reminder_batches")
        .select("created_at, recipient_count")
        .eq("kind", "balance")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  let outstandingCount = 0;
  for (const row of tenancies ?? []) {
    if (row.end_date && row.end_date <= today) continue;
    if (row.start_date > monthEnd) continue;
    const isStartingMonth =
      row.start_date >= monthStart && row.start_date <= monthEnd;
    const due =
      isStartingMonth && row.first_month_rent !== null
        ? Number(row.first_month_rent)
        : Number(row.monthly_rent);
    const paid = (row.payments ?? [])
      .filter(
        (p) =>
          p.payment_type === "rent" &&
          p.paid_on >= monthStart &&
          p.paid_on <= monthEnd,
      )
      .reduce((s, p) => s + Number(p.amount), 0);
    if (due - paid > 0.01) outstandingCount++;
  }

  const lastBalance = lastBalanceRes?.data as
    | { created_at: string; recipient_count: number }
    | null
    | undefined;
  const lastGeneralText = fmtWhen(lastGeneral?.sent_at ?? null);
  const lastBalanceText = lastBalance?.created_at
    ? `${fmtWhen(lastBalance.created_at)} · ${lastBalance.recipient_count} tenant${
        lastBalance.recipient_count === 1 ? "" : "s"
      }`
    : null;

  return { outstandingCount, lastGeneralText, lastBalanceText };
}
