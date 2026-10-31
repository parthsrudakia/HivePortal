import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayISO } from "./date";

const mocks = vi.hoisted(() => ({
  gmail: vi.fn(),
  outlook: vi.fn(),
  admin: null as unknown,
}));
vi.mock("./google-mail", () => ({ checkGmailAuth: mocks.gmail }));
vi.mock("./graph-mail", () => ({ checkOutlookSendAuth: mocks.outlook }));
vi.mock("./access", () => ({ isMaster: (email: string) => email === "boss@example.com" }));
// The send-path reporter builds its own service-role client.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => mocks.admin }));

type Row = {
  id: string;
  user_id: string;
  message: string;
  show_after: string | null;
  created_by: string | null;
  dismissed_at: string | null;
};

// In-memory login_reminders with just the query surface the module uses.
function fakeAdmin() {
  const rows: Row[] = [];
  const query = (run: (matched: Row[]) => Row[]) => {
    const filters: ((r: Row) => boolean)[] = [];
    const q = {
      eq(col: keyof Row, v: unknown) {
        filters.push((r) => r[col] === v);
        return q;
      },
      is(col: keyof Row, v: null) {
        filters.push((r) => r[col] === v);
        return q;
      },
      in(col: keyof Row, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]));
        return q;
      },
      select() {
        return q;
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: run(rows.filter((r) => filters.every((f) => f(r)))), error: null });
      },
    };
    return q;
  };
  return {
    rows,
    open: (createdBy: string) =>
      rows.filter((r) => r.created_by === createdBy && r.dismissed_at === null),
    auth: {
      admin: {
        listUsers: async () => ({
          data: {
            users: [
              { id: "u-boss", email: "boss@example.com" },
              { id: "u-staff", email: "staff@example.com" },
            ],
          },
          error: null,
        }),
      },
    },
    from(table: string) {
      expect(table).toBe("login_reminders");
      return {
        select: () => query((m) => m),
        update: (patch: Partial<Row>) =>
          query((m) => m.map((r) => Object.assign(r, patch))),
        insert: async (input: Omit<Row, "id" | "dismissed_at">[]) => {
          for (const r of input) rows.push({ id: `r${rows.length + 1}`, dismissed_at: null, ...r });
          return { error: null };
        },
      };
    },
  };
}

const PASS = { configured: true, ok: true };
const GMAIL_DOWN = {
  configured: true,
  ok: false,
  error: "Invalid login: 535-5.7.8 Username and Password not accepted.",
};

let admin: ReturnType<typeof fakeAdmin>;
let health: typeof import("./mailbox-health");

// Lets the recheck pauses run, then returns the result.
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}
const run = () => settle(health.runMailboxHealthCheck(admin as never));
const report = (channel: "gmail" | "outlook") =>
  settle(health.reportMailboxAuthFailure(channel));

beforeEach(async () => {
  vi.useFakeTimers();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  mocks.gmail.mockReset().mockResolvedValue(PASS);
  mocks.outlook.mockReset().mockResolvedValue(PASS);
  admin = fakeAdmin();
  mocks.admin = admin;
  // Fresh module per test: the 10-minute limit is module state.
  vi.resetModules();
  health = await import("./mailbox-health");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runMailboxHealthCheck", () => {
  it("creates one reminder per master user when a mailbox can't connect", async () => {
    mocks.gmail.mockResolvedValue(GMAIL_DOWN);
    const result = await run();

    expect(result).toEqual({
      gmail: { connected: false, error: GMAIL_DOWN.error, created: 1 },
      outlook: { connected: true, cleared: 0 },
    });
    expect(mocks.gmail).toHaveBeenCalledTimes(2); // failed, then confirmed
    expect(admin.rows).toEqual([
      {
        id: "r1",
        user_id: "u-boss",
        message:
          "The NY Gmail account isn't connected (Google is rejecting its app password), so NY agreements and reminders aren't going out. Ask Parth or Amir to reconnect it. [Invalid login: 535-5.7.8 Username and Password not accepted.]",
        show_after: todayISO(),
        created_by: "mailbox-check:gmail",
        dismissed_at: null,
      },
    ]);
  });

  it("counts an unconfigured mailbox as not connected", async () => {
    mocks.outlook.mockResolvedValue({ configured: false, ok: false });
    const result = await run();

    expect(result.outlook).toEqual({ connected: false, error: "not configured", created: 1 });
    expect(admin.open("mailbox-check:outlook")[0].message).toMatch(
      /^The Outlook work mailbox isn't connected .* \[not configured\]$/,
    );
  });

  it("doesn't duplicate the reminder on repeated failures", async () => {
    mocks.gmail.mockResolvedValue(GMAIL_DOWN);
    await run();
    const again = await run();
    await report("gmail");

    expect(again.gmail).toMatchObject({ connected: false, created: 0 });
    expect(admin.rows).toHaveLength(1);
  });

  it("dismisses the reminder by itself once the mailbox connects again", async () => {
    mocks.gmail.mockResolvedValue(GMAIL_DOWN);
    mocks.outlook.mockResolvedValue({ configured: true, ok: false, error: "invalid_grant" });
    await run();
    expect(admin.rows).toHaveLength(2);

    mocks.gmail.mockResolvedValue(PASS);
    const result = await run();

    expect(result.gmail).toEqual({ connected: true, cleared: 1 });
    expect(admin.open("mailbox-check:gmail")).toHaveLength(0);
    expect(admin.open("mailbox-check:outlook")).toHaveLength(1); // still down
  });

  it("raises nothing when a failed check passes on the recheck", async () => {
    mocks.gmail.mockResolvedValueOnce(GMAIL_DOWN).mockResolvedValue(PASS);
    const result = await run();

    expect(result.gmail).toEqual({ connected: true, cleared: 0 });
    expect(admin.rows).toHaveLength(0);
  });
});

describe("reportMailboxAuthFailure", () => {
  it("creates the reminder when the recheck also fails", async () => {
    mocks.gmail.mockResolvedValue(GMAIL_DOWN);
    await report("gmail");

    expect(mocks.gmail).toHaveBeenCalledTimes(1);
    expect(admin.open("mailbox-check:gmail")).toHaveLength(1);
  });

  it("creates no reminder when the recheck passes", async () => {
    await report("gmail");

    expect(mocks.gmail).toHaveBeenCalledTimes(1);
    expect(admin.rows).toHaveLength(0);
  });

  it("rechecks each mailbox at most once per 10 minutes", async () => {
    mocks.gmail.mockResolvedValue(GMAIL_DOWN);
    await report("gmail");
    await report("gmail");
    await report("outlook"); // its own limit
    expect(mocks.gmail).toHaveBeenCalledTimes(1);
    expect(mocks.outlook).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(9 * 60_000);
    await report("gmail");
    expect(mocks.gmail).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await report("gmail");
    expect(mocks.gmail).toHaveBeenCalledTimes(2);
    expect(admin.rows).toHaveLength(1);
  });

  it("never throws, even when the check and the database both blow up", async () => {
    mocks.outlook.mockRejectedValue(new Error("network down"));
    await expect(report("outlook")).resolves.toBeUndefined();

    mocks.gmail.mockResolvedValue(GMAIL_DOWN);
    mocks.admin = {
      auth: { admin: { listUsers: () => Promise.reject(new Error("db down")) } },
      from: () => {
        throw new Error("db down");
      },
    };
    await expect(report("gmail")).resolves.toBeUndefined();
  });
});
