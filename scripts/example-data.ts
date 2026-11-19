/**
 * The example data from vision.md, with fixed ids. Made up; no real staff data.
 * Used by `npm run seed` (scripts/seed.ts) and by the skeleton's test fixtures
 * (test/shared/fixtures.ts), so the deployed example and the tests agree.
 */
import type { Doctor, Duty, LeaveRequest, Rule } from "../src/shared/tables.js";

export const EXAMPLE_CREATED_AT = "2026-11-18T00:00:00.000Z";

export const EXAMPLE_DOCTORS: readonly Doctor[] = [
  {
    id: "asha.rao",
    name: "Dr Asha Rao",
    grade: "consultant",
    modalities: ["CT", "MRI"],
    maxHoursPerWeek: 40,
    active: true,
  },
  {
    id: "ben.ochieng",
    name: "Dr Ben Ochieng",
    grade: "resident",
    modalities: ["CT", "XR"],
    maxHoursPerWeek: 40,
    active: true,
  },
  {
    id: "chen.li",
    name: "Dr Chen Li",
    grade: "resident",
    modalities: ["US", "XR"],
    maxHoursPerWeek: 40,
    active: true,
  },
  {
    id: "dana.novak",
    name: "Dr Dana Novak",
    grade: "consultant",
    modalities: ["MRI", "US"],
    maxHoursPerWeek: 40,
    active: true,
  },
];

function duty(
  date: string,
  type: Duty["type"],
  modality: Duty["modality"],
  doctorsNeeded: number,
  needsConsultant: boolean,
): Duty {
  const id = `d-${date}-${type.toLowerCase()}-${modality.toLowerCase()}`;
  return { id, date, type, modality, doctorsNeeded, needsConsultant, cancelled: false };
}

/** The six duties of the week of 2026-12-07. Ids are "d-<date>-<type>-<modality>". */
export const EXAMPLE_DUTIES: readonly Duty[] = [
  duty("2026-12-07", "AM", "CT", 2, true),
  duty("2026-12-07", "CALL", "XR", 1, false),
  duty("2026-12-08", "AM", "MRI", 1, true),
  duty("2026-12-08", "AM", "US", 1, false),
  duty("2026-12-08", "AM", "XR", 1, false),
  duty("2026-12-09", "PM", "XR", 1, false),
];

export const EXAMPLE_LEAVE: readonly LeaveRequest[] = [
  {
    id: "leave-chen-li-2026-12-07",
    doctorId: "chen.li",
    startDate: "2026-12-07",
    endDate: "2026-12-09",
    reason: null,
    status: "approved",
    createdAt: EXAMPLE_CREATED_AT,
    decidedAt: EXAMPLE_CREATED_AT,
    decidedBy: "coord1",
  },
];

export const EXAMPLE_RULES: readonly Rule[] = [
  {
    id: "rule-1-rest-after-call",
    type: "rest_after_call",
    strength: "hard",
    enabled: true,
    settings: {},
    createdAt: EXAMPLE_CREATED_AT,
  },
  {
    id: "rule-2-residents-on-xr",
    type: "modality_assignment",
    strength: "soft",
    enabled: true,
    settings: { who: { grade: "resident" }, modalities: ["XR"], mode: "preferOn" },
    createdAt: EXAMPLE_CREATED_AT,
  },
  {
    id: "rule-3-one-call-per-week",
    type: "duty_limit",
    strength: "hard",
    enabled: true,
    settings: { dutyType: "CALL", max: 1, per: "week" },
    createdAt: EXAMPLE_CREATED_AT,
  },
];
