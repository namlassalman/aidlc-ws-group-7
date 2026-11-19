/**
 * `npx tsx scripts/seed-extra-weeks.ts`: adds the weeks around the Demo Test Plan week to the
 * deployed tables, leaving the week of 2026-12-07 exactly as `npm run seed` writes it.
 *
 * Run `npm run seed` first. Then this script writes, through the DynamoDB mode of
 * src/shared/db.ts:
 * - Wei Min's 15-duty weekly pattern (quality/uat-data.md §2) for the two weeks before the test
 *   week (23 Nov, 30 Nov) and the four weeks after it (14 Dec to 4 Jan): 90 duties;
 * - leave for the four example doctors on dates outside 2026-12-07..13 only (approved, rejected,
 *   cancelled and pending), so the test week keeps only Chen Li's vision.md leave;
 * - no new rules: the three example rules stay the only rules;
 * - rosters: 23 Nov to 28 Dec generated and published one week at a time with the roster
 *   service, and 4 Jan generated as a draft only. The week of 7 Dec gets no roster, so the
 *   coordinator generates it in the demo (Demo Test Plan C2).
 *
 * Fixed ids and plain overwrites, so running it again leaves the same duties and leave, and
 * generates and publishes those weeks again.
 *
 *   AWS_PROFILE=deploy AWS_REGION=us-west-2 npx tsx scripts/seed-extra-weeks.ts
 */
import { putItem } from "../src/shared/db.js";
import { addDays } from "../src/shared/time.js";
import {
  TABLES,
  TABLE_ENV,
  TABLE_NAMES,
  dutyItem,
  leaveItem,
  type Duty,
  type LeaveRequest,
  type TableName,
} from "../src/shared/tables.js";
import { Deadline } from "../src/features/roster/deadline.js";
import { generateRun, publishRun } from "../src/features/roster/service.js";
import { readStackOutputs, requireOutput } from "./stack-outputs.js";

const TEST_WEEK = "2026-12-07";
const PUBLISHED_WEEKS = ["2026-11-23", "2026-11-30", "2026-12-14", "2026-12-21", "2026-12-28"];
const DRAFT_WEEKS = ["2027-01-04"];
const CREATED_AT = "2026-11-19T00:00:00.000Z";

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

function duty(
  date: string,
  type: Duty["type"],
  modality: Duty["modality"],
  doctorsNeeded = 1,
  needsConsultant = false,
): Duty {
  const id = `d-${date}-${type.toLowerCase()}-${modality.toLowerCase()}`;
  return { id, date, type, modality, doctorsNeeded, needsConsultant, cancelled: false };
}

/** The weekly pattern of quality/uat-data.md §2, for the week starting on `monday`. */
function weekPattern(monday: string): Duty[] {
  const day = (n: number) => addDays(monday, n);
  return [
    duty(day(0), "AM", "CT", 2, true),
    duty(day(0), "PM", "MRI", 1, true),
    duty(day(0), "CALL", "XR"),
    duty(day(1), "AM", "US"),
    duty(day(1), "AM", "XR"),
    duty(day(1), "PM", "CT"),
    duty(day(2), "AM", "MRI", 1, true),
    duty(day(2), "PM", "US"),
    duty(day(2), "CALL", "CT"),
    duty(day(3), "AM", "XR"),
    duty(day(3), "PM", "XR"),
    duty(day(4), "AM", "CT"),
    duty(day(4), "PM", "US"),
    duty(day(4), "CALL", "MRI", 1, true),
    duty(day(5), "CALL", "XR"),
  ];
}

function leave(
  doctorId: string,
  startDate: string,
  endDate: string,
  status: LeaveRequest["status"],
): LeaveRequest {
  const decided = status === "approved" || status === "rejected";
  return {
    id: `leave-${doctorId.replace(".", "-")}-${startDate}`,
    doctorId,
    startDate,
    endDate,
    reason: null,
    status,
    createdAt: CREATED_AT,
    decidedAt: decided || status === "cancelled" ? CREATED_AT : null,
    decidedBy: decided ? "coord1" : status === "cancelled" ? doctorId : null,
  };
}

/** quality/uat-data.md §2 leave, without the test week and without the refused overlaps. */
const EXTRA_LEAVE: LeaveRequest[] = [
  leave("asha.rao", "2026-11-26", "2026-11-27", "approved"),
  leave("chen.li", "2026-11-30", "2026-12-01", "rejected"),
  leave("dana.novak", "2026-12-03", "2026-12-03", "approved"),
  leave("chen.li", "2026-12-15", "2026-12-15", "rejected"),
  leave("asha.rao", "2026-12-17", "2026-12-18", "approved"),
  leave("ben.ochieng", "2026-12-17", "2026-12-17", "approved"),
  leave("ben.ochieng", "2026-12-22", "2026-12-22", "cancelled"),
  leave("chen.li", "2026-12-24", "2026-12-26", "approved"),
  leave("dana.novak", "2026-12-27", "2026-12-29", "approved"),
  leave("ben.ochieng", "2026-12-28", "2026-12-29", "pending"),
  leave("chen.li", "2026-12-30", "2026-12-30", "pending"),
  leave("ben.ochieng", "2027-01-05", "2027-01-06", "approved"),
  leave("chen.li", "2027-01-08", "2027-01-08", "pending"),
];

function inTestWeek(date: string): boolean {
  return date >= TEST_WEEK && date <= addDays(TEST_WEEK, 6);
}

async function write(table: TableName, id: string, item: Record<string, unknown>): Promise<void> {
  try {
    await putItem(TABLES[table], item);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Seed failed writing ${id} to the ${table} table: ${message}`, {
      cause: error,
    });
  }
}

async function main(): Promise<void> {
  const outputs = await readStackOutputs();
  process.env.DB_MODE = "dynamodb";
  for (const name of TABLE_NAMES)
    process.env[TABLE_ENV[name]] = requireOutput(outputs, `Table${pascal(name)}`);

  const weeks = [...PUBLISHED_WEEKS, ...DRAFT_WEEKS];
  const duties = weeks.flatMap(weekPattern);
  for (const d of duties) {
    if (inTestWeek(d.date)) throw new Error(`Refusing to write ${d.id}: it is in the test week`);
    await write("duties", d.id, dutyItem(d));
  }
  for (const l of EXTRA_LEAVE) {
    if (inTestWeek(l.startDate) || inTestWeek(l.endDate))
      throw new Error(`Refusing to write ${l.id}: it touches the test week`);
    await write("leave", l.id, leaveItem(l));
  }

  for (const weekStart of weeks) {
    const now = new Date().toISOString();
    await generateRun({ weekStart, weeks: 1, now, deadline: new Deadline() });
    if (PUBLISHED_WEEKS.includes(weekStart))
      await publishRun({ weekStart, weeks: 1, now, deadline: new Deadline() });
  }

  console.log(
    `Added ${duties.length} duties and ${EXTRA_LEAVE.length} leave requests around the week of ` +
      `${TEST_WEEK}; published ${PUBLISHED_WEEKS.join(", ")}; draft only ${DRAFT_WEEKS.join(", ")}. ` +
      `The week of ${TEST_WEEK} is unchanged and has no roster.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
