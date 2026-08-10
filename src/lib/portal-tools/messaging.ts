import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { todayISO } from "@/lib/date";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { buildBalanceDetail, type BalanceDetail } from "@/lib/balance-detail";
import {
  inventorySheetEmailTemplate,
  sendBalanceReminderOutlook,
  sendBalanceReminderGmail,
  balanceReminderText,
} from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { sendGmailMessage } from "@/lib/google-mail";
import { buildInventorySheet } from "@/lib/inventory-sheet";
import { sendDocument } from "@/lib/telegram";
import { requireChatId } from "./context";
import { admin, one } from "./helpers";

// Send rent balance reminders (email and/or text) to tenants who still owe rent
// this month. Omit tenancy_id to remind everyone owing; pass it to remind a
// single tenant. Texts use the same wording as the emails. Mirrors the Rent
// Tracker buttons but runs under the bot's service-role client.
export async function sendBalanceReminders(args: {
  channel: "email" | "text" | "both";
  tenancy_id?: string;
}) {
  const supabase = admin();
  const doEmail = args.channel === "email" || args.channel === "both";
  const doSms = args.channel === "text" || args.channel === "both";

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const period = `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthLabel = now.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const today = todayISO();

  type PropertyRel = { is_new_york: boolean };
  type ReminderRow = {
    id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    security_deposit: number | null;
    start_date: string;
    move_out_date: string | null;
    paused_at: string | null;
    tenants:
      | { full_name: string; email: string | null; phone: string | null }
      | { full_name: string; email: string | null; phone: string | null }[]
      | null;
    rooms:
      | { properties: PropertyRel | PropertyRel[] | null }
      | { properties: PropertyRel | PropertyRel[] | null }[]
      | null;
    payments: {
      id: string;
      amount: number;
      paid_on: string;
      payment_type: string;
      notes: string | null;
    }[];
  };

  let query = supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at,
       tenants(full_name, email, phone),
       rooms(properties(is_new_york)),
       payments(id, amount, paid_on, payment_type, notes)`,
    )
    .eq("status", "active");
  if (args.tenancy_id) query = query.eq("id", args.tenancy_id);
  const { data, error } = await query.returns<ReminderRow[]>();
  if (error) throw new Error(error.message);
  if (args.tenancy_id && (!data || data.length === 0)) {
    return { ok: false, error: "No active tenancy found for that id." };
  }

  const { charges, allocations, rentChanges } =
    await fetchLedgerSidecars(supabase);

  let owing = 0;
  let emailed = 0;
  let texted = 0;
  let failed = 0;
  const recipients: string[] = [];
  const noContactOnChannel: string[] = [];

  for (const row of data ?? []) {
    if (row.move_out_date && row.move_out_date <= today) continue;
    if (row.start_date > today) continue;
    // Paused tenancies are excluded from all reminders, email and SMS.
    if (row.paused_at) continue;

    const { netBalance } = computeLedger(
      row,
      row.payments ?? [],
      charges.get(row.id) ?? [],
      allocations.get(row.id) ?? [],
      today,
      rentChanges.get(row.id) ?? [],
    );
    if (netBalance <= 0.01) continue;
    owing++;

    const tenant = one(row.tenants);
    const name = tenant?.full_name ?? "Tenant";
    const email = tenant?.email?.trim();
    const phone = tenant?.phone?.trim();
    let delivered = false;

    // With this month's late fee already posted, the templates drop the
    // "avoid a late fee" line for fee-included wording.
    const lateFeeCharged = (charges.get(row.id) ?? []).some(
      (c) =>
        c.kind === "late_fee" &&
        c.charged_on >= `${today.slice(0, 7)}-01` &&
        c.charged_on <= today,
    );

    if (doEmail && email) {
      // Mini ledger + utility statement links; best-effort, never blocks the send.
      let detail: BalanceDetail | undefined;
      try {
        detail = await buildBalanceDetail(supabase, {
          tenancy: row,
          payments: row.payments ?? [],
          charges: charges.get(row.id) ?? [],
          rentChanges: rentChanges.get(row.id) ?? [],
          today,
        });
      } catch (e) {
        console.error("[balance-reminders] breakdown failed:", e);
      }
      const isNewYork = one(one(row.rooms)?.properties ?? null)?.is_new_york ?? false;
      const res = isNewYork
        ? await sendBalanceReminderGmail(
            email,
            netBalance,
            monthLabel,
            detail,
            lateFeeCharged,
          )
        : await sendBalanceReminderOutlook(
            email,
            netBalance,
            monthLabel,
            detail,
            lateFeeCharged,
          );
      if (res.ok) {
        emailed++;
        delivered = true;
      } else failed++;
    }
    if (doSms && phone) {
      const res = await sendSms(phone, balanceReminderText(netBalance, monthLabel, lateFeeCharged), {
        type: "rent_balance",
        context: `${name} · ${monthLabel}`,
      });
      if (res.ok) {
        texted++;
        delivered = true;
      }
    }

    if (delivered) recipients.push(name);
    else noContactOnChannel.push(name);
  }

  if (emailed + texted > 0) {
    await supabase.from("rent_reminder_batches").insert({
      kind: "balance",
      channel: doEmail && doSms ? "both" : doEmail ? "email" : "sms",
      period_month: period,
      recipient_count: doEmail ? emailed : texted,
    });
  }

  return {
    ok: true,
    channel: args.channel,
    month: monthLabel,
    owing,
    emailed,
    texted,
    failed,
    recipients,
    no_contact_on_channel: noContactOnChannel,
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

export const messagingTools = [
  betaZodTool({
    name: "send_balance_reminders",
    description:
      "Send rent balance reminders to tenant(s) who still owe rent this month. " +
      "ALWAYS ask the operator which channel first — email, text, or both — " +
      "never assume, and read back what you're about to do (channel + how many / " +
      "which tenant) and get an explicit confirmation before calling this; it " +
      "sends immediately. Omit tenancy_id to remind EVERY owing tenant; pass a " +
      "tenancy_id (find it via list_active_tenants) to remind just one tenant. " +
      "Texts go only to tenants with a phone on file and use the same wording as " +
      "the emails. After it runs, report how many were emailed/texted (and note " +
      "anyone owing who had no address/phone for the chosen channel).",
    inputSchema: z.object({
      channel: z
        .enum(["email", "text", "both"])
        .describe("Which channel to send on. Ask the operator each time."),
      tenancy_id: z
        .string()
        .optional()
        .describe(
          "Send to just this tenancy (via list_active_tenants). Omit to send to all owing tenants.",
        ),
    }),
    run: async (args) => JSON.stringify(await sendBalanceReminders(args)),
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
];
