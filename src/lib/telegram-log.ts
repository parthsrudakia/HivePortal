import { createClient } from "@supabase/supabase-js";

/**
 * Diagnostic activity log for the Telegram ops bot. Records every step of a bot
 * turn — the user's message, each tool call (with input, result, latency, and
 * whether it succeeded), the assistant's reply plus token usage, and any
 * agent-level error — so a failed or surprising turn can be reconstructed and
 * investigated after the fact. Writes go through the service role, so this works
 * from the webhook route and from inside tool handlers regardless of session.
 *
 * Rows for a single user turn share a turn_id (a uuid minted per incoming
 * message) so the whole exchange can be read back in order.
 */

export type TelegramLogKind =
  | "user_message"
  | "assistant_reply"
  | "tool_call"
  | "agent_error"
  | "slash_command"
  | "rejected";

export const TELEGRAM_KIND_LABELS: Record<TelegramLogKind, string> = {
  user_message: "User message",
  assistant_reply: "Assistant reply",
  tool_call: "Tool call",
  agent_error: "Agent error",
  slash_command: "Slash command",
  rejected: "Rejected (not allowed)",
};

/**
 * Cap the size of any single string we persist. Tool inputs/results are stored
 * verbatim (including short secrets like credential passwords, by design), but a
 * tool that returns a base64 spreadsheet could be megabytes — truncate long
 * strings so the log stays queryable. Secrets are far shorter than this cap and
 * are never affected.
 */
const MAX_STRING = 20_000;

function truncateStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`
      : value;
  }
  if (depth > 8) return "[…nested too deep]";
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((v) => truncateStrings(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateStrings(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * If a tool returned a JSON string, parse it so it's stored as structured JSON
 * (and so the ok flag can be read back). Falls back to the raw (truncated)
 * string when it isn't JSON.
 */
export function normalizeToolResult(raw: unknown): unknown {
  if (typeof raw !== "string") return truncateStrings(raw);
  try {
    return truncateStrings(JSON.parse(raw));
  } catch {
    return truncateStrings(raw);
  }
}

/** Read an `ok` boolean from a tool's JSON result, if it exposes one. */
export function okFromResult(raw: unknown): boolean | null {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      return Boolean((parsed as { ok: unknown }).ok);
    }
  } catch {
    // not JSON / no ok field
  }
  return null;
}

export async function logTelegramEvent(entry: {
  kind: TelegramLogKind;
  chatId: number;
  turnId?: string | null;
  telegramUserId?: number | null;
  username?: string | null;
  toolName?: string | null;
  ok?: boolean | null;
  latencyMs?: number | null;
  error?: string | null;
  /** Human-readable one-liner (user text, reply text, error message). */
  text?: string | null;
  /** Structured payload (tool input+result, model usage, stop reason, …). */
  detail?: unknown;
}): Promise<void> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;
    const sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await sb.from("telegram_activity_log").insert({
      kind: entry.kind,
      chat_id: entry.chatId,
      turn_id: entry.turnId ?? null,
      telegram_user_id: entry.telegramUserId ?? null,
      username: entry.username ?? null,
      tool_name: entry.toolName ?? null,
      ok: entry.ok ?? null,
      latency_ms: entry.latencyMs ?? null,
      error: entry.error ?? null,
      text: entry.text ? String(entry.text).slice(0, MAX_STRING) : null,
      detail:
        entry.detail === undefined ? null : truncateStrings(entry.detail),
    });
  } catch {
    // Diagnostic logging is best-effort — it must never break a bot turn.
  }
}
