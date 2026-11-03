/**
 * Minimal Microsoft Graph client for sending email as the M365 work account
 * (vineet.dutta@hiveny.com) — used for non-New-York agreements (with
 * letterhead).
 *
 * Uses a delegated OAuth2 refresh token minted once for the work mailbox. Raw
 * fetch, no graph SDK dependency.
 *
 * The refresh token must be consented for BOTH delegated scopes:
 *   - Mail.ReadWrite  → create the draft, read Sent Items to verify delivery
 *   - Mail.Send       → send the draft
 * plus offline_access. If the token was minted without one of them, the send
 * path fails at token-refresh time with an AAD consent error — re-mint
 * MS_REFRESH_TOKEN after consenting both.
 *
 * Env: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REFRESH_TOKEN
 */

import type { DraftInput, SendDiag, SendResult } from "./google-mail";
import { RetryableFailure, withSendRetry } from "./send-retry";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_MESSAGES_URL = `${GRAPH_BASE}/me/messages`;

// The send path (createDraft → send → verify) touches both the ReadWrite
// (create draft / read Sent Items) and Send surfaces, so every token is minted
// consented for both.
const SCOPE_READWRITE_SEND =
  "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access";

// Every Graph/AAD request is bounded so a hung call fails fast instead of
// eating the serverless time budget.
const GRAPH_TIMEOUT_MS = 15_000;

// Messages are addressed with immutable ids so the draft's id survives the
// move to Sent Items — that turns "did it really send?" into a direct GET on
// the message instead of a heuristic Sent-Items search.
const PREFER_IMMUTABLE_ID = { Prefer: 'IdType="ImmutableId"' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Transient Graph/AAD hiccups (throttling, gateway blips) get one bounded
// retry honoring Retry-After. Callers narrow retryStatuses when a blind retry
// isn't safe — POST /send is retried only on 429, where Graph is explicit
// that the request was not processed.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

async function graphFetch(
  url: string,
  init: RequestInit,
  retryStatuses: Set<number> = TRANSIENT_STATUSES,
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  if (!retryStatuses.has(res.status)) return res;
  const retryAfter = Number(res.headers.get("retry-after"));
  await sleep(
    Math.min(
      (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000,
      5_000,
    ),
  );
  return fetch(url, { ...init, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
}

// POST /send gets its own retries (withSendRetry below) instead of graphFetch's.
const NO_RETRY = new Set<number>();
const SEND_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 8_000;

type SendFailure = { status: number; detail: string };

function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    : undefined;
}

// Only a message that is still a draft has certainly not been sent. Any
// doubt (lookup failed, no longer a draft) means don't resend.
async function stillUnsentDraft(draftUrl: string, token: string): Promise<boolean> {
  const res = await graphFetch(`${draftUrl}?$select=isDraft`, {
    headers: { Authorization: `Bearer ${token}`, ...PREFER_IMMUTABLE_ID },
  }).catch(() => null);
  if (!res?.ok) return false;
  return ((await res.json().catch(() => ({}))) as { isDraft?: boolean }).isDraft === true;
}

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
 * Verify the work mailbox can mint the exact token the send path uses
 * (Mail.ReadWrite + Mail.Send) — i.e. that sendOutlookMessage will work —
 * WITHOUT sending anything. Used by the Telegram /diag command to confirm a
 * re-consent took effect. Testing Mail.Send alone would pass /diag while real
 * sends still fail on the ReadWrite half.
 */
export async function checkOutlookSendAuth(): Promise<{
  configured: boolean;
  ok: boolean;
  error?: string;
}> {
  if (!outlookConfigured()) return { configured: false, ok: false };
  try {
    await accessToken(SCOPE_READWRITE_SEND);
    return { configured: true, ok: true };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      error: e instanceof Error ? e.message : "Unknown Outlook error",
    };
  }
}

async function accessToken(scope: string): Promise<string> {
  const cfg = config();
  if (!cfg) throw new Error("Outlook is not configured (missing MS_* env).");
  const tokenUrl = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
  const res = await graphFetch(tokenUrl, {
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
 *   1. POST /me/messages (Prefer: ImmutableId) — create a durable draft whose
 *      id survives the move to Sent Items.
 *   2. POST /me/messages/{id}/send — send that persisted draft.
 *   3. GET the message by its immutable id and confirm it now lives in Sent
 *      Items and is no longer a draft — an exact check that can't confuse this
 *      send with an earlier email to the same recipient. A Sent-Items search
 *      (internetMessageId, then recipient+subject+time window) remains as the
 *      fallback for mailboxes that ignore the immutable-id preference. Never
 *      trust the 202 alone — a positive match is the only path to success.
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

    // 1. Create the draft (synchronous — durably persisted before we send),
    //    addressed with an immutable id so the same id still resolves after
    //    the message moves to Sent Items. A lease PDF is small, so the
    //    single-request (<3MB) attachment path is fine.
    const createRes = await graphFetch(GRAPH_MESSAGES_URL, {
      method: "POST",
      headers: { ...authHeaders, ...PREFER_IMMUTABLE_ID },
      body: JSON.stringify({
        subject: input.subject,
        body: input.html
          ? { contentType: "HTML", content: input.html }
          : { contentType: "Text", content: input.text },
        // Bulk blasts hide every tenant in BCC with no visible To (Graph
        // sends fine with only bccRecipients); `to` may be "" in that case.
        toRecipients: input.to
          ? [{ emailAddress: { address: input.to } }]
          : [],
        bccRecipients: (input.bcc
          ? Array.isArray(input.bcc)
            ? input.bcc
            : [input.bcc]
          : []
        ).map((address) => ({ emailAddress: { address } })),
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
    // and how the Sent-folder match resolved.
    const diag: SendDiag = {
      createStatus: createRes.status,
      internetMessageIdOnCreate: draft.internetMessageId ?? null,
    };
    if (!draft.id) {
      return {
        ok: false,
        error: "Outlook draft create returned no message id.",
        diag,
      };
    }
    const draftUrl = `${GRAPH_MESSAGES_URL}/${encodeURIComponent(draft.id)}`;

    // Resolve the Sent Items folder id up front; the primary verification
    // compares the message's parentFolderId against it. Best-effort — the
    // search fallback still works without it.
    let sentFolderId: string | null = null;
    const folderRes = await graphFetch(
      `${GRAPH_BASE}/me/mailFolders/sentitems?$select=id`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => null);
    if (folderRes?.ok) {
      sentFolderId =
        ((await folderRes.json()) as { id?: string }).id ?? null;
    }

    // 2. Record the instant just before we submit — the fallback search
    //    confirms delivery by finding a Sent-Items message to this recipient,
    //    with this subject, sent at/after this instant. The 60s back-off
    //    absorbs client/server clock skew.
    const sentFloor = new Date(Date.now() - 60_000).toISOString();

    // 3. Send the persisted draft. /send returns 202 with an empty body.
    //    429/5xx and network errors are retried with backoff (send-retry.ts,
    //    Retry-After honoured up to 8s). 429 means Graph didn't process the
    //    request; after anything ambiguous (5xx, timeout, network error) the
    //    draft is re-read first and only resent while it is still a draft.
    //    A definite 4xx rejection means the draft never left — clean it up
    //    and fail. Anything still ambiguous after the retries falls through
    //    to verification, which decides whether the message actually went
    //    out — never delete or resend on an ambiguous outcome.
    let sendErrorDetail = "";
    let sendDefinitelyFailed = false;
    const send = await withSendRetry(
      async () => {
        const res = await graphFetch(
          `${draftUrl}/send`,
          { method: "POST", headers: authHeaders },
          NO_RETRY,
        );
        if (!SEND_RETRY_STATUSES.has(res.status)) return res;
        const failure: SendFailure = {
          status: res.status,
          detail: await res.text().catch(() => ""),
        };
        throw new RetryableFailure(failure, retryAfterMs(res));
      },
      {
        isRetryable: () => true, // a retryable status or a network error
        beforeRetry: (e) =>
          e instanceof RetryableFailure && (e.result as SendFailure).status === 429
            ? Promise.resolve(true)
            : stillUnsentDraft(draftUrl, token),
      },
    );
    if (send.ok) {
      diag.sendStatus = send.value.status;
      if (!send.value.ok) {
        const detail = await send.value.text().catch(() => "");
        sendErrorDetail = `Outlook send failed (${send.value.status}): ${detail.slice(0, 200)}`;
        sendDefinitelyFailed = send.value.status >= 400 && send.value.status < 500;
      }
    } else if (send.error instanceof RetryableFailure) {
      const { status, detail } = send.error.result as SendFailure;
      diag.sendStatus = status;
      sendErrorDetail = `Outlook send failed (${status}): ${detail.slice(0, 200)}`;
      sendDefinitelyFailed = status === 429;
    } else {
      const e = send.error;
      sendErrorDetail = `Outlook send did not respond: ${e instanceof Error ? e.message : String(e)}`;
      diag.note = "send timed out — outcome resolved via Sent Items check";
    }
    const sendAttempts = send.attempts;
    if (sendDefinitelyFailed) {
      // Best-effort: the draft was never sent, so remove it rather than
      // letting failed attempts pile up in the Drafts folder.
      await fetch(draftUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      }).catch(() => {});
      return { ok: false, error: sendErrorDetail, diag, attempts: sendAttempts };
    }

    // 4. Verify the message actually landed in Sent Items before reporting
    //    success. Primary: GET the message by its immutable id and check it
    //    is no longer a draft and now lives in Sent Items — exact, immune to
    //    a quick resend to the same recipient. Fallback: search Sent Items by
    //    internetMessageId, then recipient + subject + sentDateTime window,
    //    for mailboxes that ignore the immutable-id preference. Never fall
    //    back to trusting the 202 — a positive match is the only path to
    //    success. Poll briefly: the async send + Sent-Items write usually
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

      if (sentFolderId) {
        const getRes = await graphFetch(
          `${draftUrl}?$select=id,isDraft,parentFolderId,internetMessageId`,
          {
            headers: { Authorization: `Bearer ${token}`, ...PREFER_IMMUTABLE_ID },
          },
        ).catch(() => null);
        if (getRes?.ok) {
          const m = (await getRes.json()) as {
            id?: string;
            isDraft?: boolean;
            parentFolderId?: string;
            internetMessageId?: string;
          };
          if (m.isDraft === false && m.parentFolderId === sentFolderId) {
            diag.verifyMethod = "immutable-id";
            diag.verifyAttempts = attempts;
            diag.matchedInSentItems = true;
            return {
              ok: true,
              id: m.internetMessageId ?? m.id ?? "",
              diag,
              attempts: sendAttempts,
            };
          }
        }
      }

      const checkRes = await graphFetch(verifyUrl, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (checkRes?.ok) {
        const found = (await checkRes.json()) as {
          value?: Array<{
            id?: string;
            internetMessageId?: string;
            toRecipients?: Array<{ emailAddress?: { address?: string } }>;
          }>;
        };
        const candidates = found.value ?? [];
        diag.sentItemsCandidates = candidates.length;
        const byId = draft.internetMessageId
          ? candidates.find(
              (m) => m.internetMessageId === draft.internetMessageId,
            )
          : undefined;
        const match =
          byId ??
          candidates.find((m) =>
            (m.toRecipients ?? []).some(
              (r) => r.emailAddress?.address?.toLowerCase() === recipient,
            ),
          );
        if (match) {
          diag.verifyMethod = "subject+recipient+sentDateTime";
          diag.verifyAttempts = attempts;
          diag.matchedInSentItems = true;
          return {
            ok: true,
            id: match.internetMessageId ?? match.id ?? "",
            diag,
            attempts: sendAttempts,
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
        sendErrorDetail ||
        "Outlook accepted the send but no matching message appeared in Sent " +
          "Items within ~13s — it may have been silently dropped, or may still " +
          "be processing. Check the Sent folder before retrying so the tenant " +
          "isn't emailed twice.",
      diag,
      attempts: sendAttempts,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown Outlook error",
    };
  }
}
