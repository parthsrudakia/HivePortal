import { describe, expect, it, vi } from "vitest";
import { createRetryFetch } from "./retry-fetch";

const ok = () => new Response("[]", { status: 200 });
const url = "https://db.example.com/rest/v1/payments";

describe("createRetryFetch", () => {
  it("retries a read whose connection failed, then returns the answer", async () => {
    const base = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok());
    const res = await createRetryFetch(base, [0, 0])(url);
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt and rethrows", async () => {
    const base = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(createRetryFetch(base, [0, 0])(url, { method: "GET" })).rejects.toThrow(
      /fetch failed/,
    );
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("never re-sends a write", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const base = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      await expect(createRetryFetch(base, [0, 0])(url, { method })).rejects.toThrow();
      expect(base).toHaveBeenCalledTimes(1);
    }
  });

  it("retries a gateway error on a read but not a real query error", async () => {
    const gateway = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(ok());
    expect((await createRetryFetch(gateway, [0, 0])(url)).status).toBe(200);
    expect(gateway).toHaveBeenCalledTimes(2);

    const broken = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    expect((await createRetryFetch(broken, [0, 0])(url)).status).toBe(500);
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("does not retry a request the caller aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const base = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(createRetryFetch(base, [0, 0])(url, { signal: ctl.signal })).rejects.toThrow();
    expect(base).toHaveBeenCalledTimes(1);
  });
});
