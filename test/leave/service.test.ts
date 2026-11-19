// Leave service tests (u4-leave): in-memory tables (emptied by test/setup.ts), a fixed `now`, and
// the real event hook with subscriptions cleared before each test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../src/shared/auth.js";
import { putItem } from "../../src/shared/db.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/shared/errors.js";
import {
  clearSubscriptions,
  subscribe,
  type LeaveApprovedPayload,
} from "../../src/shared/events.js";
import {
  TABLES,
  doctorItem,
  leaveItem,
  type Doctor,
  type LeaveRequest,
} from "../../src/shared/tables.js";
import * as repository from "../../src/features/leave/repository.js";
import {
  approveLeave,
  cancelLeave,
  listLeave,
  rejectLeave,
  requestLeave,
} from "../../src/features/leave/service.js";

const NOW = "2026-11-20T09:00:00.000Z";
const LATER = "2026-11-21T10:00:00.000Z";

const ben: AuthUser = { id: "ben.ochieng", role: "doctor" };
const riya: AuthUser = { id: "riya.coord", role: "coordinator" };

const doctor = (id: string, active = true): Doctor => ({
  id,
  name: id,
  grade: "resident",
  modalities: ["CT"],
  maxHoursPerWeek: 40,
  active,
});

const leave = (overrides: Partial<LeaveRequest>): LeaveRequest => ({
  id: "leave-x",
  doctorId: "ben.ochieng",
  startDate: "2026-12-14",
  endDate: "2026-12-16",
  reason: null,
  status: "pending",
  createdAt: NOW,
  decidedAt: null,
  decidedBy: null,
  ...overrides,
});

async function seedDoctors(): Promise<void> {
  for (const d of [doctor("ben.ochieng"), doctor("chen.li"), doctor("dana.novak")]) {
    await putItem(TABLES.doctors, doctorItem(d));
  }
  await putItem(TABLES.doctors, doctorItem(doctor("old.doctor", false)));
}

async function seedLeave(...requests: LeaveRequest[]): Promise<void> {
  for (const request of requests) await putItem(TABLES.leave, leaveItem(request));
}

const ids = (list: LeaveRequest[]) => list.map((l) => l.id);

beforeEach(async () => {
  clearSubscriptions();
  await seedDoctors();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestLeave", () => {
  it("creates a pending request for the caller (AC2.3.1)", async () => {
    const created = await requestLeave(
      { startDate: "2026-12-14", endDate: "2026-12-16", reason: "  course  " },
      ben,
      NOW,
      () => "leave-new",
    );

    expect(created).toEqual({
      id: "leave-new",
      doctorId: "ben.ochieng",
      startDate: "2026-12-14",
      endDate: "2026-12-16",
      reason: "course",
      status: "pending",
      createdAt: NOW,
      decidedAt: null,
      decidedBy: null,
    });
    expect(await repository.getLeave("leave-new")).toEqual(created);
  });

  it("stores an empty reason as null and accepts past dates (BR1.5, BR1.6)", async () => {
    const created = await requestLeave(
      { startDate: "2020-01-01", endDate: "2020-01-01", reason: "   " },
      ben,
      NOW,
    );
    expect(created.reason).toBeNull();
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses overlap with own pending or approved leave, but not rejected (BR1.4)", async () => {
    await seedLeave(
      leave({ id: "p1", startDate: "2026-12-10", endDate: "2026-12-14" }),
      leave({ id: "a1", status: "approved", startDate: "2026-12-20", endDate: "2026-12-20" }),
      leave({ id: "r1", status: "rejected", startDate: "2026-12-28", endDate: "2026-12-30" }),
    );

    const touchingPending = requestLeave({ startDate: "2026-12-14", endDate: "2026-12-15" }, ben);
    await expect(touchingPending).rejects.toBeInstanceOf(ConflictError);
    await expect(touchingPending).rejects.toThrow(/p1/);
    await expect(
      requestLeave({ startDate: "2026-12-19", endDate: "2026-12-21" }, ben),
    ).rejects.toBeInstanceOf(ConflictError);
    const overRejected = await requestLeave(
      { startDate: "2026-12-29", endDate: "2026-12-29" },
      ben,
    );
    expect(overRejected.status).toBe("pending");
  });

  it("refuses a deactivated or missing doctor, and a coordinator (BR1.2, BR1.3)", async () => {
    const range = { startDate: "2026-12-14", endDate: "2026-12-16" };
    await expect(requestLeave(range, { id: "old.doctor", role: "doctor" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(requestLeave(range, { id: "nobody", role: "doctor" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(requestLeave(range, riya)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await repository.allLeave()).toEqual([]);
  });
});

describe("approveLeave and rejectLeave", () => {
  it("approves and publishes one payload equal to the saved request (AC1.6.1, AC1.14.1)", async () => {
    await seedLeave(
      leave({
        id: "leave-chen",
        doctorId: "chen.li",
        startDate: "2026-12-07",
        endDate: "2026-12-09",
      }),
    );
    const received: LeaveApprovedPayload[] = [];
    subscribe("leave.approved", (payload) => void received.push(payload), "recorder");

    const { leave: approved, followUps } = await approveLeave("leave-chen", riya, NOW);

    expect(approved).toMatchObject({ status: "approved", decidedAt: NOW, decidedBy: "riya.coord" });
    expect(await repository.getLeave("leave-chen")).toEqual(approved);
    expect(ids(await repository.approvedLeave())).toEqual(["leave-chen"]);
    expect(received).toEqual([
      {
        leaveId: "leave-chen",
        doctorId: "chen.li",
        startDate: "2026-12-07",
        endDate: "2026-12-09",
        approvedBy: "riya.coord",
        at: NOW,
      },
    ]);
    expect(followUps).toEqual([{ subscriber: "recorder", ok: true }]);
  });

  it("keeps the approval when a subscriber throws (NFR5.3)", async () => {
    await seedLeave(leave({ id: "leave-1" }));
    subscribe(
      "leave.approved",
      () => {
        throw new Error("regeneration failed");
      },
      "roster",
    );

    const result = await approveLeave("leave-1", riya, NOW);

    expect(result.leave.status).toBe("approved");
    expect(result.followUps[0]).toMatchObject({ ok: false, message: "regeneration failed" });
    expect((await repository.getLeave("leave-1"))?.status).toBe("approved");
  });

  it("publishes nothing when the save fails (NFR5.2)", async () => {
    await seedLeave(leave({ id: "leave-1" }));
    const handler = vi.fn();
    subscribe("leave.approved", handler);
    vi.spyOn(repository, "saveLeave").mockRejectedValueOnce(new Error("leave putItem failed"));

    await expect(approveLeave("leave-1", riya, NOW)).rejects.toThrow("leave putItem failed");
    expect(handler).not.toHaveBeenCalled();
    expect((await repository.getLeave("leave-1"))?.status).toBe("pending");
  });

  it("refuses deciding twice (409), an unknown id (404) and a doctor (403) (AC1.6.2, AC1.6.3)", async () => {
    await seedLeave(leave({ id: "leave-1" }));
    await approveLeave("leave-1", riya, NOW);

    await expect(approveLeave("leave-1", riya, LATER)).rejects.toBeInstanceOf(ConflictError);
    await expect(rejectLeave("leave-1", riya, LATER)).rejects.toBeInstanceOf(ConflictError);
    await expect(approveLeave("missing", riya)).rejects.toBeInstanceOf(NotFoundError);
    await expect(approveLeave("leave-1", ben)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects a pending request and publishes nothing (BR2.5)", async () => {
    await seedLeave(leave({ id: "leave-1" }));
    const handler = vi.fn();
    subscribe("leave.approved", handler);

    const rejected = await rejectLeave("leave-1", riya, NOW);

    expect(rejected).toMatchObject({ status: "rejected", decidedAt: NOW, decidedBy: "riya.coord" });
    expect(handler).not.toHaveBeenCalled();
    expect(await repository.approvedLeave()).toEqual([]);
  });
});

describe("cancelLeave", () => {
  it("lets the owner cancel a pending request, which leaves the pending list (AC2.4.1)", async () => {
    await seedLeave(leave({ id: "leave-1" }));

    const cancelled = await cancelLeave("leave-1", ben, NOW);

    expect(cancelled).toMatchObject({
      status: "cancelled",
      decidedAt: NOW,
      decidedBy: "ben.ochieng",
    });
    expect(await listLeave({ status: "pending" }, riya)).toEqual([]);
  });

  it("refuses cancelling an approved request (409) or an unknown id (404) (AC2.4.2)", async () => {
    await seedLeave(leave({ id: "leave-1", status: "approved", decidedBy: "riya.coord" }));

    await expect(cancelLeave("leave-1", ben)).rejects.toBeInstanceOf(ConflictError);
    await expect(cancelLeave("missing", ben)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses another doctor or the coordinator (403), before the status check (AC2.4.3)", async () => {
    await seedLeave(
      leave({ id: "chen-pending", doctorId: "chen.li" }),
      leave({ id: "chen-approved", doctorId: "chen.li", status: "approved" }),
    );

    await expect(cancelLeave("chen-pending", ben)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelLeave("chen-approved", ben)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelLeave("chen-pending", riya)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await repository.getLeave("chen-pending"))?.status).toBe("pending");
  });
});

describe("listLeave", () => {
  const sample = () =>
    seedLeave(
      leave({
        id: "chen-approved",
        doctorId: "chen.li",
        status: "approved",
        startDate: "2026-12-07",
        endDate: "2026-12-09",
      }),
      leave({
        id: "dana-pending",
        doctorId: "dana.novak",
        startDate: "2026-12-08",
        endDate: "2026-12-08",
      }),
      leave({
        id: "dana-rejected",
        doctorId: "dana.novak",
        status: "rejected",
        startDate: "2026-12-01",
        endDate: "2026-12-02",
      }),
      leave({
        id: "ben-rejected",
        status: "rejected",
        startDate: "2026-12-21",
        endDate: "2026-12-22",
      }),
      leave({ id: "ben-pending", startDate: "2026-12-14", endDate: "2026-12-16" }),
      leave({
        id: "ben-approved",
        status: "approved",
        startDate: "2026-12-07",
        endDate: "2026-12-07",
      }),
    );

  it("shows a doctor everyone's approved leave and their own requests only (AC2.5.1, AC2.5.2)", async () => {
    await sample();

    const seen = await listLeave({}, ben);

    expect(ids(seen)).toEqual(["ben-approved", "chen-approved", "ben-pending", "ben-rejected"]);
    expect(seen.find((l) => l.id === "ben-rejected")?.status).toBe("rejected");
    expect(ids(await listLeave({ status: "pending" }, ben))).toEqual(["ben-pending"]);
  });

  it("shows the coordinator every request in every state (AC2.5.3)", async () => {
    await sample();

    const seen = await listLeave({}, riya);

    expect(ids(seen)).toEqual([
      "dana-rejected",
      "ben-approved",
      "chen-approved",
      "dana-pending",
      "ben-pending",
      "ben-rejected",
    ]);
  });

  it("filters by inclusive date overlap and gives the same order every time (BR4.3, NFR5.1)", async () => {
    await sample();

    const first = await listLeave({ from: "2026-12-09", to: "2026-12-14" }, riya);
    const second = await listLeave({ from: "2026-12-09", to: "2026-12-14" }, riya);

    expect(ids(first)).toEqual(["chen-approved", "ben-pending"]);
    expect(second).toEqual(first);
    expect(await listLeave({ from: "2027-01-01" }, ben)).toEqual([]);
  });
});
