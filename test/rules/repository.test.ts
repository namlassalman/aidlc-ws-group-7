// Repository tests (u5-rules): the rules table and the read-only views of the other tables,
// on the shared in-memory table helpers (BR1.4, BR2.3, BR2.4, BR3.2, BR3.4).
import { beforeEach, describe, expect, it } from "vitest";
import {
  approvedLeaveOverlapping,
  createRule,
  deleteRule,
  dutiesBetween,
  getDoctor,
  getDuty,
  getRosterWeek,
  getRule,
  listDoctors,
  listRules,
  publishedWeeksBetween,
  saveRule,
} from "../../src/features/rules/repository.js";
import { putItem } from "../../src/shared/db.js";
import { ConflictError } from "../../src/shared/errors.js";
import { TABLES, ruleKey, type LeaveRequest, type Rule } from "../../src/shared/tables.js";
import { doctor, exampleLeave, exampleRules } from "../shared/fixtures.js";
import { putDoctors, putLeave, putRosterWeek, putRules, seedExample } from "./seed.js";

const dutyLimit = (id: string): Rule => ({
  id,
  type: "duty_limit",
  strength: "soft",
  enabled: true,
  settings: { dutyType: "AM", max: 3, per: "week" },
  createdAt: "2026-11-19T00:00:00.000Z",
});

beforeEach(async () => {
  await seedExample();
});

describe("rules table", () => {
  it("lists every rule in id order, without table keys", async () => {
    await putRules([dutyLimit("rule-10-duty-limit")]);
    const rules = await listRules();
    expect(rules.map((r) => r.id)).toEqual([
      "rule-1-rest-after-call",
      "rule-10-duty-limit",
      "rule-2-residents-on-xr",
      "rule-3-one-call-per-week",
    ]);
    expect(rules[0]).toEqual(exampleRules()[0]);
    expect(rules[0]).not.toHaveProperty("pk");
  });

  it("creates a new rule and refuses a second create with the same id (ConflictError)", async () => {
    await createRule(dutyLimit("rule-4-duty-limit"));
    expect(await getRule("rule-4-duty-limit")).toEqual(dutyLimit("rule-4-duty-limit"));
    await expect(createRule(dutyLimit("rule-4-duty-limit"))).rejects.toBeInstanceOf(ConflictError);
  });

  it("saves over an existing rule and deletes it", async () => {
    const changed = { ...exampleRules()[0], enabled: false };
    await saveRule(changed);
    expect((await getRule(changed.id))?.enabled).toBe(false);
    await deleteRule(changed.id);
    expect(await getRule(changed.id)).toBeUndefined();
    expect((await listRules()).map((r) => r.id)).not.toContain(changed.id);
  });

  it("gives undefined for an unknown rule id", async () => {
    expect(await getRule("rule-99-weekly-hours")).toBeUndefined();
  });

  it("treats a stored rule that no longer matches the schema as a server fault", async () => {
    await putItem(TABLES.rules, {
      ...ruleKey("rule-9-duty-limit"),
      id: "rule-9-duty-limit",
      type: "duty_limit",
      strength: "hard",
      enabled: true,
      settings: { dutyType: "CALL" },
    });
    await expect(listRules()).rejects.toThrow(
      "rules table holds an invalid rule rule-9-duty-limit",
    );
  });
});

describe("other tables (read only)", () => {
  it("reads a doctor and lists every doctor, deactivated ones included", async () => {
    await putDoctors([doctor("dana.novak", { active: false })]);
    expect(await getDoctor("asha.rao")).toEqual(doctor("asha.rao"));
    const all = await listDoctors();
    expect(all.map((d) => d.id)).toEqual(["asha.rao", "ben.ochieng", "chen.li", "dana.novak"]);
    expect(all.find((d) => d.id === "dana.novak")?.active).toBe(false);
  });

  it("gives undefined for an unknown doctor, duty or roster week", async () => {
    expect(await getDoctor("nobody")).toBeUndefined();
    expect(await getDuty("d-2030-01-01-am-ct")).toBeUndefined();
    expect(await getRosterWeek("draft", "2026-12-07")).toBeUndefined();
  });

  it("reads duties in a date range, ordered by start hour then id", async () => {
    const duties = await dutiesBetween("2026-12-07", "2026-12-08");
    expect(duties.map((d) => d.id)).toEqual([
      "d-2026-12-07-am-ct",
      "d-2026-12-07-call-xr",
      "d-2026-12-08-am-mri",
      "d-2026-12-08-am-us",
      "d-2026-12-08-am-xr",
    ]);
    expect(await getDuty("d-2026-12-09-pm-xr")).toMatchObject({ type: "PM", modality: "XR" });
  });

  it("keeps only the doctor's approved leave overlapping the range", async () => {
    const base = exampleLeave()[0];
    const other: LeaveRequest[] = [
      { ...base, id: "leave-ben-pending", doctorId: "ben.ochieng", status: "pending" },
      { ...base, id: "leave-chen-old", startDate: "2026-11-01", endDate: "2026-11-03" },
      { ...base, id: "leave-chen-late", startDate: "2027-01-04", endDate: "2027-01-05" },
    ];
    await putLeave(other);
    const chen = await approvedLeaveOverlapping("chen.li", "2026-11-30", "2026-12-31");
    expect(chen.map((l) => l.id)).toEqual(["leave-chen-li-2026-12-07"]);
    expect(await approvedLeaveOverlapping("ben.ochieng", "2026-11-30", "2026-12-31")).toEqual([]);
  });

  it("reads one roster week and the published weeks in a range", async () => {
    await putRosterWeek("draft", "2026-12-07", [["ben.ochieng", "d-2026-12-07-call-xr"]]);
    await putRosterWeek("published", "2026-11-30", [["asha.rao", "d-x"]]);
    await putRosterWeek("published", "2026-12-07", [["asha.rao", "d-2026-12-07-am-ct"]]);
    await putRosterWeek("published", "2027-01-04", []);
    const draft = await getRosterWeek("draft", "2026-12-07");
    expect(draft?.placements).toEqual([
      { dutyId: "d-2026-12-07-call-xr", place: 1, doctorId: "ben.ochieng", locked: false },
    ]);
    const published = await publishedWeeksBetween("2026-11-30", "2026-12-28");
    expect(published.map((w) => w.weekStart)).toEqual(["2026-11-30", "2026-12-07"]);
  });
});
