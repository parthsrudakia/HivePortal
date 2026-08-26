import { describe, expect, it } from "vitest";
import { planSupersessions, samePerson, type DedupeRow } from "./agreement-dedupe";

let n = 0;
function row(overrides: Partial<DedupeRow>): DedupeRow {
  return {
    id: `id-${++n}`,
    status: "pending",
    tenant_name: "Test Person",
    recipient_email: "test@example.com",
    sent_at: "2026-08-01T12:00:00Z",
    signed_at: null,
    assigned_tenancy_id: null,
    unsigned_pdf_path: null,
    signed_pdf_path: null,
    ...overrides,
  };
}

function signedRow(overrides: Partial<DedupeRow>): DedupeRow {
  return row({
    status: "signed",
    signed_at: "2026-08-01T13:00:00Z",
    signed_pdf_path: "signed.pdf",
    ...overrides,
  });
}

describe("samePerson", () => {
  it("matches on email regardless of name, case-insensitively", () => {
    expect(
      samePerson(
        row({ tenant_name: "A B", recipient_email: "X@Gmail.com" }),
        row({ tenant_name: "C D", recipient_email: "x@gmail.com" }),
      ),
    ).toBe(true);
  });

  it("matches a name that is a subset of a longer name", () => {
    expect(
      samePerson(
        row({ tenant_name: "Ralph Rivas", recipient_email: "a@a.com" }),
        row({ tenant_name: "Ralph Martin Rivas", recipient_email: "b@b.com" }),
      ),
    ).toBe(true);
  });

  it("matches small typos and ignores diacritics", () => {
    expect(
      samePerson(
        row({ tenant_name: "Leonardo Matías Chavarry", recipient_email: "a@a.com" }),
        row({ tenant_name: "Leonardo Matias Chavary", recipient_email: "b@b.com" }),
      ),
    ).toBe(true);
  });

  it("does not match different people", () => {
    expect(
      samePerson(
        row({ tenant_name: "Karthik Vinod", recipient_email: "a@a.com" }),
        row({ tenant_name: "Tanvi Mahadik", recipient_email: "b@b.com" }),
      ),
    ).toBe(false);
  });

  it("does not treat a shared single token as the same person", () => {
    expect(
      samePerson(
        row({ tenant_name: "Simran Kadam", recipient_email: "a@a.com" }),
        row({ tenant_name: "Simran Patel", recipient_email: "b@b.com" }),
      ),
    ).toBe(false);
  });
});

describe("planSupersessions", () => {
  it("deletes the older pending duplicate within 15 days, keeps the newest", () => {
    const oldRow = row({ sent_at: "2026-07-27T00:00:00Z" });
    const newRow = row({ sent_at: "2026-08-09T00:00:00Z" });
    const plan = planSupersessions([oldRow, newRow]);
    expect(plan).toEqual([
      {
        id: oldRow.id,
        tenantName: oldRow.tenant_name,
        keptId: newRow.id,
        reassignTenancyId: null,
      },
    ]);
  });

  it("keeps both when the sends are more than 15 days apart", () => {
    const plan = planSupersessions([
      row({ sent_at: "2026-06-01T00:00:00Z" }),
      row({ sent_at: "2026-08-09T00:00:00Z" }),
    ]);
    expect(plan).toEqual([]);
  });

  it("a newer signed copy supersedes an older signed+assigned one and takes over its tenancy", () => {
    const older = signedRow({
      sent_at: "2026-08-17T03:21:00Z",
      assigned_tenancy_id: "t-1",
    });
    const newer = signedRow({ sent_at: "2026-08-17T19:21:00Z" });
    const plan = planSupersessions([older, newer]);
    expect(plan).toEqual([
      {
        id: older.id,
        tenantName: older.tenant_name,
        keptId: newer.id,
        reassignTenancyId: "t-1",
      },
    ]);
  });

  it("a pending resend never supersedes an older signed copy", () => {
    const signed = signedRow({ sent_at: "2026-07-30T01:57:00Z" });
    const dupe = row({ sent_at: "2026-07-30T02:16:00Z" });
    expect(planSupersessions([signed, dupe])).toEqual([]);
  });

  it("collapses a cluster to the newest signed winner", () => {
    const a = row({ sent_at: "2026-07-22T00:00:00Z" });
    const b = row({ sent_at: "2026-07-25T04:00:00Z" });
    const signed = signedRow({ sent_at: "2026-07-25T14:00:00Z" });
    const plan = planSupersessions([a, b, signed]);
    expect(plan.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(plan.every((p) => p.keptId === signed.id)).toBe(true);
  });

  it("cleans up already-dismissed duplicates but never keeps them as winners", () => {
    const dismissed = row({
      status: "dismissed",
      sent_at: "2026-08-09T00:00:00Z",
    });
    const older = row({ sent_at: "2026-08-01T00:00:00Z" });
    const plan = planSupersessions([older, dismissed]);
    // The dismissed newest is not a keeper, so the older pending survives;
    // the dismissed row itself has no newer keeper and just stays.
    expect(plan).toEqual([]);

    const newest = row({ sent_at: "2026-08-10T00:00:00Z" });
    const plan2 = planSupersessions([older, dismissed, newest]);
    expect(plan2.map((p) => p.id).sort()).toEqual(
      [older.id, dismissed.id].sort(),
    );
  });

  it("reassigns at most one tenancy per winner", () => {
    const winner = signedRow({ sent_at: "2026-08-10T00:00:00Z" });
    const first = signedRow({
      sent_at: "2026-08-09T00:00:00Z",
      assigned_tenancy_id: "t-1",
    });
    const second = signedRow({
      sent_at: "2026-08-08T00:00:00Z",
      assigned_tenancy_id: "t-2",
    });
    const plan = planSupersessions([winner, first, second]);
    const takeovers = plan.filter((p) => p.reassignTenancyId !== null);
    expect(takeovers).toHaveLength(1);
    expect(takeovers[0].reassignTenancyId).toBe("t-1");
  });

  it("leaves unrelated people alone", () => {
    const plan = planSupersessions([
      row({ tenant_name: "Karthik Vinod", recipient_email: "k@x.com" }),
      row({ tenant_name: "Tanvi Mahadik", recipient_email: "t@x.com" }),
    ]);
    expect(plan).toEqual([]);
  });
});
