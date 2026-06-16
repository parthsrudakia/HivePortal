/**
 * Minimal Gmail API client for creating draft emails as the personal account
 * (vdutta1485@gmail.com) — used for New York agreements (no letterhead).
 *
 * Uses an OAuth2 refresh token minted once via the Gmail "gmail.compose" scope.
 * No googleapis dependency — raw fetch, matching src/lib/telegram.ts.
 *
 * Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRAFTS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
const REVIEW_URL = "https://mail.google.com/mail/u/0/#drafts";

export type DraftInput = {
  to: string;
  subject: string;
  /** Optional HTML body. When omitted, a plain text/plain message is built. */
  html?: string;
  text: string;
  attachment: { filename: string; base64: string; mimeType?: string };
};

export type DraftResult =
  | { ok: true; draftUrl: string }
  | { ok: false; error: string };

function config() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

export function gmailConfigured(): boolean {
  return config() !== null;
}

async function accessToken(): Promise<string> {
  const cfg = config();
  if (!cfg) throw new Error("Gmail is not configured (missing GMAIL_* env).");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Gmail token refresh failed (${res.status}): ${detail.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Gmail token refresh returned no access_token.");
  }
  return data.access_token;
}

/**
 * RFC 2822 multipart/mixed message + a base64 PDF attachment. When `html` is
 * provided the body is multipart/alternative (text + html); otherwise it's a
 * single plain text/plain part. Boundary strings are neutral on purpose.
 */
function buildMimeMessage(input: DraftInput): string {
  const boundary = "mixed_boundary_8a3f";
  const altBoundary = "alt_boundary_8a3f";
  const mime = input.attachment.mimeType || "application/pdf";
  // Re-wrap the attachment base64 at 76 cols per MIME convention.
  const wrapped = input.attachment.base64.replace(/.{76}/g, "$&\r\n");

  const bodySection = input.html
    ? [
        `--${boundary}`,
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        "",
        `--${altBoundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        input.text,
        "",
        `--${altBoundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "",
        input.html,
        "",
        `--${altBoundary}--`,
      ]
    : [
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        input.text,
      ];

  return [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...bodySection,
    "",
    `--${boundary}`,
    `Content-Type: ${mime}; name="${input.attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${input.attachment.filename}"`,
    "",
    wrapped,
    "",
    `--${boundary}--`,
  ].join("\r\n");
}

function base64UrlEncode(raw: string): string {
  return Buffer.from(raw, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function createGmailDraft(input: DraftInput): Promise<DraftResult> {
  if (!gmailConfigured()) {
    return { ok: false, error: "Gmail is not configured (missing GMAIL_* env)." };
  }
  try {
    const token = await accessToken();
    const raw = base64UrlEncode(buildMimeMessage(input));
    const res = await fetch(DRAFTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw } }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Gmail draft failed (${res.status}): ${detail.slice(0, 200)}`,
      };
    }
    // Deep-link straight to this draft so tapping the link opens it in Gmail;
    // fall back to the drafts list if the id isn't present.
    const data = (await res.json().catch(() => null)) as {
      message?: { id?: string };
    } | null;
    const msgId = data?.message?.id;
    return {
      ok: true,
      draftUrl: msgId
        ? `https://mail.google.com/mail/u/0/#drafts/${msgId}`
        : REVIEW_URL,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown Gmail error",
    };
  }
}
