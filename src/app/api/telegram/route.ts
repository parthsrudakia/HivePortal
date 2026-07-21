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
import { logTelegramEvent } from "@/lib/telegram-log";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel: Fable turns on hard tasks can run minutes

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
  cancel_move_out, update_tenant, update_tenancy, add_charge,
  update_room_rent, set_listing_action, set_room_status, log_cleaning,
  update_cleaning_record, delete_cleaning_record, add_cleaner,
  set_cleaner_enabled, assign_cleaner, add_tenant, send_balance_reminders),
  confirm the action in your reply ("Recorded $2,000 payment for John on 5/13/26.").
- If a user asks for something that requires destructive action but is ambiguous,
  briefly summarize what you're about to do and ask for confirmation before
  calling the write tool.
- NEVER say an email, agreement, or reminder was sent unless the sending tool
  (send_agreement, email_inventory_sheet, or send_balance_reminders) ran in THIS
  turn and returned ok: true. If you haven't called the tool, nothing was sent —
  when the operator confirms ("send it", "yes"), you must actually call the tool
  before replying. Take the recipient and mailbox in your confirmation from the
  tool result, not from memory. If asked about an email from an earlier request,
  refer to it as a past send rather than confirming it as new.
- If you can't find what the operator's asking about, say so directly rather
  than guessing.

Profitability & utilities:
- get_profitability answers "how are the units doing" / "which unit loses
  money" — per-unit YTD and monthly profit plus the year's revenue/expense/net
  summary. Amounts flagged estimated mean a utility month had no uploaded bill
  and used a similar-unit average; mention that when it changes the story.
- add_profitability_line_item records manual yearly revenue/expense lines
  (admin costs, one-off income) — it's a write, confirm like other writes.
- get_utility_bills for bills and the over-$200 usage splits;
  get_utility_statement_url gets a 1-hour link to a bill's original statement
  when the operator wants the actual PDF.

Inventory sheet:
- share_inventory_sheet sends the shareable inventory spreadsheet into this chat
  as a file. email_inventory_sheet emails it (from the personal Gmail account)
  to a recipient.
- To email it you need a destination address. If the operator asks to email the
  sheet but doesn't give an address, ask "What email should I send it to?" before
  calling email_inventory_sheet. After it sends, confirm the recipient.

Agreements:
- When the operator wants to send a new tenant a sublease agreement, collect
  these fields conversationally: tenant name, recipient email, property
  address, monthly rent, security deposit, lease start date, lease end date,
  and whether the apartment is in New York. The New York answer decides the
  letterhead and which mailbox it sends from — always confirm it.
- Autocomplete the address — never make the operator type it in full. Take
  whatever fragment they gave (building name, street, unit, neighborhood)
  and call resolve_property_address; use the returned full_address and the
  property's is_new_york flag. If several units match, list them and ask
  which. If needs_city_state is true, ask for just the city/state.
- Auto-correct to the EXACT postal address. If the result says
  operator_confirmed: true, it was used on a real agreement before — use it
  verbatim, don't re-derive it. Otherwise the address is composed from
  portal shorthand: expand it to the true mailing address (full street name,
  e.g. "JFK Blvd" → "John F. Kennedy Blvd", plus the ZIP code if you know
  it) before reading it back.
- Include the completed address in your read-back so the operator confirms
  it (and the New York answer) before you send — if they correct it, use
  their version. Always pass the property_id to send_agreement: on success
  the confirmed address is saved and reused verbatim for the next agreement
  at that property.
- Ask for any missing field one or two at a time. Default the agreement date to
  today and the sublessor name to "Vineet Dutta" unless told otherwise.
- This SENDS the agreement straight to the tenant — there is no draft to review.
  So before calling the tool, always read the details back and get an explicit
  confirmation to send, then call send_agreement.
- New York → no letterhead, sent from the personal Gmail account (From "Vineet",
  unbranded). Not New York → with letterhead, sent from the Outlook work account.
- If send_agreement refuses because the address's state contradicts the New York
  answer, relay the mismatch and ask the operator which is right. If they insist
  on sending as-is, call send_agreement again with the same details plus
  confirm_mailbox_mismatch=true — the operator's instruction wins.
- The email carries the PDF (pre-signed by the operator) plus a link where the
  tenant signs online; the link expires after 48 hours. Until they sign, the
  tenant shows in the signing tally on the portal's /agreements page (resend /
  dismiss happen there). When they sign, a signed copy is emailed to them
  automatically.
- send_agreement fails if the operator's signature isn't on file yet — in that
  case tell the operator to draw their signature on the portal's Agreements page
  and try again.
- After it succeeds, confirm to the operator that the agreement was sent, to whom,
  and from which mailbox (Gmail vs Outlook), and mention the tenant has 48 hours
  to sign via the link. If the tool returns an error (e.g. a mailbox isn't
  configured or lacks send permission), relay it plainly.

Adding tenants:
- add_tenant creates the tenant AND places them in a room (an active tenancy).
  Use it when the operator asks to add / onboard a tenant — often right after an
  agreement, by re-sending the same details.
- Required fields: full name, email, phone, monthly rent, lease start date, lease
  end date, and which room. Ask for any that are missing — don't guess.
- You must resolve the room yourself. If the operator named the unit/room, call
  list_properties to find the unit by address, then get_property to see its rooms
  and pick the vacant one; if more than one room could match, ask which one.
- If the message does NOT specify a unit + room, call list_inventory to pull the
  inventory tab (the available / opening-soon rooms) and ask the operator which
  room to place the tenant in. Show the options (unit, room, rent) — never guess
  a room.
- This writes to the database. Read the details back — name, email, phone, room,
  rent, lease start/end — and get an explicit confirmation before calling
  add_tenant. After it succeeds, confirm the tenant was added and to which room.
- add_tenant does NOT send an agreement, and send_agreement does NOT add a
  tenant — they're separate steps.

Editing tenants & tenancies:
- update_tenant fixes profile fields (name, email, phone, pays_as, etc.).
  update_tenancy fixes money and dates on the tenancy: monthly rent, the
  prorated first-month amount, deposit, lease start/end. Find the tenancy_id
  via list_active_tenants (or get_property for a specific room).
- The prorated first-month rent applies only to the calendar month the
  tenancy starts in; the ledger recomputes automatically when you change it.
- end_tenancy schedules/executes a move-out; cancel_move_out undoes it.
- add_charge posts something the tenant OWES (security deposit, $50 late fee,
  or a described "other" charge). record_payment records money RECEIVED.
  Don't mix them up.
- get_lease_url fetches a 10-minute download link for the lease PDF on file.
- These write to the database — read the change back and get an explicit
  confirmation before calling, then confirm the result.

Utilities:
- get_utility_bills answers anything about utility spend: bills are extracted
  from statements uploaded on the portal's Utilities tab. Filter by month
  ("YYYY-MM"), unit (property_id via list_properties /
  resolve_property_address), utility type, or over_threshold_only.
- A bill counts toward the calendar month holding most of its billing-period
  days, matching the portal's Utilities page — so "May's electric" means
  billing periods mostly in May, not statements dated May.
- The $200 overage clause: when a unit's electric or gas USAGE charges (not
  late fees) top $200 in a month, the excess is split among that unit's
  occupants. Use over_threshold_only to find those bills; excess_over_200 is
  the amount to split. overage_dismissed means the operator already waived it.
- Bills with unit "unmatched" weren't linked to a property — mention them when
  totals look low, and suggest matching them on the Utilities page.

Cleaning:
- log_cleaning records a cleaning; list_cleanings shows recent records so a
  wrong one can be fixed (update_cleaning_record) or removed
  (delete_cleaning_record).
- list_cleaners / add_cleaner / set_cleaner_enabled / assign_cleaner manage
  the cleaner roster and which properties each cleaner covers.

Balance reminders:
- send_balance_reminders reminds tenants who still owe rent this month. It can
  go out by email, text, or both — ALWAYS ask the operator which channel first;
  never assume.
- It can remind everyone owing (omit tenancy_id) or a single tenant (pass the
  tenancy_id from list_active_tenants). If the operator names one tenant, look up
  their tenancy_id first.
- Before sending, read back what you'll do — the channel and whether it's all
  owing tenants or a specific one — and get an explicit confirmation; it sends
  immediately. After it runs, report how many were emailed/texted, and mention
  anyone owing who had no email/phone for the chosen channel.`;

type ConvoMessage = Anthropic.Beta.BetaMessageParam;

/**
 * Guard against the model claiming an email went out without calling a send
 * tool (observed 7/3/26: replied "Sent to …@gmail.com from Gmail ✅" to a
 * "send it" confirmation without ever invoking send_agreement). The reply is
 * only trusted if one of these tools actually ran — and reported ok — during
 * this turn; otherwise the claim is replaced with a correction.
 */
const EMAIL_SEND_TOOLS = new Set([
  "send_agreement",
  "email_inventory_sheet",
  "send_balance_reminders",
]);

// A hallucinated confirmation reads like "Sent to x@y.com from Gmail ✅" — a
// completed-send word alongside a recipient address or mailbox name. Plain
// mentions in read-backs and questions ("resend it?", "Send it?") carry
// neither, so they don't trip this.
function claimsEmailSent(text: string): boolean {
  return (
    /\b(sent|resent|emailed)\b/i.test(text) &&
    /(\S+@\S+|\bgmail\b|\boutlook\b)/i.test(text)
  );
}

function falseSendCorrection(original: string): string {
  return (
    "⚠️ Correction: my reply below claimed an email was sent, but no " +
    "email-sending tool actually ran in this turn — nothing was sent just now. " +
    "If you wanted an email sent, please ask again.\n\n" +
    `Original reply:\n${original}`
  );
}

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
  // A missing webhook secret must fail closed. Otherwise anyone who knows an
  // allowed Telegram user id could forge a webhook payload directly.
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "TELEGRAM_WEBHOOK_SECRET is not configured" },
      { status: 503 },
    );
  }
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  if (got !== expected) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let update: {
    update_id?: number;
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

  // Telegram re-delivers an update until it gets a 200 — e.g. when a long
  // agent turn overruns the function budget. Claim the update_id before doing
  // any work; a duplicate delivery hits the primary key and is dropped, so one
  // operator message can never run the agent (or send an email) twice. Any
  // other insert error is ignored — dedup must not take the bot down.
  if (typeof update.update_id === "number") {
    const { error: dupError } = await admin()
      .from("telegram_updates")
      .insert({ update_id: update.update_id, chat_id: msg.chat.id });
    if (dupError?.code === "23505") {
      return NextResponse.json({ ok: true });
    }
  }

  const allowed = allowedUserIds();
  if (allowed.size > 0 && !allowed.has(msg.from.id)) {
    await logTelegramEvent({
      kind: "rejected",
      chatId: msg.chat.id,
      telegramUserId: msg.from.id,
      username: msg.from.username,
      text: msg.text.slice(0, 500),
      detail: { reason: "not on allow list" },
    });
    await sendMessage(
      msg.chat.id,
      "This bot is private. Your Telegram ID isn't on the allow list.",
    );
    return NextResponse.json({ ok: true });
  }

  const userText = msg.text.trim();

  // Correlates every diagnostic-log row for this turn (user msg → tool calls →
  // reply / error). Metadata about who sent it rides along on each row.
  const turnId = randomUUID();
  const actor = {
    chatId: msg.chat.id,
    turnId,
    telegramUserId: msg.from.id,
    username: msg.from.username,
  };

  // Slash commands
  if (userText === "/start" || userText === "/help") {
    await logTelegramEvent({ ...actor, kind: "slash_command", text: userText });
    await sendMessage(
      msg.chat.id,
      "Hi — I'm the Hive ops assistant.\n\n" +
        "Ask things like:\n" +
        "• Who's overdue on rent this month?\n" +
        "• Show me available rooms in JSQ\n" +
        "• Send me the shareable inventory sheet\n" +
        "• Email the inventory sheet to broker@example.com\n" +
        "• Which units are due for cleaning?\n" +
        "• How much did we spend on utilities in May?\n" +
        "• Which units went over $200 on electric last month?\n" +
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
    await logTelegramEvent({
      ...actor,
      kind: "slash_command",
      text: userText,
      detail: { outlook, gmail },
    });
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
    await logTelegramEvent({ ...actor, kind: "slash_command", text: userText });
    await sendMessage(msg.chat.id, "Chat history cleared.");
    return NextResponse.json({ ok: true });
  }

  await sendChatAction(msg.chat.id, "typing");

  // maxRetries 5 (SDK default 2): 529 overload windows often outlast the
  // default ~2s of backoff; extra retries stay well under maxDuration.
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 5,
  });

  // Build the messages array: persisted history + this turn's user message.
  const history = await loadHistory(msg.chat.id);
  const newUserMessage: ConvoMessage = {
    role: "user",
    content: [{ type: "text", text: userText }],
  };
  const messages = [...history, newUserMessage];

  await logTelegramEvent({ ...actor, kind: "user_message", text: userText });

  const turnStartedAt = Date.now();
  // Filled in by instrumentTool as the agent loop runs — one entry per tool
  // call this turn. Read afterwards to verify any "sent" claim in the reply.
  const calledTools: { name: string; ok: boolean }[] = [];
  let finalMessage: Anthropic.Beta.BetaMessage;
  try {
    // Run inside the chat context so tools that deliver files (e.g.
    // share_inventory_sheet) know which chat to send the document to, and so the
    // per-tool diagnostic logger can attribute each call to this turn. The
    // toolRunner is awaited *inside* the callback so the AsyncLocalStorage store
    // stays active for the whole tool-execution loop, not just construction.
    finalMessage = await runWithToolContext(
      {
        chatId: msg.chat.id,
        turnId,
        telegramUserId: msg.from.id,
        username: msg.from.username,
        calledTools,
      },
      async () =>
        await client.beta.messages.toolRunner({
          model: "claude-opus-4-8",
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
    await logTelegramEvent({
      ...actor,
      kind: "agent_error",
      ok: false,
      latencyMs: Date.now() - turnStartedAt,
      error: errText,
    });
    // Transient API problems (overload, rate limit, 5xx) get a friendly
    // resend prompt; the full error is already in the log above.
    const transient =
      e instanceof Anthropic.APIError &&
      (e.status === 429 || e.status === 529 || (e.status ?? 0) >= 500);
    await sendMessage(
      msg.chat.id,
      transient
        ? "Claude is temporarily overloaded — please resend that in a minute."
        : `Sorry — agent error: ${errText}`,
    );
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

  // If the reply claims an email was sent but no send tool succeeded this
  // turn, the claim is fabricated — replace it (in the reply AND in the
  // persisted history, so future turns don't inherit the false belief).
  const sendToolSucceeded = calledTools.some(
    (t) => EMAIL_SEND_TOOLS.has(t.name) && t.ok,
  );
  const falseSendClaim = !sendToolSucceeded && claimsEmailSent(text);
  const replyText = falseSendClaim ? falseSendCorrection(text) : text;
  const assistantContent: ConvoMessage["content"] = falseSendClaim
    ? [{ type: "text", text: replyText }]
    : finalMessage.content;
  const credentialToolUsed = calledTools.some(
    (tool) => tool.name === "get_credentials",
  );

  if (falseSendClaim) {
    await logTelegramEvent({
      ...actor,
      kind: "agent_error",
      ok: false,
      error: "reply claimed an email was sent but no send tool ran this turn",
      text,
      detail: { calledTools },
    });
  }

  // Persist this turn (user input + full final assistant content, so future
  // turns have the tool-use chain in context if needed).
  await appendHistory(msg.chat.id, "user", newUserMessage.content);
  await appendHistory(
    msg.chat.id,
    "assistant",
    credentialToolUsed
      ? [{ type: "text", text: "[credential response omitted from history]" }]
      : assistantContent,
  );

  // Diagnostic record of the reply the operator actually saw, plus the token
  // usage and stop reason for the whole turn.
  await logTelegramEvent({
    ...actor,
    kind: "assistant_reply",
    latencyMs: Date.now() - turnStartedAt,
    text: credentialToolUsed
      ? "[credential response redacted]"
      : replyText.length > 0
        ? replyText
        : "(no text — final message had no reply)",
    detail: credentialToolUsed
      ? {
          redacted: true,
          stop_reason: finalMessage.stop_reason,
          usage: finalMessage.usage,
        }
      : {
          stop_reason: finalMessage.stop_reason,
          usage: finalMessage.usage,
          content: finalMessage.content,
          ...(falseSendClaim ? { false_send_claim: true } : {}),
        },
  });

  if (finalMessage.stop_reason === "refusal") {
    await sendMessage(msg.chat.id, "Sorry — I can't help with that request.");
  } else if (replyText.length === 0) {
    await sendMessage(msg.chat.id, "(Done — no message to add.)");
  } else {
    await sendMessage(msg.chat.id, replyText, {
      reply_to_message_id: msg.message_id,
    });
  }

  return NextResponse.json({ ok: true });
}
