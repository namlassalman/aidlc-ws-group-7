// Test data for the rules Unit's tests: seeds the in-memory tables (reset before each test by
// test/setup.ts) with the vision.md example data through the shared table helpers and builders.
import { putItem } from "../../src/shared/db.js";
import {
  TABLES,
  doctorItem,
  dutyItem,
  leaveItem,
  rosterItem,
  ruleItem,
  type Doctor,
  type Duty,
  type LeaveRequest,
  type RosterPlacement,
  type RosterVersion,
  type Rule,
} from "../../src/shared/tables.js";
import { exampleDoctors, exampleDuties, exampleLeave, exampleRules } from "../shared/fixtures.js";

export const putDoctors = (doctors: readonly Doctor[]) =>
  Promise.all(doctors.map((d) => putItem(TABLES.doctors, doctorItem(d))));

export const putDuties = (duties: readonly Duty[]) =>
  Promise.all(duties.map((d) => putItem(TABLES.duties, dutyItem(d))));

export const putLeave = (leave: readonly LeaveRequest[]) =>
  Promise.all(leave.map((l) => putItem(TABLES.leave, leaveItem(l))));

export const putRules = (rules: readonly Rule[]) =>
  Promise.all(rules.map((r) => putItem(TABLES.rules, ruleItem(r))));

/** The example doctors, duties, Chen's approved leave and the three example rules. */
export async function seedExample(): Promise<void> {
  await putDoctors(exampleDoctors());
  await putDuties(exampleDuties());
  await putLeave(exampleLeave());
  await putRules(exampleRules());
}

/** One roster week; `placements` are [doctorId, dutyId] pairs, each taking place 1, 2, ... */
export async function putRosterWeek(
  version: RosterVersion,
  weekStart: string,
  pairs: readonly [string, string][],
): Promise<void> {
  const nextPlace = new Map<string, number>();
  const placements: RosterPlacement[] = pairs.map(([doctorId, dutyId]) => {
    const place = (nextPlace.get(dutyId) ?? 0) + 1;
    nextPlace.set(dutyId, place);
    return { dutyId, place, doctorId, locked: false };
  });
  await putItem(
    TABLES.rosters,
    rosterItem({
      weekStart,
      version,
      periodStart: weekStart,
      periodWeeks: 1,
      generatedAt: "2026-11-30T00:00:00.000Z",
      publishedAt: version === "published" ? "2026-11-30T01:00:00.000Z" : null,
      now: "2026-11-30T00:00:00.000Z",
      placements,
      gaps: [],
      brokenSoftRules: [],
    }),
  );
}

/** The AC1.9.1 draft: Ben on the 2026-12-07 CALL XR. */
export const putBenOnCallDraft = () =>
  putRosterWeek("draft", "2026-12-07", [["ben.ochieng", "d-2026-12-07-call-xr"]]);
