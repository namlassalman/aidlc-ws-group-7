import { afterEach, describe, expect, it } from "vitest";
import {
  addDays,
  clearDutyIntervalCache,
  dutyInterval,
  hoursOf,
  isLocked,
  monthOf,
  overlaps,
  weekOf,
  weeksOf,
} from "../../src/shared/time.js";
import { duty } from "./fixtures.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe("dutyInterval (Asia/Singapore, UTC+8)", () => {
  it("gives AM 08:00-13:00 and PM 13:00-18:00 local time, half-open", () => {
    const am = dutyInterval(duty("d-2026-12-08-am-xr"));
    expect(new Date(am.start).toISOString()).toBe("2026-12-08T00:00:00.000Z");
    expect(new Date(am.end).toISOString()).toBe("2026-12-08T05:00:00.000Z");
    expect(am.hours).toBe(5);
    const pm = dutyInterval(duty("d-2026-12-09-pm-xr"));
    expect(new Date(pm.start).toISOString()).toBe("2026-12-09T05:00:00.000Z");
    expect(new Date(pm.end).toISOString()).toBe("2026-12-09T10:00:00.000Z");
  });

  it("gives CALL 18:00 to 08:00 the next day, counted on its start date", () => {
    const call = dutyInterval(duty("d-2026-12-07-call-xr"));
    expect(new Date(call.start).toISOString()).toBe("2026-12-07T10:00:00.000Z");
    expect(new Date(call.end).toISOString()).toBe("2026-12-08T00:00:00.000Z");
    expect(call.hours).toBe(14);
    expect(call.countsOn).toBe("2026-12-07");
  });

  it("does not overlap a CALL ending at 08:00 with an AM starting at 08:00", () => {
    const call = dutyInterval(duty("d-2026-12-07-call-xr"));
    const am = dutyInterval(duty("d-2026-12-08-am-xr"));
    expect(call.end).toBe(am.start);
    expect(overlaps(call, am)).toBe(false);
    expect(overlaps(call, dutyInterval(duty("late-pm", { date: "2026-12-07", type: "PM" })))).toBe(
      false,
    );
    expect(overlaps(am, dutyInterval(duty("same-am", { date: "2026-12-08", type: "AM" })))).toBe(
      true,
    );
  });

  it("follows ROSTER_TIME_ZONE when it changes", () => {
    process.env.ROSTER_TIME_ZONE = "Europe/London";
    clearDutyIntervalCache();
    const am = dutyInterval(duty("d-2026-12-08-am-xr"));
    expect(new Date(am.start).toISOString()).toBe("2026-12-08T08:00:00.000Z");
  });

  afterEach(() => {
    process.env.ROSTER_TIME_ZONE = "Asia/Singapore";
    clearDutyIntervalCache();
  });

  it("refuses an invalid date and an invalid time zone", () => {
    expect(() => dutyInterval(duty("bad", { date: "2026-02-30" }))).toThrow(/no such calendar day/);
    process.env.ROSTER_TIME_ZONE = "Mars/Olympus";
    expect(() => dutyInterval(duty("zone", { date: "2026-12-08" }))).toThrow(
      /Invalid ROSTER_TIME_ZONE/,
    );
  });
});

describe("calendar helpers", () => {
  it("gives the hours of each duty type", () => {
    expect([hoursOf("AM"), hoursOf("PM"), hoursOf("CALL")]).toEqual([5, 5, 14]);
  });

  it("puts every day of a week on its Monday, Sunday included", () => {
    expect(weekOf("2026-12-07")).toBe("2026-12-07");
    expect(weekOf("2026-12-13")).toBe("2026-12-07");
    expect(weekOf("2026-12-14")).toBe("2026-12-14");
    expect(weekOf("2027-01-01")).toBe("2026-12-28");
  });

  it("gives months, day arithmetic across a year end, and consecutive weeks", () => {
    expect(monthOf("2026-12-31")).toBe("2026-12");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-12-01", -1)).toBe("2026-11-30");
    expect(weeksOf("2026-12-07", 3)).toEqual(["2026-12-07", "2026-12-14", "2026-12-21"]);
    expect(() => weeksOf("2026-12-08", 1)).toThrow(/not a Monday/);
  });
});

describe("isLocked (12 hours)", () => {
  const am = duty("d-2026-12-08-am-xr");
  const start = Date.parse("2026-12-08T00:00:00.000Z");

  it("locks a duty starting 11:59 from now", () => {
    expect(isLocked(am, start - 12 * HOUR + MINUTE)).toBe(true);
  });

  it("does not lock a duty starting 12:01 from now, or exactly 12 hours from now", () => {
    expect(isLocked(am, start - 12 * HOUR - MINUTE)).toBe(false);
    expect(isLocked(am, new Date(start - 12 * HOUR))).toBe(false);
  });

  it("locks a duty that has already started or ended", () => {
    expect(isLocked(am, start + HOUR)).toBe(true);
    expect(isLocked(am, "2026-12-20T00:00:00.000Z")).toBe(true);
  });

  it("refuses an invalid now", () => {
    expect(() => isLocked(am, "not a date")).toThrow(/Invalid "now"/);
  });
});
