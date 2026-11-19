/**
 * RosterService (u6-roster): generate, publish, regenerate after late leave, and the three reads.
 *
 * Rules: BR2.1-BR2.2 (what a run reads), BR5 (one draft per week), BR6.1-BR6.4 (409 without a
 * draft and nothing written; the 12-hour lock merge by place; published items written before
 * drafts are deleted, NFR5.2), BR7.1-BR7.5 (leave.approved regenerates and republishes every
 * touched published run, in order, under one Deadline; a cut-off names the runs not
 * regenerated, NFR5.3, NFR Design R-05), BR8 (week reads through shapeForViewer; my duties from
 * req.user.id only), BR9 (coverage: gaps, soft rules, locked clashes at server time, hours with
 * CALL = 14 h in its start week). Review findings folded in: a published week records the run it
 * was published with (R-01); each place taken from the draft is re-checked with checkPlacement
 * after the merge and becomes a gap if it fails (R-02).
 * Contracts: C1 (rosters items), C2 (checkPlacement, buildWindow, DutyCalendar), C3 (payload,
 * subscriber `u6-roster`), C4 (shared errors), C9 (route behaviour). Logs: observability-design.
 */
import type { AuthUser } from "../../shared/auth.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { subscribe } from "../../shared/events.js";
import { log } from "../../shared/log.js";
import {
  buildWindow,
  checkPlacement,
  windowRange,
  type DutyTypeCounts,
  type PlacedDuty,
} from "../../shared/rules.js";
import type {
  BrokenSoftRule,
  Doctor,
  Duty,
  LeaveRequest,
  RosterGap,
  RosterPlacement,
  RosterVersion,
  RosterWeek,
} from "../../shared/tables.js";
import { addDays, hoursOf, isLocked, weekOf, weeksOf } from "../../shared/time.js";
import { Deadline, systemClock, type MonotonicClock } from "./deadline.js";
import {
  compareDuties,
  compareStrings,
  generate,
  sortWeekLists,
  type GeneratorInputs,
  type RunStats,
} from "./generator.js";
import { rosterRepository, type RosterRepository } from "./repository.js";
import {
  LeaveApprovedPayload,
  RunTooLongError,
  type CoverageReport,
  type DoctorHours,
  type LockedClash,
  type MyDuty,
  type RosterWeekView,
} from "./schemas.js";

export type ServiceDeps = { repo?: RosterRepository; clock?: MonotonicClock };

export type Trigger = "generate" | "publish" | "leave.approved";

export type RunRequest = {
  weekStart: string;
  weeks: number;
  /** ISO instant: the lock and generation time of the run. */
  now: string;
  deadline: Deadline;
  trigger?: Trigger;
};

/** The reason of a gap made by the publish re-check (Functional Design R-02). */
export const RELOCK_REASON = "Changed by the 12-hour lock; generate again";

export const LEAVE_SUBSCRIBER = "u6-roster";

const repoOf = (deps: ServiceDeps): RosterRepository => deps.repo ?? rosterRepository;

/** Normalises an ISO instant to the `toISOString` form stored on items. */
export const toInstant = (value: string): string => new Date(value).toISOString();

const byIdOf = <T extends { id: string }>(items: readonly T[]) =>
  new Map(items.map((item) => [item.id, item]));

// ---------------------------------------------------------------------------------------------
// Logging (observability-design)
// ---------------------------------------------------------------------------------------------

function logRun(trigger: Trigger, req: RunRequest, stats: RunStats): void {
  log("info", "roster run", {
    trigger,
    weekStart: req.weekStart,
    weeks: req.weeks,
    duties: stats.duties,
    places: stats.places,
    placements: stats.placements,
    gaps: stats.gaps,
    durationMs: Math.round(req.deadline.elapsedMs()),
  });
}

/** Runs one generate or publish, logging the cut-off warning when the deadline stops it. */
async function guarded<T>(trigger: Trigger, req: RunRequest, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RunTooLongError) {
      log("warn", "roster run stopped at the 15 s cut-off", {
        trigger,
        weekStart: req.weekStart,
        weeks: req.weeks,
        durationMs: Math.round(req.deadline.elapsedMs()),
        stage: error.stage,
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Inputs of a run (BR2.1, BR2.2)
// ---------------------------------------------------------------------------------------------

async function loadRunData(
  repo: RosterRepository,
  weekStart: string,
  weeks: number,
): Promise<GeneratorInputs> {
  const runWeeks = weeksOf(weekStart, weeks);
  const runEnd = addDays(runWeeks[runWeeks.length - 1], 6);
  const { from, to } = windowRange({ weekStart, weeks });
  const [doctors, windowDuties, approvedLeave, rules, publishedWeeks] = await Promise.all([
    repo.allDoctors(),
    repo.dutiesBetween(from, to),
    repo.approvedLeaveOverlapping(from, to),
    repo.enabledRules(),
    repo.publishedWeeksBetween(weekOf(from), weekOf(to)),
  ]);
  const live = windowDuties.filter((d) => !d.cancelled);
  return {
    weekStart,
    weeks,
    doctors,
    duties: live.filter((d) => d.date >= weekStart && d.date <= runEnd),
    windowDuties: live,
    approvedLeave,
    rules,
    publishedWeeks,
  };
}

// ---------------------------------------------------------------------------------------------
// Generate (W1)
// ---------------------------------------------------------------------------------------------

/** Generates the run and writes one draft per week (BR5.1). Nothing is written on a cut-off. */
export async function generateRun(req: RunRequest, deps: ServiceDeps = {}): Promise<RosterWeek[]> {
  const repo = repoOf(deps);
  const trigger = req.trigger ?? "generate";
  return guarded(trigger, req, async () => {
    const inputs = await loadRunData(repo, req.weekStart, req.weeks);
    req.deadline.check("read");
    const { weeks, stats } = generate(inputs, req.now, req.deadline);
    req.deadline.check("write");
    for (const week of weeks) await repo.putWeek(week);
    logRun(trigger, req, stats);
    return weeks;
  });
}

// ---------------------------------------------------------------------------------------------
// Publish (W2): the lock merge and the re-check
// ---------------------------------------------------------------------------------------------

type Origin = "draft" | "published";
type Tagged<T> = T & { week: string; origin: Origin };

type MergedRun = {
  placements: Tagged<RosterPlacement>[];
  gaps: Tagged<RosterGap>[];
  soft: Tagged<BrokenSoftRule>[];
};

type DutyEntries = {
  placements: RosterPlacement[];
  gaps: RosterGap[];
  soft: BrokenSoftRule[];
};

function entriesOf(week: RosterWeek | undefined, dutyId: string): DutyEntries {
  return {
    placements: (week?.placements ?? []).filter((p) => p.dutyId === dutyId),
    gaps: (week?.gaps ?? []).filter((g) => g.dutyId === dutyId),
    soft: (week?.brokenSoftRules ?? []).filter((s) => s.dutyId === dutyId),
  };
}

function takeEntries(entries: DutyEntries, week: string, origin: Origin, out: MergedRun): void {
  for (const p of entries.placements) out.placements.push({ ...p, week, origin });
  for (const g of entries.gaps) out.gaps.push({ ...g, week, origin });
  for (const s of entries.soft) out.soft.push({ ...s, week, origin });
}

/** BR6.2, BR6.3 for a locked duty: published doctors stay by place; empty places take the draft's. */
function mergeLockedDuty(
  duty: Duty,
  draft: DutyEntries,
  published: DutyEntries,
  week: string,
  out: MergedRun,
): void {
  const kept = new Set(published.placements.map((p) => p.place));
  const keptDoctors = new Set(published.placements.map((p) => p.doctorId));
  takeEntries(
    {
      placements: published.placements,
      gaps: [],
      soft: published.soft.filter((s) => keptDoctors.has(s.doctorId)),
    },
    week,
    "published",
    out,
  );
  const places = new Set<number>(Array.from({ length: duty.doctorsNeeded }, (_, i) => i + 1));
  for (const entry of [...draft.placements, ...draft.gaps]) places.add(entry.place);
  for (const place of [...places].sort((a, b) => a - b)) {
    if (kept.has(place)) continue;
    const fromDraft = draft.placements.find((p) => p.place === place);
    if (fromDraft) {
      const soft = draft.soft.filter((s) => s.doctorId === fromDraft.doctorId);
      takeEntries({ placements: [fromDraft], gaps: [], soft }, week, "draft", out);
      continue;
    }
    const gap =
      draft.gaps.find((g) => g.place === place) ?? published.gaps.find((g) => g.place === place);
    if (gap) out.gaps.push({ ...gap, week, origin: "draft" });
  }
}

function mergeRun(
  drafts: readonly RosterWeek[],
  published: ReadonlyMap<string, RosterWeek>,
  dutyById: ReadonlyMap<string, Duty>,
  now: string,
): MergedRun {
  const out: MergedRun = { placements: [], gaps: [], soft: [] };
  for (const draft of drafts) {
    const week = draft.weekStart;
    const publishedWeek = published.get(week);
    const ids = new Set(
      [draft, publishedWeek]
        .flatMap((w) => [...(w?.placements ?? []), ...(w?.gaps ?? [])])
        .map((e) => e.dutyId),
    );
    for (const id of [...ids].sort(compareStrings)) {
      const duty = dutyById.get(id);
      const draftEntries = entriesOf(draft, id);
      if (!publishedWeek || !duty || !isLocked(duty, now)) {
        takeEntries(draftEntries, week, "draft", out);
      } else {
        mergeLockedDuty(duty, draftEntries, entriesOf(publishedWeek, id), week, out);
      }
    }
  }
  for (const p of out.placements) {
    const duty = dutyById.get(p.dutyId);
    if (duty) p.locked = isLocked(duty, now);
  }
  return out;
}

type RecheckContext = {
  inputs: GeneratorInputs;
  dutyById: ReadonlyMap<string, Duty>;
  doctorsById: ReadonlyMap<string, Doctor>;
  publishedOutside: PlacedDuty[];
  hasFairShare: boolean;
};

function recheckContext(inputs: GeneratorInputs): RecheckContext {
  const runWeeks = new Set(weeksOf(inputs.weekStart, inputs.weeks));
  const windowDuties = byIdOf(inputs.windowDuties);
  const publishedOutside = inputs.publishedWeeks
    .filter((w) => !runWeeks.has(w.weekStart))
    .flatMap((w) => w.placements)
    .flatMap((p) => {
      const duty = windowDuties.get(p.dutyId);
      return duty ? [{ doctorId: p.doctorId, duty }] : [];
    });
  return {
    inputs,
    dutyById: byIdOf(inputs.duties),
    doctorsById: byIdOf(inputs.doctors),
    publishedOutside,
    hasFairShare: inputs.rules.some((r) => r.enabled && r.type === "fair_share"),
  };
}

function countsFor(ctx: RecheckContext, others: readonly RosterPlacement[], duty: Duty) {
  const counts: Record<string, DutyTypeCounts> = {};
  for (const doctor of ctx.inputs.doctors) {
    if (doctor.active && doctor.modalities.includes(duty.modality)) {
      counts[doctor.id] = { AM: 0, PM: 0, CALL: 0 };
    }
  }
  for (const p of others) {
    const placed = ctx.dutyById.get(p.dutyId);
    if (placed && counts[p.doctorId]) counts[p.doctorId][placed.type] += 1;
  }
  return counts;
}

/** True when `placement` still passes checkPlacement against every other merged placement. */
function passesRecheck(
  ctx: RecheckContext,
  placement: RosterPlacement,
  others: readonly RosterPlacement[],
): boolean {
  const duty = ctx.dutyById.get(placement.dutyId);
  const doctor = ctx.doctorsById.get(placement.doctorId);
  if (!duty) return true; // a cancelled duty: left out of every read anyway
  if (!doctor) return false;
  const placed = others.flatMap((p) => {
    const d = ctx.dutyById.get(p.dutyId);
    return d ? [{ doctorId: p.doctorId, duty: d }] : [];
  });
  const period = { weekStart: ctx.inputs.weekStart, weeks: ctx.inputs.weeks };
  return checkPlacement({
    doctor,
    duty,
    approvedLeave: ctx.inputs.approvedLeave.filter((l) => l.doctorId === doctor.id),
    doctorPlacements: buildWindow(period, doctor.id, placed, ctx.publishedOutside),
    dutyPlacements: others
      .filter((p) => p.dutyId === duty.id)
      .map((p) => ({
        doctorId: p.doctorId,
        grade: ctx.doctorsById.get(p.doctorId)?.grade ?? "resident",
      })),
    rules: ctx.inputs.rules,
    periodCounts: ctx.hasFairShare ? countsFor(ctx, others, duty) : {},
  }).allowed;
}

/** R-02: each place taken from the draft is checked again; one that fails becomes a gap. */
function recheckDraftPlaces(ctx: RecheckContext, merged: MergedRun): void {
  const fromDraft = merged.placements
    .filter((p) => p.origin === "draft" && ctx.dutyById.has(p.dutyId))
    .sort(
      (a, b) =>
        compareDuties(ctx.dutyById.get(a.dutyId)!, ctx.dutyById.get(b.dutyId)!) ||
        a.place - b.place,
    );
  for (const placement of fromDraft) {
    const others = merged.placements.filter((p) => p !== placement);
    if (passesRecheck(ctx, placement, others)) continue;
    merged.placements = others;
    merged.soft = merged.soft.filter(
      (s) =>
        !(
          s.origin === "draft" &&
          s.dutyId === placement.dutyId &&
          s.doctorId === placement.doctorId
        ),
    );
    merged.gaps.push({
      dutyId: placement.dutyId,
      place: placement.place,
      reason: RELOCK_REASON,
      suggested: null,
      week: placement.week,
      origin: "draft",
    });
  }
}

const cleanPlacement = (p: RosterPlacement): RosterPlacement => ({
  dutyId: p.dutyId,
  place: p.place,
  doctorId: p.doctorId,
  locked: p.locked,
});

const cleanGap = (g: RosterGap): RosterGap => ({
  dutyId: g.dutyId,
  place: g.place,
  reason: g.reason,
  suggested: g.suggested
    ? { doctorId: g.suggested.doctorId, brokenHardRules: [...g.suggested.brokenHardRules] }
    : null,
});

function cleanSoft(entries: readonly BrokenSoftRule[]): BrokenSoftRule[] {
  const seen = new Set<string>();
  const out: BrokenSoftRule[] = [];
  for (const s of entries) {
    const key = `${s.dutyId}|${s.doctorId}|${s.ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dutyId: s.dutyId, doctorId: s.doctorId, ruleId: s.ruleId, reason: s.reason });
  }
  return out;
}

function publishedWeeksOf(
  req: RunRequest,
  drafts: readonly RosterWeek[],
  merged: MergedRun,
  dutyById: ReadonlyMap<string, Duty>,
): RosterWeek[] {
  return drafts.map((draft) => {
    const inWeek = <T extends { week: string }>(entries: readonly T[]) =>
      entries.filter((e) => e.week === draft.weekStart);
    const lists = sortWeekLists(
      {
        placements: inWeek(merged.placements).map(cleanPlacement),
        gaps: inWeek(merged.gaps).map(cleanGap),
        brokenSoftRules: cleanSoft(inWeek(merged.soft)),
      },
      dutyById,
    );
    return {
      weekStart: draft.weekStart,
      version: "published" as const,
      periodStart: req.weekStart, // R-01: the run it was published with, from the request
      periodWeeks: req.weeks,
      generatedAt: draft.generatedAt,
      publishedAt: req.now,
      now: req.now,
      ...lists,
    };
  });
}

/**
 * Publishes the run's drafts (W2). 409 and nothing written when a week has no draft (BR6.1).
 * Writes every published item first, then deletes the drafts (BR6.4, NFR5.2).
 */
export async function publishRun(req: RunRequest, deps: ServiceDeps = {}): Promise<RosterWeek[]> {
  const repo = repoOf(deps);
  const trigger = req.trigger ?? "publish";
  return guarded(trigger, req, async () => {
    const runWeeks = weeksOf(req.weekStart, req.weeks);
    const drafts = await Promise.all(runWeeks.map((w) => repo.getWeek("draft", w)));
    const missing = runWeeks.find((_, i) => !drafts[i]);
    if (missing) {
      throw new ConflictError(`No draft for the week of ${missing}; generate a draft first`);
    }
    const inputs = await loadRunData(repo, req.weekStart, req.weeks);
    req.deadline.check("read");
    const ctx = recheckContext(inputs);
    const published = new Map(inputs.publishedWeeks.map((w) => [w.weekStart, w]));
    const draftWeeks = drafts as RosterWeek[];
    const merged = mergeRun(draftWeeks, published, ctx.dutyById, req.now);
    recheckDraftPlaces(ctx, merged);
    const weeks = publishedWeeksOf(req, draftWeeks, merged, ctx.dutyById);
    req.deadline.check("write");
    for (const week of weeks) await repo.putWeek(week);
    for (const week of runWeeks) await repo.deleteDraft(week);
    const placements = weeks.reduce((n, w) => n + w.placements.length, 0);
    const gaps = weeks.reduce((n, w) => n + w.gaps.length, 0);
    logRun(trigger, req, {
      duties: inputs.duties.length,
      places: placements + gaps,
      placements,
      gaps,
    });
    return weeks;
  });
}

// ---------------------------------------------------------------------------------------------
// Regenerate after late leave (W3)
// ---------------------------------------------------------------------------------------------

type RunSpec = { weekStart: string; weeks: number };

const describeRun = (run: RunSpec) =>
  `${run.weekStart} (${run.weeks} week${run.weeks === 1 ? "" : "s"})`;

/** The distinct runs of the touched weeks, by periodStart then periodWeeks (BR7.3). */
function distinctRuns(weeks: readonly RosterWeek[]): RunSpec[] {
  const runs = new Map<string, RunSpec>();
  for (const w of weeks) {
    runs.set(`${w.periodStart}|${w.periodWeeks}`, {
      weekStart: w.periodStart,
      weeks: w.periodWeeks,
    });
  }
  return [...runs.values()].sort(
    (a, b) => compareStrings(a.weekStart, b.weekStart) || a.weeks - b.weeks,
  );
}

function logRegenerated(leaveId: string, runs: readonly RunSpec[], skipped: readonly RunSpec[]) {
  const shape = (r: RunSpec) => ({ periodStart: r.weekStart, periodWeeks: r.weeks });
  log("info", "roster regenerated after leave", {
    leaveId,
    runs: runs.map(shape),
    skipped: skipped.map(shape),
  });
}

/**
 * The `leave.approved` handler: regenerate and republish every published run the leave touches,
 * with now = the approval's `at`, under one Deadline. Throws on any failure; DomainEvents reports
 * it to the approval as a follow-up (BR7.5).
 */
export async function onLeaveApproved(raw: unknown, deps: ServiceDeps = {}): Promise<void> {
  const deadline = new Deadline(deps.clock ?? systemClock);
  const payload = LeaveApprovedPayload.parse(raw);
  const repo = repoOf(deps);
  const now = toInstant(payload.at);
  const touched = await repo.publishedWeeksBetween(
    weekOf(payload.startDate),
    weekOf(payload.endDate),
  );
  const runs = distinctRuns(touched);
  const done: RunSpec[] = [];
  for (const [index, run] of runs.entries()) {
    try {
      deadline.check("read");
      const req: RunRequest = { ...run, now, deadline, trigger: "leave.approved" };
      await generateRun(req, deps);
      await publishRun(req, deps);
      done.push(run);
    } catch (error) {
      if (!(error instanceof RunTooLongError)) throw error;
      const skipped = runs.slice(index);
      logRegenerated(payload.leaveId, done, skipped);
      throw new RunTooLongError(
        `Regeneration stopped at the 15 s cut-off; not regenerated: ${skipped.map(describeRun).join(", ")}`,
        { stage: error.stage, elapsedMs: error.elapsedMs },
      );
    }
  }
  logRegenerated(payload.leaveId, done, []);
}

/** Subscribes the roster to `leave.approved` as `u6-roster` (BR7.1). Returns the unsubscribe. */
export function subscribeToLeaveApproved(deps: ServiceDeps = {}): () => void {
  return subscribe("leave.approved", (payload) => onLeaveApproved(payload, deps), LEAVE_SUBSCRIBER);
}

// ---------------------------------------------------------------------------------------------
// Reads (W4, W5, W6)
// ---------------------------------------------------------------------------------------------

/** The one read-shaping function (security-design §1): doctors never see drafts or suggestions. */
export function shapeForViewer(view: RosterWeekView, user: AuthUser): RosterWeekView {
  if (user.role === "coordinator") return view;
  if (view.version === "draft") throw new ForbiddenError("Doctors can only see published rosters");
  const placed = new Set(view.placements.map((p) => p.doctorId));
  return {
    ...view,
    gaps: view.gaps.map((g) => ({ ...g, suggested: null })),
    brokenSoftRules: [],
    doctors: view.doctors.filter((d) => placed.has(d.id)),
  };
}

/** The week with its non-cancelled duties; entries of cancelled duties left out (BR8.1). */
function buildView(
  week: RosterWeek,
  duties: Duty[],
  doctorsById: ReadonlyMap<string, Doctor>,
): RosterWeekView {
  const live = new Set(duties.map((d) => d.id));
  const placements = week.placements.filter((p) => live.has(p.dutyId));
  const gaps = week.gaps.filter((g) => live.has(g.dutyId));
  const mentioned = new Set([
    ...placements.map((p) => p.doctorId),
    ...gaps.flatMap((g) => (g.suggested ? [g.suggested.doctorId] : [])),
  ]);
  const doctors = [...mentioned]
    .sort(compareStrings)
    .map((id) => ({ id, name: doctorsById.get(id)?.name ?? id }));
  const brokenSoftRules = week.brokenSoftRules.filter((s) => live.has(s.dutyId));
  return { ...week, placements, gaps, brokenSoftRules, duties, doctors };
}

/** Views of weeks for a viewer, with one duties query and the doctors list. */
export async function toViews(
  weeks: readonly RosterWeek[],
  user: AuthUser,
  deps: ServiceDeps = {},
): Promise<RosterWeekView[]> {
  if (weeks.length === 0) return [];
  const repo = repoOf(deps);
  const mondays = weeks.map((w) => w.weekStart).sort(compareStrings);
  const [duties, doctors] = await Promise.all([
    repo.dutiesBetween(mondays[0], addDays(mondays[mondays.length - 1], 6)),
    repo.allDoctors(),
  ]);
  const live = duties.filter((d) => !d.cancelled);
  const doctorsById = byIdOf(doctors);
  return weeks.map((week) => {
    const own = live.filter((d) => weekOf(d.date) === week.weekStart);
    return shapeForViewer(buildView(week, own, doctorsById), user);
  });
}

/** GET /roster/weeks/{weekStart} (W4). */
export async function readWeek(
  user: AuthUser,
  weekStart: string,
  version: RosterVersion,
  deps: ServiceDeps = {},
): Promise<RosterWeekView> {
  if (version === "draft" && user.role !== "coordinator") {
    throw new ForbiddenError("Doctors can only see published rosters");
  }
  const week = await repoOf(deps).getWeek(version, weekStart);
  if (!week) throw new NotFoundError(`No ${version} roster for the week of ${weekStart}`);
  const [view] = await toViews([week], user, deps);
  return view;
}

/** GET /roster/mine (W5): the caller's published placements, from req.user.id only. */
export async function myDuties(
  user: AuthUser,
  from: string,
  to: string,
  deps: ServiceDeps = {},
): Promise<MyDuty[]> {
  const repo = repoOf(deps);
  const weeks = await repo.publishedWeeksBetween(weekOf(from), weekOf(to));
  if (weeks.length === 0) return [];
  const duties = byIdOf((await repo.dutiesBetween(from, to)).filter((d) => !d.cancelled));
  const mine = weeks.flatMap((week) =>
    week.placements
      .filter((p) => p.doctorId === user.id)
      .flatMap((p) => {
        const duty = duties.get(p.dutyId);
        return duty ? [{ duty, place: p.place, locked: p.locked }] : [];
      }),
  );
  return mine.sort((a, b) => compareDuties(a.duty, b.duty) || a.place - b.place);
}

function lockedClashes(
  placements: readonly RosterPlacement[],
  dutyById: ReadonlyMap<string, Duty>,
  leave: readonly LeaveRequest[],
  doctorsById: ReadonlyMap<string, Doctor>,
  now: string,
): LockedClash[] {
  return placements.flatMap((p) => {
    const duty = dutyById.get(p.dutyId)!;
    if (!isLocked(duty, now)) return [];
    const onLeave = leave.some(
      (l) => l.doctorId === p.doctorId && l.startDate <= duty.date && duty.date <= l.endDate,
    );
    if (!onLeave) return [];
    const name = doctorsById.get(p.doctorId)?.name ?? p.doctorId;
    const reason = `${name} has approved leave on ${duty.date}`;
    return [{ dutyId: p.dutyId, place: p.place, doctorId: p.doctorId, reason }];
  });
}

/** BR9.5: every active doctor and every placed doctor; AM 5, PM 5, CALL 14 (in its start week). */
function hoursPerDoctor(
  placements: readonly RosterPlacement[],
  dutyById: ReadonlyMap<string, Duty>,
  doctors: readonly Doctor[],
): DoctorHours[] {
  const hours = new Map<string, number>();
  for (const doctor of doctors) if (doctor.active) hours.set(doctor.id, 0);
  for (const p of placements) {
    const type = dutyById.get(p.dutyId)!.type;
    hours.set(p.doctorId, (hours.get(p.doctorId) ?? 0) + hoursOf(type));
  }
  const doctorsById = byIdOf(doctors);
  return [...hours.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([doctorId, total]) => ({
      doctorId,
      hours: total,
      max: doctorsById.get(doctorId)?.maxHoursPerWeek ?? null,
    }));
}

/**
 * GET /roster/weeks/{weekStart}/coverage (W6): from the draft, else the published week (BR9.1).
 * `now` is the server's current time; locked clashes come from the current approved leave.
 */
export async function coverage(
  weekStart: string,
  now: string,
  deps: ServiceDeps = {},
): Promise<CoverageReport> {
  const repo = repoOf(deps);
  const week =
    (await repo.getWeek("draft", weekStart)) ?? (await repo.getWeek("published", weekStart));
  if (!week) throw new NotFoundError(`No roster for the week of ${weekStart}`);
  const weekEnd = addDays(weekStart, 6);
  const [duties, doctors, leave] = await Promise.all([
    repo.dutiesBetween(weekStart, weekEnd),
    repo.allDoctors(),
    repo.approvedLeaveOverlapping(weekStart, weekEnd),
  ]);
  const dutyById = byIdOf(duties.filter((d) => !d.cancelled));
  const placements = week.placements.filter((p) => dutyById.has(p.dutyId));
  return {
    weekStart,
    version: week.version,
    unfilled: week.gaps.filter((g) => dutyById.has(g.dutyId)),
    brokenSoftRules: week.brokenSoftRules.filter((s) => dutyById.has(s.dutyId)),
    lockedClashes: lockedClashes(placements, dutyById, leave, byIdOf(doctors), now),
    hours: hoursPerDoctor(placements, dutyById, doctors),
  };
}
