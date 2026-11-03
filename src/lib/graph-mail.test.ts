import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retry = vi.hoisted(() => ({ waits: [] as number[] }));

// Same retry decisions, minus the real waits and the shared budget.
vi.mock("./send-retry", async (importOriginal) => {
  const real = await importOriginal<typeof import("./send-retry")>();
  return {
    ...real,
    withSendRetry: <T>(fn: () => Promise<T>, opts: Parameters<typeof real.withSendRetry>[1]) =>
      real.withSendRetry(fn, {
        ...opts,
        budget: { reserve: () => true },
        sleep: async (ms) => {
          retry.waits.push(ms);
        },
      }),
  };
});

import { sendOutlookMessage } from "./graph-mail";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Scripted mailbox: each POST /send takes the next reply. */
let mailbox: {
  sendReplies: Array<() => Response>;
  sends: number;
  /** What the pre-resend check sees. */
  stillDraft: boolean;
  /** Whether the message shows up in Sent Items when verified. */
  delivered: boolean;
  deleted: boolean;
};

beforeEach(() => {
  process.env.MS_CLIENT_ID = "client";
  process.env.MS_CLIENT_SECRET = "secret";
  process.env.MS_TENANT_ID = "tenant";
  process.env.MS_REFRESH_TOKEN = "refresh";
  retry.waits = [];
  mailbox = { sendReplies: [], sends: 0, stillDraft: true, delivered: true, deleted: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("login.microsoftonline.com")) return json({ access_token: "token" });
      if (method === "POST" && url.endsWith("/me/messages")) {
        return json({ id: "draft-1", internetMessageId: "<m1@example.com>" }, 201);
      }
      if (url.endsWith("/mailFolders/sentitems?$select=id")) return json({ id: "sent-items" });
      if (method === "POST" && url.endsWith("/draft-1/send")) {
        mailbox.sends++;
        const reply = mailbox.sendReplies.shift();
        if (!reply) throw new Error("unexpected extra send");
        return reply();
      }
      if (method === "DELETE") {
        mailbox.deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/draft-1?$select=isDraft")) return json({ isDraft: mailbox.stillDraft });
      if (url.includes("/draft-1?$select=id,isDraft,parentFolderId")) {
        return json(
          mailbox.delivered
            ? { id: "draft-1", isDraft: false, parentFolderId: "sent-items", internetMessageId: "<m1@example.com>" }
            : { id: "draft-1", isDraft: true, parentFolderId: "drafts" },
        );
      }
      if (url.includes("/sentitems/messages?")) return json({ value: [] });
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const accepted = () => new Response(null, { status: 202 });
const send = () =>
  sendOutlookMessage({ to: "tenant@example.com", subject: "Rent", text: "Hi", html: "<p>Hi</p>" });

describe("sendOutlookMessage retries", () => {
  it("retries a 503 while the message is still a draft, honouring Retry-After up to 8s", async () => {
    mailbox.sendReplies = [
      () => new Response("busy", { status: 503, headers: { "retry-after": "30" } }),
      accepted,
    ];
    const r = await send();
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(mailbox.sends).toBe(2);
    expect(retry.waits).toEqual([8_000]);
  });

  it("retries a network error while the message is still a draft", async () => {
    mailbox.sendReplies = [
      () => {
        throw new TypeError("fetch failed");
      },
      accepted,
    ];
    const r = await send();
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(mailbox.sends).toBe(2);
  });

  it("retries a 429 without the draft check (Graph didn't process it)", async () => {
    mailbox.stillDraft = false;
    mailbox.sendReplies = [() => new Response("slow down", { status: 429 }), accepted];
    const r = await send();
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(mailbox.sends).toBe(2);
    expect(retry.waits).toEqual([2_000]);
  });

  it("does not resend after a 5xx once the message has left Drafts", async () => {
    mailbox.stillDraft = false;
    mailbox.sendReplies = [() => new Response("oops", { status: 500 }), accepted];
    const r = await send();
    // Verification finds it in Sent Items: it did go out, exactly once.
    expect(r).toMatchObject({ ok: true, attempts: 1 });
    expect(mailbox.sends).toBe(1);
  });

  it("does not retry a 4xx rejection, and removes the draft", async () => {
    mailbox.sendReplies = [() => new Response("bad request", { status: 400 })];
    const r = await send();
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(mailbox.sends).toBe(1);
    expect(mailbox.deleted).toBe(true);
  });

  it("never resends after Graph accepted the send, even if verification can't find it", async () => {
    vi.useFakeTimers(); // skip the ~13s Sent Items polling
    mailbox.delivered = false;
    mailbox.sendReplies = [accepted];
    const pending = send();
    await vi.runAllTimersAsync();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(mailbox.sends).toBe(1);
  });
});
