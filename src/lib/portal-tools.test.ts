import { describe, expect, it } from "vitest";
import { tools } from "@/lib/portal-tools";

// The Telegram bot's tool surface. This list is the contract: a refactor that
// drops, renames, or duplicates a tool must fail here, not in production.
const EXPECTED_TOOL_NAMES = [
  "add_charge",
  "add_cleaner",
  "add_profitability_line_item",
  "add_tenant",
  "assign_cleaner",
  "cancel_move_out",
  "delete_cleaning_record",
  "dismiss_moved_out_balance",
  "email_inventory_sheet",
  "end_tenancy",
  "get_collection_summary",
  "get_credentials",
  "get_lease_url",
  "get_monthly_collections",
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
  "record_payment",
  "resolve_property_address",
  "send_agreement",
  "send_balance_reminders",
  "set_cleaner_enabled",
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
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    expect(new Set(names).size).toBe(EXPECTED_TOOL_NAMES.length);
  });
});
