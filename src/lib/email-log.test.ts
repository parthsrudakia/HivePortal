import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: db.insert }) }),
}));

import { logEmail } from "./email-log";

const base = { type: "rent_balance" as const, recipient: "tenant@example.com", subject: "Rent" };
const row = () => db.insert.mock.calls[0][0];

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  db.insert.mockReset();
});

describe("logEmail attempts note", () => {
  it("adds it to the error of a failed send that took retries", async () => {
    await logEmail({ ...base, status: "failed", error: "Timeout", context: "Oct", attempts: 3 });
    expect(row()).toMatchObject({ error: "Timeout (after 3 attempts)", context: "Oct" });
  });

  it("adds it to the context of a sent email that took retries", async () => {
    await logEmail({ ...base, status: "sent", context: "Oct · outlook", attempts: 2 });
    expect(row()).toMatchObject({ error: null, context: "Oct · outlook (after 2 attempts)" });
  });

  it("stands alone when a retried send had no context", async () => {
    await logEmail({ ...base, status: "sent", attempts: 2 });
    expect(row()).toMatchObject({ context: "(after 2 attempts)" });
  });

  it("leaves first-try sends unchanged", async () => {
    await logEmail({ ...base, status: "failed", error: "Bad address", context: "Oct", attempts: 1 });
    expect(row()).toMatchObject({ error: "Bad address", context: "Oct" });
  });
});
