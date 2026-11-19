/**
 * Rules repository (u5-rules): the only data access of the rules feature, through the shared
 * table helpers in src/shared/db.ts and the C1 keys and query specs in src/shared/tables.ts.
 *
 * - Writes the rules table only: create (ifNotExists, BR1.4), save (BR1.5, BR2.1, BR2.2) and
 *   delete (BR2.3). Lists every rule with one query on pk RULE, in id order (BR2.4, NFR1.2).
 * - Reads, never writes, the other features' tables (doctors, duties, approved leave, roster
 *   weeks) for named-doctor validation (BR1.2) and the can-take answer (BR3.1-BR3.4).
 * - Stored items have their keys stripped; rules are parsed with the shared RuleSchema, and a
 *   stored rule that no longer parses is a server fault (500), never a client error.
 */
import { deleteItem, getItem, putItem, query, type Item } from "../../shared/db.js";
import { RuleSchema, type Rule } from "../../shared/rules.js";
import {
  TABLES,
  doctorKey,
  dutiesBetween as dutiesBetweenSpec,
  dutyKey,
  leaveStartingBy,
  rosterKey,
  rosterWeeksBetween,
  ruleItem,
  ruleKey,
  type Doctor,
  type Duty,
  type LeaveRequest,
  type RosterVersion,
  type RosterWeek,
} from "../../shared/tables.js";

const KEY_ATTRIBUTES = ["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk"] as const;

/** The item without its table and index keys. */
function withoutKeys<T>(item: Item): T {
  const copy: Item = { ...item };
  for (const attribute of KEY_ATTRIBUTES) delete copy[attribute];
  return copy as T;
}

const compareIds = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function toRule(item: Item): Rule {
  const parsed = RuleSchema.safeParse(withoutKeys(item));
  if (!parsed.success) {
    throw new Error(`rules table holds an invalid rule ${String(item.sk)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Rules table (read and write)
// ---------------------------------------------------------------------------------------------

/** Every rule, ordered by id (the order checkPlacement applies them in). */
export async function listRules(): Promise<Rule[]> {
  const items = await query(TABLES.rules, { pk: "RULE" });
  return items.map(toRule).sort(compareIds);
}

export async function getRule(id: string): Promise<Rule | undefined> {
  const item = await getItem(TABLES.rules, ruleKey(id));
  return item ? toRule(item) : undefined;
}

/** Writes a new rule; throws the shared ConflictError when the id already exists. */
export async function createRule(rule: Rule): Promise<void> {
  await putItem(TABLES.rules, ruleItem(rule), { ifNotExists: true });
}

/** Overwrites a rule (edit and switches; last write wins, C1). */
export async function saveRule(rule: Rule): Promise<void> {
  await putItem(TABLES.rules, ruleItem(rule));
}

export async function deleteRule(id: string): Promise<void> {
  await deleteItem(TABLES.rules, ruleKey(id));
}

// ---------------------------------------------------------------------------------------------
// Other features' tables (read only)
// ---------------------------------------------------------------------------------------------

export async function getDoctor(id: string): Promise<Doctor | undefined> {
  const item = await getItem(TABLES.doctors, doctorKey(id));
  return item ? withoutKeys<Doctor>(item) : undefined;
}

/** Every doctor, active or not, ordered by id. */
export async function listDoctors(): Promise<Doctor[]> {
  const items = await query(TABLES.doctors, { pk: "DOCTOR" });
  return items.map((item) => withoutKeys<Doctor>(item)).sort(compareIds);
}

export async function getDuty(id: string): Promise<Duty | undefined> {
  const item = await getItem(TABLES.duties, dutyKey(id));
  return item ? withoutKeys<Duty>(item) : undefined;
}

/** Duties dated from `from` to `to` (inclusive), cancelled ones included, by start then id. */
export async function dutiesBetween(from: string, to: string): Promise<Duty[]> {
  const items = await query(TABLES.duties, dutiesBetweenSpec(from, to));
  return items.map((item) => withoutKeys<Duty>(item));
}

/** The doctor's approved leave overlapping [from, to] (inclusive dates). */
export async function approvedLeaveOverlapping(
  doctorId: string,
  from: string,
  to: string,
): Promise<LeaveRequest[]> {
  const items = await query(TABLES.leave, leaveStartingBy("approved", to));
  return items
    .map((item) => withoutKeys<LeaveRequest>(item))
    .filter(
      (leave) =>
        leave.doctorId === doctorId && leave.status === "approved" && leave.endDate >= from,
    );
}

export async function getRosterWeek(
  version: RosterVersion,
  weekStart: string,
): Promise<RosterWeek | undefined> {
  const item = await getItem(TABLES.rosters, rosterKey(version, weekStart));
  return item ? withoutKeys<RosterWeek>(item) : undefined;
}

/** Published roster weeks from `fromMonday` to `toMonday` (inclusive), by week. */
export async function publishedWeeksBetween(
  fromMonday: string,
  toMonday: string,
): Promise<RosterWeek[]> {
  const items = await query(TABLES.rosters, rosterWeeksBetween("published", fromMonday, toMonday));
  return items.map((item) => withoutKeys<RosterWeek>(item));
}
