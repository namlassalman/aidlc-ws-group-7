// Leave repository tests (u4-leave): in-memory tables, emptied before each test by test/setup.ts.
// Covers BR1.5 (must not already exist), BR4.4 (index keys rewritten on save) and key stripping.
import { describe, expect, it } from "vitest";
import { getItem, putItem } from "../../src/shared/db.js";
import { ConflictError } from "../../src/shared/errors.js";
import { TABLES, doctorItem, leaveKey, type LeaveRequest } from "../../src/shared/tables.js";
import {
  allLeave,
  approvedLeave,
  getDoctor,
  getLeave,
  leaveOfDoctorId,
  saveLeave,
  saveNewLeave,
} from "../../src/features/leave/repository.js";

const pendingLeave = (overrides: Partial<LeaveRequest> = {}): LeaveRequest => ({
  id: "leave-1",
  doctorId: "ben.ochieng",
  startDate: "2026-12-14",
  endDate: "2026-12-16",
  reason: "course",
  status: "pending",
  createdAt: "2026-11-20T09:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  ...overrides,
});

describe("leave repository", () => {
  it("reads a saved request back without its key attributes", async () => {
    const leave = pendingLeave();
    await saveNewLeave(leave);

    expect(await getLeave(leave.id)).toEqual(leave);
    expect(await allLeave()).toEqual([leave]);
    const stored = await getItem(TABLES.leave, leaveKey(leave.id));
    expect(stored).toMatchObject({ pk: "LEAVE", gsi2pk: "pending" });
  });

  it("returns undefined for an unknown request id", async () => {
    expect(await getLeave("no-such-leave")).toBeUndefined();
  });

  it("refuses a second new request with the same id (ConflictError)", async () => {
    await saveNewLeave(pendingLeave());

    await expect(saveNewLeave(pendingLeave({ reason: "other" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await getLeave("leave-1"))?.reason).toBe("course");
  });

  it("moves a request into and out of the approved partition as its status changes", async () => {
    const leave = pendingLeave();
    await saveNewLeave(leave);
    expect(await approvedLeave()).toEqual([]);

    const approved = { ...leave, status: "approved" as const, decidedBy: "riya.coord" };
    await saveLeave(approved);
    expect(await approvedLeave()).toEqual([approved]);

    await saveLeave({ ...approved, status: "cancelled" });
    expect(await approvedLeave()).toEqual([]);
  });

  it("returns only the given doctor's requests, ordered by start date", async () => {
    const later = pendingLeave({ id: "leave-b", startDate: "2026-12-20", endDate: "2026-12-21" });
    const earlier = pendingLeave({ id: "leave-a", startDate: "2026-12-01", endDate: "2026-12-02" });
    const other = pendingLeave({ id: "leave-c", doctorId: "chen.li" });
    for (const leave of [later, earlier, other]) await saveNewLeave(leave);

    expect(await leaveOfDoctorId("ben.ochieng")).toEqual([earlier, later]);
    expect(await leaveOfDoctorId("dana.novak")).toEqual([]);
  });

  it("reads a doctor's id and active flag, or undefined for an unknown id", async () => {
    await putItem(
      TABLES.doctors,
      doctorItem({
        id: "ben.ochieng",
        name: "Ben Ochieng",
        grade: "resident",
        modalities: ["CT"],
        maxHoursPerWeek: 40,
        active: true,
      }),
    );

    expect(await getDoctor("ben.ochieng")).toEqual({ id: "ben.ochieng", active: true });
    expect(await getDoctor("nobody")).toBeUndefined();
  });
});
