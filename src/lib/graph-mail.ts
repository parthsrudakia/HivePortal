/**
 * Minimal Microsoft Graph client for creating draft emails as the M365 work
 * account (vineet.dutta@hiveny.com) — used for non-New-York agreements
 * (with letterhead).
 *
 * Uses a delegated OAuth2 refresh token minted once for the work mailbox. Raw
 * fetch, no graph SDK dependency.
 *
 * The refresh token must be consented for BOTH delegated scopes:
 *   - Mail.ReadWrite  → createOutlookDraft (stage a draft)
 *   - Mail.Send       → sendOutlookMessage (send immediately, /me/sendMail)
 * plus offline_access. If the token was minted with only Mail.ReadWrite, the
 * send path fails at token-refresh time with an AAD consent error — re-mint
 * MS_REFRESH_TOKEN after consenting Mail.Send.
 *
 * Env: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REFRESH_TOKEN
 */

import type {
  DraftInput,
  DraftResult,
  SendDiag,
  SendResult,
} from "./google-mail";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_MESSAGES_URL = `${GRAPH_BASE}/me/messages`;

const SCOPE_READWRITE =
  "https://graph.microsoft.com/Mail.ReadWrite offline_access";
const SCOPE_SEND = "https://graph.microsoft.com/Mail.Send offline_access";
// The reliable send path (createDraft → send → verify) touches both the
// ReadWrite (create draft / read Sent Items) and Send surfaces, so it mints a
// single token consented for both.
const SCOPE_READWRITE_SEND =
  "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access";

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

/**
 * Verify the work mailbox can mint a Mail.Send access token — i.e. that sending
 * (sendOutlookMessage, non-NY agreements) will work — WITHOUT sending anything.
 * Used by the Telegram /diag command to confirm a re-consent took effect.
 */
export async function checkOutlookSendAuth(): Promise<{
  configured: boolean;
  ok: boolean;
  error?: string;
}> {
  if (!outlookConfigured()) return { configured: false, ok: false };
  try {
    await accessToken(SCOPE_SEND);
    return { configured: true, ok: true };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      error: e instanceof Error ? e.message : "Unknown Outlook error",
    };
  }
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
    // AADSTS65001 / invalid_grant on the send scope means the refresh token was
    // minted without Mail.Send consent — surface an actionable hint.
    const needsConsent =
      scope.includes("Mail.Send") &&
      /AADSTS65001|invalid_grant|consent/i.test(detail);
    const hint = needsConsent
      ? " — the refresh token isn't consented for Mail.Send; re-mint MS_REFRESH_TOKEN with Mail.Send + offline_access."
      : "";
    throw new Error(
      `Outlook token refresh failed (${res.status}): ${detail.slice(0, 200)}${hint}`,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a message from the M365 work account and CONFIRM it actually left the
 * mailbox. Used for non-New-York agreements sent straight from Telegram.
 *
 * Why not /me/sendMail: that endpoint is fire-and-forget — it returns 202
 * ("queued"), then sends asynchronously. If the async send later fails
 * (throttling under a burst of agreements, a transient mailbox error, attachment
 * processing), the message is silently dropped and never reaches Sent Items,
 * yet the caller already saw 202 and reports "sent". That false success is the
 * bug this function exists to avoid.
 *
 * Instead, three steps:
 *   1. POST /me/messages           — create a durable draft, capture its stable
 *                                    internetMessageId.
 *   2. POST /me/messages/{id}/send — send that persisted draft.
 *   3. poll Sent Items by internetMessageId — only report success once the
 *      message is actually visible in Sent. If it never appears, return an error
 *      so the operator is told to retry rather than falsely told it sent.
 *
 * Requires the refresh token to be consented for both Mail.ReadWrite and
 * Mail.Send (+ offline_access).
 */
export async function sendOutlookMessage(
  input: DraftInput,
): Promise<SendResult> {
  if (!outlookConfigured()) {
    return { ok: false, error: "Outlook is not configured (missing MS_* env)." };
  }
  try {
    const token = await accessToken(SCOPE_READWRITE_SEND);
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // 1. Create the draft (synchronous — durably persisted before we send).
    const createRes = await fetch(GRAPH_MESSAGES_URL, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
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
                contentType: input.attachment.mimeType || "application/pdf",
                contentBytes: input.attachment.base64,
              },
            ]
          : [],
      }),
    });
    if (!createRes.ok) {
      const detail = await createRes.text().catch(() => "");
      return {
        ok: false,
        error: `Outlook draft create failed (${createRes.status}): ${detail.slice(0, 200)}`,
      };
    }
    const draft = (await createRes.json()) as {
      id?: string;
      internetMessageId?: string;
    };
    // Diagnostic breadcrumbs surfaced to the Telegram activity log so a bad send
    // can be investigated — notably whether the draft carried an
    // internetMessageId (the field whose absence used to trigger a false success)
    // and how the Sent-Items match resolved.
    const diag: SendDiag = {
      createStatus: createRes.status,
      internetMessageIdOnCreate: draft.internetMessageId ?? null,
      verifyMethod: "subject+recipient+sentDateTime",
    };
    if (!draft.id) {
      return {
        ok: false,
        error: "Outlook draft create returned no message id.",
        diag,
      };
    }

    // 2. Record the instant just before we submit. Delivery is confirmed by
    //    finding a message in Sent Items addressed to this recipient, with this
    //    subject, sent at/after this instant. This does NOT depend on
    //    internetMessageId — some mailboxes only assign (or rewrite) it at send
    //    time, which is exactly what broke the old id-keyed verification. The 60s
    //    back-off absorbs client/server clock skew.
    const sentFloor = new Date(Date.now() - 60_000).toISOString();

    // 3. Send the persisted draft. /send returns 202 with an empty body.
    const sendRes = await fetch(
      `${GRAPH_MESSAGES_URL}/${encodeURIComponent(draft.id)}/send`,
      { method: "POST", headers: authHeaders },
    );
    diag.sendStatus = sendRes.status;
    if (!sendRes.ok) {
      const detail = await sendRes.text().catch(() => "");
      return {
        ok: false,
        error: `Outlook send failed (${sendRes.status}): ${detail.slice(0, 200)}`,
        diag,
      };
    }

    // 4. Verify the message actually landed in Sent Items before reporting
    //    success. Match on recipient + subject + sentDateTime window. Never fall
    //    back to trusting the 202 — a positive Sent-Items match is the only path
    //    to success. Poll briefly: the async send + Sent-Items write usually
    //    completes within a few seconds.
    const escapedSubject = input.subject.replace(/'/g, "''");
    const recipient = input.to.toLowerCase();
    const verifyUrl =
      `${GRAPH_BASE}/me/mailFolders/sentitems/messages` +
      `?$filter=${encodeURIComponent(
        `sentDateTime ge ${sentFloor} and subject eq '${escapedSubject}'`,
      )}` +
      `&$select=id,internetMessageId,toRecipients,sentDateTime&$top=25`;
    const delays = [1000, 1500, 2000, 2500, 3000, 3000]; // ~13s total budget
    let attempts = 0;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      attempts = attempt + 1;
      const checkRes = await fetch(verifyUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (checkRes.ok) {
        const found = (await checkRes.json()) as {
          value?: Array<{
            id?: string;
            internetMessageId?: string;
            toRecipients?: Array<{ emailAddress?: { address?: string } }>;
          }>;
        };
        const candidates = found.value ?? [];
        diag.sentItemsCandidates = candidates.length;
        const match = candidates.find((m) =>
          (m.toRecipients ?? []).some(
            (r) => r.emailAddress?.address?.toLowerCase() === recipient,
          ),
        );
        if (match) {
          diag.verifyAttempts = attempts;
          diag.matchedInSentItems = true;
          return {
            ok: true,
            id: match.internetMessageId ?? match.id ?? "",
            diag,
          };
        }
      }
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
    diag.verifyAttempts = attempts;
    diag.matchedInSentItems = false;
    return {
      ok: false,
      error:
        "Outlook accepted the send but no matching message appeared in Sent " +
        "Items within ~13s — it may have been silently dropped. Please retry.",
      diag,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown Outlook error",
    };
  }
}
