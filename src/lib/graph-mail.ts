/**
 * Minimal Microsoft Graph client for creating draft emails as the M365 work
 * account (vineet.dutta@hiveny.com) — used for non-New-York agreements
 * (with letterhead).
 *
 * Uses a delegated OAuth2 refresh token (scopes: Mail.ReadWrite offline_access)
 * minted once for the work mailbox. Raw fetch, no graph SDK dependency.
 *
 * Env: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REFRESH_TOKEN
 */

import type { DraftInput, DraftResult, SendResult } from "./google-mail";

const GRAPH_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/messages";
const GRAPH_SENDMAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

const SCOPE_READWRITE =
  "https://graph.microsoft.com/Mail.ReadWrite offline_access";
const SCOPE_SEND = "https://graph.microsoft.com/Mail.Send offline_access";

function config() {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const tenantId = process.env.MS_TENANT_ID;
  const refreshToken = process.env.MS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !tenantId || !refreshToken) return null;
  return { clientId, clientSecret, tenantId, refreshToken };
}

export function outlookConfigured(): boolean {
  return config() !== null;
}

async function accessToken(scope: string = SCOPE_READWRITE): Promise<string> {
  const cfg = config();
  if (!cfg) throw new Error("Outlook is not configured (missing MS_* env).");
  const tokenUrl = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
      scope,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Outlook token refresh failed (${res.status}): ${detail.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Outlook token refresh returned no access_token.");
  }
  return data.access_token;
}

export async function createOutlookDraft(
  input: DraftInput,
): Promise<DraftResult> {
  if (!outlookConfigured()) {
    return { ok: false, error: "Outlook is not configured (missing MS_* env)." };
  }
  try {
    const token = await accessToken();
    // Create the draft message with the PDF as an inline fileAttachment. A lease
    // PDF is small, so the single-request (<3MB) attachment path is fine.
    const res = await fetch(GRAPH_MESSAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject: input.subject,
        body: input.html
          ? { contentType: "HTML", content: input.html }
          : { contentType: "Text", content: input.text },
        toRecipients: [{ emailAddress: { address: input.to } }],
        isDraft: true,
        attachments: input.attachment
          ? [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: input.attachment.filename,
                contentType: input.attachment.mimeType || "application/pdf",
                contentBytes: input.attachment.base64,
              },
            ]
          : [],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Outlook draft failed (${res.status}): ${detail.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as { webLink?: string };
    return {
      ok: true,
      draftUrl: data.webLink || "https://outlook.office.com/mail/drafts",
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown Outlook error",
    };
  }
}

/**
 * Send a message immediately from the M365 work account (saved to Sent Items),
 * rather than staging a draft. Used for non-New-York agreements once the
 * operator opts to send straight from Telegram. Requires the Mail.Send scope to
 * be consented on the refresh token; /me/sendMail returns 202 with no body.
 */
export async function sendOutlookMessage(
  input: DraftInput,
): Promise<SendResult> {
  if (!outlookConfigured()) {
    return { ok: false, error: "Outlook is not configured (missing MS_* env)." };
  }
  try {
    const token = await accessToken(SCOPE_SEND);
    const res = await fetch(GRAPH_SENDMAIL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: input.html
            ? { contentType: "HTML", content: input.html }
            : { contentType: "Text", content: input.text },
          toRecipients: [{ emailAddress: { address: input.to } }],
          attachments: input.attachment
            ? [
                {
                  "@odata.type": "#microsoft.graph.fileAttachment",
                  name: input.attachment.filename,
                  contentType:
                    input.attachment.mimeType || "application/pdf",
                  contentBytes: input.attachment.base64,
                },
              ]
            : [],
        },
        saveToSentItems: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Outlook send failed (${res.status}): ${detail.slice(0, 200)}`,
      };
    }
    // sendMail returns 202 Accepted with an empty body — no id to surface.
    return { ok: true, id: "" };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown Outlook error",
    };
  }
}
