/**
 * Telegram bot webhook for HivePortal.
 *
 * Telegram → POST here on every user message.
 * We auth the sender, load recent conversation, hand off to Claude with the
 * portal tools, and stream the agent's final reply back as a Telegram message.
 *
 * Auth:
 *   1. Optional secret_token header check (set by setWebhook).
 *   2. Hard whitelist of Telegram user IDs from ALLOWED_TELEGRAM_USER_IDS env.
 */

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { runWithToolContext, tools } from "@/lib/portal-tools";
import { allowedUserIds, sendChatAction, sendMessage } from "@/lib/telegram";
import { checkOutlookSendAuth } from "@/lib/graph-mail";
import { checkGmailAuth } from "@/lib/google-mail";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel: allow long agent loops

const SYSTEM_PROMPT = `You are the operations assistant for Hive — a co-living
business in NYC that master-leases apartments and rents rooms individually.
The operator (Vinny) talks to you over Telegram.

You have a set of tools that read and mutate the Hive Portal database. Use them.
Don't ask the operator to look things up themselves — call the right tool.

Style:
- Direct and concise. Short messages — Telegram is a chat, not an email.
- When you list tenants/properties/rooms, show only the fields the operator
  actually needs (name, unit, balance, etc.), never raw UUIDs unless asked.
- Format money as $1,234.
- Dates as MM/DD/YY.
- When you take a destructive action (record_payment, end_tenancy,
  update_room_rent, set_listing_action, set_room_status, log_cleaning),
  confirm the action in your reply ("Recorded $2,000 payment for John on 5/13/26.").
- If a user asks for something that requires destructive action but is ambiguous,
  briefly summarize what you're about to do and ask for confirmation before
  calling the write tool.
- If you can't find what the operator's asking about, say so directly rather
  than guessing.

Inventory sheet:
- share_inventory_sheet sends the shareable inventory spreadsheet into this chat
  as a file. email_inventory_sheet emails it (from the personal Gmail account)
  to a recipient.
- To email it you need a destination address. If the operator asks to email the
  sheet but doesn't give an address, ask "What email should I send it to?" before
  calling email_inventory_sheet. After it sends, confirm the recipient.

Agreements:
- When the operator wants to send a new tenant a sublease agreement, collect
  these fields conversationally: tenant name, recipient email, full property
  address, monthly rent, security deposit, lease start date, lease end date,
  and whether the apartment is in New York. The New York answer decides the
  letterhead and which mailbox it sends from — always confirm it.
- Ask for any missing field one or two at a time. Default the agreement date to
  today and the sublessor name to "Vineet Dutta" unless told otherwise.
- This SENDS the agreement straight to the tenant — there is no draft to review.
  So before calling the tool, always read the details back and get an explicit
  confirmation to send, then call send_agreement.
- New York → no letterhead, sent from the personal Gmail account (From "Vineet",
  unbranded). Not New York → with letterhead, sent from the Outlook work account.
- After it succeeds, confirm to the operator that the agreement was sent, to whom,
  and from which mailbox (Gmail vs Outlook). If the tool returns an error (e.g. a
  mailbox isn't configured or lacks send permission), relay it plainly.`;

type ConvoMessage = Anthropic.Beta.BetaMessageParam;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function loadHistory(chatId: number): Promise<ConvoMessage[]> {
  const supabase = admin();
  // Keep the last ~20 turns (≈10 user + 10 assistant) so context stays small.
  const { data } = await supabase
    .from("telegram_chat_messages")
    .select("role, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(40);
  if (!data) return [];
  return data
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

async function appendHistory(
  chatId: number,
  role: "user" | "assistant",
  content: ConvoMessage["content"],
) {
  const supabase = admin();
  await supabase.from("telegram_chat_messages").insert({
    chat_id: chatId,
    role,
    content,
  });
}

export async function POST(req: Request) {
  // Optional shared-secret header set when registering the webhook.
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== expected) {
      return new NextResponse("unauthorized", { status: 401 });
    }
  }

  let update: {
    message?: {
      message_id: number;
      from?: { id: number; username?: string };
      chat: { id: number };
      text?: string;
    };
  };
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const msg = update.message;
  if (!msg || !msg.text || !msg.from) {
    return NextResponse.json({ ok: true });
  }

  const allowed = allowedUserIds();
  if (allowed.size > 0 && !allowed.has(msg.from.id)) {
    await sendMessage(
      msg.chat.id,
      "This bot is private. Your Telegram ID isn't on the allow list.",
    );
    return NextResponse.json({ ok: true });
  }

  const userText = msg.text.trim();

  // Slash commands
  if (userText === "/start" || userText === "/help") {
    await sendMessage(
      msg.chat.id,
      "Hi — I'm the Hive ops assistant.\n\n" +
        "Ask things like:\n" +
        "• Who's overdue on rent this month?\n" +
        "• Show me available rooms in JSQ\n" +
        "• Send me the shareable inventory sheet\n" +
        "• Email the inventory sheet to broker@example.com\n" +
        "• Which units are due for cleaning?\n" +
        "• What's the ClickPay password for 90 Washington?\n" +
        "• Record a $2000 rent payment for Tom today, Zelle\n" +
        "• End John's tenancy on July 31\n\n" +
        "/diag to check mail (Outlook/Gmail) auth.\n" +
        "/reset to clear our chat history.",
    );
    return NextResponse.json({ ok: true });
  }

  if (userText === "/diag") {
    await sendChatAction(msg.chat.id, "typing");
    const [outlook, gmail] = await Promise.all([
      checkOutlookSendAuth(),
      checkGmailAuth(),
    ]);
    const line = (
      label: string,
      r: { configured: boolean; ok: boolean; error?: string },
    ) => {
      if (!r.configured) return `${label}: ⚪️ not configured`;
      if (r.ok) return `${label}: ✅ OK`;
      return `${label}: ❌ ${r.error ?? "auth failed"}`;
    };
    await sendMessage(
      msg.chat.id,
      "Mail diagnostics (no email sent):\n\n" +
        `${line("Outlook (Mail.Send)", outlook)}\n` +
        `${line("Gmail", gmail)}`,
    );
    return NextResponse.json({ ok: true });
  }

  if (userText === "/reset") {
    const supabase = admin();
    await supabase
      .from("telegram_chat_messages")
      .delete()
      .eq("chat_id", msg.chat.id);
    await sendMessage(msg.chat.id, "Chat history cleared.");
    return NextResponse.json({ ok: true });
  }

  await sendChatAction(msg.chat.id, "typing");

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build the messages array: persisted history + this turn's user message.
  const history = await loadHistory(msg.chat.id);
  const newUserMessage: ConvoMessage = {
    role: "user",
    content: [{ type: "text", text: userText }],
  };
  const messages = [...history, newUserMessage];

  let finalMessage: Anthropic.Beta.BetaMessage;
  try {
    // Run inside the chat context so tools that deliver files (e.g.
    // share_inventory_sheet) know which chat to send the document to. The
    // toolRunner is awaited *inside* the callback so the AsyncLocalStorage store
    // stays active for the whole tool-execution loop, not just construction.
    finalMessage = await runWithToolContext(
      { chatId: msg.chat.id },
      async () =>
        await client.beta.messages.toolRunner({
          model: "claude-opus-4-7",
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          tools,
          messages,
        }),
    );
  } catch (e) {
    console.error("Anthropic tool runner failed:", e);
    const errText = e instanceof Error ? e.message : "unknown error";
    await sendMessage(msg.chat.id, `Sorry — agent error: ${errText}`);
    return NextResponse.json({ ok: true });
  }

  // Extract the assistant's text reply (concat all text blocks).
  const text = finalMessage.content
    .filter(
      (b): b is Anthropic.Beta.BetaTextBlock => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  // Persist this turn (user input + full final assistant content, so future
  // turns have the tool-use chain in context if needed).
  await appendHistory(msg.chat.id, "user", newUserMessage.content);
  await appendHistory(msg.chat.id, "assistant", finalMessage.content);

  if (text.length === 0) {
    await sendMessage(msg.chat.id, "(Done — no message to add.)");
  } else {
    await sendMessage(msg.chat.id, text, { reply_to_message_id: msg.message_id });
  }

  return NextResponse.json({ ok: true });
}
