/**
 * Roster Unit (u6-roster) data shapes: the zod schemas for the five C9 routes and the C3
 * `leave.approved` payload, the read-model types, and RunTooLongError.
 *
 * Rules: BR1.2 (generate/publish bodies: weekStart a Monday, weeks 1-8 = 4, unknown fields
 * refused), BR1.4 (/roster/mine: from <= to, span at most 56 days, NFR Design R-04), BR1.5 (week
 * reads: weekStart a Monday, version published | draft). Contracts: C1 (RosterWeek), C3
 * (payload checked loosely: required fields with formats, unknown fields stripped, NFR Design
 * R-01), C9 (routes), C4 (errors: RunTooLongError is a ConflictError, so 409).
 */
import { z } from "zod";
import { ConflictError } from "../../shared/errors.js";
import {
  ROSTER_VERSIONS,
  type BrokenSoftRule,
  type Duty,
  type RosterGap,
  type RosterVersion,
  type RosterWeek,
} from "../../shared/tables.js";
import { addDays, isMonday } from "../../shared/time.js";

/** The longest /roster/mine range, in days counted inclusively (8 weeks). */
export const MAX_MINE_SPAN_DAYS = 56;

/** The largest run a request may ask for (NFR1.9). */
export const MAX_RUN_WEEKS = 8;

const safeIsMonday = (date: string): boolean => {
  try {
    return isMonday(date);
  } catch {
    return false;
  }
};

const IsoDate = z.iso.date();
const Monday = IsoDate.refine(safeIsMonday, { message: "must be a Monday" });
const Weeks = z.number().int().min(1).max(MAX_RUN_WEEKS);
const Instant = z.iso.datetime({ offset: true });

/** POST /roster/generate. `now` is honoured only with the test sign-in (BR1.3). */
export const GenerateBody = z.strictObject({
  weekStart: Monday,
  weeks: Weeks.default(4),
  now: Instant.optional(),
});
export type GenerateBody = z.infer<typeof GenerateBody>;

/** POST /roster/publish. */
export const PublishBody = z.strictObject({
  weekStart: Monday,
  weeks: Weeks.default(4),
  now: Instant.optional(),
});
export type PublishBody = z.infer<typeof PublishBody>;

/** GET /roster/weeks/{weekStart} and its coverage. */
export const WeekParams = z.strictObject({ weekStart: Monday });

export const WeekQuery = z.strictObject({
  version: z.enum(ROSTER_VERSIONS).default("published"),
});

/** The empty query of the coverage route: any field is refused. */
export const CoverageQuery = z.strictObject({});

/** True when [from, to] spans at most MAX_MINE_SPAN_DAYS days, counted inclusively. */
const withinSpan = (from: string, to: string): boolean => {
  try {
    return to <= addDays(from, MAX_MINE_SPAN_DAYS - 1);
  } catch {
    return false;
  }
};

/** GET /roster/mine. The doctor comes from req.user only; `doctorId` is an unknown field (400). */
export const MineQuery = z
  .strictObject({ from: IsoDate, to: IsoDate })
  .refine((q) => q.from <= q.to, { message: "from must not be after to", path: ["to"] })
  .refine((q) => withinSpan(q.from, q.to), {
    message: `the range must be at most ${MAX_MINE_SPAN_DAYS} days (8 weeks)`,
    path: ["to"],
  });
export type MineQuery = z.infer<typeof MineQuery>;

/** The C3 payload, checked loosely: required fields with their formats; unknown fields dropped. */
export const LeaveApprovedPayload = z.object({
  leaveId: z.string().min(1),
  doctorId: z.string().min(1),
  startDate: IsoDate,
  endDate: IsoDate,
  approvedBy: z.string().min(1),
  at: Instant,
});
export type LeaveApprovedPayload = z.infer<typeof LeaveApprovedPayload>;

// ---------------------------------------------------------------------------------------------
// Read models (entities.md)
// ---------------------------------------------------------------------------------------------

export type DoctorName = { id: string; name: string };

/**
 * What the week routes return: the rosters item (C1) with the week's non-cancelled duties and the
 * names of the doctors it mentions (an optional field added to C9's RosterWeek).
 */
export type RosterWeekView = RosterWeek & { duties: Duty[]; doctors: DoctorName[] };

/** One of the caller's published placements (GET /roster/mine). */
export type MyDuty = { duty: Duty; place: number; locked: boolean };

export type LockedClash = { dutyId: string; place: number; doctorId: string; reason: string };

export type DoctorHours = { doctorId: string; hours: number; max: number | null };

/** GET /roster/weeks/{weekStart}/coverage (BR9). */
export type CoverageReport = {
  weekStart: string;
  version: RosterVersion;
  unfilled: RosterGap[];
  brokenSoftRules: BrokenSoftRule[];
  lockedClashes: LockedClash[];
  hours: DoctorHours[];
};

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export const RUN_TOO_LONG_MESSAGE = "Generation took longer than 15 seconds; generate fewer weeks";

export type DeadlineStage = "read" | "place" | "write";

/** The 15 s soft cut-off (NFR1.3). A ConflictError, so the error middleware answers 409. */
export class RunTooLongError extends ConflictError {
  readonly stage: DeadlineStage | undefined;
  readonly elapsedMs: number | undefined;

  constructor(
    message: string = RUN_TOO_LONG_MESSAGE,
    info: { stage?: DeadlineStage; elapsedMs?: number } = {},
  ) {
    super(message);
    this.stage = info.stage;
    this.elapsedMs = info.elapsedMs;
  }
}
