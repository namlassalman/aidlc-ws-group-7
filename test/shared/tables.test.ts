import { afterEach, describe, expect, it } from "vitest";
import {
  TABLES,
  TABLE_INDEXES,
  INDEX_KEYS,
  doctorKey,
  dutiesBetween,
  dutyItem,
  dutyKey,
  leaveItem,
  leaveStartingBy,
  rosterKey,
  ruleKey,
  type Duty,
  type LeaveRequest,
} from "../../src/shared/tables.js";

const callDuty: Duty = {
  id: "d-2026-12-07-call-xr",
  date: "2026-12-07",
  type: "CALL",
  modality: "XR",
  doctorsNeeded: 1,
  needsConsultant: false,
  cancelled: false,
};

describe("table names", () => {
  afterEach(() => {
    delete process.env.TABLE_DUTIES;
  });

  it("default to the logical name locally", () => {
    expect(TABLES.doctors).toBe("doctors");
    expect(TABLES.rosters).toBe("rosters");
  });

  it("come from the TABLE_* environment variable when it is set", () => {
    process.env.TABLE_DUTIES = "RosterApp-DutiesTable-ABC";
    expect(TABLES.duties).toBe("RosterApp-DutiesTable-ABC");
  });
});

describe("C1 keys", () => {
  it("builds the fixed partition keys", () => {
    expect(doctorKey("asha.rao")).toEqual({ pk: "DOCTOR", sk: "asha.rao" });
    expect(dutyKey("d1")).toEqual({ pk: "DUTY", sk: "d1" });
    expect(ruleKey("r1")).toEqual({ pk: "RULE", sk: "r1" });
    expect(rosterKey("published", "2026-12-07")).toEqual({ pk: "published", sk: "2026-12-07" });
  });

  it("gives a duty the byDate sort key date#HH#id", () => {
    expect(dutyItem({ ...callDuty, id: "d1", date: "2026-12-07", type: "AM" }).gsi1sk).toBe(
      "2026-12-07#08#d1",
    );
    const item = dutyItem(callDuty);
    expect(item).toMatchObject({
      pk: "DUTY",
      sk: callDuty.id,
      gsi1pk: "DUTY",
      gsi1sk: "2026-12-07#18#d-2026-12-07-call-xr",
      type: "CALL",
    });
  });

  it("indexes leave by doctor and by status on startDate#id", () => {
    const leave: LeaveRequest = {
      id: "l1",
      doctorId: "chen.li",
      startDate: "2026-12-07",
      endDate: "2026-12-09",
      reason: null,
      status: "approved",
      createdAt: "2026-11-18T00:00:00.000Z",
      decidedAt: null,
      decidedBy: null,
    };
    expect(leaveItem(leave)).toMatchObject({
      pk: "LEAVE",
      sk: "l1",
      gsi1pk: "chen.li",
      gsi1sk: "2026-12-07#l1",
      gsi2pk: "approved",
      gsi2sk: "2026-12-07#l1",
    });
  });

  it("builds date-range query specs whose upper bound sorts after every id on the last day", () => {
    const spec = dutiesBetween("2026-12-07", "2026-12-13");
    expect(spec).toEqual({
      index: "byDate",
      pk: "DUTY",
      skBetween: ["2026-12-07", "2026-12-13#~"],
    });
    expect("2026-12-13#18#zzz" <= spec.skBetween[1]).toBe(true);
    expect("2026-12-14#08#a" <= spec.skBetween[1]).toBe(false);
    expect(leaveStartingBy("approved", "2026-12-13").skBetween).toEqual(["0000", "2026-12-13#~"]);
  });

  it("declares the indexes each table has", () => {
    expect(TABLE_INDEXES.duties).toEqual(["byDate"]);
    expect(TABLE_INDEXES.leave).toEqual(["byDoctor", "byStatus"]);
    expect(TABLE_INDEXES.doctors).toEqual([]);
    expect(INDEX_KEYS.byStatus).toEqual({ pk: "gsi2pk", sk: "gsi2sk" });
  });
});
