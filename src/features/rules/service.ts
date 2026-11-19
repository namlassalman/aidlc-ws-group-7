/**
 * Rules service (u5-rules): the logic behind /api/rules (contract C8).
 *
 * - List (BR2.4): doctors get enabled rules only; the coordinator gets every rule.
 * - Create (BR1.1-BR1.4): settings validated with the shared validateSettings against every
 *   doctor, active or not; enabled defaults to true; an enabled rule is checked with the shared
 *   findContradiction (409 naming the other rule); id rule-<n>-<type> from the highest existing
 *   number, written with ifNotExists and retried once with the next number on a clash.
 * - Edit (BR1.5): strength and/or settings (settings replaced whole), revalidated, contradiction
 *   checked only when enabled. Switch on (BR2.1, contradiction first), off (BR2.2), delete (BR2.3);
 *   a switch to the state a rule is already in returns it unchanged and writes nothing.
 * - Can-take (BR3.1-BR3.6): every decision is made by ONE call of the shared checkPlacement, on
 *   the duty's week from its draft, else published, else none, with the asked doctor's own place
 *   on the duty left out of all three inputs (Functional Design R-01).
 * - Audit (NFR2.7): one `rule.changed` line after each successful change.
 * - Rule responses carry an added `description` (describeRule, functional-spec W8), which C8
 *   permits as an optional response field; it is never stored.
 */
import type { AuthUser } from "../../shared/auth.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import {
  RuleSchema,
  buildWindow,
  checkPlacement,
  findContradiction,
  validateSettings,
  windowRange,
  type BrokenRule,
  type DutyTypeCounts,
  type PlacedDuty,
  type Rule,
  type RuleType,
  type Strength,
} from "../../shared/rules.js";
import type { Doctor, Duty, RosterPlacement, RosterWeek } from "../../shared/tables.js";
import { weekOf } from "../../shared/time.js";
import * as repo from "./repository.js";

export type RuleView = Rule & { description: string };

export type CreateRuleInput = {
  type: RuleType;
  strength: Strength;
  settings: unknown;
  enabled?: boolean;
};

/** At least one of the two is given (checked by the router). */
export type EditRulePatch = { strength?: Strength; settings?: unknown };

export type RosterSource = "draft" | "published" | "none";

export type CanTakeAnswer = {
  doctorId: string;
  dutyId: string;
  allowed: boolean;
  broken: BrokenRule[];
  source: RosterSource;
};

type RuleAction = "create" | "edit" | "enable" | "disable" | "delete";

// ---------------------------------------------------------------------------------------------
// Descriptions (functional-spec W8)
// ---------------------------------------------------------------------------------------------

type ModalityWho = Extract<Rule, { type: "modality_assignment" }>["settings"]["who"];

function whoText(who: ModalityWho, plural: boolean): string {
  if ("doctorIds" in who) return who.doctorIds.join(", ");
  return plural ? `${who.grade}s` : who.grade;
}

/** One plain sentence describing a rule, built from its type and settings. */
export function describeRule(rule: Rule): string {
  switch (rule.type) {
    case "modality_assignment": {
      const modalities = rule.settings.modalities.join(", ");
      return rule.settings.mode === "only"
        ? `${whoText(rule.settings.who, false)} reports ${modalities} only`
        : `Prefer ${whoText(rule.settings.who, true)} on ${modalities}`;
    }
    case "duty_limit":
      return `At most ${rule.settings.max} ${rule.settings.dutyType} per doctor per ${rule.settings.per}`;
    case "rest_after_call":
      return "No AM duty the morning after a CALL";
    case "weekly_hours":
      return "Stay within each doctor's maximum hours per week";
    case "consultant_cover":
      return `Every ${rule.settings.modalities.join(", ")} duty has at least one consultant`;
    case "fair_share":
      return `Spread ${rule.settings.dutyType} duties evenly across doctors`;
  }
}

const toView = (rule: Rule): RuleView => ({ ...rule, description: describeRule(rule) });

// ---------------------------------------------------------------------------------------------
// Shared steps of the change workflows
// ---------------------------------------------------------------------------------------------

function audit(action: RuleAction, rule: Rule, user: AuthUser, requestId: string): void {
  log("info", "rule.changed", {
    action,
    ruleId: rule.id,
    type: rule.type,
    by: user.id,
    at: new Date().toISOString(),
    requestId,
  });
}

/** BR1.3: refuses a rule (as it will be saved, enabled) that contradicts another enabled rule. */
function assertNoContradiction(rule: Rule, rules: readonly Rule[], doctors: readonly Doctor[]) {
  const enabled = rules.filter((other) => other.enabled && other.id !== rule.id);
  const other = findContradiction(rule, enabled, doctors);
  if (other) {
    throw new ConflictError(`Contradicts ${other.id} (${describeRule(other)})`, [
      { ruleId: other.id, description: describeRule(other) },
    ]);
  }
}

function findOrThrow(rules: readonly Rule[], id: string): Rule {
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new NotFoundError(`Rule ${id} not found`);
  return rule;
}

const RULE_NUMBER = /^rule-(\d+)-/;

/** BR1.4: 1 + the highest leading number among the existing ids (0 when there are none). */
export function nextRuleNumber(rules: readonly Pick<Rule, "id">[]): number {
  let highest = 0;
  for (const { id } of rules) {
    const match = RULE_NUMBER.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

export const ruleIdFor = (n: number, type: RuleType) => `rule-${n}-${type.replace(/_/g, "-")}`;

/** Writes the new rule with ifNotExists; on a clash takes the next number once (BR1.4). */
async function storeNewRule(rule: Rule, n: number): Promise<Rule> {
  try {
    await repo.createRule(rule);
    return rule;
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const retry = { ...rule, id: ruleIdFor(n + 1, rule.type) };
    await repo.createRule(retry);
    return retry;
  }
}

// ---------------------------------------------------------------------------------------------
// W1-W6: rule workflows
// ---------------------------------------------------------------------------------------------

export async function listRulesFor(user: AuthUser): Promise<RuleView[]> {
  const rules = await repo.listRules();
  const visible = user.role === "coordinator" ? rules : rules.filter((r) => r.enabled);
  return visible.map(toView);
}

export async function createRule(
  input: CreateRuleInput,
  user: AuthUser,
  requestId: string,
): Promise<RuleView> {
  const [doctors, rules] = await Promise.all([repo.listDoctors(), repo.listRules()]);
  const settings = validateSettings({ type: input.type, settings: input.settings }, doctors);
  const n = nextRuleNumber(rules);
  const rule = RuleSchema.parse({
    id: ruleIdFor(n, input.type),
    type: input.type,
    strength: input.strength,
    enabled: input.enabled ?? true,
    settings,
    createdAt: new Date().toISOString(),
  });
  if (rule.enabled) assertNoContradiction(rule, rules, doctors);
  const stored = await storeNewRule(rule, n);
  audit("create", stored, user, requestId);
  return toView(stored);
}

export async function editRule(
  id: string,
  patch: EditRulePatch,
  user: AuthUser,
  requestId: string,
): Promise<RuleView> {
  const [doctors, rules] = await Promise.all([repo.listDoctors(), repo.listRules()]);
  const existing = findOrThrow(rules, id);
  const settings = validateSettings(
    { type: existing.type, settings: patch.settings ?? existing.settings },
    doctors,
  );
  const updated = RuleSchema.parse({
    ...existing,
    strength: patch.strength ?? existing.strength,
    settings,
  });
  if (updated.enabled) assertNoContradiction(updated, rules, doctors);
  await repo.saveRule(updated);
  audit("edit", updated, user, requestId);
  return toView(updated);
}

export async function enableRule(id: string, user: AuthUser, requestId: string): Promise<RuleView> {
  const [doctors, rules] = await Promise.all([repo.listDoctors(), repo.listRules()]);
  const existing = findOrThrow(rules, id);
  if (existing.enabled) return toView(existing);
  const enabled = { ...existing, enabled: true };
  assertNoContradiction(enabled, rules, doctors);
  await repo.saveRule(enabled);
  audit("enable", enabled, user, requestId);
  return toView(enabled);
}

export async function disableRule(
  id: string,
  user: AuthUser,
  requestId: string,
): Promise<RuleView> {
  const existing = findOrThrow(await repo.listRules(), id);
  if (!existing.enabled) return toView(existing);
  const disabled = { ...existing, enabled: false };
  await repo.saveRule(disabled);
  audit("disable", disabled, user, requestId);
  return toView(disabled);
}

export async function removeRule(id: string, user: AuthUser, requestId: string): Promise<void> {
  const existing = await repo.getRule(id);
  if (!existing) throw new NotFoundError(`Rule ${id} not found`);
  await repo.deleteRule(id);
  audit("delete", existing, user, requestId);
}

// ---------------------------------------------------------------------------------------------
// W7: "can this doctor take this duty?"
// ---------------------------------------------------------------------------------------------

type CanTakeData = {
  doctor: Doctor;
  duty: Duty;
  doctors: Doctor[];
  rules: Rule[];
  week: string;
  /** The window's duties by id, cancelled ones included. */
  dutiesById: Map<string, Duty>;
  /** The placements of the duty's week in the version used, the asked place left out. */
  weekPlacements: RosterPlacement[];
  draftPlaced: PlacedDuty[];
  publishedPlaced: PlacedDuty[];
  approvedLeave: { startDate: string; endDate: string }[];
  source: RosterSource;
};

/** BR3.1: the asked doctor and an open duty, or 404. */
async function loadSubject(doctorId: string, dutyId: string) {
  const [doctor, duty, doctors, rules] = await Promise.all([
    repo.getDoctor(doctorId),
    repo.getDuty(dutyId),
    repo.listDoctors(),
    repo.listRules(),
  ]);
  if (!doctor) throw new NotFoundError(`Doctor ${doctorId} not found`);
  if (!duty) throw new NotFoundError(`Duty ${dutyId} not found`);
  if (duty.cancelled) throw new NotFoundError(`Cannot check ${dutyId}: duty is cancelled`);
  return { doctor, duty, doctors, rules };
}

/** Joins roster placements to their open duties, leaving out the asked place (BR3.3). */
function placedDuties(
  weeks: readonly RosterWeek[],
  dutiesById: ReadonlyMap<string, Duty>,
  asked: { doctorId: string; dutyId: string },
): PlacedDuty[] {
  const placed: PlacedDuty[] = [];
  for (const week of weeks) {
    for (const p of week.placements) {
      if (p.doctorId === asked.doctorId && p.dutyId === asked.dutyId) continue;
      const duty = dutiesById.get(p.dutyId);
      if (duty && !duty.cancelled) placed.push({ doctorId: p.doctorId, duty });
    }
  }
  return placed;
}

/** BR3.2-BR3.4: the roster weeks, duties and leave around the duty. Two parallel rounds. */
async function loadCanTakeData(doctorId: string, dutyId: string): Promise<CanTakeData> {
  const { doctor, duty, doctors, rules } = await loadSubject(doctorId, dutyId);
  const week = weekOf(duty.date);
  const { from, to } = windowRange({ weekStart: week, weeks: 1 });
  const [draft, published, duties, leave] = await Promise.all([
    repo.getRosterWeek("draft", week),
    repo.publishedWeeksBetween(weekOf(from), weekOf(to)),
    repo.dutiesBetween(from, to),
    repo.approvedLeaveOverlapping(doctorId, from, to),
  ]);
  const publishedWeek = published.find((w) => w.weekStart === week);
  const used = draft ?? publishedWeek;
  const asked = { doctorId, dutyId };
  const dutiesById = new Map(duties.map((d) => [d.id, d]));
  const openPlacements = (used?.placements ?? []).filter(
    (p) =>
      !(p.doctorId === doctorId && p.dutyId === dutyId) &&
      dutiesById.get(p.dutyId)?.cancelled === false,
  );
  return {
    doctor,
    duty,
    doctors,
    rules,
    week,
    dutiesById,
    weekPlacements: openPlacements,
    draftPlaced: draft ? placedDuties([draft], dutiesById, asked) : [],
    publishedPlaced: placedDuties(published, dutiesById, asked),
    approvedLeave: leave.map((l) => ({ startDate: l.startDate, endDate: l.endDate })),
    source: draft ? "draft" : publishedWeek ? "published" : "none",
  };
}

/** AM, PM and CALL counts in the duty's week for active doctors trained for its modality. */
function weekCounts(data: CanTakeData): Record<string, DutyTypeCounts> {
  const counts: Record<string, DutyTypeCounts> = {};
  for (const d of data.doctors) {
    if (d.active && d.modalities.includes(data.duty.modality)) {
      counts[d.id] = { AM: 0, PM: 0, CALL: 0 };
    }
  }
  for (const p of data.weekPlacements) {
    const placed = data.dutiesById.get(p.dutyId);
    if (placed && counts[p.doctorId]) counts[p.doctorId][placed.type] += 1;
  }
  return counts;
}

export async function checkCanTake(doctorId: string, dutyId: string): Promise<CanTakeAnswer> {
  const data = await loadCanTakeData(doctorId, dutyId);
  const { doctor, duty } = data;
  const grades = new Map(data.doctors.map((d) => [d.id, d.grade]));
  const dutyPlacements = data.weekPlacements
    .filter((p) => p.dutyId === duty.id && grades.has(p.doctorId))
    .map((p) => ({ doctorId: p.doctorId, grade: grades.get(p.doctorId)! }));
  const result = checkPlacement({
    doctor,
    duty,
    approvedLeave: data.approvedLeave,
    doctorPlacements: buildWindow(
      { weekStart: data.week, weeks: 1 },
      doctorId,
      data.draftPlaced,
      data.publishedPlaced,
      { draftWeeks: data.source === "draft" ? [data.week] : [] },
    ),
    dutyPlacements,
    rules: data.rules.filter((r) => r.enabled),
    periodCounts: weekCounts(data),
  });
  const inactive: BrokenRule = {
    ruleId: "inactive-doctor",
    strength: "hard",
    reason: `${doctor.id} is deactivated`,
  };
  const broken = doctor.active ? result.broken : [inactive, ...result.broken];
  return {
    doctorId,
    dutyId,
    allowed: doctor.active && result.allowed,
    broken,
    source: data.source,
  };
}
