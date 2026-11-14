import { describe, expect, it } from "vitest";
import { pickTenancyForAgreement, type AttachCandidate } from "./agreement-attach";

function candidate(overrides: Partial<AttachCandidate>): AttachCandidate {
  return {
    id: "tenancy-1",
    tenant_id: "tenant-1",
    room_id: "room-a",
    property_id: "prop-1",
    matchedByEmail: true,
    ...overrides,
  };
}

describe("pickTenancyForAgreement", () => {
  it("picks the tenancy in the agreement's room", () => {
    const picked = pickTenancyForAgreement(
      { room_id: "room-a", property_id: "prop-1" },
      [candidate({}), candidate({ id: "tenancy-2", room_id: "room-b" })],
    );
    expect(picked?.id).toBe("tenancy-1");
  });

  it("attaches nothing when the tenant is in a different room (pending transfer)", () => {
    const picked = pickTenancyForAgreement(
      { room_id: "room-b", property_id: "prop-1" },
      [candidate({ room_id: "room-a" })],
    );
    expect(picked).toBeNull();
  });

  it("attaches nothing when two tenancies match the room", () => {
    const picked = pickTenancyForAgreement(
      { room_id: "room-a", property_id: "prop-1" },
      [candidate({}), candidate({ id: "tenancy-2" })],
    );
    expect(picked).toBeNull();
  });

  it("accepts a name-only match when the room matches", () => {
    const picked = pickTenancyForAgreement(
      { room_id: "room-a", property_id: "prop-1" },
      [candidate({ matchedByEmail: false })],
    );
    expect(picked?.id).toBe("tenancy-1");
  });

  it("falls back to the property for roomless requests, email matches only", () => {
    const request = { room_id: null, property_id: "prop-1" };
    expect(pickTenancyForAgreement(request, [candidate({})])?.id).toBe("tenancy-1");
    expect(
      pickTenancyForAgreement(request, [candidate({ matchedByEmail: false })]),
    ).toBeNull();
    expect(
      pickTenancyForAgreement(request, [candidate({ property_id: "prop-2" })]),
    ).toBeNull();
  });
});
