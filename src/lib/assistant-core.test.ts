import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  claimsMessageSent,
  conversationEvidenceText,
  finalizeTurn,
  PAST_SEND_NOTE,
  ranOnlyReadTools,
  SYSTEM_PROMPT,
  unsupportedUuids,
  UNVERIFIED_STAMP,
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

const REAL_ID = "3f6c8f8e-88df-4bfb-b40a-9df6a63a2a7c";
const FAKE_ID = "88a2f4ba-3a44-49c1-b9e2-04725c7ea883";

describe("unsupportedUuids", () => {
  it("passes IDs present in evidence, catches ones that are not", () => {
    const evidence = `tool result: {"id":"${REAL_ID}"}`;
    expect(unsupportedUuids(`Unit A (${REAL_ID})`, evidence)).toEqual([]);
    expect(unsupportedUuids(`Unit B (${FAKE_ID})`, evidence)).toEqual([
      FAKE_ID,
    ]);
  });
  it("matches case-insensitively", () => {
    expect(unsupportedUuids(REAL_ID.toUpperCase(), REAL_ID)).toEqual([]);
  });
});

describe("conversationEvidenceText", () => {
  it("flattens string and block content", () => {
    const text = conversationEvidenceText([
      { role: "user", content: `send to ${REAL_ID}` },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(text).toContain(REAL_ID);
    expect(text).toContain("ok");
  });
});

describe("finalizeTurn grounding guards", () => {
  it("blocks a reply citing a UUID absent from evidence (8/12/26 626-Summit regression)", () => {
    const turn = finalizeTurn(
      msg(`626 Summit has two units: Apt 2 (${FAKE_ID})`),
      [],
      `earlier conversation mentioning ${REAL_ID}`,
    );
    expect(turn.fabricatedIds).toEqual([FAKE_ID]);
    expect(turn.replyText).toContain("discarded");
    expect(turn.replyText).not.toContain("Apt 2");
    expect(JSON.stringify(turn.contentForHistory)).toContain("fabricated");
  });

  it("allows a reply whose UUIDs come from tool results or history", () => {
    const turn = finalizeTurn(
      msg(`Send it? (property ${REAL_ID})`),
      [{ name: "resolve_property_address", ok: true }],
      `{"property_id":"${REAL_ID}"}`,
    );
    expect(turn.fabricatedIds).toEqual([]);
    expect(turn.replyText).toContain(REAL_ID);
  });

  it("stamps a zero-tool status claim as unverified (8/12/26 'not signed yet' regression)", () => {
    const turn = finalizeTurn(msg("Not signed yet — still pending."), [], "");
    expect(turn.ungroundedStatusClaim).toBe(true);
    expect(turn.replyText.startsWith(UNVERIFIED_STAMP)).toBe(true);
    expect(turn.replyText).toContain("still pending");
    expect(JSON.stringify(turn.contentForHistory)).toContain(UNVERIFIED_STAMP);
  });

  it("does not stamp a status answer grounded in a tool call", () => {
    const turn = finalizeTurn(msg("She signed on 8/12 — all set."), [
      { name: "query_database", ok: true },
    ]);
    expect(turn.ungroundedStatusClaim).toBe(false);
    expect(turn.replyText).not.toContain(UNVERIFIED_STAMP);
  });

  it("does not stamp zero-tool replies without status language", () => {
    const turn = finalizeTurn(msg("Which unit is Aziz's — Apt 2 or Apt 3?"), []);
    expect(turn.ungroundedStatusClaim).toBe(false);
  });
});

describe("SYSTEM_PROMPT id-trailer rule", () => {
  it("restricts the parenthetical ID line to pending-write confirmations", () => {
    // 9/14/26 regression: the widget appended "(tenancies: Name id, ...)" to
    // every reply. The rule below is what stops that; keep it in the prompt.
    expect(SYSTEM_PROMPT).toContain("Never append UUIDs to any other reply");
    expect(SYSTEM_PROMPT).toContain("(tenancies: Name id, Name id, ...)");
  });
});
