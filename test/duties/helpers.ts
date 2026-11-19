/**
 * Shared test helpers for the Duties Unit (u3-duties). Source: quality/duties-test-cases.md
 * section 7.1. The tables are emptied before every test by test/setup.ts.
 */
import { expect } from "vitest";
import type { Response } from "supertest";
import { putItem } from "../../src/shared/db.js";
import { TABLES, dutyItem, type Duty } from "../../src/shared/tables.js";
// Read-only use of the skeleton's example data; feature Units never edit scripts/*.
import { EXAMPLE_DUTIES as SEED_DUTIES } from "../../scripts/example-data.js";

export const COORD = { "X-User-Id": "coord1", "X-User-Role": "coordinator" };
export const DOCTOR = { "X-User-Id": "ben.ochieng", "X-User-Role": "doctor" };

/** The seven Duty fields, sorted: exactly what every response item carries (BR4.4). */
export const DUTY_FIELDS = [
  "cancelled",
  "date",
  "doctorsNeeded",
  "id",
  "modality",
  "needsConsultant",
  "type",
];

/** Stores a duty with the C1 keys, using the skeleton's own item builder. */
export async function seedDuty(duty: Duty): Promise<void> {
  await putItem(TABLES.duties, dutyItem(duty));
}

/** The six example duties, ids "d-<date>-<type>-<modality>" (fresh copies, never the seed's). */
export const EXAMPLE_DUTIES: Duty[] = SEED_DUTIES.map((d) => ({ ...d }));

/**
 * The AC1.5.1 order: start date, then start time, then id. Written out in full rather than
 * derived from EXAMPLE_DUTIES, so a change in the seed's order cannot hide a sorting bug.
 */
export const EXAMPLE_ORDER = [
  "d-2026-12-07-am-ct",
  "d-2026-12-07-call-xr",
  "d-2026-12-08-am-mri",
  "d-2026-12-08-am-us",
  "d-2026-12-08-am-xr",
  "d-2026-12-09-pm-xr",
];

/** Seeds the example duties in reverse, so a passing order test proves sorting. */
export async function seedExampleWeek(): Promise<void> {
  for (const duty of [...EXAMPLE_DUTIES].reverse()) await seedDuty(duty);
}

/** A valid create body (AC1.4.1). */
export const VALID_BODY = {
  date: "2026-12-07",
  type: "AM",
  modality: "CT",
  doctorsNeeded: 2,
  needsConsultant: true,
};

const ERROR_FOR_STATUS: Record<number, string> = {
  400: "validation",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
};

/** TC-DUT-A40: checks the status and the C4 ErrorBody shape. */
export function expectError(res: Response, status: number, field?: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error).toBe(ERROR_FOR_STATUS[status]);
  expect(typeof res.body.message).toBe("string");
  expect(Array.isArray(res.body.details)).toBe(true);
  if (status === 400) {
    expect(res.body.details.length).toBeGreaterThan(0);
    if (field) expect(JSON.stringify(res.body.details)).toContain(field);
  } else {
    expect(res.body.details).toEqual([]);
  }
}
