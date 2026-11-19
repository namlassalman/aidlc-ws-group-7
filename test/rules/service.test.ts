// Service tests (u5-rules): rule workflows W1-W6 (BR1.1-BR2.4), the can-take answer W7
// (BR3.1-BR3.6, AC1.9.1-AC1.9.4, R-01, NFR1.1, NFR1.4, NFR5.1) and the audit line (NFR2.7).
// Real in-memory tables and the real shared checker; checkPlacement is wrapped in a spy only to
// count its calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkCanTake,
  createRule,
  describeRule,
  disableRule,
  editRule,
  enableRule,
  listRulesFor,
  removeRule,
} from "../../src/features/rules/service.js";
import { listRules } from "../../src/features/rules/repository.js";
import type { AuthUser } from "../../src/shared/auth.js";
import { ConflictError, NotFoundError, ValidationError } from "../../src/shared/errors.js";
import { checkPlacement } from "../../src/shared/rules.js";
import {
  DUTY_TYPES,
  MODALITIES,
  type Doctor,
  type Duty,
  type Rule,
} from "../../src/shared/tables.js";
import { addDays } from "../../src/shared/time.js";
import { doctor, duty, exampleDuties, exampleLeave, exampleRules } from "../shared/fixtures.js";
import {
  putBenOnCallDraft,
  putDoctors,
  putDuties,
  putLeave,
  putRosterWeek,
  putRules,
  seedExample,
} from "./seed.js";

vi.mock("../../src/shared/rules.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/rules.js")>();
  return { ...actual, checkPlacement: vi.fn(actual.checkPlacement) };
});

const coordinator: AuthUser = { id: "coord1", role: "coordinator" };
const benUser: AuthUser = { id: "ben.ochieng", role: "doctor" };

const raoOnly = (modality: "MRI" | "CT") => ({
  type: "modality_assignment" as const,
  strength: "hard" as const,
  settings: { who: { doctorIds: ["asha.rao"] }, modalities: [modality], mode: "only" },
});

beforeEach(async () => {
  await seedExample();
});

describe("listing rules (BR2.4)", () => {
  it("gives the coordinator every rule and a doctor the enabled ones, in id order", async () => {
    await disableRule("rule-2-residents-on-xr", coordinator, "req-1");
    const all = await listRulesFor(coordinator);
    const mine = await listRulesFor(benUser);
    expect(all.map((r) => [r.id, r.enabled])).toEqual([
      ["rule-1-rest-after-call", true],
      ["rule-2-residents-on-xr", false],
      ["rule-3-one-call-per-week", true],
    ]);
    expect(mine.map((r) => r.id)).toEqual(["rule-1-rest-after-call", "rule-3-one-call-per-week"]);
  });

  it("describes each rule in one plain sentence (W8)", async () => {
    const all = await listRulesFor(coordinator);
    expect(all.map((r) => r.description)).toEqual([
      "No AM duty the morning after a CALL",
      "Prefer residents on XR",
      "At most 1 CALL per doctor per week",
    ]);
    const base = { id: "rule-9-x", strength: "soft", enabled: true } as const;
    const more: Rule[] = [
      { ...base, type: "weekly_hours", settings: {} },
      { ...base, type: "consultant_cover", settings: { modalities: ["CT", "MRI"] } },
      { ...base, type: "fair_share", settings: { dutyType: "CALL" } },
      {
        ...base,
        type: "modality_assignment",
        settings: { who: { doctorIds: ["asha.rao"] }, modalities: ["MRI"], mode: "only" },
      },
    ];
    expect(more.map(describeRule)).toEqual([
      "Stay within each doctor's maximum hours per week",
      "Every CT, MRI duty has at least one consultant",
      "Spread CALL duties evenly across doctors",
      "asha.rao reports MRI only",
    ]);
  });
});

describe("creating a rule (BR1.1-BR1.4)", () => {
  it("stores a valid duty-limit rule, enabled by default, as rule-4-duty-limit (AC1.7.1)", async () => {
    const created = await createRule(
      { type: "duty_limit", strength: "hard", settings: { dutyType: "AM", max: 3, per: "week" } },
      coordinator,
      "req-1",
    );
    expect(created).toMatchObject({
      id: "rule-4-duty-limit",
      enabled: true,
      settings: { dutyType: "AM", max: 3, per: "week" },
      description: "At most 3 AM per doctor per week",
    });
    expect(Date.parse(created.createdAt ?? "")).not.toBeNaN();
    expect((await listRules()).map((r) => r.id)).toContain("rule-4-duty-limit");
  });

  it("refuses a mode-only rule naming Ben with MRI, naming doctor and modality (AC1.7.2)", async () => {
    const attempt = createRule(
      {
        type: "modality_assignment",
        strength: "hard",
        settings: { who: { doctorIds: ["ben.ochieng"] }, modalities: ["MRI"], mode: "only" },
      },
      coordinator,
      "req-1",
    );
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toThrow("Doctor ben.ochieng is not trained for any of MRI");
    expect(await listRules()).toHaveLength(3);
  });

  it("refuses settings that do not match the type's schema (400)", async () => {
    await expect(
      createRule(
        { type: "duty_limit", strength: "soft", settings: { dutyType: "AM", max: 1, extra: 1 } },
        coordinator,
        "req-1",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses 'Dr Rao CT only' against an enabled 'Dr Rao MRI only', naming the rule (AC1.7.3)", async () => {
    const mriOnly = await createRule(raoOnly("MRI"), coordinator, "req-1");
    expect(mriOnly.id).toBe("rule-4-modality-assignment");
    const attempt = createRule(raoOnly("CT"), coordinator, "req-2");
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toThrow(
      "Contradicts rule-4-modality-assignment (asha.rao reports MRI only)",
    );
    expect(await listRules()).toHaveLength(4);
  });

  it("does not check a rule created disabled, but finds the contradiction on switch-on", async () => {
    await createRule(raoOnly("MRI"), coordinator, "req-1");
    const ctOnly = await createRule({ ...raoOnly("CT"), enabled: false }, coordinator, "req-2");
    expect(ctOnly).toMatchObject({ id: "rule-5-modality-assignment", enabled: false });
    await expect(enableRule(ctOnly.id, coordinator, "req-3")).rejects.toThrow(
      "Contradicts rule-4-modality-assignment",
    );
    expect((await listRules()).find((r) => r.id === ctOnly.id)?.enabled).toBe(false);
  });

  it("accepts a rule naming a deactivated doctor (Q1)", async () => {
    await putDoctors([doctor("asha.rao", { active: false })]);
    const created = await createRule(raoOnly("MRI"), coordinator, "req-1");
    expect(created.id).toBe("rule-4-modality-assignment");
  });

  it("takes the next number when two creates clash, and refuses a double clash (409)", async () => {
    const input = {
      type: "fair_share" as const,
      strength: "soft" as const,
      settings: { dutyType: "CALL" },
    };
    const results = await Promise.allSettled([
      createRule(input, coordinator, "req-1"),
      createRule(input, coordinator, "req-2"),
      createRule(input, coordinator, "req-3"),
    ]);
    const ids = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.id] : []));
    expect(ids.sort()).toEqual(["rule-4-fair-share", "rule-5-fair-share"]);
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
  });
});

describe("editing, switching and deleting (BR1.5, BR2.1-BR2.3)", () => {
  it("edits strength only, keeping id, type, enabled and createdAt", async () => {
    const edited = await editRule(
      "rule-3-one-call-per-week",
      { strength: "soft" },
      coordinator,
      "r",
    );
    expect(edited).toEqual({
      ...exampleRules()[2],
      strength: "soft",
      description: "At most 1 CALL per doctor per week",
    });
  });

  it("replaces the settings whole and revalidates them", async () => {
    const edited = await editRule(
      "rule-3-one-call-per-week",
      { settings: { dutyType: "PM", max: 2, per: "month" } },
      coordinator,
      "r",
    );
    expect(edited.settings).toEqual({ dutyType: "PM", max: 2, per: "month" });
    await expect(
      editRule("rule-3-one-call-per-week", { settings: { dutyType: "PM" } }, coordinator, "r"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses an edit of an unknown rule (404) and an edit that makes a contradiction (409)", async () => {
    await expect(
      editRule("rule-42-duty-limit", { strength: "soft" }, coordinator, "r"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await createRule(raoOnly("MRI"), coordinator, "r");
    await createRule(
      {
        type: "modality_assignment",
        strength: "soft",
        settings: { who: { grade: "consultant" }, modalities: ["CT"], mode: "only" },
      },
      coordinator,
      "r",
    );
    await expect(
      editRule("rule-5-modality-assignment", { strength: "hard" }, coordinator, "r"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("switches a rule off and on, unchanged when already in that state", async () => {
    const off = await disableRule("rule-1-rest-after-call", coordinator, "r");
    expect(off.enabled).toBe(false);
    expect((await disableRule("rule-1-rest-after-call", coordinator, "r")).enabled).toBe(false);
    const on = await enableRule("rule-1-rest-after-call", coordinator, "r");
    expect(on.enabled).toBe(true);
    expect((await enableRule("rule-1-rest-after-call", coordinator, "r")).enabled).toBe(true);
    await expect(enableRule("rule-42-duty-limit", coordinator, "r")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("deletes a rule for good, and refuses to delete an unknown one (404)", async () => {
    await removeRule("rule-2-residents-on-xr", coordinator, "r");
    expect((await listRules()).map((r) => r.id)).toEqual([
      "rule-1-rest-after-call",
      "rule-3-one-call-per-week",
    ]);
    await expect(removeRule("rule-2-residents-on-xr", coordinator, "r")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("can this doctor take this duty? (BR3.1-BR3.6)", () => {
  it("says no for Ben on 2026-12-08 AM XR after the 2026-12-07 CALL in the draft (AC1.9.1)", async () => {
    await putBenOnCallDraft();
    const answer = await checkCanTake("ben.ochieng", "d-2026-12-08-am-xr");
    expect(answer).toMatchObject({
      doctorId: "ben.ochieng",
      dutyId: "d-2026-12-08-am-xr",
      allowed: false,
      source: "draft",
    });
    expect(answer.broken).toEqual([
      {
        ruleId: "rule-1-rest-after-call",
        strength: "hard",
        reason: "ben.ochieng is on CALL d-2026-12-07-call-xr the night before",
      },
    ]);
  });

  it("says no for Chen on every duty from 2026-12-07 to 09: approved leave (AC1.9.2)", async () => {
    for (const { id } of exampleDuties()) {
      const answer = await checkCanTake("chen.li", id);
      expect(answer.allowed).toBe(false);
      expect(answer.broken.map((b) => b.ruleId)).toContain("always-on:approved-leave");
    }
  });

  it("finds no leave clash for Ben's 2026-12-07 CALL with leave on 2026-12-08 only (AC1.9.3)", async () => {
    await putBenOnCallDraft();
    await putLeave([
      {
        ...exampleLeave()[0],
        id: "leave-ben-2026-12-08",
        doctorId: "ben.ochieng",
        startDate: "2026-12-08",
        endDate: "2026-12-08",
      },
    ]);
    const answer = await checkCanTake("ben.ochieng", "d-2026-12-07-call-xr");
    expect(answer.broken.map((b) => b.ruleId)).not.toContain("always-on:approved-leave");
    expect(answer.allowed).toBe(true);
  });

  it("says no for Ben on a PM when he has an AM the same day (AC1.9.4)", async () => {
    await putDuties([
      duty("d-2026-12-08-pm-xr", { date: "2026-12-08", type: "PM", modality: "XR" }),
    ]);
    await putRosterWeek("draft", "2026-12-07", [["ben.ochieng", "d-2026-12-08-am-xr"]]);
    const answer = await checkCanTake("ben.ochieng", "d-2026-12-08-pm-xr");
    expect(answer.allowed).toBe(false);
    expect(answer.broken[0].ruleId).toBe("always-on:one-daytime-duty");
  });

  it("uses the published week when there is no draft, and no roster when there is neither", async () => {
    expect(await checkCanTake("ben.ochieng", "d-2026-12-08-am-xr")).toEqual({
      doctorId: "ben.ochieng",
      dutyId: "d-2026-12-08-am-xr",
      allowed: true,
      broken: [],
      source: "none",
    });
    await putRosterWeek("published", "2026-12-07", [["ben.ochieng", "d-2026-12-07-call-xr"]]);
    const answer = await checkCanTake("ben.ochieng", "d-2026-12-08-am-xr");
    expect(answer).toMatchObject({ allowed: false, source: "published" });
    expect(answer.broken[0].ruleId).toBe("rule-1-rest-after-call");
  });

  it("answers no for a deactivated doctor, with inactive-doctor first (BR3.5)", async () => {
    await putDoctors([doctor("ben.ochieng", { active: false })]);
    await putBenOnCallDraft();
    const answer = await checkCanTake("ben.ochieng", "d-2026-12-08-am-xr");
    expect(answer.allowed).toBe(false);
    expect(answer.broken.map((b) => b.ruleId)).toEqual([
      "inactive-doctor",
      "rule-1-rest-after-call",
    ]);
    expect(answer.broken[0]).toEqual({
      ruleId: "inactive-doctor",
      strength: "hard",
      reason: "ben.ochieng is deactivated",
    });
  });

  it("refuses an unknown doctor, an unknown duty and a cancelled duty (404)", async () => {
    await putDuties([duty("d-2026-12-08-am-us", { cancelled: true })]);
    await expect(checkCanTake("nobody", "d-2026-12-08-am-xr")).rejects.toThrow(
      "Doctor nobody not found",
    );
    await expect(checkCanTake("ben.ochieng", "d-none")).rejects.toBeInstanceOf(NotFoundError);
    const cancelled = checkCanTake("chen.li", "d-2026-12-08-am-us");
    await expect(cancelled).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelled).rejects.toThrow("duty is cancelled");
  });

  it("judges the place a doctor already holds without double counting (R-01)", async () => {
    await putRules([
      {
        id: "rule-4-fair-share",
        type: "fair_share",
        strength: "hard",
        enabled: true,
        settings: { dutyType: "CALL" },
      },
    ]);
    await putBenOnCallDraft();
    const answer = await checkCanTake("ben.ochieng", "d-2026-12-07-call-xr");
    expect(answer).toMatchObject({ allowed: true, broken: [], source: "draft" });
    // A second CALL in the same week does count: Ben's 1 CALL against Chen's 0 (both XR, active).
    await putRosterWeek("draft", "2026-12-07", [
      ["ben.ochieng", "d-2026-12-07-call-xr"],
      ["ben.ochieng", "d-2026-12-08-am-xr"],
    ]);
    await putDuties([
      duty("d-2026-12-10-call-xr", { date: "2026-12-10", type: "CALL", modality: "XR" }),
    ]);
    const second = await checkCanTake("ben.ochieng", "d-2026-12-10-call-xr");
    expect(second.broken.map((b) => b.ruleId)).toEqual([
      "rule-3-one-call-per-week",
      "rule-4-fair-share",
    ]);
  });

  it("gives the same answer for the same inputs (NFR5.1) with exactly one checker call (NFR1.4)", async () => {
    await putBenOnCallDraft();
    vi.mocked(checkPlacement).mockClear();
    const first = await checkCanTake("ben.ochieng", "d-2026-12-08-am-xr");
    expect(vi.mocked(checkPlacement)).toHaveBeenCalledTimes(1);
    const second = await checkCanTake("ben.ochieng", "d-2026-12-08-am-xr");
    expect(second).toEqual(first);
  });

  it("answers in under 1 s for 20 doctors and 100 duties a week over a four-week draft (NFR1.1)", async () => {
    const doctors: Doctor[] = Array.from({ length: 20 }, (_, i) => ({
      id: `doc-${String(i).padStart(2, "0")}`,
      name: `Dr ${i}`,
      grade: i % 2 === 0 ? "consultant" : "resident",
      modalities: [...MODALITIES],
      maxHoursPerWeek: 60,
      active: true,
    }));
    const weeks = ["2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28"];
    const duties: Duty[] = weeks.flatMap((week) =>
      Array.from({ length: 100 }, (_, i) => ({
        id: `p-${week}-${String(i).padStart(3, "0")}`,
        date: addDays(week, i % 7),
        type: DUTY_TYPES[i % 3],
        modality: MODALITIES[Math.floor(i / 7) % 4],
        doctorsNeeded: 1,
        needsConsultant: false,
        cancelled: false,
      })),
    );
    await putDoctors(doctors);
    await putDuties(duties);
    for (const week of weeks) {
      const pairs = duties
        .filter((d) => d.id.startsWith(`p-${week}`))
        .map((d, i): [string, string] => [doctors[(i * 7) % 20].id, d.id]);
      await putRosterWeek("draft", week, pairs);
      await putRosterWeek("published", week, pairs);
    }
    const started = performance.now();
    const answer = await checkCanTake("doc-03", "p-2026-12-14-050");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(answer.source).toBe("draft");
  });
});

describe("audit line (NFR2.7)", () => {
  const savedLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    process.env.LOG_LEVEL = savedLevel;
    vi.restoreAllMocks();
  });

  it("writes one rule.changed line per change with action, rule, type, caller, time and request", async () => {
    process.env.LOG_LEVEL = "info";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const created = await createRule(
      { type: "weekly_hours", strength: "soft", settings: {} },
      coordinator,
      "req-create",
    );
    await editRule(created.id, { strength: "hard" }, coordinator, "req-edit");
    await disableRule(created.id, coordinator, "req-disable");
    await disableRule(created.id, coordinator, "req-again");
    await enableRule(created.id, coordinator, "req-enable");
    await removeRule(created.id, coordinator, "req-delete");
    await expect(removeRule(created.id, coordinator, "req-missing")).rejects.toThrow();
    const lines = spy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.msg === "rule.changed");
    expect(lines.map((l) => [l.action, l.requestId])).toEqual([
      ["create", "req-create"],
      ["edit", "req-edit"],
      ["disable", "req-disable"],
      ["enable", "req-enable"],
      ["delete", "req-delete"],
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({
        level: "info",
        ruleId: "rule-4-weekly-hours",
        type: "weekly_hours",
        by: "coord1",
      });
      expect(Date.parse(String(line.at))).not.toBeNaN();
      expect(line).not.toHaveProperty("settings");
    }
  });
});
