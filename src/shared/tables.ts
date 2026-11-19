/**
 * Tables, keys, indexes and item shapes (contract C1). Owned by the walking skeleton.
 *
 * - `TABLES.<name>` is the physical table name, read from the TABLE_* environment variables the
 *   CDK stack sets on the Lambda (local and test default: the logical name).
 * - Every table has string keys `pk` and `sk`. Indexes use `gsi1pk`/`gsi1sk` and `gsi2pk`/`gsi2sk`.
 * - Feature Units build keys with the helpers below and never invent their own key formats.
 *   Adding a table or an index is a skeleton change made by the integration lead.
 */
import type { Rule, RuleType } from "./rules.js";

export type { Rule, RuleType };

export const MODALITIES = ["CT", "MRI", "US", "XR"] as const;
export type Modality = (typeof MODALITIES)[number];

export const DUTY_TYPES = ["AM", "PM", "CALL"] as const;
export type DutyType = (typeof DUTY_TYPES)[number];

export const GRADES = ["consultant", "resident"] as const;
export type Grade = (typeof GRADES)[number];

export const LEAVE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const ROSTER_VERSIONS = ["draft", "published"] as const;
export type RosterVersion = (typeof ROSTER_VERSIONS)[number];

/** The logical table names; each feature writes only its own table. */
export const TABLE_NAMES = ["doctors", "duties", "leave", "rules", "rosters"] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** The environment variable holding each table's physical name (set by infra/roster-stack.ts). */
export const TABLE_ENV: Record<TableName, string> = {
  doctors: "TABLE_DOCTORS",
  duties: "TABLE_DUTIES",
  leave: "TABLE_LEAVE",
  rules: "TABLE_RULES",
  rosters: "TABLE_ROSTERS",
};

function tableName(name: TableName): string {
  return process.env[TABLE_ENV[name]] || name;
}

/** Physical table names, read from the environment on each access (so scripts can set them late). */
export const TABLES: Readonly<Record<TableName, string>> = {
  get doctors() {
    return tableName("doctors");
  },
  get duties() {
    return tableName("duties");
  },
  get leave() {
    return tableName("leave");
  },
  get rules() {
    return tableName("rules");
  },
  get rosters() {
    return tableName("rosters");
  },
};

export type IndexName = "byDate" | "byDoctor" | "byStatus";

/** Key attributes of each global secondary index. */
export const INDEX_KEYS: Record<IndexName, { pk: string; sk: string }> = {
  byDate: { pk: "gsi1pk", sk: "gsi1sk" },
  byDoctor: { pk: "gsi1pk", sk: "gsi1sk" },
  byStatus: { pk: "gsi2pk", sk: "gsi2sk" },
};

/** The indexes each table has; infra/roster-stack.ts creates exactly these. */
export const TABLE_INDEXES: Record<TableName, readonly IndexName[]> = {
  doctors: [],
  duties: ["byDate"],
  leave: ["byDoctor", "byStatus"],
  rules: [],
  rosters: [],
};

export type Key = { pk: string; sk: string };

// ---------------------------------------------------------------------------------------------
// Item types (C1). Stored items are these fields plus their keys.
// ---------------------------------------------------------------------------------------------

export type Doctor = {
  id: string;
  name: string;
  grade: Grade;
  modalities: Modality[];
  maxHoursPerWeek: number;
  active: boolean;
};

export type Duty = {
  id: string;
  /** YYYY-MM-DD; a CALL's date is the date it starts. */
  date: string;
  type: DutyType;
  modality: Modality;
  doctorsNeeded: number;
  needsConsultant: boolean;
  cancelled: boolean;
};

export type LeaveRequest = {
  id: string;
  doctorId: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: LeaveStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
};

export type RosterPlacement = { dutyId: string; place: number; doctorId: string; locked: boolean };

export type RosterGap = {
  dutyId: string;
  place: number;
  reason: string;
  suggested: { doctorId: string; brokenHardRules: string[] } | null;
};

export type BrokenSoftRule = { dutyId: string; doctorId: string; ruleId: string; reason: string };

/** One Monday-to-Sunday week of one roster version. A run of N weeks writes N items. */
export type RosterWeek = {
  weekStart: string;
  version: RosterVersion;
  periodStart: string;
  periodWeeks: number;
  generatedAt: string;
  publishedAt: string | null;
  now: string;
  placements: RosterPlacement[];
  gaps: RosterGap[];
  brokenSoftRules: BrokenSoftRule[];
};

// ---------------------------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------------------------

/** The start hour of each duty type, used in the duties `byDate` sort key. */
export const DUTY_START_HOUR: Record<DutyType, "08" | "13" | "18"> = {
  AM: "08",
  PM: "13",
  CALL: "18",
};

/** Upper bound suffix for a date range on a `<date>#...` sort key: "<to>#~" sorts after every id. */
export const RANGE_END = "#~";

export const doctorKey = (id: string): Key => ({ pk: "DOCTOR", sk: id });

export const dutyKey = (id: string): Key => ({ pk: "DUTY", sk: id });

export function dutyIndexKeys(duty: Pick<Duty, "id" | "date" | "type">) {
  return { gsi1pk: "DUTY", gsi1sk: `${duty.date}#${DUTY_START_HOUR[duty.type]}#${duty.id}` };
}

export const leaveKey = (id: string): Key => ({ pk: "LEAVE", sk: id });

export function leaveIndexKeys(
  leave: Pick<LeaveRequest, "id" | "doctorId" | "startDate" | "status">,
) {
  const sortKey = `${leave.startDate}#${leave.id}`;
  return { gsi1pk: leave.doctorId, gsi1sk: sortKey, gsi2pk: leave.status, gsi2sk: sortKey };
}

export const ruleKey = (id: string): Key => ({ pk: "RULE", sk: id });

export const rosterKey = (version: RosterVersion, weekStart: string): Key => ({
  pk: version,
  sk: weekStart,
});

// ---------------------------------------------------------------------------------------------
// Item builders: the item with its keys, ready for putItem.
// ---------------------------------------------------------------------------------------------

export const doctorItem = (doctor: Doctor) => ({ ...doctorKey(doctor.id), ...doctor });

export const dutyItem = (duty: Duty) => ({ ...dutyKey(duty.id), ...dutyIndexKeys(duty), ...duty });

export const leaveItem = (leave: LeaveRequest) => ({
  ...leaveKey(leave.id),
  ...leaveIndexKeys(leave),
  ...leave,
});

export const ruleItem = (rule: Rule) => ({ ...ruleKey(rule.id), ...rule });

export const rosterItem = (week: RosterWeek) => ({
  ...rosterKey(week.version, week.weekStart),
  ...week,
});

// ---------------------------------------------------------------------------------------------
// Query specs for the C1 access patterns (pass to db.query).
// ---------------------------------------------------------------------------------------------

/** Duties from `from` to `to` (inclusive dates), ordered by start hour then id. */
export const dutiesBetween = (from: string, to: string) => ({
  index: "byDate" as const,
  pk: "DUTY",
  skBetween: [from, `${to}${RANGE_END}`] as [string, string],
});

/** A doctor's leave requests, ordered by start date. */
export const leaveOfDoctor = (doctorId: string) => ({ index: "byDoctor" as const, pk: doctorId });

/**
 * Leave with `status` starting on or before `to`. The caller keeps `endDate >= from` to get the
 * requests overlapping [from, to].
 */
export const leaveStartingBy = (status: LeaveStatus, to: string) => ({
  index: "byStatus" as const,
  pk: status,
  skBetween: ["0000", `${to}${RANGE_END}`] as [string, string],
});

/** Weeks of one roster version from `fromMonday` to `toMonday` (inclusive). */
export const rosterWeeksBetween = (
  version: RosterVersion,
  fromMonday: string,
  toMonday: string,
) => ({
  pk: version,
  skBetween: [fromMonday, toMonday] as [string, string],
});
