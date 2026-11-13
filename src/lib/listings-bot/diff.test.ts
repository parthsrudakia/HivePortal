import { describe, expect, it } from "vitest";
import {
  describeChanges,
  diffInventory,
  formatDiffMessage,
  formatOpenActions,
  isEmptyDiff,
  type InvRoom,
} from "./diff";

function room(over: Partial<InvRoom> = {}): InvRoom {
  return {
    id: "room-1",
    unit: "12 Example St Apt 3A",
    building_name: null,
    street_address: "12 Example St",
    unit_number: "3A",
    neighborhood: "Journal Square",
    room_number: "2",
    status: "available",
    available_from: null,
    rent: { base: 1300, services: 150, total: 1450 },
    amenities: {
      has_private_bathroom: false,
      has_ac: true,
      unit: ["Dishwasher"],
      building: ["Elevator"],
    },
    photos_url: "https://example.com/photos",
    marketing_description: "Sunny room",
    facebook_ads: false,
    listing_action: "no_action",
    ...over,
  };
}

const asMap = (rooms: InvRoom[]) => new Map(rooms.map((r) => [r.id, r]));

describe("diffInventory", () => {
  it("reports nothing when nothing changed", () => {
    expect(isEmptyDiff(diffInventory(asMap([room()]), [room()]))).toBe(true);
  });

  it("separates new, changed and removed rooms", () => {
    const d = diffInventory(asMap([room(), room({ id: "gone" })]), [
      room({ rent: { base: 1350, services: 150, total: 1500 } }),
      room({ id: "new" }),
    ]);
    expect(d.added.map((r) => r.id)).toEqual(["new"]);
    expect(d.removed.map((r) => r.id)).toEqual(["gone"]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].changes).toEqual([
      "Total rent: $1,450 → <b>$1,500</b>",
      "Base rent: $1,300 → <b>$1,350</b>",
    ]);
  });
});

describe("describeChanges", () => {
  it("covers every listing-relevant field", () => {
    const lines = describeChanges(
      room(),
      room({
        status: "occupied",
        available_from: "2026-12-15",
        amenities: {
          has_private_bathroom: true,
          has_ac: true,
          unit: ["Dishwasher", "Washer"],
          building: [],
        },
        photos_url: null,
        marketing_description: "Bright & <big> room",
        facebook_ads: true,
        listing_action: "update_price_or_date",
      }),
    );
    expect(lines).toEqual([
      "Status: Available → <b>Occupied</b>",
      "Available from: Now → <b>Dec 15, 2026</b>",
      "Private bathroom: No → <b>Yes</b>",
      "Unit amenities: added Washer",
      "Building amenities: removed Elevator",
      "Photos link removed",
      "Description updated:\n<blockquote>Bright &amp; &lt;big&gt; room</blockquote>",
      "Facebook ads: Off → <b>On</b>",
      "Listing action: No action → <b>Update price/date</b>",
    ]);
  });

  it("ignores amenity reordering", () => {
    const a = room({
      amenities: { has_private_bathroom: false, has_ac: true, unit: ["A", "B"], building: [] },
    });
    const b = room({
      amenities: { has_private_bathroom: false, has_ac: true, unit: ["B", "A"], building: [] },
    });
    expect(describeChanges(a, b)).toEqual([]);
  });
});

describe("formatDiffMessage", () => {
  it("tells the team what to do for each kind of change", () => {
    const d = diffInventory(asMap([room(), room({ id: "gone", room_number: "4" })]), [
      room({ available_from: "2026-12-01" }),
      room({ id: "new", room_number: "1", listing_action: "priority" }),
    ]);
    const text = formatDiffMessage(d, new Map([["gone", "It is now occupied."]]));
    expect(text).toContain("🆕 <b>New in inventory — 12 Example St Apt 3A · Room 1</b>");
    expect(text).toContain("$1,450/mo · available Now · Journal Square");
    expect(text).toContain("Flagged: <b>Priority listing</b>");
    expect(text).toContain("→ Please post a listing for it.");
    expect(text).toContain("✏️ <b>Updated — 12 Example St Apt 3A · Room 2</b>");
    expect(text).toContain("• Available from: Now → <b>Dec 1, 2026</b>");
    expect(text).toContain("❌ <b>Out of inventory — 12 Example St Apt 3A · Room 4</b>\nIt is now occupied.");
    expect(text).toContain("→ Please take its listing ads down.");
  });
});

describe("formatOpenActions", () => {
  it("lists only flagged rooms", () => {
    expect(formatOpenActions([room()])).toBe("No rooms are flagged for a listing action.");
    expect(formatOpenActions([room(), room({ id: "b", room_number: "3", listing_action: "boost_post" })])).toBe(
      "<b>Rooms flagged for a listing action:</b>\n• 12 Example St Apt 3A · Room 3 — Boost post",
    );
  });
});
