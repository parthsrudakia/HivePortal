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
import { runWithToolContext } from "@/lib/portal-tools";
import {
  runAssistantTurn,
  finalizeTurn,
  conversationEvidenceText,
  type ConvoMessage,
} from "@/lib/assistant-core";
import { allowedUserIds, sendChatAction, sendMessage } from "@/lib/telegram";
import { checkOutlookSendAuth } from "@/lib/graph-mail";
import { checkGmailAuth } from "@/lib/google-mail";
import { logTelegramEvent } from "@/lib/telegram-log";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel: Opus turns on hard tasks can run minutes

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
  // Raw tool results this turn — the UUID grounding guard's evidence pool.
  const toolEvidence: string[] = [];
  let finalMessage: Anthropic.Beta.BetaMessage;
  try {
    // Run inside the chat context so tools that deliver files (e.g.
    // share_inventory_sheet) know which chat to send the document to, and so
    // the per-tool diagnostic logger can attribute each call to this turn. The
    // toolRunner is awaited *inside* the callback so the AsyncLocalStorage
    // store stays active for the whole tool-execution loop.
    finalMessage = await runWithToolContext(
      {
        chatId: msg.chat.id,
        turnId,
        telegramUserId: msg.from.id,
        username: msg.from.username,
        calledTools,
        toolEvidence,
      },
      () =>
        runAssistantTurn(
          client,
          messages,
          calledTools,
          async (flagged) => {
            await logTelegramEvent({
              ...actor,
              kind: "agent_error",
              ok: false,
              error:
                "reply claimed a send without a successful send tool — retrying with corrective reminder",
              text: flagged,
              detail: { calledTools: [...calledTools] },
            });
          },
          async (kind, flagged) => {
            await logTelegramEvent({
              ...actor,
              kind: "agent_error",
              ok: false,
              error:
                kind === "fabricated_ids"
                  ? "reply cited IDs with no tool-result source — retrying with grounding reminder"
                  : kind === "ungrounded_action"
                    ? "reply claimed an action/lookup with zero tool calls — retrying with grounding reminder"
                    : "reply stated status with zero tool calls — retrying with grounding reminder",
              text: flagged,
              detail: { calledTools: [...calledTools] },
            });
          },
        ),
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

  // Post-turn guards (shared with the web widget): strip forged markers,
  // detect a fabricated send, and build the content to persist with the
  // [tools run this turn: …] evidence marker.
  const {
    replyText,
    text,
    contentForHistory,
    credentialToolUsed,
    falseSendClaim,
    fabricatedIds,
    ungroundedStatusClaim,
    ungroundedActionClaim,
  } = finalizeTurn(
    finalMessage,
    calledTools,
    conversationEvidenceText(messages) + "\n" + toolEvidence.join("\n"),
  );

  if (fabricatedIds.length > 0 || ungroundedStatusClaim || ungroundedActionClaim) {
    await logTelegramEvent({
      ...actor,
      kind: "agent_error",
      ok: false,
      error:
        fabricatedIds.length > 0
          ? `reply blocked — fabricated ID(s) survived the retry: ${fabricatedIds.join(", ")}`
          : ungroundedActionClaim
            ? "reply replaced — action/lookup claim with zero tool calls survived the retry"
            : "reply stamped unverified — status claim with zero tool calls survived the retry",
      text,
      detail: { calledTools: [...calledTools] },
    });
  }

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

  // Persist this turn (user input + the final assistant content with the
  // tool-evidence marker appended).
  await appendHistory(msg.chat.id, "user", newUserMessage.content);
  await appendHistory(msg.chat.id, "assistant", contentForHistory);

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
      parse_mode: "HTML",
    });
  }

  return NextResponse.json({ ok: true });
}
