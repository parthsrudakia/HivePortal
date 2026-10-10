import { randomUUID } from "node:crypto";

// Email open tracking. Every HTML email the portal sends (Resend dispatch and
// the Outlook senders) gets a 1x1 pixel pointing at /api/o/<trackId>; the
// trackId is stored on the email's email_log row, and loading the pixel
// records an open there (see the email_open_tracking migration).
//
// Opens are approximate: Apple Mail pre-loads images (false opens) and many
// clients hide images until the reader allows them (missed opens).
//
// New York Gmail sends stay plain text to the eye: they go out as
// text + an HTML part that is the same text, unstyled (trackedPlainText), and
// their pixel is served from the neutral SIGN_ORIGIN host, because NY mail
// must never expose the portal's "hive" domain, even in a hidden image URL.

export type TrackingOpts = {
  /** Serve the pixel from the neutral SIGN_ORIGIN host (New York mail). */
  neutral?: boolean;
};

/** Where the pixel is served from, or null to send untracked. */
export function trackingOrigin(opts: TrackingOpts = {}): string | null {
  const raw = (opts.neutral ? process.env.SIGN_ORIGIN : process.env.EMAIL_TRACKING_ORIGIN)?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function pixelUrl(trackId: string, opts: TrackingOpts = {}): string | null {
  const origin = trackingOrigin(opts);
  return origin ? `${origin}/api/o/${trackId}` : null;
}

/**
 * Add an open-tracking pixel to an HTML body. Returns the tracked HTML and the
 * trackId to store on the email_log row, or the original HTML and a null
 * trackId when tracking is unconfigured or there is no HTML body.
 */
export function addTrackingPixel(
  html: string | undefined,
  opts: TrackingOpts = {},
): {
  html: string | undefined;
  trackId: string | null;
} {
  if (!html) return { html, trackId: null };
  const trackId = randomUUID();
  const url = pixelUrl(trackId, opts);
  if (!url) return { html, trackId: null };
  const img = `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;opacity:0;" />`;
  // Inside </body> when it's a full document, otherwise at the very end.
  const tracked = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${img}</body>`)
    : `${html}${img}`;
  return { html: tracked, trackId };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The HTML twin of a plain-text email: the same words and line breaks, no
 * styling, with bare URLs made clickable (a plain-text client would autolink
 * them). Mail apps show this part, so it must read exactly like the text.
 */
export function plainTextHtml(text: string): string {
  const body = escapeHtml(text)
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`)
    .replace(/\r?\n/g, "<br>\n");
  return `<div>${body}</div>`;
}

/**
 * A plain-text NY email made trackable: returns the HTML part (text twin +
 * pixel on the neutral host) and its trackId. With SIGN_ORIGIN unset there is
 * no safe pixel host, so it returns no HTML and the email stays text-only.
 */
export function trackedPlainText(text: string): {
  html: string | undefined;
  trackId: string | null;
} {
  const tracked = addTrackingPixel(plainTextHtml(text), { neutral: true });
  return tracked.trackId ? tracked : { html: undefined, trackId: null };
}

// The smallest transparent GIF (43 bytes).
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
