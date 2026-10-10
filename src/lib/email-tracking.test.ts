import { afterEach, describe, expect, it } from "vitest";
import { addTrackingPixel, TRANSPARENT_GIF } from "@/lib/email-tracking";

const saved = process.env.EMAIL_TRACKING_ORIGIN;
afterEach(() => {
  if (saved === undefined) delete process.env.EMAIL_TRACKING_ORIGIN;
  else process.env.EMAIL_TRACKING_ORIGIN = saved;
});

describe("addTrackingPixel", () => {
  it("appends a 1x1 pixel pointing at the tracking route", () => {
    process.env.EMAIL_TRACKING_ORIGIN = "https://portal.example.com/";
    const { html, trackId } = addTrackingPixel("<div>Hi</div>");
    expect(trackId).toMatch(/^[0-9a-f-]{36}$/);
    expect(html).toBe(
      `<div>Hi</div><img src="https://portal.example.com/api/o/${trackId}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;opacity:0;" />`,
    );
  });

  it("puts the pixel inside </body> for a full document", () => {
    process.env.EMAIL_TRACKING_ORIGIN = "https://portal.example.com";
    const { html } = addTrackingPixel("<html><body><p>x</p></body></html>");
    expect(html).toMatch(/<p>x<\/p><img [^>]+\/><\/body><\/html>$/);
  });

  it("gives every send its own id", () => {
    process.env.EMAIL_TRACKING_ORIGIN = "https://portal.example.com";
    expect(addTrackingPixel("<p/>").trackId).not.toBe(addTrackingPixel("<p/>").trackId);
  });

  it("sends untracked when unconfigured or there is no HTML", () => {
    delete process.env.EMAIL_TRACKING_ORIGIN;
    expect(addTrackingPixel("<p>x</p>")).toEqual({ html: "<p>x</p>", trackId: null });
    process.env.EMAIL_TRACKING_ORIGIN = "https://portal.example.com";
    expect(addTrackingPixel(undefined)).toEqual({ html: undefined, trackId: null });
  });

  it("serves a real GIF", () => {
    expect(TRANSPARENT_GIF.subarray(0, 6).toString("ascii")).toBe("GIF89a");
  });
});
