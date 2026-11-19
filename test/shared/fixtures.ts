// Test fixtures: the vision.md example data (fixed ids) and small builders.
// Each builder returns a fresh copy, so no test can change another test's data.
import {
  EXAMPLE_DOCTORS,
  EXAMPLE_DUTIES,
  EXAMPLE_LEAVE,
  EXAMPLE_RULES,
} from "../../scripts/example-data.js";
import type { PlacementInput } from "../../src/shared/rules.js";
import type { Doctor, Duty, Rule } from "../../src/shared/tables.js";

const clone = <T>(value: T): T => structuredClone(value);

export type DoctorId = "asha.rao" | "ben.ochieng" | "chen.li" | "dana.novak";

export function doctor(id: DoctorId, overrides: Partial<Doctor> = {}): Doctor {
  const found = EXAMPLE_DOCTORS.find((d) => d.id === id);
  if (!found) throw new Error(`No example doctor ${id}`);
  return { ...clone(found), ...overrides };
}

/** An example duty by id ("d-2026-12-08-am-xr"), or a new duty built from `overrides`. */
export function duty(id: string, overrides: Partial<Duty> = {}): Duty {
  const found = EXAMPLE_DUTIES.find((d) => d.id === id);
  const base: Duty = found
    ? clone(found)
    : {
        id,
        date: "2026-12-07",
        type: "AM",
        modality: "CT",
        doctorsNeeded: 1,
        needsConsultant: false,
        cancelled: false,
      };
  return { ...base, ...overrides };
}

export const exampleRules = (): Rule[] => clone([...EXAMPLE_RULES]);

export const exampleLeave = () => clone([...EXAMPLE_LEAVE]);

export const exampleDoctors = (): Doctor[] => clone([...EXAMPLE_DOCTORS]);

export const exampleDuties = (): Duty[] => clone([...EXAMPLE_DUTIES]);

/** A PlacementInput with nothing placed, no leave and no rules; override what the test needs. */
export function placementInput(
  doctorValue: Doctor,
  dutyValue: Duty,
  overrides: Partial<PlacementInput> = {},
): PlacementInput {
  return {
    doctor: doctorValue,
    duty: dutyValue,
    approvedLeave: [],
    doctorPlacements: [],
    dutyPlacements: [],
    rules: [],
    periodCounts: {},
    ...overrides,
  };
}
