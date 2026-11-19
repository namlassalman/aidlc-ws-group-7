// u6-roster generator (US1.11, US1.12; BR2.3-BR2.5, BR3, BR4; NFR1.3, NFR1.4, NFR5.1).
// Pure: no tables. The example data comes from scripts/example-data.ts through the fixtures.
import { describe, expect, it } from "vitest";
import type { RosterWeek } from "../../src/shared/tables.js";
import { Deadline } from "../../src/features/roster/deadline.js";
import {
  generate,
  type GeneratorInputs,
  type StepSnapshot,
} from "../../src/features/roster/generator.js";
import { RunTooLongError } from "../../src/features/roster/schemas.js";
import {
  EARLY_NOW,
  EXAMPLE_WEEK,
  FakeClock,
  exampleData,
  leaveRequest,
  makeData,
} from "./fixtures.js";

const noDeadline = { check: () => {} };

/** 04:00 on 2026-12-07 in Singapore: the 08:00 AM CT duty starts in 4 hours, so it is locked. */
const BEFORE_CT = "2026-12-06T20:00:00.000Z";

function exampleInputs(): GeneratorInputs {
  const data = exampleData();
  return {
    weekStart: EXAMPLE_WEEK,
    weeks: 1,
    doctors: data.doctors,
    duties: data.duties,
    windowDuties: data.duties,
    approvedLeave: data.leave,
    rules: data.rules,
    publishedWeeks: [],
  };
}

function publishedWeek(placements: RosterWeek["placements"]): RosterWeek {
  return {
    weekStart: EXAMPLE_WEEK,
    version: "published",
    periodStart: EXAMPLE_WEEK,
    periodWeeks: 1,
    generatedAt: EARLY_NOW,
    publishedAt: EARLY_NOW,
    now: EARLY_NOW,
    placements,
    gaps: [],
    brokenSoftRules: [],
  };
}

const who = (week: RosterWeek) => week.placements.map((p) => [p.dutyId, p.place, p.doctorId]);

describe("the example week (AC1.11.1, AC1.12.1)", () => {
  it("gives exactly the expected draft, the gap reason and the suggestion", () => {
    const { weeks, stats } = generate(exampleInputs(), EARLY_NOW, noDeadline);
    expect(weeks).toHaveLength(1);
    const [week] = weeks;
    expect(who(week)).toEqual([
      ["d-2026-12-07-am-ct", 1, "asha.rao"],
      ["d-2026-12-07-am-ct", 2, "ben.ochieng"],
      ["d-2026-12-07-call-xr", 1, "ben.ochieng"],
      ["d-2026-12-08-am-mri", 1, "asha.rao"],
      ["d-2026-12-08-am-us", 1, "dana.novak"],
      ["d-2026-12-09-pm-xr", 1, "ben.ochieng"],
    ]);
    expect(week.placements.every((p) => p.locked === false)).toBe(true);
    expect(week.gaps).toEqual([
      {
        dutyId: "d-2026-12-08-am-xr",
        place: 1,
        reason:
          "Dr Ben Ochieng is the only XR-trained doctor free; rest after call (hard) blocks Dr Ben Ochieng",
        suggested: { doctorId: "ben.ochieng", brokenHardRules: ["rule-1-rest-after-call"] },
      },
    ]);
    expect(week.placements.some((p) => p.doctorId === "chen.li")).toBe(false);
    expect(week).toMatchObject({
      version: "draft",
      periodStart: EXAMPLE_WEEK,
      periodWeeks: 1,
      generatedAt: EARLY_NOW,
      now: EARLY_NOW,
      publishedAt: null,
      brokenSoftRules: [],
    });
    expect(stats).toEqual({ duties: 6, places: 7, placements: 6, gaps: 1 });
  });

  it("gives byte-identical output for two runs, whatever the input order (AC1.11.2, NFR5.1)", () => {
    const first = JSON.stringify(generate(exampleInputs(), EARLY_NOW, noDeadline));
    const second = JSON.stringify(generate(exampleInputs(), EARLY_NOW, noDeadline));
    const shuffled = exampleInputs();
    shuffled.doctors = [...shuffled.doctors].reverse();
    shuffled.duties = [...shuffled.duties].reverse();
    shuffled.rules = [...shuffled.rules].reverse();
    expect(second).toBe(first);
    expect(JSON.stringify(generate(shuffled, EARLY_NOW, noDeadline))).toBe(first);
  });
});

describe("incremental recount (NFR1.4)", () => {
  const trace = (inputs: GeneratorInputs, fullRecount: boolean) => {
    const steps: StepSnapshot[] = [];
    const result = generate(inputs, EARLY_NOW, noDeadline, {
      fullRecount,
      onStep: (s) => steps.push(s),
    });
    return { steps, result };
  };

  it("matches the full recount step by step on the example week", () => {
    const incremental = trace(exampleInputs(), false);
    const full = trace(exampleInputs(), true);
    expect(incremental.steps).toHaveLength(7);
    expect(incremental.steps).toEqual(full.steps);
    expect(incremental.result).toEqual(full.result);
  });

  it("matches the full recount step by step on generated data with fair share", () => {
    const data = makeData(10, 2);
    const inputs: GeneratorInputs = {
      ...data,
      weeks: 2,
      windowDuties: data.duties,
      approvedLeave: data.leave,
      publishedWeeks: [],
    };
    const incremental = trace(inputs, false);
    const full = trace(inputs, true);
    expect(incremental.steps.length).toBeGreaterThan(50);
    expect(incremental.steps).toEqual(full.steps);
    expect(incremental.result).toEqual(full.result);
  });
});

describe("gaps with no suggestion (AC1.12.2, BR4.2, BR4.4)", () => {
  it("uses the consultant wording when no consultant is free", () => {
    const inputs = exampleInputs();
    inputs.approvedLeave = [
      ...inputs.approvedLeave,
      leaveRequest("asha.rao", "2026-12-07", "2026-12-07"),
    ];
    const [week] = generate(inputs, EARLY_NOW, noDeadline).weeks;
    const ctGaps = week.gaps.filter((g) => g.dutyId === "d-2026-12-07-am-ct");
    expect(ctGaps).toEqual([
      {
        dutyId: "d-2026-12-07-am-ct",
        place: 1,
        reason: "No consultant trained in CT is free on 2026-12-07 AM",
        suggested: null,
      },
      {
        dutyId: "d-2026-12-07-am-ct",
        place: 2,
        reason: "No consultant trained in CT is free on 2026-12-07 AM",
        suggested: null,
      },
    ]);
  });

  it("uses the plain wording when no trained doctor passes the always-on checks", () => {
    const inputs = exampleInputs();
    inputs.approvedLeave = [
      ...inputs.approvedLeave,
      leaveRequest("ben.ochieng", "2026-12-09", "2026-12-09"),
    ];
    const [week] = generate(inputs, EARLY_NOW, noDeadline).weeks;
    expect(week.gaps.find((g) => g.dutyId === "d-2026-12-09-pm-xr")).toEqual({
      dutyId: "d-2026-12-09-pm-xr",
      place: 1,
      reason: "No XR-trained doctor is free on 2026-12-09 PM",
      suggested: null,
    });
  });
});

describe("locked duties (BR2.3-BR2.5)", () => {
  it("carries a locked published doctor at its place number, even when inactive", () => {
    const inputs = exampleInputs();
    inputs.doctors = inputs.doctors.map((d) => (d.id === "asha.rao" ? { ...d, active: false } : d));
    inputs.publishedWeeks = [
      publishedWeek([
        { dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "ben.ochieng", locked: false },
        { dutyId: "d-2026-12-07-am-ct", place: 2, doctorId: "asha.rao", locked: false },
      ]),
    ];
    const [week] = generate(inputs, BEFORE_CT, noDeadline).weeks;
    expect(week.placements.filter((p) => p.dutyId === "d-2026-12-07-am-ct")).toEqual([
      { dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "ben.ochieng", locked: true },
      { dutyId: "d-2026-12-07-am-ct", place: 2, doctorId: "asha.rao", locked: true },
    ]);
    // Rao is inactive, so she is not placed anywhere else.
    expect(week.placements.filter((p) => p.doctorId === "asha.rao")).toHaveLength(1);
  });

  it("fills an empty place of a locked duty and marks it locked (Q4: B)", () => {
    const inputs = exampleInputs();
    inputs.publishedWeeks = [
      publishedWeek([
        { dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "asha.rao", locked: false },
      ]),
    ];
    const [week] = generate(inputs, BEFORE_CT, noDeadline).weeks;
    expect(week.placements.filter((p) => p.dutyId === "d-2026-12-07-am-ct")).toEqual([
      { dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "asha.rao", locked: true },
      { dutyId: "d-2026-12-07-am-ct", place: 2, doctorId: "ben.ochieng", locked: true },
    ]);
  });

  it("opens every place of a locked duty with no published week (BR2.5)", () => {
    const [week] = generate(exampleInputs(), BEFORE_CT, noDeadline).weeks;
    expect(week.placements.filter((p) => p.dutyId === "d-2026-12-07-am-ct")).toEqual([
      { dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "asha.rao", locked: true },
      { dutyId: "d-2026-12-07-am-ct", place: 2, doctorId: "ben.ochieng", locked: true },
    ]);
  });
});

describe("doctors and duties left out", () => {
  it("never places a deactivated doctor", () => {
    const inputs = exampleInputs();
    inputs.doctors = inputs.doctors.map((d) =>
      d.id === "dana.novak" ? { ...d, active: false } : d,
    );
    const [week] = generate(inputs, EARLY_NOW, noDeadline).weeks;
    expect(week.placements.some((p) => p.doctorId === "dana.novak")).toBe(false);
    expect(week.gaps.map((g) => g.dutyId)).toContain("d-2026-12-08-am-us");
    expect(week.gaps.every((g) => g.suggested?.doctorId !== "dana.novak")).toBe(true);
  });

  it("ignores cancelled duties and still writes a week with no duties (BR5.2)", () => {
    const inputs = exampleInputs();
    inputs.duties = inputs.duties.map((d) => ({ ...d, cancelled: true }));
    inputs.weeks = 2;
    const { weeks } = generate(inputs, EARLY_NOW, noDeadline);
    expect(weeks.map((w) => [w.weekStart, w.placements.length, w.gaps.length])).toEqual([
      ["2026-12-07", 0, 0],
      ["2026-12-14", 0, 0],
    ]);
  });
});

describe("the deadline (NFR1.3)", () => {
  it("stops a run between placements and returns nothing", () => {
    const data = makeData(20, 4);
    const inputs: GeneratorInputs = {
      ...data,
      weeks: 4,
      windowDuties: data.duties,
      approvedLeave: data.leave,
      publishedWeeks: [],
    };
    const clock = new FakeClock(0, 1000); // every read moves the clock on by 1 s
    const steps: number[] = [];
    let result: unknown;
    expect(() => {
      result = generate(inputs, EARLY_NOW, new Deadline(clock.now), {
        onStep: (s) => steps.push(s.step),
      });
    }).toThrow(RunTooLongError);
    expect(result).toBeUndefined();
    expect(steps.at(-1)).toBe(14); // 15 checks of 1 s each reach the 15 s cut-off
  });

  it("lets a run under the cut-off finish", () => {
    const clock = new FakeClock(0);
    const deadline = new Deadline(clock.now);
    clock.advance(14_999);
    expect(() => generate(exampleInputs(), EARLY_NOW, deadline)).not.toThrow();
  });
});
