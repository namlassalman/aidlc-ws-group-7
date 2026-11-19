// u6-roster data shapes (BR1.2, BR1.4, BR1.5; C3 payload, NFR Design R-01 and R-04).
import { describe, expect, it } from "vitest";
import { ConflictError } from "../../src/shared/errors.js";
import {
  GenerateBody,
  LeaveApprovedPayload,
  MineQuery,
  PublishBody,
  RUN_TOO_LONG_MESSAGE,
  RunTooLongError,
  WeekParams,
  WeekQuery,
} from "../../src/features/roster/schemas.js";

const validPayload = () => ({
  leaveId: "leave-dana.novak-2026-12-08",
  doctorId: "dana.novak",
  startDate: "2026-12-08",
  endDate: "2026-12-08",
  approvedBy: "coord1",
  at: "2026-12-01T00:00:00.000Z",
});

describe("GenerateBody and PublishBody", () => {
  it("accepts a Monday and defaults weeks to 4", () => {
    expect(GenerateBody.parse({ weekStart: "2026-12-07" })).toEqual({
      weekStart: "2026-12-07",
      weeks: 4,
    });
    expect(PublishBody.parse({ weekStart: "2026-12-07", weeks: 1 }).weeks).toBe(1);
  });

  it("refuses a Tuesday", () => {
    expect(GenerateBody.safeParse({ weekStart: "2026-12-08" }).success).toBe(false);
    expect(PublishBody.safeParse({ weekStart: "2026-12-08" }).success).toBe(false);
  });

  it("refuses weeks: 9 and weeks: 0", () => {
    expect(GenerateBody.safeParse({ weekStart: "2026-12-07", weeks: 9 }).success).toBe(false);
    expect(GenerateBody.safeParse({ weekStart: "2026-12-07", weeks: 0 }).success).toBe(false);
  });

  it("refuses an unknown field", () => {
    const result = GenerateBody.safeParse({ weekStart: "2026-12-07", doctorId: "asha.rao" });
    expect(result.success).toBe(false);
  });

  it("refuses an invalid date and a non-ISO now", () => {
    expect(GenerateBody.safeParse({ weekStart: "2026-02-30" }).success).toBe(false);
    expect(GenerateBody.safeParse({ weekStart: "2026-12-07", now: "tomorrow" }).success).toBe(
      false,
    );
  });
});

describe("WeekParams and WeekQuery", () => {
  it("defaults the version to published and refuses another value", () => {
    expect(WeekQuery.parse({})).toEqual({ version: "published" });
    expect(WeekQuery.safeParse({ version: "old" }).success).toBe(false);
    expect(WeekParams.safeParse({ weekStart: "2026-12-09" }).success).toBe(false);
  });
});

describe("MineQuery", () => {
  it("accepts an 8-week range", () => {
    expect(MineQuery.safeParse({ from: "2026-12-07", to: "2027-01-31" }).success).toBe(true);
  });

  it("refuses a span over 56 days", () => {
    expect(MineQuery.safeParse({ from: "2026-12-07", to: "2027-02-01" }).success).toBe(false);
  });

  it("refuses from after to, and a doctorId field", () => {
    expect(MineQuery.safeParse({ from: "2026-12-13", to: "2026-12-07" }).success).toBe(false);
    const withDoctor = { from: "2026-12-07", to: "2026-12-13", doctorId: "chen.li" };
    expect(MineQuery.safeParse(withDoctor).success).toBe(false);
  });
});

describe("LeaveApprovedPayload", () => {
  it("passes a payload with an extra field and drops the field", () => {
    const parsed = LeaveApprovedPayload.parse({ ...validPayload(), comment: "late leave" });
    expect(parsed).toEqual(validPayload());
  });

  it("fails a payload missing at", () => {
    const withoutAt: Partial<ReturnType<typeof validPayload>> = validPayload();
    delete withoutAt.at;
    expect(LeaveApprovedPayload.safeParse(withoutAt).success).toBe(false);
  });

  it("fails a payload whose startDate is not a date", () => {
    expect(LeaveApprovedPayload.safeParse({ ...validPayload(), startDate: "08/12" }).success).toBe(
      false,
    );
  });
});

describe("RunTooLongError", () => {
  it("is a ConflictError (409) with the cut-off message", () => {
    const error = new RunTooLongError(undefined, { stage: "place", elapsedMs: 15_001 });
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.status).toBe(409);
    expect(error.message).toBe(RUN_TOO_LONG_MESSAGE);
    expect(error.stage).toBe("place");
  });
});
