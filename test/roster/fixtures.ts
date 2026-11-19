// Roster Unit test fixtures (u6-roster): seed helpers on the in-memory tables, generated speed
// data and a fake monotonic clock. Every builder returns fresh copies, so tests never share
// mutable data. Items are written with the skeleton's item builders (contract C1).
import {
  EXAMPLE_CREATED_AT,
  EXAMPLE_DOCTORS,
  EXAMPLE_DUTIES,
  EXAMPLE_LEAVE,
  EXAMPLE_RULES,
} from "../../scripts/example-data.js";
import { putItem } from "../../src/shared/db.js";
import {
  MODALITIES,
  TABLES,
  doctorItem,
  dutyItem,
  leaveItem,
  ruleItem,
  type Doctor,
  type Duty,
  type DutyType,
  type LeaveRequest,
  type Modality,
  type Rule,
} from "../../src/shared/tables.js";
import { addDays, weeksOf } from "../../src/shared/time.js";

const clone = <T>(value: T): T => structuredClone(value);

/** The Monday of the example week (vision.md). */
export const EXAMPLE_WEEK = "2026-12-07";

/** A time well before the example week, when no example duty is locked. */
export const EARLY_NOW = "2026-12-01T00:00:00.000Z";

export type SeedData = {
  doctors?: readonly Doctor[];
  duties?: readonly Duty[];
  leave?: readonly LeaveRequest[];
  rules?: readonly Rule[];
};

export type ExampleData = {
  doctors: Doctor[];
  duties: Duty[];
  leave: LeaveRequest[];
  rules: Rule[];
};

/** Fresh copies of the example data from scripts/example-data.ts. */
export function exampleData(): ExampleData {
  return {
    doctors: clone([...EXAMPLE_DOCTORS]),
    duties: clone([...EXAMPLE_DUTIES]),
    leave: clone([...EXAMPLE_LEAVE]),
    rules: clone([...EXAMPLE_RULES]),
  };
}

/** Writes doctors, duties, leave and rules through the table helpers and item builders. */
export async function seedTables(data: SeedData): Promise<void> {
  for (const doctor of data.doctors ?? []) await putItem(TABLES.doctors, doctorItem(doctor));
  for (const duty of data.duties ?? []) await putItem(TABLES.duties, dutyItem(duty));
  for (const request of data.leave ?? []) await putItem(TABLES.leave, leaveItem(request));
  for (const rule of data.rules ?? []) await putItem(TABLES.rules, ruleItem(rule));
}

/** Seeds the whole example: four doctors, six duties, Chen Li's approved leave, three rules. */
export async function seedExample(): Promise<ExampleData> {
  const data = exampleData();
  await seedTables(data);
  return data;
}

/** A leave request; approved by default. */
export function leaveRequest(
  doctorId: string,
  startDate: string,
  endDate: string,
  overrides: Partial<LeaveRequest> = {},
): LeaveRequest {
  return {
    id: `leave-${doctorId}-${startDate}`,
    doctorId,
    startDate,
    endDate,
    reason: null,
    status: "approved",
    createdAt: EXAMPLE_CREATED_AT,
    decidedAt: EXAMPLE_CREATED_AT,
    decidedBy: "coord1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Generated speed data
// ---------------------------------------------------------------------------------------------

/** The first Monday of the generated data (four weeks after the example week). */
export const SPEED_WEEK = "2027-01-04";

const pad = (n: number) => String(n).padStart(2, "0");

function speedDoctors(count: number): Doctor[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${pad(i + 1)}`,
    name: `Dr Test ${pad(i + 1)}`,
    grade: i % 5 < 2 ? "consultant" : "resident",
    modalities: [MODALITIES[i % 4], MODALITIES[(i + 1) % 4]],
    maxHoursPerWeek: 40,
    active: true,
  }));
}

function speedDuty(
  date: string,
  type: DutyType,
  modality: Modality,
  doctorsNeeded: number,
  needsConsultant: boolean,
): Duty {
  const id = `s-${date}-${type.toLowerCase()}-${modality.toLowerCase()}`;
  return { id, date, type, modality, doctorsNeeded, needsConsultant, cancelled: false };
}

/** 25 duties per week: five per weekday (two AM, two PM, one CALL), modalities rotating. */
function speedDuties(weekStart: string, weeks: number): Duty[] {
  const duties: Duty[] = [];
  for (const monday of weeksOf(weekStart, weeks)) {
    for (let day = 0; day < 5; day += 1) {
      const date = addDays(monday, day);
      duties.push(
        speedDuty(date, "AM", "CT", 2, true),
        speedDuty(date, "AM", "MRI", 1, true),
        speedDuty(date, "PM", "US", 1, false),
        speedDuty(date, "PM", "XR", 2, false),
        speedDuty(date, "CALL", MODALITIES[day % 4], 1, false),
      );
    }
  }
  return duties;
}

function speedRules(): Rule[] {
  return [
    ...clone([...EXAMPLE_RULES]),
    {
      id: "rule-4-weekly-hours",
      type: "weekly_hours",
      strength: "hard",
      enabled: true,
      settings: {},
    },
    {
      id: "rule-5-fair-calls",
      type: "fair_share",
      strength: "soft",
      enabled: true,
      settings: { dutyType: "CALL" },
    },
  ];
}

/**
 * Deterministic generated data: `doctorCount` active doctors (fixed ids doc-01...), 25 duties per
 * week for `weeks` weeks from SPEED_WEEK, two approved leave requests and five rules.
 */
export function makeData(doctorCount: number, weeks: number): ExampleData & { weekStart: string } {
  const doctors = speedDoctors(doctorCount);
  const leave = [
    leaveRequest(doctors[2 % doctorCount].id, SPEED_WEEK, addDays(SPEED_WEEK, 2)),
    leaveRequest(doctors[6 % doctorCount].id, addDays(SPEED_WEEK, 7), addDays(SPEED_WEEK, 11)),
  ];
  return {
    weekStart: SPEED_WEEK,
    doctors,
    duties: speedDuties(SPEED_WEEK, weeks),
    leave,
    rules: speedRules(),
  };
}

// ---------------------------------------------------------------------------------------------
// Fake monotonic clock
// ---------------------------------------------------------------------------------------------

/**
 * A fake monotonic clock for the Deadline. `now()` returns the current time and then moves it
 * on by `stepMs` (0 by default); `advance(ms)` moves it by hand. No real time passes.
 */
export class FakeClock {
  private current: number;
  reads = 0;

  constructor(
    start = 0,
    private readonly stepMs = 0,
  ) {
    this.current = start;
  }

  readonly now = (): number => {
    const value = this.current;
    this.current += this.stepMs;
    this.reads += 1;
    return value;
  };

  advance(ms: number): void {
    this.current += ms;
  }
}
