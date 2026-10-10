import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { todayISO } from "@/lib/date";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars, fetchTenantLedgers, tenantLedger } from "@/lib/rent-data";
import {
  buildBalanceDetail,
  buildTenantBalanceDetail,
  type BalanceDetail,
} from "@/lib/balance-detail";
import {
  inventorySheetEmailTemplate,
  sendBalanceReminderOutlook,
  sendBalanceReminderGmail,
  balanceReminderText,
} from "@/lib/email";
import { getSmsOptStatus, sendBalanceText, sendSms } from "@/lib/sms";
import { resolveRecipientPhone } from "@/lib/sms-recipient";
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
    tenant_id: string;
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
      `id, tenant_id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at,
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

  const [{ charges, allocations, rentChanges }, tl] = await Promise.all([
    fetchLedgerSidecars(supabase),
    fetchTenantLedgers(supabase),
  ]);

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

    // Tenant-wide: one ledger per tenant across every room they've had.
    const { netBalance } = tenantLedger(tl, row.tenant_id, () =>
      computeLedger(
        row,
        row.payments ?? [],
        charges.get(row.id) ?? [],
        allocations.get(row.id) ?? [],
        today,
        rentChanges.get(row.id) ?? [],
      ),
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
        const inputs = tl.inputs.get(row.tenant_id);
        detail = inputs
          ? await buildTenantBalanceDetail(supabase, { inputs, today })
          : await buildBalanceDetail(supabase, {
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
      const res = await sendBalanceText(phone, balanceReminderText(netBalance, monthLabel, lateFeeCharged, tenant?.full_name), {
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

// Free-form text message. Recipients may be phone numbers or tenant names —
// names resolve against the tenants table and must match exactly one tenant
// with a phone on file. thread_mode "individual" texts each recipient in
// their own thread (recipients never see each other); "shared" puts everyone
// in ONE thread. include_operator adds the operator's own number
// (OPERATOR_PHONE env) to each thread so they see the message and replies.
export async function sendTextMessage(args: {
  recipients: string[];
  message: string;
  thread_mode: "individual" | "shared";
  include_operator?: boolean;
}) {
  const supabase = admin();
  const phones: string[] = [];
  for (const entry of args.recipients) {
    if (!entry.trim()) continue;
    // Phone numbers pass through; names must match exactly one tenant.
    const resolved = await resolveRecipientPhone(supabase, entry);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    phones.push(resolved.phone);
  }
  let operator: string | null = null;
  if (args.include_operator) {
    operator = process.env.OPERATOR_PHONE?.trim() || null;
    if (!operator) {
      return {
        ok: false,
        error:
          "OPERATOR_PHONE is not configured — set it in the environment to include the operator in threads.",
      };
    }
  }
  if (phones.length === 0) {
    return { ok: false, error: "No recipients resolved." };
  }

  if (args.thread_mode === "shared") {
    const all = operator ? [...phones, operator] : phones;
    const res = await sendSms(all, args.message, {
      type: "manual",
      context: `bot send_text · shared thread · ${all.length} recipient${all.length === 1 ? "" : "s"}`,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      thread_mode: "shared",
      recipients: all,
      group_thread: all.length > 1,
    };
  }

  // Individual: one thread per recipient (plus the operator in each, when
  // requested) — recipients never see each other's numbers or replies.
  const sent: string[] = [];
  const failed: { recipient: string; error: string }[] = [];
  for (const phone of phones) {
    const res = await sendSms(operator ? [phone, operator] : phone, args.message, {
      type: "manual",
      context: `bot send_text · individual thread${operator ? " + operator" : ""}`,
    });
    if (res.ok) sent.push(phone);
    else failed.push({ recipient: phone, error: res.error });
  }
  return {
    ok: failed.length === 0,
    thread_mode: "individual",
    threads_sent: sent.length,
    sent,
    failed,
    operator_included_in_each: operator !== null,
  };
}

// Ask Zoom whether a recipient has opted out of our texts (replied STOP).
// Zoom enforces STOP on the 10DLC campaign itself, so an opted-out tenant's
// reminders still log as "sent" in the portal but never arrive — this is how
// the operator finds that out.
export async function checkTextOptStatus(args: { recipient: string }) {
  const resolved = await resolveRecipientPhone(admin(), args.recipient);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const res = await getSmsOptStatus(resolved.phone);
  if (!res.ok) return { ok: false, tenant: resolved.tenantName, error: res.error };
  return {
    ok: true,
    tenant: resolved.tenantName,
    phone: res.phone,
    status: res.status,
    opted_out: res.optedOut,
    explanation: res.optedOut
      ? "This number replied STOP (or Cancel/End/Quit) to our texts. Zoom blocks our messages to it; portal sends will still log as sent but won't arrive. Only the tenant can lift this by texting START to our number."
      : "This number is opted in — Zoom will deliver our texts to it.",
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
      "the emails; each text is a group thread with the tenant and the operator " +
      "(Vineet), so the tenant sees the operator's number and replies reach both. After it runs, report how many were emailed/texted (and note " +
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
    name: "send_text",
    description:
      "Send a free-form SMS from the Hive Zoom Phone number. Recipients can be " +
      "phone numbers or tenant names (looked up in the portal; must match " +
      "exactly one tenant with a phone on file). thread_mode 'individual' " +
      "sends each recipient their OWN text in a separate thread — recipients " +
      "never see each other; 'shared' puts ALL recipients in ONE thread where " +
      "everyone sees everyone's number and replies. When the operator says " +
      "'group text with me in it' (or similar), they mean INDIVIDUAL texts to " +
      "each tenant with their own number included in each thread — " +
      "thread_mode 'individual' + include_operator true — NOT one shared " +
      "thread. Use 'shared' ONLY when the operator explicitly asks for one " +
      "common thread where the tenants can see each other, and confirm that " +
      "consequence first. include_operator adds the operator's own number to " +
      "each thread so they see the message and any replies. This sends " +
      "immediately — ALWAYS read back the exact message text, the resolved " +
      "recipients, and the thread mode, and get an explicit confirmation from " +
      "the operator before calling this. Only US/Canada (+1) numbers can " +
      "receive texts.",
    inputSchema: z.object({
      recipients: z
        .array(z.string())
        .min(1)
        .describe("Phone numbers and/or tenant names."),
      message: z
        .string()
        .min(1)
        .max(1200)
        .describe("The exact text to send, confirmed by the operator."),
      thread_mode: z
        .enum(["individual", "shared"])
        .describe(
          "'individual' = one text per recipient, separate threads (the " +
            "default meaning of 'group text with me in it'). 'shared' = one " +
            "thread everyone shares — only on an explicit request for a " +
            "common thread.",
        ),
      include_operator: z
        .boolean()
        .optional()
        .describe(
          "Add the operator's own phone (OPERATOR_PHONE env) to each thread " +
            "('individual') or to the one thread ('shared').",
        ),
    }),
    run: async (args) => JSON.stringify(await sendTextMessage(args)),
  }),
  betaZodTool({
    name: "check_text_opt_status",
    description:
      "Check with Zoom whether a phone number has opted OUT of our texts by " +
      "replying STOP. Use this when a tenant says they aren't getting the rent " +
      "reminder texts, or before re-sending a text that 'didn't arrive' — an " +
      "opted-out number still shows as sent in the portal's text log, but Zoom " +
      "never delivers it. Read-only; safe to call without confirmation. " +
      "recipient can be a phone number or a tenant name (must match exactly one " +
      "tenant with a phone on file). If opted out, tell the operator only the " +
      "tenant can fix it by texting START to our number.",
    inputSchema: z.object({
      recipient: z
        .string()
        .min(1)
        .describe("Phone number or tenant name to check."),
    }),
    run: async (args) => JSON.stringify(await checkTextOptStatus(args)),
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
