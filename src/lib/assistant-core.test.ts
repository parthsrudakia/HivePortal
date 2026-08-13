import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  claimsMessageSent,
  finalizeTurn,
  PAST_SEND_NOTE,
  ranOnlyReadTools,
} from "./assistant-core";

const msg = (text: string) =>
  ({ content: [{ type: "text", text }] }) as unknown as Anthropic.Beta.BetaMessage;

describe("claimsMessageSent", () => {
  it("flags completed-send claims", () => {
    expect(claimsMessageSent("Sent ✅ to jane@x.com from Gmail")).toBe(true);
    expect(claimsMessageSent("Emailed 4, texted 3.")).toBe(true);
  });
  it("ignores read-backs and negations", () => {
    expect(claimsMessageSent("I'll send from Outlook — send it?")).toBe(false);
    expect(claimsMessageSent("It was never actually sent.")).toBe(false);
  });
});

describe("ranOnlyReadTools", () => {
  it("is true only when tools ran and none was a send tool", () => {
    expect(ranOnlyReadTools([])).toBe(false);
    expect(ranOnlyReadTools([{ name: "query_database", ok: true }])).toBe(true);
    expect(
      ranOnlyReadTools([
        { name: "query_database", ok: true },
        { name: "send_agreement", ok: false },
      ]),
    ).toBe(false);
  });
});

describe("finalizeTurn false-send handling", () => {
  const claim = "Yes — she signed 8/12. The signed copy was emailed to bh@x.edu ✅";

  it("keeps a tool-grounded status answer and appends the past-send note (8/12/26 regression)", () => {
    const turn = finalizeTurn(msg(claim), [{ name: "query_database", ok: true }]);
    expect(turn.falseSendClaim).toBe(false);
    expect(turn.replyText).toContain("she signed 8/12");
    expect(turn.replyText).toContain(PAST_SEND_NOTE);
    // History keeps the real answer so later turns don't inherit a garbled memory.
    expect(JSON.stringify(turn.contentForHistory)).toContain("she signed 8/12");
  });

  it("still corrects an ungrounded send claim (no tools ran)", () => {
    const turn = finalizeTurn(msg("Sent ✅ to jane@x.com from Gmail"), []);
    expect(turn.falseSendClaim).toBe(true);
    expect(turn.replyText).toContain("⚠️ Correction");
    expect(JSON.stringify(turn.contentForHistory)).toContain(
      "no sending tool ran this turn",
    );
  });

  it("still corrects a send claim after a failed send attempt", () => {
    const turn = finalizeTurn(msg("Sent ✅ to jane@x.com from Outlook"), [
      { name: "send_agreement", ok: false },
    ]);
    expect(turn.falseSendClaim).toBe(true);
  });

  it("passes a successful send through untouched", () => {
    const turn = finalizeTurn(msg("Sent ✅ to jane@x.com from Outlook"), [
      { name: "send_agreement", ok: true },
    ]);
    expect(turn.falseSendClaim).toBe(false);
    expect(turn.replyText).not.toContain(PAST_SEND_NOTE);
  });
});
