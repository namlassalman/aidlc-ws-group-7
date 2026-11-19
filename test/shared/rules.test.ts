import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/shared/errors.js";
import {
  buildWindow,
  checkPlacement,
  findContradiction,
  validateSettings,
  windowRange,
  type PlacedDuty,
  type Rule,
} from "../../src/shared/rules.js";
import type { Duty } from "../../src/shared/tables.js";
import {
  doctor,
  duty,
  exampleDoctors,
  exampleLeave,
  exampleRules,
  placementInput,
} from "./fixtures.js";

const ids = (broken: { ruleId: string }[]) => broken.map((b) => b.ruleId);

function rule(id: string, partial: Omit<Rule, "id" | "enabled"> & { enabled?: boolean }): Rule {
  return { enabled: true, ...partial, id } as Rule;
}

const placed = (...duties: Duty[]) => duties.map((d) => ({ duty: d }));

describe("checkPlacement: always-on checks", () => {
  it("allows a trained, free doctor with nothing broken", () => {
    const result = checkPlacement(
      placementInput(doctor("ben.ochieng"), duty("d-2026-12-09-pm-xr")),
    );
    expect(result).toEqual({ allowed: true, broken: [] });
  });

  it("trained-modality: refuses a doctor not trained for the modality", () => {
    const result = checkPlacement(placementInput(doctor("asha.rao"), duty("d-2026-12-08-am-xr")));
    expect(result.allowed).toBe(false);
    expect(ids(result.broken)).toEqual(["always-on:trained-modality"]);
    expect(result.broken[0].strength).toBe("hard");
  });

  it("approved-leave: refuses a duty inside approved leave, CALL by its start date", () => {
    const leave = exampleLeave().map(({ startDate, endDate }) => ({ startDate, endDate }));
    const li = doctor("chen.li");
    const onLeave = checkPlacement(
      placementInput(li, duty("d-2026-12-09-pm-xr"), { approvedLeave: leave }),
    );
    expect(ids(onLeave.broken)).toEqual(["always-on:approved-leave"]);
    // A CALL starting the day leave ends counts on that day; one starting the day after does not,
    // and a CALL starting the night before leave begins does not either.
    const callOnLastDay = duty("c1", { date: "2026-12-09", type: "CALL", modality: "XR" });
    const callAfter = duty("c2", { date: "2026-12-10", type: "CALL", modality: "XR" });
    const callBefore = duty("c3", { date: "2026-12-06", type: "CALL", modality: "XR" });
    const check = (d: Duty) =>
      checkPlacement(placementInput(li, d, { approvedLeave: leave })).allowed;
    expect([check(callOnLastDay), check(callAfter), check(callBefore)]).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("time-overlap: refuses a duty overlapping one the doctor already has", () => {
    const ben = doctor("ben.ochieng");
    const secondCall = duty("d-2026-12-07-call-ct", {
      date: "2026-12-07",
      type: "CALL",
      modality: "CT",
    });
    const result = checkPlacement(
      placementInput(ben, secondCall, { doctorPlacements: placed(duty("d-2026-12-07-call-xr")) }),
    );
    expect(ids(result.broken)).toEqual(["always-on:time-overlap"]);
  });

  it("consultant-needed: refuses a resident unless a consultant is already on the duty", () => {
    const ben = doctor("ben.ochieng");
    const ctAm = duty("d-2026-12-07-am-ct");
    expect(ids(checkPlacement(placementInput(ben, ctAm)).broken)).toEqual([
      "always-on:consultant-needed",
    ]);
    const withRao = checkPlacement(
      placementInput(ben, ctAm, {
        dutyPlacements: [{ doctorId: "asha.rao", grade: "consultant" }],
      }),
    );
    expect(withRao).toEqual({ allowed: true, broken: [] });
  });

  it("one-daytime-duty: refuses a second AM or PM duty on the same date", () => {
    const dana = doctor("dana.novak");
    const pmUs = duty("d-2026-12-08-pm-us", { date: "2026-12-08", type: "PM", modality: "US" });
    const result = checkPlacement(
      placementInput(dana, pmUs, { doctorPlacements: placed(duty("d-2026-12-08-am-mri")) }),
    );
    expect(ids(result.broken)).toEqual(["always-on:one-daytime-duty"]);
    const callUs = duty("d-2026-12-08-call-us", {
      date: "2026-12-08",
      type: "CALL",
      modality: "US",
    });
    const call = checkPlacement(
      placementInput(dana, callUs, { doctorPlacements: placed(duty("d-2026-12-08-am-mri")) }),
    );
    expect(call.allowed).toBe(true);
  });

  it("already-on-duty: refuses a doctor already on this duty", () => {
    const rao = doctor("asha.rao");
    const ctAm = duty("d-2026-12-07-am-ct");
    const result = checkPlacement(
      placementInput(rao, ctAm, {
        dutyPlacements: [{ doctorId: "asha.rao", grade: "consultant" }],
      }),
    );
    expect(ids(result.broken)).toEqual(["always-on:already-on-duty"]);
    const fromWindow = checkPlacement(
      placementInput(rao, ctAm, { doctorPlacements: placed(ctAm) }),
    );
    expect(ids(fromWindow.broken)).toEqual(["always-on:already-on-duty"]);
  });
});

describe("checkPlacement: the example week", () => {
  it("Ochieng on 2026-12-08 AM XR after his CALL breaks only rest after call", () => {
    const result = checkPlacement(
      placementInput(doctor("ben.ochieng"), duty("d-2026-12-08-am-xr"), {
        doctorPlacements: placed(duty("d-2026-12-07-am-ct"), duty("d-2026-12-07-call-xr")),
        rules: exampleRules(),
      }),
    );
    expect(result).toEqual({
      allowed: false,
      broken: [
        {
          ruleId: "rule-1-rest-after-call",
          strength: "hard",
          reason: "ben.ochieng is on CALL d-2026-12-07-call-xr the night before",
        },
      ],
    });
  });

  it("Ochieng with one CALL is allowed onto a PM duty under max 1 CALL per week", () => {
    const result = checkPlacement(
      placementInput(doctor("ben.ochieng"), duty("d-2026-12-09-pm-xr"), {
        doctorPlacements: placed(duty("d-2026-12-07-call-xr")),
        rules: exampleRules(),
      }),
    );
    expect(result).toEqual({ allowed: true, broken: [] });
  });
});

describe("checkPlacement: rule break tests", () => {
  const ben = doctor("ben.ochieng");

  it("modality_assignment only: a named doctor off the listed modalities", () => {
    const raoMriOnly = rule("r-mri-only", {
      type: "modality_assignment",
      strength: "hard",
      settings: { who: { doctorIds: ["asha.rao"] }, modalities: ["MRI"], mode: "only" },
    });
    const rao = doctor("asha.rao");
    const onCt = checkPlacement(
      placementInput(rao, duty("d-2026-12-07-am-ct"), { rules: [raoMriOnly] }),
    );
    expect(onCt.allowed).toBe(false);
    expect(ids(onCt.broken)).toEqual(["r-mri-only"]);
    const onMri = checkPlacement(
      placementInput(rao, duty("d-2026-12-08-am-mri"), { rules: [raoMriOnly] }),
    );
    expect(onMri.allowed).toBe(true);
  });

  it("modality_assignment preferOn: a soft break is reported but still allowed", () => {
    const residentsOnCt = rule("r-prefer", {
      type: "modality_assignment",
      strength: "soft",
      settings: { who: { grade: "resident" }, modalities: ["CT"], mode: "preferOn" },
    });
    const result = checkPlacement(
      placementInput(doctor("asha.rao"), duty("d-2026-12-07-am-ct"), { rules: [residentsOnCt] }),
    );
    expect(result.allowed).toBe(true);
    expect(result.broken).toEqual([
      expect.objectContaining({ ruleId: "r-prefer", strength: "soft" }),
    ]);
  });

  it("duty_limit: a second CALL in the week, but only for its own dutyType", () => {
    const limit = exampleRules().filter((r) => r.type === "duty_limit");
    const secondCall = duty("d-2026-12-10-call-xr", {
      date: "2026-12-10",
      type: "CALL",
      modality: "XR",
    });
    const call = checkPlacement(
      placementInput(ben, secondCall, {
        doctorPlacements: placed(duty("d-2026-12-07-call-xr")),
        rules: limit,
      }),
    );
    expect(ids(call.broken)).toEqual(["rule-3-one-call-per-week"]);
    const nextWeek = duty("d-2026-12-14-call-xr", {
      date: "2026-12-14",
      type: "CALL",
      modality: "XR",
    });
    const otherWeek = checkPlacement(
      placementInput(ben, nextWeek, {
        doctorPlacements: placed(duty("d-2026-12-07-call-xr")),
        rules: limit,
      }),
    );
    expect(otherWeek.allowed).toBe(true);
  });

  it("duty_limit per month counts every week of the month", () => {
    const monthly = rule("r-month", {
      type: "duty_limit",
      strength: "hard",
      settings: { dutyType: "PM", max: 1, per: "month" },
    });
    const pm = duty("d-2026-12-28-pm-xr", { date: "2026-12-28", type: "PM", modality: "XR" });
    const result = checkPlacement(
      placementInput(ben, pm, {
        doctorPlacements: placed(duty("d-2026-12-09-pm-xr")),
        rules: [monthly],
      }),
    );
    expect(ids(result.broken)).toEqual(["r-month"]);
  });

  it("weekly_hours: hours in the week including this duty over the doctor's maximum", () => {
    const hours = rule("r-hours", { type: "weekly_hours", strength: "soft", settings: {} });
    const limited = doctor("ben.ochieng", { maxHoursPerWeek: 20 });
    // CALL 14 h + AM 5 h = 19 h; a PM (5 h) makes 24 h > 20.
    const doctorPlacements = placed(duty("d-2026-12-07-call-xr"), duty("d-2026-12-08-am-xr"));
    const over = checkPlacement(
      placementInput(limited, duty("d-2026-12-09-pm-xr"), { doctorPlacements, rules: [hours] }),
    );
    expect(over).toMatchObject({
      allowed: true,
      broken: [{ ruleId: "r-hours", strength: "soft" }],
    });
    const within = checkPlacement(
      placementInput(doctor("ben.ochieng"), duty("d-2026-12-09-pm-xr"), {
        doctorPlacements,
        rules: [hours],
      }),
    );
    expect(within.broken).toEqual([]);
  });

  it("consultant_cover: only on the last open place, with no consultant on the duty", () => {
    const cover = rule("r-cover", {
      type: "consultant_cover",
      strength: "hard",
      settings: { modalities: ["CT"] },
    });
    const ct = duty("ct-two", { modality: "CT", doctorsNeeded: 2, needsConsultant: false });
    const firstPlace = checkPlacement(placementInput(ben, ct, { rules: [cover] }));
    expect(firstPlace.allowed).toBe(true);
    const lastPlace = checkPlacement(
      placementInput(ben, ct, {
        rules: [cover],
        dutyPlacements: [{ doctorId: "x", grade: "resident" }],
      }),
    );
    expect(ids(lastPlace.broken)).toEqual(["r-cover"]);
    const covered = checkPlacement(
      placementInput(ben, ct, {
        rules: [cover],
        dutyPlacements: [{ doctorId: "asha.rao", grade: "consultant" }],
      }),
    );
    expect(covered.allowed).toBe(true);
  });

  it("fair_share: more than the lowest count + 1, only for its dutyType", () => {
    const fair = rule("r-fair", {
      type: "fair_share",
      strength: "soft",
      settings: { dutyType: "CALL" },
    });
    const call = duty("d-2026-12-10-call-xr", { date: "2026-12-10", type: "CALL", modality: "XR" });
    const uneven = {
      "ben.ochieng": { AM: 0, PM: 0, CALL: 1 },
      "chen.li": { AM: 0, PM: 0, CALL: 0 },
    };
    expect(
      ids(
        checkPlacement(placementInput(ben, call, { rules: [fair], periodCounts: uneven })).broken,
      ),
    ).toEqual(["r-fair"]);
    const even = { "ben.ochieng": { AM: 0, PM: 0, CALL: 0 }, "chen.li": { AM: 0, PM: 0, CALL: 0 } };
    expect(
      checkPlacement(placementInput(ben, call, { rules: [fair], periodCounts: even })).broken,
    ).toEqual([]);
    expect(
      checkPlacement(
        placementInput(ben, duty("d-2026-12-09-pm-xr"), { rules: [fair], periodCounts: uneven }),
      ).broken,
    ).toEqual([]);
  });

  it("skips disabled rules", () => {
    const rules = exampleRules().map((r) => ({ ...r, enabled: false }));
    const result = checkPlacement(
      placementInput(ben, duty("d-2026-12-08-am-xr"), {
        doctorPlacements: placed(duty("d-2026-12-07-call-xr")),
        rules,
      }),
    );
    expect(result).toEqual({ allowed: true, broken: [] });
  });

  it("lists always-on checks first, then rules by id, whatever order the rules come in", () => {
    const zLimit = rule("z-limit", {
      type: "duty_limit",
      strength: "hard",
      settings: { dutyType: "AM", max: 0, per: "week" },
    });
    const aPrefer = rule("a-prefer", {
      type: "modality_assignment",
      strength: "soft",
      settings: { who: { grade: "resident" }, modalities: ["XR"], mode: "preferOn" },
    });
    const result = checkPlacement(
      placementInput(doctor("asha.rao"), duty("d-2026-12-08-am-xr"), { rules: [zLimit, aPrefer] }),
    );
    expect(ids(result.broken)).toEqual(["always-on:trained-modality", "a-prefer", "z-limit"]);
  });
});

describe("validateSettings and findContradiction", () => {
  const doctors = exampleDoctors();

  it("returns parsed settings for a valid rule", () => {
    expect(
      validateSettings(
        { type: "duty_limit", settings: { dutyType: "CALL", max: 1, per: "week" } },
        doctors,
      ),
    ).toEqual({
      dutyType: "CALL",
      max: 1,
      per: "week",
    });
  });

  it("refuses unknown keys, empty lists and a max below 0", () => {
    const bad = [
      { type: "rest_after_call" as const, settings: { extra: true } },
      { type: "consultant_cover" as const, settings: { modalities: [] } },
      { type: "duty_limit" as const, settings: { dutyType: "CALL", max: -1, per: "week" } },
    ];
    for (const r of bad) expect(() => validateSettings(r, doctors)).toThrow(ValidationError);
  });

  it("refuses a named doctor who is not trained for any listed modality, or unknown", () => {
    const liMriOnly = {
      type: "modality_assignment" as const,
      settings: { who: { doctorIds: ["chen.li"] }, modalities: ["MRI"], mode: "only" },
    };
    expect(() => validateSettings(liMriOnly, doctors)).toThrow(/chen.li is not trained/);
    const ghost = {
      ...liMriOnly,
      settings: { ...liMriOnly.settings, who: { doctorIds: ["ghost"] } },
    };
    expect(() => validateSettings(ghost, doctors)).toThrow(/not a known doctor/);
  });

  it("finds two hard only-rules naming the same doctor with no common modality", () => {
    type ModalityRule = Extract<Rule, { type: "modality_assignment" }>;
    const onlyRule = (
      id: string,
      who: ModalityRule["settings"]["who"],
      modalities: ModalityRule["settings"]["modalities"],
    ) =>
      rule(id, {
        type: "modality_assignment",
        strength: "hard",
        settings: { who, modalities, mode: "only" },
      });
    const raoMri = onlyRule("r-a", { doctorIds: ["asha.rao"] }, ["MRI"]);
    const consultantsUs = onlyRule("r-b", { grade: "consultant" }, ["US"]);
    expect(findContradiction(consultantsUs, [raoMri], doctors)?.id).toBe("r-a");
    const sharedModality = onlyRule("r-b", { grade: "consultant" }, ["US", "MRI"]);
    expect(findContradiction(sharedModality, [raoMri], doctors)).toBeUndefined();
    expect(
      findContradiction({ ...consultantsUs, strength: "soft" }, [raoMri], doctors),
    ).toBeUndefined();
    expect(
      findContradiction(consultantsUs, [{ ...raoMri, enabled: false }], doctors),
    ).toBeUndefined();
  });
});

describe("buildWindow", () => {
  const ben = "ben.ochieng";
  const at = (id: string, date: string, doctorId = ben): PlacedDuty => ({
    doctorId,
    duty: duty(id, { date, type: "PM", modality: "XR" }),
  });

  it("starts at the earlier of the day before the period and the 1st of its month", () => {
    expect(windowRange({ weekStart: "2026-12-14", weeks: 2 })).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(windowRange({ weekStart: "2027-02-01", weeks: 1 })).toEqual({
      from: "2027-01-31",
      to: "2027-02-28",
    });
    expect(windowRange({ weekStart: "2026-12-28", weeks: 1 })).toEqual({
      from: "2026-12-01",
      to: "2027-01-31",
    });
  });

  it("uses one roster version per week: the draft for the period's weeks, otherwise published", () => {
    const draft = [at("draft-in-period", "2026-12-15"), at("draft-before", "2026-12-08")];
    const published = [
      at("pub-in-period", "2026-12-16"),
      at("pub-before", "2026-12-09"),
      at("pub-outside", "2026-11-30"),
      at("pub-other-doctor", "2026-12-09", "chen.li"),
    ];
    const window = buildWindow({ weekStart: "2026-12-14", weeks: 2 }, ben, draft, published);
    expect(window.from).toBe("2026-12-01");
    expect(window.placements.map((d) => d.id)).toEqual(["pub-before", "draft-in-period"]);
    expect(window.weekCounts.get("2026-12-14")).toEqual({ AM: 0, PM: 1, CALL: 0 });
    expect(window.monthCounts.get("2026-12")).toEqual({ AM: 0, PM: 2, CALL: 0 });
  });

  it("uses published only when draftWeeks is empty (a week with no draft)", () => {
    const window = buildWindow(
      { weekStart: "2026-12-14", weeks: 1 },
      ben,
      [at("draft", "2026-12-15")],
      [at("pub", "2026-12-16")],
      { draftWeeks: [] },
    );
    expect(window.placements.map((d) => d.id)).toEqual(["pub"]);
  });
});

describe("checkPlacement: determinism and speed", () => {
  function exampleInput() {
    const period = { weekStart: "2026-12-07", weeks: 1 };
    const draft = [
      { doctorId: "ben.ochieng", duty: duty("d-2026-12-07-am-ct") },
      { doctorId: "ben.ochieng", duty: duty("d-2026-12-07-call-xr") },
    ];
    return placementInput(doctor("ben.ochieng"), duty("d-2026-12-08-am-xr"), {
      doctorPlacements: buildWindow(period, "ben.ochieng", draft, []),
      rules: exampleRules(),
      periodCounts: {
        "ben.ochieng": { AM: 1, PM: 0, CALL: 1 },
        "chen.li": { AM: 0, PM: 0, CALL: 0 },
      },
    });
  }

  it("gives identical output for identical input", () => {
    expect(checkPlacement(exampleInput())).toEqual(checkPlacement(exampleInput()));
    const input = exampleInput();
    expect(JSON.stringify(checkPlacement(input))).toBe(JSON.stringify(checkPlacement(input)));
  });

  it("runs 100,000 calls in under 0.5 s (NFR1.1)", () => {
    const input = exampleInput();
    for (let i = 0; i < 1_000; i += 1) checkPlacement(input);
    const started = performance.now();
    for (let i = 0; i < 100_000; i += 1) checkPlacement(input);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(500);
  });
});
