import { describe, expect, it } from "vitest";
import {
  formatChangeNotice,
  formatNag,
  inNagWindow,
  mention,
  pendingFor,
  type Member,
} from "./acks";

const iso = (d: Date) => d.toISOString();

const member = (over: Partial<Member>): Member => ({
  id: 1,
  user_id: 100,
  first_name: "Gian",
  last_name: null,
  username: null,
  remind: true,
  active: true,
  joined_at: null,
  ...over,
});

const gian = member({ id: 1, user_id: 100, first_name: "Gian", username: "gian" });
const grace = member({ id: 2, user_id: 200, first_name: "Grace" });
const mary = member({ id: 3, user_id: 300, first_name: "Mary", username: "mary_h" });

describe("inNagWindow (8 AM – 6 PM Eastern)", () => {
  it("keeps a time inside the window", () => {
    // 2:00 PM EST
    const at = new Date("2026-11-18T19:00:00Z");
    expect(iso(inNagWindow(at))).toBe(iso(at));
  });

  it("allows exactly 6:00 PM", () => {
    const at = new Date("2026-11-18T23:00:00Z");
    expect(iso(inNagWindow(at))).toBe(iso(at));
  });

  it("pushes an evening time to 8 AM the next day", () => {
    // 7:30 PM EST Nov 18 → 8:00 AM EST Nov 19
    expect(iso(inNagWindow(new Date("2026-11-19T00:30:00Z")))).toBe(
      "2026-11-19T13:00:00.000Z",
    );
  });

  it("pushes an early-morning time to 8 AM the same day", () => {
    // 4:00 AM EDT Jul 1 → 8:00 AM EDT
    expect(iso(inNagWindow(new Date("2026-07-01T08:00:00Z")))).toBe(
      "2026-07-01T12:00:00.000Z",
    );
  });
});

describe("mention", () => {
  it("uses @username when there is one, a tg:// link otherwise", () => {
    expect(mention(gian)).toBe("@gian");
    expect(mention(grace)).toBe('<a href="tg://user?id=200">Grace</a>');
  });
});

describe("formatChangeNotice", () => {
  it("only says the inventory changed, points to the portal and tags everyone", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://portal.example.com/";
    expect(formatChangeNotice([gian, grace])).toBe(
      "📋 <b>Inventory updated</b>\n" +
        'Check the <a href="https://portal.example.com/inventory">portal</a> for what changed and update your ads to match.\n\n' +
        '👉 @gian <a href="tg://user?id=200">Grace</a> — react to this message once your ads are updated.',
    );
  });
  it("still asks for a reaction when nobody is known yet", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(formatChangeNotice([])).toBe(
      "📋 <b>Inventory updated</b>\nCheck the portal for what changed and update your ads to match.\n\n" +
        "👉 React to this message once your ads are updated.",
    );
  });
});

describe("pendingFor", () => {
  it("keeps a listed teammate pending until their user id is known", () => {
    const listed = member({ id: 9, user_id: null, username: "graceconsuelo" });
    expect(pendingFor({ id: 7, created_at: "" }, [listed], new Set(["7:null"]))).toEqual([listed]);
  });

  const task = { id: 7, created_at: "2026-11-18T15:00:00.000Z" };

  it("drops people who reacted", () => {
    const acked = new Set(["7:100"]);
    expect(pendingFor(task, [gian, grace, mary], acked)).toEqual([grace, mary]);
  });

  it("skips people who joined after the change was posted", () => {
    const late = member({ user_id: 400, joined_at: "2026-11-18T16:00:00.000Z" });
    expect(pendingFor(task, [late, grace], new Set())).toEqual([grace]);
  });
});

describe("formatNag", () => {
  it("combines open changes into one line and tags only who is missing", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const text = formatNag([
      { id: 1, lines: [], created_at: "", pending: [grace] },
      { id: 2, lines: [], created_at: "", pending: [grace, mary] },
    ]);
    expect(text).toBe(
      "🔔 <b>Reminder</b>\n2 inventory changes still need your ads updated. " +
        "Check the portal for what changed and update your ads to match.\n\n" +
        '👉 <a href="tg://user?id=200">Grace</a> @mary_h — react here once done.',
    );
  });

  it("speaks of a single change in the singular", () => {
    const text = formatNag([{ id: 1, lines: [], created_at: "", pending: [gian] }]);
    expect(text).toContain("An inventory change still needs your ads updated.");
    expect(text).toContain("👉 @gian — react here once done.");
  });
});
