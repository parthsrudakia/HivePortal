/** Minimal Telegram Bot API client — only what the webhook needs. */

const API_BASE = "https://api.telegram.org";

function token() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return t;
}

/**
 * Split text into Telegram-sized chunks (cap 4096) without cutting mid-word:
 * prefer the last newline before the limit, then the last space; only a
 * single unbroken run longer than `max` is hard-sliced. Pure — unit-tested.
 * Joining the chunks back with "\n" reproduces the input (splits happen at
 * whitespace that is consumed by the split).
 */
export function chunkMessage(text: string, max = 4000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    if (cut < 1) cut = window.lastIndexOf(" ");
    if (cut < 1) cut = max; // one long unbroken run — hard slice
    chunks.push(rest.slice(0, cut));
    // Drop the single whitespace char we split on (if that's where we cut).
    rest = /\s/.test(rest[cut] ?? "") ? rest.slice(cut + 1) : rest.slice(cut);
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

async function postChunk(
  chatId: number,
  chunk: string,
  opts: { reply_to_message_id?: number },
  parseMode?: "HTML",
) {
  const res = await fetch(`${API_BASE}/bot${token()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: opts.reply_to_message_id,
      parse_mode: parseMode,
      link_preview_options: { is_disabled: true },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    // A malformed HTML entity is a 400 "can't parse entities" — resend this
    // one chunk as plain text so a stray tag degrades it, never loses it.
    if (parseMode && res.status === 400 && /can't parse entit/i.test(detail)) {
      return postChunk(chatId, chunk, opts, undefined);
    }
    // Don't throw; log and continue so we don't double-handle on retry.
    console.error("Telegram sendMessage failed:", detail);
  }
}

export async function sendMessage(
  chatId: number,
  text: string,
  opts: { reply_to_message_id?: number; parse_mode?: "HTML" } = {},
) {
  for (const chunk of chunkMessage(text)) {
    await postChunk(chatId, chunk, opts, opts.parse_mode);
  }
}

export async function sendDocument(
  chatId: number,
  doc: { buffer: Buffer; filename: string; mimeType?: string },
  opts: { caption?: string; reply_to_message_id?: number } = {},
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (opts.caption) form.append("caption", opts.caption);
  if (opts.reply_to_message_id != null) {
    form.append("reply_to_message_id", String(opts.reply_to_message_id));
  }
  const blob = new Blob([new Uint8Array(doc.buffer)], {
    type: doc.mimeType ?? "application/octet-stream",
  });
  form.append("document", blob, doc.filename);

  const res = await fetch(`${API_BASE}/bot${token()}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("Telegram sendDocument failed:", detail);
    return { ok: false, error: detail };
  }
  return { ok: true };
}

export async function sendChatAction(chatId: number, action: "typing") {
  await fetch(`${API_BASE}/bot${token()}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  }).catch(() => {
    // Ignore — typing indicator is best-effort.
  });
}

export function allowedUserIds(): Set<number> {
  const raw = process.env.ALLOWED_TELEGRAM_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  );
}
