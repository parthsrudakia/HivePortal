import { describe, expect, it } from "vitest";
import { parseOptStatus, toE164 } from "@/lib/sms";

describe("toE164", () => {
  it.each([
    ["(609) 554-9141", "+16095549141"],
    ["573-576-1646", "+15735761646"],
    ["‭+1 (551) 226-2418‬", "+15512262418"],
    ["16095549141", "+16095549141"],
  ])("normalizes %s", (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });

  it("skips non-+1 and malformed numbers", () => {
    expect(toE164("+91 90822 84744")).toBeNull();
    expect(toE164("351911559455")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
  });
});

describe("parseOptStatus", () => {
  const payload = {
    phone_number_campaign_opt_statuses: [
      {
        consumer_phone_number: "+16095549141",
        zoom_phone_user_number: "+13322460817",
        opt_status: "opt_in",
      },
      {
        consumer_phone_number: "+16095549141",
        zoom_phone_user_number: "+13477081889",
        opt_status: "opt_out",
      },
    ],
  };

  it("matches the sender/recipient pair regardless of formatting", () => {
    expect(parseOptStatus(payload, "13322460817", "+1 609-554-9141")).toBe("opt_in");
    expect(parseOptStatus(payload, "+13477081889", "6095549141")).toBe("opt_out");
  });

  it("returns null when the pair is missing", () => {
    expect(parseOptStatus(payload, "+13322460817", "+12125550123")).toBeNull();
    expect(parseOptStatus({}, "+13322460817", "+16095549141")).toBeNull();
  });
});
