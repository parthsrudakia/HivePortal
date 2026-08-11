import { describe, expect, it } from "vitest";
import { chunkMessage } from "./telegram";

describe("chunkMessage", () => {
  it("returns short text unchanged in a single chunk", () => {
    expect(chunkMessage("hello world")).toEqual(["hello world"]);
  });

  it("returns a single chunk for text exactly at the limit", () => {
    const s = "a".repeat(4000);
    expect(chunkMessage(s)).toEqual([s]);
  });

  it("splits long multi-line text at newline boundaries, ≤ max each", () => {
    const line = "x".repeat(200);
    const text = Array.from({ length: 60 }, () => line).join("\n"); // ~12k
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    // Every chunk is whole lines — no line was cut in half.
    for (const c of chunks) {
      for (const l of c.split("\n")) expect(l).toBe(line);
    }
    // Rejoining on the split whitespace reproduces the input.
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard-slices a single unbroken run with no whitespace", () => {
    const s = "z".repeat(9000);
    const chunks = chunkMessage(s);
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 1000]);
    expect(chunks.join("")).toBe(s);
  });

  it("falls back to a space when there is no newline in the window", () => {
    const word = "w".repeat(100);
    const text = Array.from({ length: 60 }, () => word).join(" "); // spaces only
    const chunks = chunkMessage(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4000);
      // No chunk starts or ends mid-word (each boundary was a space).
      expect(c.startsWith("w")).toBe(true);
      expect(c.endsWith("w")).toBe(true);
    }
    expect(chunks.join(" ")).toBe(text);
  });

  it("keeps an empty string as one empty chunk", () => {
    expect(chunkMessage("")).toEqual([""]);
  });
});
