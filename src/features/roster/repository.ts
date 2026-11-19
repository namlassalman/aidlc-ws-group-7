/**
 * RosterRepository (u6-roster): roster items through the skeleton's table helpers only, plus
 * read-only loaders for the doctors, duties, leave and rules tables. No AWS SDK, no other
 * feature's code.
 *
 * Rules: BR5 (one draft item per week, replacing any draft), BR6.4 (write published items, delete
 * drafts), BR8 and BR9 (reads). Contracts: C1 (rosters keys pk = version, sk = weekStart; the
 * dutiesBetween, leaveStartingBy and rosterWeeksBetween access patterns), C9 (the data behind
 * the five roster routes). Writes are last write
 * wins (C1 note, NFR1.11). The table keys are stripped from everything returned.
 */
import { deleteItem, getItem, putItem, query, type Item } from "../../shared/db.js";
import { RuleSchema, type Rule } from "../../shared/rules.js";
import {
  TABLES,
  dutiesBetween as dutiesBetweenSpec,
  leaveStartingBy,
  rosterItem,
  rosterKey,
  rosterWeeksBetween,
  type Doctor,
  type Duty,
  type LeaveRequest,
  type RosterVersion,
  type RosterWeek,
} from "../../shared/tables.js";

const KEY_ATTRIBUTES = ["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk"] as const;

/** The stored item without its table and index keys. */
function stripKeys<T>(item: Item): T {
  const copy: Item = { ...item };
  for (const key of KEY_ATTRIBUTES) delete copy[key];
  return copy as T;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Roster items (the rosters table, owned by this Unit)
// ---------------------------------------------------------------------------------------------

export async function getWeek(
  version: RosterVersion,
  weekStart: string,
): Promise<RosterWeek | undefined> {
  const item = await getItem(TABLES.rosters, rosterKey(version, weekStart));
  return item ? stripKeys<RosterWeek>(item) : undefined;
}

/** Writes the whole week, replacing any item of the same version and week. */
export async function putWeek(week: RosterWeek): Promise<void> {
  await putItem(TABLES.rosters, rosterItem(week));
}

export async function deleteDraft(weekStart: string): Promise<void> {
  await deleteItem(TABLES.rosters, rosterKey("draft", weekStart));
}

/** Published weeks from the Monday `fromMonday` to the Monday `toMonday`, inclusive. */
export async function publishedWeeksBetween(
  fromMonday: string,
  toMonday: string,
): Promise<RosterWeek[]> {
  const items = await query(TABLES.rosters, rosterWeeksBetween("published", fromMonday, toMonday));
  return items.map((item) => stripKeys<RosterWeek>(item));
}

// ---------------------------------------------------------------------------------------------
// Read-only loaders (other features' tables, through the table helpers)
// ---------------------------------------------------------------------------------------------

/** Every doctor, active or not, by id. */
export async function allDoctors(): Promise<Doctor[]> {
  const items = await query(TABLES.doctors, { pk: "DOCTOR" });
  return items.map((item) => stripKeys<Doctor>(item)).sort(byId);
}

export async function activeDoctors(): Promise<Doctor[]> {
  return (await allDoctors()).filter((doctor) => doctor.active);
}

/** Duties dated from `from` to `to`, ordered by start then id. Cancelled ones are kept, flagged. */
export async function dutiesBetween(from: string, to: string): Promise<Duty[]> {
  const items = await query(TABLES.duties, dutiesBetweenSpec(from, to));
  return items.map((item) => stripKeys<Duty>(item));
}

/** Approved leave overlapping [from, to]: starting by `to` and ending on or after `from`. */
export async function approvedLeaveOverlapping(from: string, to: string): Promise<LeaveRequest[]> {
  const items = await query(TABLES.leave, leaveStartingBy("approved", to));
  return items
    .map((item) => stripKeys<LeaveRequest>(item))
    .filter((leave) => leave.status === "approved" && leave.endDate >= from);
}

/** The enabled rules, by id. A stored rule that fails the C2 schema throws (fail loud). */
export async function enabledRules(): Promise<Rule[]> {
  const items = await query(TABLES.rules, { pk: "RULE" });
  return items
    .map((item) => RuleSchema.parse(stripKeys(item)))
    .filter((rule) => rule.enabled)
    .sort(byId);
}

/** The repository as one object, so the service can take a wrapped one in tests. */
export const rosterRepository = {
  getWeek,
  putWeek,
  deleteDraft,
  publishedWeeksBetween,
  allDoctors,
  activeDoctors,
  dutiesBetween,
  approvedLeaveOverlapping,
  enabledRules,
};

export type RosterRepository = typeof rosterRepository;
