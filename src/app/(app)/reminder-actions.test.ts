import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as { id: string; user_id: string; created_by: string | null; dismissed_at: string | null }[],
  updates: [] as string[][],
}));

// Just the two login_reminders queries the action makes.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        in: (_col: string, ids: string[]) => ({
          eq: async (_c: string, userId: string) => ({
            data: mocks.rows.filter((r) => ids.includes(r.id) && r.user_id === userId),
            error: null,
          }),
        }),
      }),
      update: (patch: { dismissed_at: string }) => ({
        in: (_col: string, ids: string[]) => ({
          eq: async (_c: string, userId: string) => {
            mocks.updates.push(ids);
            for (const r of mocks.rows) {
              if (ids.includes(r.id) && r.user_id === userId) r.dismissed_at = patch.dismissed_at;
            }
            return { error: null };
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/session", () => ({ getSessionUser: async () => ({ id: "u-boss" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { dismissLoginReminders } from "./reminder-actions";

const MOVE_OUT = "11111111-1111-4111-8111-111111111111";
const GMAIL = "22222222-2222-4222-8222-222222222222";
const OUTLOOK = "33333333-3333-4333-8333-333333333333";
const dismissed = (id: string) => mocks.rows.find((r) => r.id === id)?.dismissed_at ?? null;

beforeEach(() => {
  mocks.updates = [];
  mocks.rows = [
    { id: MOVE_OUT, user_id: "u-boss", created_by: "telegram", dismissed_at: null },
    { id: GMAIL, user_id: "u-boss", created_by: "mailbox-check:gmail", dismissed_at: null },
    { id: OUTLOOK, user_id: "u-boss", created_by: "mailbox-check:outlook", dismissed_at: null },
  ];
});

describe("dismissLoginReminders", () => {
  it("dismisses ordinary reminders as before", async () => {
    expect(await dismissLoginReminders([MOVE_OUT])).toBeUndefined();
    expect(dismissed(MOVE_OUT)).not.toBeNull();
  });

  it("leaves mailbox warnings in place when shown alongside other reminders", async () => {
    expect(await dismissLoginReminders([MOVE_OUT, GMAIL, OUTLOOK])).toBeUndefined();
    expect(mocks.updates).toEqual([[MOVE_OUT]]);
    expect(dismissed(MOVE_OUT)).not.toBeNull();
    expect(dismissed(GMAIL)).toBeNull();
    expect(dismissed(OUTLOOK)).toBeNull();
  });

  it("writes nothing when only mailbox warnings were shown", async () => {
    expect(await dismissLoginReminders([GMAIL])).toBeUndefined();
    expect(mocks.updates).toEqual([]);
    expect(dismissed(GMAIL)).toBeNull();
  });
});
