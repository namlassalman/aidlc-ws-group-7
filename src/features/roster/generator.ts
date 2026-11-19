/**
 * Generator (u6-roster): the pure, deterministic fill algorithm (W1 steps 3-6).
 * `generate(inputs, now, deadline)` has no I/O, no clock and no randomness: the same inputs and
 * `now` give byte-identical weeks (BR3.6, NFR5.1). The deadline only stops a run; it never
 * changes what is placed.
 *
 * Rules: BR2.3-BR2.5 (carry locked published doctors at their place numbers, R-05; fill empty
 * locked places, Q4: B), BR3.1 (allowed = checkPlacement from src/shared/rules.ts, with the
 * window from buildWindow and periodCounts for the active doctors trained for the modality),
 * BR3.2 (fewest-allowed place first; ties by duty start, duty id, place), BR3.3 (fewest broken
 * soft rules, then fewest duties that month, then lowest id), BR3.4 (record broken soft rules),
 * BR3.5 (gaps only when no open place has an allowed doctor), BR3.7 and NFR1.4 (incremental
 * recount, identical to a full recount), BR4.1-BR4.5 (gap reasons and suggestions).
 * Contracts: C1 (RosterWeek item shape), C2 (checkPlacement, buildWindow, DutyCalendar), C9
 * (the drafts POST /roster/generate returns).
 */
import {
  buildWindow,
  checkPlacement,
  indexPlacements,
  type BrokenRule,
  type DutyTypeCounts,
  type PlacedDuty,
  type PlacementResult,
  type PlacementWindow,
  type Rule,
} from "../../shared/rules.js";
import type {
  BrokenSoftRule,
  Doctor,
  Duty,
  DutyType,
  LeaveRequest,
  RosterGap,
  RosterPlacement,
  RosterWeek,
  RuleType,
} from "../../shared/tables.js";
import { addDays, dutyInterval, isLocked, monthOf, weekOf, weeksOf } from "../../shared/time.js";
import type { DeadlineCheck } from "./deadline.js";

export type GeneratorInputs = {
  weekStart: string;
  weeks: number;
  /** Every doctor. Only active ones are placed; the others are needed for carried locked places. */
  doctors: readonly Doctor[];
  /** The duties dated in the run's weeks (cancelled ones are ignored). */
  duties: readonly Duty[];
  /** The duties in the placement window, to join published placements outside the run. */
  windowDuties: readonly Duty[];
  /** Approved leave overlapping the window. */
  approvedLeave: readonly Pick<LeaveRequest, "doctorId" | "startDate" | "endDate">[];
  /** Rules; only enabled ones are used. */
  rules: readonly Rule[];
  /** Published weeks in the window. */
  publishedWeeks: readonly RosterWeek[];
};

/** The allowed doctors of every open place after one recount (step 0 is the first count). */
export type StepSnapshot = { step: number; allowed: Record<string, string[]> };

export type GeneratorOptions = {
  /** Recount every open place after each placement (slow; for the equivalence test). */
  fullRecount?: boolean;
  onStep?: (snapshot: StepSnapshot) => void;
};

export type RunStats = { duties: number; places: number; placements: number; gaps: number };

export type GeneratorResult = { weeks: RosterWeek[]; stats: RunStats };

/** A rule type in words, for gap reasons (BR4.1, Q1: B). */
export const RULE_LABELS: Readonly<Record<RuleType, string>> = {
  modality_assignment: "modality assignment",
  duty_limit: "duty limit",
  rest_after_call: "rest after call",
  weekly_hours: "weekly hours",
  consultant_cover: "consultant cover",
  fair_share: "fair share",
};

// ---------------------------------------------------------------------------------------------
// Ordering helpers (exported for the service, which sorts merged weeks the same way)
// ---------------------------------------------------------------------------------------------

export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareDuties(a: Duty, b: Duty): number {
  return dutyInterval(a).start - dutyInterval(b).start || compareStrings(a.id, b.id);
}

/** Sorts a week's lists as entities.md states, looking duties up by id. */
export function sortWeekLists(
  week: Pick<RosterWeek, "placements" | "gaps" | "brokenSoftRules">,
  dutyById: ReadonlyMap<string, Duty>,
): Pick<RosterWeek, "placements" | "gaps" | "brokenSoftRules"> {
  const start = (id: string) => {
    const duty = dutyById.get(id);
    return duty ? dutyInterval(duty).start : Number.MAX_SAFE_INTEGER;
  };
  const byDuty = (a: string, b: string) => start(a) - start(b) || compareStrings(a, b);
  return {
    placements: [...week.placements].sort(
      (a, b) => byDuty(a.dutyId, b.dutyId) || a.place - b.place,
    ),
    gaps: [...week.gaps].sort((a, b) => byDuty(a.dutyId, b.dutyId) || a.place - b.place),
    brokenSoftRules: [...week.brokenSoftRules].sort(
      (a, b) =>
        byDuty(a.dutyId, b.dutyId) ||
        compareStrings(a.doctorId, b.doctorId) ||
        compareStrings(a.ruleId, b.ruleId),
    ),
  };
}

const isAlwaysOn = (broken: BrokenRule) => broken.ruleId.startsWith("always-on:");

const softCount = (result: PlacementResult) =>
  result.broken.filter((b) => b.strength === "soft").length;

/** Enabled hard rules broken (never an always-on check), in rule-id order as checkPlacement gives. */
const hardRuleIds = (result: PlacementResult) =>
  result.broken.filter((b) => b.strength === "hard" && !isAlwaysOn(b)).map((b) => b.ruleId);

const zeroCounts = (): DutyTypeCounts => ({ AM: 0, PM: 0, CALL: 0 });

// ---------------------------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------------------------

type OpenPlace = {
  duty: Duty;
  place: number;
  key: string;
  /** Active doctors trained for the duty's modality, by id (computed once). */
  candidates: readonly Doctor[];
  results: Map<string, PlacementResult>;
};

type RunState = {
  period: { weekStart: string; weeks: number };
  now: string;
  runWeeks: readonly string[];
  doctorsById: Map<string, Doctor>;
  active: Doctor[];
  duties: Duty[];
  dutyById: Map<string, Duty>;
  lockedDutyIds: Set<string>;
  rules: Rule[];
  ruleById: Map<string, Rule>;
  fairShareTypes: Set<DutyType>;
  leaveByDoctor: Map<string, { startDate: string; endDate: string }[]>;
  windows: Map<string, PlacementWindow>;
  placements: RosterPlacement[];
  byDuty: Map<string, RosterPlacement[]>;
  soft: BrokenSoftRule[];
  runCounts: Map<string, DutyTypeCounts>;
  open: OpenPlace[];
};

function groupLeave(inputs: GeneratorInputs): RunState["leaveByDoctor"] {
  const byDoctor = new Map<string, { startDate: string; endDate: string }[]>();
  for (const leave of inputs.approvedLeave) {
    const list = byDoctor.get(leave.doctorId) ?? [];
    list.push({ startDate: leave.startDate, endDate: leave.endDate });
    byDoctor.set(leave.doctorId, list);
  }
  return byDoctor;
}

function prepare(inputs: GeneratorInputs, now: string): RunState {
  const runWeeks = weeksOf(inputs.weekStart, inputs.weeks);
  const runEnd = addDays(runWeeks[runWeeks.length - 1], 6);
  const doctors = [...inputs.doctors].sort((a, b) => compareStrings(a.id, b.id));
  const duties = inputs.duties
    .filter((d) => !d.cancelled && d.date >= inputs.weekStart && d.date <= runEnd)
    .sort(compareDuties);
  const rules = inputs.rules.filter((r) => r.enabled).sort((a, b) => compareStrings(a.id, b.id));
  return {
    period: { weekStart: inputs.weekStart, weeks: inputs.weeks },
    now,
    runWeeks,
    doctorsById: new Map(doctors.map((d) => [d.id, d])),
    active: doctors.filter((d) => d.active),
    duties,
    dutyById: new Map(duties.map((d) => [d.id, d])),
    lockedDutyIds: new Set(duties.filter((d) => isLocked(d, now)).map((d) => d.id)),
    rules,
    ruleById: new Map(rules.map((r) => [r.id, r])),
    fairShareTypes: new Set(
      rules.flatMap((r) => (r.type === "fair_share" ? [r.settings.dutyType] : [])),
    ),
    leaveByDoctor: groupLeave(inputs),
    windows: new Map(),
    placements: [],
    byDuty: new Map(),
    soft: [],
    runCounts: new Map(),
    open: [],
  };
}

/** One window per active doctor, from the published placements outside the run (BR2.2). */
function buildWindows(state: RunState, inputs: GeneratorInputs): void {
  const runWeeks = new Set(state.runWeeks);
  const windowDuties = new Map(
    inputs.windowDuties.filter((d) => !d.cancelled).map((d) => [d.id, d]),
  );
  const published = new Map<string, PlacedDuty[]>();
  const weeks = [...inputs.publishedWeeks].sort((a, b) => compareStrings(a.weekStart, b.weekStart));
  for (const week of weeks) {
    if (runWeeks.has(week.weekStart)) continue;
    for (const placement of week.placements) {
      const duty = windowDuties.get(placement.dutyId);
      if (!duty) continue;
      const list = published.get(placement.doctorId) ?? [];
      list.push({ doctorId: placement.doctorId, duty });
      published.set(placement.doctorId, list);
    }
  }
  for (const doctor of state.active) {
    const own = published.get(doctor.id) ?? [];
    state.windows.set(doctor.id, buildWindow(state.period, doctor.id, [], own));
  }
}

function recordPlacement(
  state: RunState,
  duty: Duty,
  placement: RosterPlacement,
  soft: readonly BrokenSoftRule[],
): void {
  state.placements.push(placement);
  const onDuty = state.byDuty.get(duty.id) ?? [];
  onDuty.push(placement);
  state.byDuty.set(duty.id, onDuty);
  const window = state.windows.get(placement.doctorId);
  if (window) {
    const placements = [...window.placements, duty];
    state.windows.set(
      placement.doctorId,
      indexPlacements(placement.doctorId, placements, window.from, window.to),
    );
  }
  const counts = state.runCounts.get(placement.doctorId) ?? zeroCounts();
  counts[duty.type] += 1;
  state.runCounts.set(placement.doctorId, counts);
  state.soft.push(...soft);
}

/** BR2.3: published doctors on duties locked at `now` stay, at their place numbers (R-05). */
function carryLockedPlaces(state: RunState, publishedWeeks: readonly RosterWeek[]): void {
  const runWeeks = new Set(state.runWeeks);
  const publishedByWeek = new Map(
    publishedWeeks.filter((w) => runWeeks.has(w.weekStart)).map((w) => [w.weekStart, w]),
  );
  for (const duty of state.duties) {
    if (!state.lockedDutyIds.has(duty.id)) continue;
    const published = publishedByWeek.get(weekOf(duty.date));
    if (!published) continue; // BR2.5: nothing published, every place is open
    const carried = published.placements
      .filter((p) => p.dutyId === duty.id)
      .sort((a, b) => a.place - b.place || compareStrings(a.doctorId, b.doctorId));
    for (const p of carried) {
      const soft = published.brokenSoftRules
        .filter((s) => s.dutyId === duty.id && s.doctorId === p.doctorId)
        .map((s) => ({
          dutyId: s.dutyId,
          doctorId: s.doctorId,
          ruleId: s.ruleId,
          reason: s.reason,
        }));
      recordPlacement(
        state,
        duty,
        { dutyId: duty.id, place: p.place, doctorId: p.doctorId, locked: true },
        soft,
      );
    }
  }
}

/** Every place not carried is open (BR2.4: empty locked places too). */
function openPlaces(state: RunState): void {
  for (const duty of state.duties) {
    const taken = new Set((state.byDuty.get(duty.id) ?? []).map((p) => p.place));
    const candidates = state.active.filter((d) => d.modalities.includes(duty.modality));
    for (let place = 1; place <= duty.doctorsNeeded; place += 1) {
      if (taken.has(place)) continue;
      state.open.push({ duty, place, key: `${duty.id}#${place}`, candidates, results: new Map() });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Checking and recounting
// ---------------------------------------------------------------------------------------------

/** The run's own counts for the active doctors trained for the duty's modality (fair_share). */
function periodCountsFor(state: RunState, duty: Duty): Record<string, DutyTypeCounts> {
  const counts: Record<string, DutyTypeCounts> = {};
  for (const doctor of state.active) {
    if (doctor.modalities.includes(duty.modality)) {
      counts[doctor.id] = { ...(state.runCounts.get(doctor.id) ?? zeroCounts()) };
    }
  }
  return counts;
}

function evaluate(state: RunState, duty: Duty, doctor: Doctor): PlacementResult {
  const onDuty = state.byDuty.get(duty.id) ?? [];
  return checkPlacement({
    doctor,
    duty,
    approvedLeave: state.leaveByDoctor.get(doctor.id) ?? [],
    doctorPlacements: state.windows.get(doctor.id) ?? [],
    dutyPlacements: onDuty.map((p) => ({
      doctorId: p.doctorId,
      grade: state.doctorsById.get(p.doctorId)?.grade ?? "resident",
    })),
    rules: state.rules,
    // Only fair_share reads periodCounts, so without one an empty object gives the same result.
    periodCounts: state.fairShareTypes.size > 0 ? periodCountsFor(state, duty) : {},
  });
}

function recount(state: RunState, open: OpenPlace, doctors: readonly Doctor[] = open.candidates) {
  for (const doctor of doctors) open.results.set(doctor.id, evaluate(state, open.duty, doctor));
}

/**
 * NFR1.4: after `doctorId` is placed on `duty`, only these results can change: every candidate
 * on the same duty's places (duty placements and consultant cover), the placed doctor on every
 * place they are a candidate for (their window), and every candidate on places of the same type
 * when an enabled fair_share rule covers it (period counts).
 */
function recountAffected(state: RunState, duty: Duty, doctorId: string): void {
  const doctor = state.doctorsById.get(doctorId);
  const fairShare = state.fairShareTypes.has(duty.type);
  for (const open of state.open) {
    if (open.duty.id === duty.id || (fairShare && open.duty.type === duty.type)) {
      recount(state, open);
    } else if (doctor && open.results.has(doctorId)) {
      recount(state, open, [doctor]);
    }
  }
}

const allowedDoctors = (open: OpenPlace) =>
  open.candidates.filter((d) => open.results.get(d.id)?.allowed === true);

/** BR3.2: the open place with the fewest allowed doctors; `open` is already in tie-break order. */
function pickPlace(state: RunState): OpenPlace | undefined {
  let best: OpenPlace | undefined;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const open of state.open) {
    const count = allowedDoctors(open).length;
    if (count > 0 && count < bestCount) {
      best = open;
      bestCount = count;
    }
  }
  return best;
}

function monthDuties(state: RunState, doctorId: string, date: string): number {
  const counts = state.windows.get(doctorId)?.monthCounts.get(monthOf(date));
  return counts ? counts.AM + counts.PM + counts.CALL : 0;
}

/** BR3.3: fewest broken soft rules, then fewest duties that month, then lowest id. */
function pickDoctor(state: RunState, open: OpenPlace): Doctor {
  const ranked = allowedDoctors(open).map((doctor) => ({
    doctor,
    soft: softCount(open.results.get(doctor.id)!),
    month: monthDuties(state, doctor.id, open.duty.date),
  }));
  ranked.sort(
    (a, b) => a.soft - b.soft || a.month - b.month || compareStrings(a.doctor.id, b.doctor.id),
  );
  return ranked[0].doctor;
}

function snapshot(state: RunState, step: number, options: GeneratorOptions): void {
  if (!options.onStep) return;
  const allowed: Record<string, string[]> = {};
  for (const open of state.open) allowed[open.key] = allowedDoctors(open).map((d) => d.id);
  options.onStep({ step, allowed });
}

function fill(state: RunState, deadline: DeadlineCheck, options: GeneratorOptions): void {
  for (const open of state.open) recount(state, open);
  let step = 0;
  snapshot(state, step, options);
  for (let next = pickPlace(state); next; next = pickPlace(state)) {
    const doctor = pickDoctor(state, next);
    const result = next.results.get(doctor.id)!;
    const chosen = next;
    state.open = state.open.filter((open) => open !== chosen);
    const soft = result.broken
      .filter((b) => b.strength === "soft")
      .map((b) => ({
        dutyId: chosen.duty.id,
        doctorId: doctor.id,
        ruleId: b.ruleId,
        reason: b.reason,
      }));
    const locked = state.lockedDutyIds.has(chosen.duty.id);
    recordPlacement(
      state,
      chosen.duty,
      { dutyId: chosen.duty.id, place: chosen.place, doctorId: doctor.id, locked },
      soft,
    );
    deadline.check("place");
    if (options.fullRecount) for (const open of state.open) recount(state, open);
    else recountAffected(state, chosen.duty, doctor.id);
    step += 1;
    snapshot(state, step, options);
  }
}

// ---------------------------------------------------------------------------------------------
// Gaps (BR4)
// ---------------------------------------------------------------------------------------------

const nameOf = (state: RunState, id: string) => state.doctorsById.get(id)?.name ?? id;

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function hardLabels(state: RunState, result: PlacementResult): string {
  const labels: string[] = [];
  for (const id of hardRuleIds(result)) {
    const type = state.ruleById.get(id)?.type;
    const label = type ? RULE_LABELS[type] : id;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(", ");
}

type Evaluated = { doctor: Doctor; result: PlacementResult };

/** BR4.1: one or more trained doctors pass every always-on check; names repeated, no pronoun. */
function freeReason(state: RunState, duty: Duty, free: readonly Evaluated[]): string {
  if (free.length === 1) {
    const name = nameOf(state, free[0].doctor.id);
    const labels = hardLabels(state, free[0].result);
    return `${name} is the only ${duty.modality}-trained doctor free; ${labels} (hard) blocks ${name}`;
  }
  const names = listNames(free.map((e) => nameOf(state, e.doctor.id)));
  const parts = free.map(
    (e) => `${nameOf(state, e.doctor.id)}: ${hardLabels(state, e.result)} (hard)`,
  );
  return `${names} are the only ${duty.modality}-trained doctors free; ${parts.join("; ")}`;
}

/** BR4.2: nobody trained passes the always-on checks. */
function noneFreeReason(state: RunState, duty: Duty): string {
  const onDuty = state.byDuty.get(duty.id) ?? [];
  const hasConsultant = onDuty.some(
    (p) => state.doctorsById.get(p.doctorId)?.grade === "consultant",
  );
  if (duty.needsConsultant && !hasConsultant) {
    return `No consultant trained in ${duty.modality} is free on ${duty.date} ${duty.type}`;
  }
  return `No ${duty.modality}-trained doctor is free on ${duty.date} ${duty.type}`;
}

/** BR4.3: fewest broken hard rules, then soft rules, then duties that month, then lowest id. */
function suggest(state: RunState, duty: Duty, free: readonly Evaluated[]): RosterGap["suggested"] {
  const ranked = free.map((e) => ({
    e,
    hard: hardRuleIds(e.result).length,
    soft: softCount(e.result),
    month: monthDuties(state, e.doctor.id, duty.date),
  }));
  ranked.sort(
    (a, b) =>
      a.hard - b.hard ||
      a.soft - b.soft ||
      a.month - b.month ||
      compareStrings(a.e.doctor.id, b.e.doctor.id),
  );
  const best = ranked[0].e;
  return { doctorId: best.doctor.id, brokenHardRules: hardRuleIds(best.result) };
}

function makeGap(state: RunState, open: OpenPlace): RosterGap {
  const evaluated = open.candidates.map((doctor) => ({
    doctor,
    result: evaluate(state, open.duty, doctor),
  }));
  const free = evaluated.filter((e) => !e.result.broken.some(isAlwaysOn));
  const base = { dutyId: open.duty.id, place: open.place };
  if (free.length === 0) {
    return { ...base, reason: noneFreeReason(state, open.duty), suggested: null }; // BR4.4
  }
  return {
    ...base,
    reason: freeReason(state, open.duty, free),
    suggested: suggest(state, open.duty, free),
  };
}

// ---------------------------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------------------------

function splitByWeek(state: RunState, gaps: readonly RosterGap[]): RosterWeek[] {
  const weekOfDuty = (id: string) => weekOf(state.dutyById.get(id)!.date);
  return state.runWeeks.map((monday) => {
    const lists = sortWeekLists(
      {
        placements: state.placements.filter((p) => weekOfDuty(p.dutyId) === monday),
        gaps: gaps.filter((g) => weekOfDuty(g.dutyId) === monday),
        brokenSoftRules: state.soft.filter((s) => weekOfDuty(s.dutyId) === monday),
      },
      state.dutyById,
    );
    return {
      weekStart: monday,
      version: "draft" as const,
      periodStart: state.period.weekStart,
      periodWeeks: state.period.weeks,
      generatedAt: state.now,
      publishedAt: null,
      now: state.now,
      ...lists,
    };
  });
}

/**
 * Generates the draft weeks of one run. Pure: reads nothing, writes nothing. Throws
 * RunTooLongError (through `deadline.check`) when the run reaches the cut-off; nothing is
 * returned then.
 */
export function generate(
  inputs: GeneratorInputs,
  now: string,
  deadline: DeadlineCheck,
  options: GeneratorOptions = {},
): GeneratorResult {
  const state = prepare(inputs, now);
  buildWindows(state, inputs);
  carryLockedPlaces(state, inputs.publishedWeeks);
  openPlaces(state);
  fill(state, deadline, options);
  const gaps = state.open.map((open) => makeGap(state, open));
  const weeks = splitByWeek(state, gaps);
  return {
    weeks,
    stats: {
      duties: state.duties.length,
      places: state.placements.length + gaps.length,
      placements: state.placements.length,
      gaps: gaps.length,
    },
  };
}
