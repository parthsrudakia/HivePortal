import { describe, expect, it } from "vitest";
import {
  formatChangeNotice,
  formatNag,
  inNagWindow,
  isConfirmation,
  mention,
  pendingFor,
  resolvePosters,
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
  poster_names: [],
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
        '👉 @gian <a href="tg://user?id=200">Grace</a> — react or reply “done” once your ads are updated.',
    );
  });
  it("still asks for a reaction when nobody is known yet", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(formatChangeNotice([])).toBe(
      "📋 <b>Inventory updated</b>\nCheck the portal for what changed and update your ads to match.\n\n" +
        "👉 React or reply “done” once your ads are updated.",
    );
  });
});

describe("resolvePosters", () => {
  const gianV = member({ id: 1, user_id: 100, username: "gian", poster_names: ["Gian V"] });
  const graceC = member({ id: 2, user_id: 200, first_name: "Grace", poster_names: ["Mary Grace Consuelo"] });
  const none = new Set<number>();

  it("asks only the people whose portal name is on an affected ad", () => {
    expect(resolvePosters(["gian v ", "Gian V"], [gianV, graceC], none)).toEqual({
      asked: [gianV],
      others: [],
    });
  });

  it("names a poster nobody is linked to instead of guessing", () => {
    expect(resolvePosters(["Gian V", "Shanewaz Pranty", null], [gianV, graceC], none)).toEqual({
      asked: [gianV],
      others: ["Shanewaz Pranty", "someone not recorded"],
    });
  });

  it("never asks an admin, someone off the list or someone who left", () => {
    const off = member({ id: 3, user_id: 300, remind: false, poster_names: ["Off List"] });
    const left = member({ id: 4, user_id: 400, active: false, poster_names: ["Left Group"] });
    expect(
      resolvePosters(["Gian V", "Off List", "Left Group"], [gianV, off, left], new Set([100])),
    ).toEqual({ asked: [], others: ["Gian V", "Off List", "Left Group"] });
  });
});

describe("formatChangeNotice with untaggable posters", () => {
  it("names them after the tagged people", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(formatChangeNotice([gian], ["Shanewaz <P>"])).toBe(
      "📋 <b>Inventory updated</b>\nCheck the portal for what changed and update your ads to match.\n\n" +
        "👉 @gian — react or reply “done” once your ads are updated.\n" +
        "Also affected: ads posted by Shanewaz &lt;P&gt;.",
    );
  });
  it("asks nobody to confirm when no poster can be tagged", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(formatChangeNotice([], ["Shanewaz Pranty", "Parth"])).toBe(
      "📋 <b>Inventory updated</b>\nCheck the portal for what changed and update your ads to match.\n\n" +
        "Affected: ads posted by Shanewaz Pranty, Parth.",
    );
  });
});

describe("pendingFor", () => {
  it("waits only on the people a change was assigned to", () => {
    const t = { id: 7, created_at: "2026-11-18T15:00:00.000Z" };
    expect(pendingFor({ ...t, assignee_ids: [2] }, [gian, grace, mary], new Set())).toEqual([grace]);
    expect(pendingFor({ ...t, assignee_ids: [] }, [gian, grace], new Set())).toEqual([]);
    expect(pendingFor({ ...t, assignee_ids: null }, [gian, grace], new Set())).toEqual([gian, grace]);
  });

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
      { id: 1, kind: "inventory", lines: [], created_at: "", pending: [grace] },
      { id: 2, kind: "inventory", lines: [], created_at: "", pending: [grace, mary] },
    ]);
    expect(text).toBe(
      "🔔 <b>Reminder</b>\n2 inventory changes still need your ads updated. " +
        "Check the portal for what changed and update your ads to match.\n\n" +
        '👉 <a href="tg://user?id=200">Grace</a> @mary_h — react or reply “done” once done.',
    );
  });

  it("speaks of a single change in the singular", () => {
    const text = formatNag([{ id: 1, kind: "inventory", lines: [], created_at: "", pending: [gian] }]);
    expect(text).toContain("An inventory change still needs your ads updated.");
    expect(text).toContain("👉 @gian — react or reply “done” once done.");
  });
});

describe("formatNag with scheduled reminders", () => {
  it("repeats a reminder's own text and bullets it alongside inventory changes", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const text = formatNag([
      { id: 1, kind: "inventory", lines: [], created_at: "", pending: [grace] },
      { id: 2, kind: "reminder", lines: ["Refresh the FB &amp; Zillow listings"], created_at: "", pending: [mary] },
    ]);
    expect(text).toBe(
      "🔔 <b>Reminder</b>\n" +
        "• An inventory change still needs your ads updated. Check the portal for what changed and update your ads to match.\n" +
        "• “Refresh the FB &amp; Zillow listings”\n\n" +
        '👉 <a href="tg://user?id=200">Grace</a> @mary_h — react or reply “done” once done.',
    );
  });

  it("shows a lone reminder without a bullet", () => {
    const text = formatNag([
      { id: 3, kind: "reminder", lines: ["Post the weekend open house"], created_at: "", pending: [gian] },
    ]);
    expect(text).toBe(
      "🔔 <b>Reminder</b>\n“Post the weekend open house”\n\n👉 @gian — react or reply “done” once done.",
    );
  });
});

describe("isConfirmation", () => {
  it.each([
    "done",
    "Done ✅",
    "ads updated",
    "Updated the ads",
    "I changed the price on FB",
    "took them down",
    "all set!",
    "✅",
    "👍",
    "Posted the new listing",
  ])("counts %j", (t) => expect(isConfirmation(t)).toBe(true));

  it.each([
    "not done yet",
    "haven't updated it",
    "will update later",
    "which room changed?",
    "done?",
    "need to update the ads",
    "can you check if it's posted",
    "on it",
    "ok",
    "/help",
    "",
  ])("ignores %j", (t) => expect(isConfirmation(t)).toBe(false));
});
