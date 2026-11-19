/**
 * PlacementChecker (contract C2): the rule types and the one checker the rules Unit (u5) and the
 * roster Unit (u6) both call, so "can this doctor take this duty?" and generation always agree.
 * This file is the authority for C2 where it is more specific than contract-summary.md.
 *
 * Exported helpers
 * - `RuleType`, `settingsSchemas`, `Rule` (zod): the six rule types; unknown keys are rejected.
 * - `validateSettings(rule, doctors)`: parses the settings (ValidationError, 400) and refuses a
 *   `modality_assignment` rule in mode `only` naming a doctor who is unknown or not trained for
 *   any listed modality.
 * - `findContradiction(rule, enabledRules, doctors)`: the other rule this one contradicts, or
 *   undefined. Only kind: two enabled hard `modality_assignment` rules in mode `only` naming the
 *   same doctor (directly or by grade) with no common modality. Pass `rule` as it will be saved
 *   and enabled.
 * - `buildWindow(period, doctorId, draftPlacements, publishedPlacements, options?)`: assembles a
 *   doctor's placements for `checkPlacement`. The window runs from the earlier of (the day before
 *   the period) and (the 1st of the period's first month) to the last day of the last month the
 *   period touches. Each week uses exactly ONE roster version: the draft for the draft weeks (by
 *   default the period's own weeks), otherwise published. Never both. For `/rules/check` on one
 *   duty, use the duty's week as the period and pass `draftWeeks: []` when that week has no draft.
 * - `checkPlacement(input)`: the six always-on checks, then each enabled rule in id order.
 *   `allowed` is false when an always-on check or an enabled hard rule is broken. `broken` lists
 *   always-on checks first (fixed order), then rules by id. Pure: no I/O, no clock.
 *
 * Rule semantics
 * - `duty_limit` and `fair_share` apply only to duties of their `dutyType`.
 * - `fair_share` compares the doctor's count after this placement with the lowest count in
 *   `periodCounts` (before this placement) + 1. The caller decides who is in `periodCounts`:
 *   active doctors trained for the duty's modality, with the run's own placements so far.
 * - `consultant_cover` breaks only on the duty's last open place.
 */
import { z } from "zod";
import { ValidationError } from "./errors.js";
import {
  DUTY_TYPES,
  GRADES,
  MODALITIES,
  type Doctor,
  type Duty,
  type DutyType,
  type Grade,
} from "./tables.js";
import {
  addDays,
  dutyInterval,
  firstOfMonth,
  hoursOf,
  lastOfMonth,
  monthOf,
  overlaps,
  weekOf,
  weeksOf,
} from "./time.js";

// ---------------------------------------------------------------------------------------------
// Rule types and settings
// ---------------------------------------------------------------------------------------------

export const RuleType = z.enum([
  "modality_assignment",
  "duty_limit",
  "rest_after_call",
  "weekly_hours",
  "consultant_cover",
  "fair_share",
]);
export type RuleType = z.infer<typeof RuleType>;

export const Strength = z.enum(["hard", "soft"]);
export type Strength = z.infer<typeof Strength>;

const ModalitySchema = z.enum(MODALITIES);
const DutyTypeSchema = z.enum(DUTY_TYPES);
const GradeSchema = z.enum(GRADES);

export const settingsSchemas = {
  modality_assignment: z.strictObject({
    who: z.union([
      z.strictObject({ doctorIds: z.array(z.string().min(1)).min(1) }),
      z.strictObject({ grade: GradeSchema }),
    ]),
    modalities: z.array(ModalitySchema).min(1),
    mode: z.enum(["only", "preferOn"]),
  }),
  duty_limit: z.strictObject({
    dutyType: DutyTypeSchema,
    max: z.number().int().min(0),
    per: z.enum(["week", "month"]),
  }),
  rest_after_call: z.strictObject({}),
  weekly_hours: z.strictObject({}),
  consultant_cover: z.strictObject({ modalities: z.array(ModalitySchema).min(1) }),
  fair_share: z.strictObject({ dutyType: DutyTypeSchema }),
} as const;

export type RuleSettings = { [T in RuleType]: z.infer<(typeof settingsSchemas)[T]> };

const ruleBase = {
  id: z.string().min(1),
  strength: Strength,
  enabled: z.boolean(),
  createdAt: z.string().optional(),
};

/** A stored rule (rules table item without its keys). */
export const RuleSchema = z.discriminatedUnion("type", [
  z.object({
    ...ruleBase,
    type: z.literal("modality_assignment"),
    settings: settingsSchemas.modality_assignment,
  }),
  z.object({ ...ruleBase, type: z.literal("duty_limit"), settings: settingsSchemas.duty_limit }),
  z.object({
    ...ruleBase,
    type: z.literal("rest_after_call"),
    settings: settingsSchemas.rest_after_call,
  }),
  z.object({
    ...ruleBase,
    type: z.literal("weekly_hours"),
    settings: settingsSchemas.weekly_hours,
  }),
  z.object({
    ...ruleBase,
    type: z.literal("consultant_cover"),
    settings: settingsSchemas.consultant_cover,
  }),
  z.object({ ...ruleBase, type: z.literal("fair_share"), settings: settingsSchemas.fair_share }),
]);
export type Rule = z.infer<typeof RuleSchema>;

type ModalityRule = Extract<Rule, { type: "modality_assignment" }>;

/**
 * Validates a rule's settings for its type and, for `modality_assignment` in mode `only`, that
 * every named doctor exists and is trained for at least one listed modality.
 * Returns the parsed settings; throws ValidationError (400) with the zod issues otherwise.
 */
export function validateSettings<T extends RuleType>(
  rule: { type: T; settings: unknown },
  doctors: readonly Doctor[],
): RuleSettings[T] {
  // Indexed by a runtime string, so an unknown type (from untyped input) gives undefined.
  const schema = (settingsSchemas as Record<string, z.ZodType | undefined>)[rule.type] as
    z.ZodType<RuleSettings[T]> | undefined;
  if (!schema) throw new ValidationError(`Unknown rule type "${String(rule.type)}"`);
  const parsed = schema.safeParse(rule.settings);
  if (!parsed.success) {
    throw new ValidationError(`Invalid settings for ${rule.type}`, parsed.error.issues);
  }
  if (rule.type === "modality_assignment") {
    assertNamedDoctorsTrained(parsed.data as RuleSettings["modality_assignment"], doctors);
  }
  return parsed.data;
}

function assertNamedDoctorsTrained(
  settings: RuleSettings["modality_assignment"],
  doctors: readonly Doctor[],
): void {
  if (settings.mode !== "only" || !("doctorIds" in settings.who)) return;
  const byId = new Map(doctors.map((d) => [d.id, d]));
  for (const id of settings.who.doctorIds) {
    const doctor = byId.get(id);
    if (!doctor) {
      throw new ValidationError(`Doctor ${id} is not a known doctor`, [
        { path: ["settings", "who", "doctorIds"], message: `unknown doctor ${id}` },
      ]);
    }
    if (!settings.modalities.some((m) => doctor.modalities.includes(m))) {
      throw new ValidationError(
        `Doctor ${id} is not trained for any of ${settings.modalities.join(", ")}`,
        [
          {
            path: ["settings", "modalities"],
            message: `${id} is trained for ${doctor.modalities.join(", ")}`,
          },
        ],
      );
    }
  }
}

function whoMatches(
  who: RuleSettings["modality_assignment"]["who"],
  doctor: Pick<Doctor, "id" | "grade">,
): boolean {
  return "doctorIds" in who ? who.doctorIds.includes(doctor.id) : who.grade === doctor.grade;
}

const isHardOnly = (rule: Rule): rule is ModalityRule =>
  rule.type === "modality_assignment" && rule.strength === "hard" && rule.settings.mode === "only";

/** The first other enabled rule (by id) that `rule` contradicts, or undefined. */
export function findContradiction(
  rule: Rule,
  enabledRules: readonly Rule[],
  doctors: readonly Doctor[],
): Rule | undefined {
  if (!isHardOnly(rule)) return undefined;
  const candidates = enabledRules
    .filter((other) => other.id !== rule.id && other.enabled && isHardOnly(other))
    .sort((a, b) => compareIds(a.id, b.id)) as ModalityRule[];
  for (const other of candidates) {
    const common = rule.settings.modalities.some((m) => other.settings.modalities.includes(m));
    if (common) continue;
    const shared = doctors.some(
      (d) => whoMatches(rule.settings.who, d) && whoMatches(other.settings.who, d),
    );
    if (shared) return other;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The placement window (BR3.8)
// ---------------------------------------------------------------------------------------------

export type DutyTypeCounts = Record<DutyType, number>;

/** One doctor on one duty, as read from a roster week joined with its duty. */
export type PlacedDuty = { doctorId: string; duty: Duty };

export type PeriodSpec = { weekStart: string; weeks: number };

/** A doctor's placements, pre-indexed once so checkPlacement only does lookups. */
export type PlacementWindow = {
  doctorId: string;
  from: string;
  to: string;
  /** Duties sorted by date, start hour, then id. */
  placements: Duty[];
  byDate: Map<string, Duty[]>;
  dutyIds: Set<string>;
  weekCounts: Map<string, DutyTypeCounts>;
  monthCounts: Map<string, DutyTypeCounts>;
  weekHours: Map<string, number>;
};

const zeroCounts = (): DutyTypeCounts => ({ AM: 0, PM: 0, CALL: 0 });

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareDuties(a: Duty, b: Duty): number {
  return (
    compareIds(a.date, b.date) ||
    dutyInterval(a).start - dutyInterval(b).start ||
    compareIds(a.id, b.id)
  );
}

/** Indexes a list of duties (one doctor's placements) for checkPlacement. */
export function indexPlacements(
  doctorId: string,
  duties: readonly Duty[],
  from = "",
  to = "",
): PlacementWindow {
  const unique = new Map<string, Duty>();
  for (const duty of duties) if (!duty.cancelled) unique.set(duty.id, duty);
  const placements = [...unique.values()].sort(compareDuties);
  const window: PlacementWindow = {
    doctorId,
    from,
    to,
    placements,
    byDate: new Map(),
    dutyIds: new Set(),
    weekCounts: new Map(),
    monthCounts: new Map(),
    weekHours: new Map(),
  };
  for (const duty of placements) {
    const week = weekOf(duty.date);
    const month = monthOf(duty.date);
    if (!window.byDate.has(duty.date)) window.byDate.set(duty.date, []);
    window.byDate.get(duty.date)!.push(duty);
    window.dutyIds.add(duty.id);
    if (!window.weekCounts.has(week)) window.weekCounts.set(week, zeroCounts());
    if (!window.monthCounts.has(month)) window.monthCounts.set(month, zeroCounts());
    window.weekCounts.get(week)![duty.type] += 1;
    window.monthCounts.get(month)![duty.type] += 1;
    window.weekHours.set(week, (window.weekHours.get(week) ?? 0) + hoursOf(duty.type));
  }
  return window;
}

/** The first and last date of the window for a period (see the header comment). */
export function windowRange(period: PeriodSpec): { from: string; to: string } {
  const weeks = weeksOf(period.weekStart, period.weeks);
  const dayBefore = addDays(period.weekStart, -1);
  const monthStart = firstOfMonth(period.weekStart);
  const from = dayBefore < monthStart ? dayBefore : monthStart;
  const to = lastOfMonth(addDays(weeks[weeks.length - 1], 6));
  return { from, to };
}

export function buildWindow(
  period: PeriodSpec,
  doctorId: string,
  draftPlacements: readonly PlacedDuty[],
  publishedPlacements: readonly PlacedDuty[],
  options: { draftWeeks?: readonly string[] } = {},
): PlacementWindow {
  const { from, to } = windowRange(period);
  const draftWeeks = new Set(options.draftWeeks ?? weeksOf(period.weekStart, period.weeks));
  const inWindow = (p: PlacedDuty) =>
    p.doctorId === doctorId && p.duty.date >= from && p.duty.date <= to;
  const fromDraft = draftPlacements.filter(
    (p) => inWindow(p) && draftWeeks.has(weekOf(p.duty.date)),
  );
  const fromPublished = publishedPlacements.filter(
    (p) => inWindow(p) && !draftWeeks.has(weekOf(p.duty.date)),
  );
  return indexPlacements(
    doctorId,
    [...fromDraft, ...fromPublished].map((p) => p.duty),
    from,
    to,
  );
}

// ---------------------------------------------------------------------------------------------
// checkPlacement
// ---------------------------------------------------------------------------------------------

export const ALWAYS_ON_CHECKS = [
  "trained-modality",
  "approved-leave",
  "time-overlap",
  "consultant-needed",
  "one-daytime-duty",
  "already-on-duty",
] as const;
export type AlwaysOnCheck = (typeof ALWAYS_ON_CHECKS)[number];

export type BrokenRule = { ruleId: string; strength: Strength; reason: string };

export type PlacementResult = { allowed: boolean; broken: BrokenRule[] };

export type PlacementInput = {
  doctor: Doctor;
  duty: Duty;
  /** The doctor's approved leave overlapping the window. */
  approvedLeave: readonly { startDate: string; endDate: string }[];
  /**
   * The doctor's other placements in the window, one roster version per week: a window from
   * buildWindow (fast), or a plain list (indexed on every call).
   */
  doctorPlacements: PlacementWindow | readonly { duty: Duty }[];
  /** Doctors already on this duty. */
  dutyPlacements: readonly { doctorId: string; grade: Grade }[];
  /** Enabled rules (disabled ones are skipped anyway). */
  rules: readonly Rule[];
  /** Counts per duty type in the period, for fair_share. */
  periodCounts: Readonly<Record<string, DutyTypeCounts>>;
};

function sortedEnabled(rules: readonly Rule[]): Rule[] {
  return rules.filter((r) => r.enabled).sort((a, b) => compareIds(a.id, b.id));
}

function toWindow(
  doctorId: string,
  placements: PlacementInput["doctorPlacements"],
): PlacementWindow {
  if (!Array.isArray(placements)) return placements as PlacementWindow;
  return indexPlacements(
    doctorId,
    (placements as readonly { duty: Duty }[]).map((p) => p.duty),
  );
}

type Context = PlacementInput & { window: PlacementWindow; week: string };

/** Other duties of the doctor on `date`, excluding the duty being placed. */
function othersOn(ctx: Context, date: string): Duty[] {
  const list = ctx.window.byDate.get(date);
  if (!list) return [];
  return list.filter((d) => d.id !== ctx.duty.id);
}

const hasConsultant = (ctx: Context) => ctx.dutyPlacements.some((p) => p.grade === "consultant");

const ALWAYS_ON: Record<AlwaysOnCheck, (ctx: Context) => string | undefined> = {
  "trained-modality": ({ doctor, duty }) =>
    doctor.modalities.includes(duty.modality)
      ? undefined
      : `${doctor.id} is not trained for ${duty.modality}`,
  "approved-leave": ({ doctor, duty, approvedLeave }) =>
    approvedLeave.some((l) => l.startDate <= duty.date && duty.date <= l.endDate)
      ? `${doctor.id} has approved leave on ${duty.date}`
      : undefined,
  "time-overlap": (ctx) => {
    const own = dutyInterval(ctx.duty);
    for (const date of [addDays(ctx.duty.date, -1), ctx.duty.date, addDays(ctx.duty.date, 1)]) {
      const clash = othersOn(ctx, date).find((d) => overlaps(own, dutyInterval(d)));
      if (clash) return `${ctx.doctor.id} is already on ${clash.id}, which overlaps in time`;
    }
    return undefined;
  },
  "consultant-needed": (ctx) =>
    ctx.duty.needsConsultant && ctx.doctor.grade === "resident" && !hasConsultant(ctx)
      ? `${ctx.duty.id} needs a consultant and no consultant is on it yet`
      : undefined,
  "one-daytime-duty": (ctx) => {
    if (ctx.duty.type === "CALL") return undefined;
    const other = othersOn(ctx, ctx.duty.date).find((d) => d.type !== "CALL");
    return other
      ? `${ctx.doctor.id} already has the daytime duty ${other.id} on ${ctx.duty.date}`
      : undefined;
  },
  "already-on-duty": (ctx) =>
    ctx.dutyPlacements.some((p) => p.doctorId === ctx.doctor.id) ||
    ctx.window.dutyIds.has(ctx.duty.id)
      ? `${ctx.doctor.id} is already on ${ctx.duty.id}`
      : undefined,
};

/** Count of `type` in a period bucket, excluding the duty being placed, plus this one. */
function countWithThis(ctx: Context, counts: DutyTypeCounts | undefined, type: DutyType): number {
  const already = ctx.window.dutyIds.has(ctx.duty.id) && ctx.duty.type === type ? 1 : 0;
  return (counts?.[type] ?? 0) - already + 1;
}

const RULE_TESTS: {
  [T in RuleType]: (ctx: Context, rule: Extract<Rule, { type: T }>) => string | undefined;
} = {
  modality_assignment: (ctx, { settings }) => {
    const named = whoMatches(settings.who, ctx.doctor);
    const listed = settings.modalities.includes(ctx.duty.modality);
    if (settings.mode === "only") {
      return named && !listed
        ? `${ctx.doctor.id} reports ${settings.modalities.join(", ")} only`
        : undefined;
    }
    return listed && !named
      ? `${ctx.duty.modality} prefers other doctors than ${ctx.doctor.id}`
      : undefined;
  },
  duty_limit: (ctx, { settings }) => {
    if (ctx.duty.type !== settings.dutyType) return undefined;
    const bucket =
      settings.per === "week"
        ? ctx.window.weekCounts.get(ctx.week)
        : ctx.window.monthCounts.get(monthOf(ctx.duty.date));
    const count = countWithThis(ctx, bucket, settings.dutyType);
    return count > settings.max
      ? `${ctx.doctor.id} would have ${count} ${settings.dutyType} duties this ${settings.per} (max ${settings.max})`
      : undefined;
  },
  rest_after_call: (ctx) => {
    if (ctx.duty.type !== "AM") return undefined;
    const call = othersOn(ctx, addDays(ctx.duty.date, -1)).find((d) => d.type === "CALL");
    return call ? `${ctx.doctor.id} is on CALL ${call.id} the night before` : undefined;
  },
  weekly_hours: (ctx) => {
    const already = ctx.window.dutyIds.has(ctx.duty.id) ? hoursOf(ctx.duty.type) : 0;
    const hours = (ctx.window.weekHours.get(ctx.week) ?? 0) - already + hoursOf(ctx.duty.type);
    return hours > ctx.doctor.maxHoursPerWeek
      ? `${ctx.doctor.id} would work ${hours} h in the week of ${ctx.week} (max ${ctx.doctor.maxHoursPerWeek})`
      : undefined;
  },
  consultant_cover: (ctx, { settings }) => {
    const lastPlace = ctx.dutyPlacements.length >= ctx.duty.doctorsNeeded - 1;
    return settings.modalities.includes(ctx.duty.modality) &&
      lastPlace &&
      ctx.doctor.grade === "resident" &&
      !hasConsultant(ctx)
      ? `${ctx.duty.id} would have no consultant`
      : undefined;
  },
  fair_share: (ctx, { settings }) => {
    if (ctx.duty.type !== settings.dutyType) return undefined;
    const own = ctx.periodCounts[ctx.doctor.id]?.[settings.dutyType] ?? 0;
    let lowest = own;
    for (const counts of Object.values(ctx.periodCounts))
      lowest = Math.min(lowest, counts[settings.dutyType] ?? 0);
    return own + 1 > lowest + 1
      ? `${ctx.doctor.id} would have ${own + 1} ${settings.dutyType} duties; the lowest is ${lowest}`
      : undefined;
  },
};

function runRule(ctx: Context, rule: Rule): string | undefined {
  const test = RULE_TESTS[rule.type] as (ctx: Context, rule: Rule) => string | undefined;
  return test(ctx, rule);
}

export function checkPlacement(input: PlacementInput): PlacementResult {
  const ctx: Context = {
    ...input,
    window: toWindow(input.doctor.id, input.doctorPlacements),
    week: weekOf(input.duty.date),
  };
  const broken: BrokenRule[] = [];
  let allowed = true;
  for (const check of ALWAYS_ON_CHECKS) {
    const reason = ALWAYS_ON[check](ctx);
    if (reason) {
      broken.push({ ruleId: `always-on:${check}`, strength: "hard", reason });
      allowed = false;
    }
  }
  for (const rule of sortedEnabled(input.rules)) {
    const reason = runRule(ctx, rule);
    if (reason) {
      broken.push({ ruleId: rule.id, strength: rule.strength, reason });
      if (rule.strength === "hard") allowed = false;
    }
  }
  return { allowed, broken };
}
