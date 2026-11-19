// u6-roster repository on the in-memory tables (BR5, BR6.4, BR8, BR9; C1 access patterns).
import { describe, expect, it } from "vitest";
import { getItem } from "../../src/shared/db.js";
import { TABLES, rosterKey, type RosterWeek } from "../../src/shared/tables.js";
import {
  activeDoctors,
  allDoctors,
  approvedLeaveOverlapping,
  deleteDraft,
  dutiesBetween,
  enabledRules,
  getWeek,
  publishedWeeksBetween,
  putWeek,
} from "../../src/features/roster/repository.js";
import { exampleData, leaveRequest, seedExample, seedTables } from "./fixtures.js";

function week(version: RosterWeek["version"], weekStart: string): RosterWeek {
  return {
    weekStart,
    version,
    periodStart: weekStart,
    periodWeeks: 1,
    generatedAt: "2026-12-01T00:00:00.000Z",
    publishedAt: version === "published" ? "2026-12-01T00:00:00.000Z" : null,
    now: "2026-12-01T00:00:00.000Z",
    placements: [{ dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "asha.rao", locked: false }],
    gaps: [],
    brokenSoftRules: [],
  };
}

describe("roster items", () => {
  it("puts and gets a week, without the table keys", async () => {
    await putWeek(week("draft", "2026-12-07"));
    expect(await getWeek("draft", "2026-12-07")).toEqual(week("draft", "2026-12-07"));
    expect(await getWeek("published", "2026-12-07")).toBeUndefined();
    const stored = await getItem(TABLES.rosters, rosterKey("draft", "2026-12-07"));
    expect(stored).toMatchObject({ pk: "draft", sk: "2026-12-07" });
  });

  it("replaces a draft and deletes it", async () => {
    await putWeek(week("draft", "2026-12-07"));
    await putWeek({ ...week("draft", "2026-12-07"), placements: [] });
    expect((await getWeek("draft", "2026-12-07"))?.placements).toEqual([]);
    await deleteDraft("2026-12-07");
    expect(await getWeek("draft", "2026-12-07")).toBeUndefined();
  });

  it("queries published weeks in a range, in week order, never drafts", async () => {
    for (const monday of ["2026-12-21", "2026-11-30", "2026-12-07", "2026-12-14"]) {
      await putWeek(week("published", monday));
    }
    await putWeek(week("draft", "2026-12-14"));
    const found = await publishedWeeksBetween("2026-12-07", "2026-12-14");
    expect(found.map((w) => [w.version, w.weekStart])).toEqual([
      ["published", "2026-12-07"],
      ["published", "2026-12-14"],
    ]);
    expect(await publishedWeeksBetween("2027-01-04", "2027-01-11")).toEqual([]);
  });
});

describe("read-only loaders", () => {
  it("returns approved leave overlapping a range, dropping pending leave and leave ending before it", async () => {
    await seedTables({
      leave: [
        leaveRequest("chen.li", "2026-12-07", "2026-12-09"),
        leaveRequest("dana.novak", "2026-12-08", "2026-12-08", { status: "pending" }),
        leaveRequest("asha.rao", "2026-11-20", "2026-12-06"),
        leaveRequest("ben.ochieng", "2026-12-14", "2026-12-15"),
        leaveRequest("asha.rao", "2026-12-13", "2026-12-20", { id: "leave-asha-late" }),
      ],
    });
    const found = await approvedLeaveOverlapping("2026-12-07", "2026-12-13");
    expect(found.map((l) => l.id).sort()).toEqual(["leave-asha-late", "leave-chen.li-2026-12-07"]);
    expect(found[0]).not.toHaveProperty("gsi2pk");
  });

  it("returns cancelled duties flagged, ordered by start then id", async () => {
    const { duties } = exampleData();
    duties[3].cancelled = true; // d-2026-12-08-am-us
    await seedTables({ duties });
    const found = await dutiesBetween("2026-12-07", "2026-12-08");
    expect(found.map((d) => [d.id, d.cancelled])).toEqual([
      ["d-2026-12-07-am-ct", false],
      ["d-2026-12-07-call-xr", false],
      ["d-2026-12-08-am-mri", false],
      ["d-2026-12-08-am-us", true],
      ["d-2026-12-08-am-xr", false],
    ]);
    expect(found[0]).not.toHaveProperty("pk");
  });

  it("lists doctors by id, active ones apart, and only enabled rules", async () => {
    const data = exampleData();
    data.doctors[1].active = false; // ben.ochieng
    data.rules[1].enabled = false; // rule-2-residents-on-xr
    await seedTables(data);
    expect((await allDoctors()).map((d) => d.id)).toEqual([
      "asha.rao",
      "ben.ochieng",
      "chen.li",
      "dana.novak",
    ]);
    expect((await activeDoctors()).map((d) => d.id)).toEqual(["asha.rao", "chen.li", "dana.novak"]);
    expect((await enabledRules()).map((r) => r.id)).toEqual([
      "rule-1-rest-after-call",
      "rule-3-one-call-per-week",
    ]);
  });

  it("returns empty lists on empty tables", async () => {
    expect(await allDoctors()).toEqual([]);
    expect(await enabledRules()).toEqual([]);
    await seedExample();
    expect(await dutiesBetween("2027-01-04", "2027-01-10")).toEqual([]);
  });
});
