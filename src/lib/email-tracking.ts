import { randomUUID } from "node:crypto";

// Email open tracking. Every HTML email the portal sends (Resend dispatch and
// the Outlook senders) gets a 1x1 pixel pointing at /api/o/<trackId>; the
// trackId is stored on the email's email_log row, and loading the pixel
// records an open there (see the email_open_tracking migration).
//
// Opens are approximate: Apple Mail pre-loads images (false opens) and many
// clients hide images until the reader allows them (missed opens). Plain-text
// sends (NY Gmail) carry no pixel.

/** Where the pixel is served from (the portal), or null to send untracked. */
export function trackingOrigin(): string | null {
  const raw = process.env.EMAIL_TRACKING_ORIGIN?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function pixelUrl(trackId: string): string | null {
  const origin = trackingOrigin();
  return origin ? `${origin}/api/o/${trackId}` : null;
}

/**
 * Add an open-tracking pixel to an HTML body. Returns the tracked HTML and the
 * trackId to store on the email_log row, or the original HTML and a null
 * trackId when tracking is unconfigured or there is no HTML body.
 */
export function addTrackingPixel(html: string | undefined): {
  html: string | undefined;
  trackId: string | null;
} {
  if (!html) return { html, trackId: null };
  const trackId = randomUUID();
  const url = pixelUrl(trackId);
  if (!url) return { html, trackId: null };
  const img = `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;opacity:0;" />`;
  // Inside </body> when it's a full document, otherwise at the very end.
  const tracked = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${img}</body>`)
    : `${html}${img}`;
  return { html: tracked, trackId };
}

// The smallest transparent GIF (43 bytes).
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
