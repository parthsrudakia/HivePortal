import { describe, expect, it } from "vitest";
import { tools } from "@/lib/portal-tools";
import { createProperty } from "@/lib/portal-tools/properties";

// The Telegram bot's tool surface. This list is the contract: a refactor that
// drops, renames, or duplicates a tool must fail here, not in production.
const EXPECTED_TOOL_NAMES = [
  "add_charge",
  "add_cleaner",
  "add_profitability_line_item",
  "add_tenant",
  "assign_cleaner",
  "cancel_move_out",
  "check_text_opt_status",
  "create_property",
  "delete_cleaning_record",
  "dismiss_moved_out_balance",
  "email_inventory_sheet",
  "end_tenancy",
  "get_collection_summary",
  "get_credentials",
  "get_lease_url",
  "get_monthly_collections",
  "get_portal_guide",
  "get_profitability",
  "get_property",
  "get_property_collections",
  "get_utility_bills",
  "get_utility_statement_url",
  "list_active_tenants",
  "list_cleaners",
  "list_cleanings",
  "list_inventory",
  "list_moved_out_balances",
  "list_overdue_cleanings",
  "list_properties",
  "log_cleaning",
  "query_database",
  "record_payment",
  "resolve_property_address",
  "send_agreement",
  "send_balance_reminders",
  "send_text",
  "set_cleaner_enabled",
  "set_facebook_ads",
  "set_listing_action",
  "set_room_status",
  "settle_moved_out_balance",
  "share_inventory_sheet",
  "update_cleaning_record",
  "update_room_rent",
  "update_tenancy",
  "update_tenant",
];

describe("portal tools", () => {
  it("exposes exactly the expected tool set, with unique names", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(new Set(names).size).toBe(EXPECTED_TOOL_NAMES.length);
  });
});

describe("create_property validation", () => {
  const valid = {
    building_name: "MetroVue",
    street_address: "90 Washington St",
    unit_number: "24M",
    cross_street: "Washington & Wall",
    neighborhood: "JSQ",
    is_new_york: false,
    bedrooms: 3,
    bathrooms: 1.5,
  };

  it.each([
    ["building_name", "", /Building name/],
    ["street_address", " ", /Street address/],
    ["unit_number", "", /Unit number/],
    ["cross_street", "", /Cross street/],
    ["neighborhood", "", /Neighborhood/],
    ["bedrooms", 0, /Bedrooms/],
    ["bedrooms", 2.5, /Bedrooms/],
    ["bathrooms", 0, /Bathrooms/],
  ] as const)("rejects a missing/invalid %s", async (field, value, msg) => {
    await expect(
      createProperty({ ...valid, [field]: value }),
    ).rejects.toThrow(msg);
  });

  it("requires the New York flag", async () => {
    await expect(
      createProperty({ ...valid, is_new_york: undefined as unknown as boolean }),
    ).rejects.toThrow(/New York/);
  });

  it("rejects bad optional values before touching the database", async () => {
    await expect(
      createProperty({ ...valid, unit_rent: -1 }),
    ).rejects.toThrow(/unit rent/);
    await expect(
      createProperty({ ...valid, unit_lease_start: "2026-10-01", unit_lease_end: "2026-09-01" }),
    ).rejects.toThrow(/before the start/);
    await expect(
      createProperty({ ...valid, unit_lease_end: "next year" }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      createProperty({ ...valid, unit_amenities: ["Hot Tub"] }),
    ).rejects.toThrow(/Unknown amenities: Hot Tub/);
  });
});
