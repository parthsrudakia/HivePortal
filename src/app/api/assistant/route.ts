/**
 * In-portal ops-assistant widget backend.
 *
 * Same agent brain as the Telegram bot (shared src/lib/assistant-core.ts:
 * identical system prompt, tools, and anti-hallucination guards) but driven
 * from the portal's support chat instead of Telegram.
 *
 * Auth: portal session + the operator allowlist (Vineet & Parth) — the same
 * gate as the ledger admin and the Developers link.
 */

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { runWithToolContext } from "@/lib/portal-tools";
import {
  runAssistantTurn,
  finalizeTurn,
  type ConvoMessage,
} from "@/lib/assistant-core";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/access";
import { logTelegramEvent } from "@/lib/telegram-log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function loadHistory(userId: string): Promise<ConvoMessage[]> {
  const { data } = await admin()
    .from("assistant_chat_messages")
    .select("role, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(40);
  if (!data) return [];
  return data
    .reverse()
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content as ConvoMessage["content"],
    }));
}

async function appendHistory(
  userId: string,
  role: "user" | "assistant",
  content: ConvoMessage["content"],
) {
  await admin()
    .from("assistant_chat_messages")
    .insert({ user_id: userId, role, content: content as never });
}

/** GET → the operator's prior conversation, rendered messages only. */
export async function GET() {
  const user = await getSessionUser();
  if (!isOperator(user?.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  const history = await loadHistory(user!.id);
  const messages = history.map((m) => ({
    role: m.role,
    text: textOf(m.content),
  }));
  return NextResponse.json({ messages });
}

/** DELETE → clear this operator's conversation. */
export async function DELETE() {
  const user = await getSessionUser();
  if (!isOperator(user?.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  await admin()
    .from("assistant_chat_messages")
    .delete()
    .eq("user_id", user!.id);
  return NextResponse.json({ ok: true });
}

/** POST { message } → run one assistant turn, persist it, return the reply. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isOperator(user?.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  let body: { message?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const userText =
    typeof body.message === "string" ? body.message.trim() : "";
  if (!userText) {
    return NextResponse.json({ error: "Empty message." }, { status: 400 });
  }
  if (userText.length > 8000) {
    return NextResponse.json({ error: "Message too long." }, { status: 400 });
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 5,
  });

  const history = await loadHistory(user!.id);
  const newUserMessage: ConvoMessage = {
    role: "user",
    content: [{ type: "text", text: userText }],
  };
  const messages = [...history, newUserMessage];

  // Synthetic per-user chat id for the tool context (negative to never collide
  // with a real Telegram chat id). File-delivery tools (share_inventory_sheet)
  // target Telegram and won't reach the widget — the operator uses the
  // Download button or email_inventory_sheet instead.
  const chatId = -Math.abs(hashToInt(user!.id));
  const turnId = randomUUID();
  const calledTools: { name: string; ok: boolean }[] = [];
  // username carries the operator's email so the activity log distinguishes
  // widget turns from Telegram ones (negative chat id also marks the surface).
  const actor = {
    chatId,
    turnId,
    username: user!.email ?? undefined,
  };

  let finalMessage: Anthropic.Beta.BetaMessage;
  try {
    finalMessage = await runWithToolContext(
      { chatId, turnId, username: user!.email ?? undefined, calledTools },
      () =>
        runAssistantTurn(client, messages, calledTools, async (flagged) => {
          await logTelegramEvent({
            ...actor,
            kind: "agent_error",
            ok: false,
            error:
              "reply claimed a send without a successful send tool — retrying with corrective reminder",
            text: flagged,
            detail: { calledTools: [...calledTools] },
          });
        }),
    );
  } catch (e) {
    const errText = e instanceof Error ? e.message : "unknown error";
    await logTelegramEvent({
      ...actor,
      kind: "agent_error",
      ok: false,
      error: errText,
    });
    const transient =
      e instanceof Anthropic.APIError &&
      (e.status === 429 || e.status === 529 || (e.status ?? 0) >= 500);
    return NextResponse.json(
      {
        reply: transient
          ? "Claude is temporarily overloaded — try again in a minute."
          : `Sorry — agent error: ${errText}`,
      },
      { status: 200 },
    );
  }

  // Identical post-turn guards to the Telegram surface.
  const { replyText, text, contentForHistory, credentialToolUsed, falseSendClaim } =
    finalizeTurn(finalMessage, calledTools);

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

  await appendHistory(user!.id, "user", newUserMessage.content);
  await appendHistory(user!.id, "assistant", contentForHistory);

  await logTelegramEvent({
    ...actor,
    kind: "assistant_reply",
    text: credentialToolUsed ? "[credential response redacted]" : replyText,
    detail: credentialToolUsed
      ? { redacted: true, calledTools }
      : { calledTools },
  });

  const reply =
    replyText.length > 0 ? replyText : "(Done — no message to add.)";
  return NextResponse.json({ reply });
}

// Text of an assistant/user content array for rendering, markers stripped.
function textOf(content: ConvoMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
    )
    .map((b) => b.text)
    .join("\n\n")
    .replace(/\s*\[(?:tools run this turn:[^\]]*|no tools were run this turn)\]/gi, "")
    .trim();
}

// Stable 31-bit int from a UUID, for the synthetic tool-context chat id.
function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
