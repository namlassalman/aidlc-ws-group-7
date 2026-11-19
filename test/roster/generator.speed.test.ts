// u6-roster generator speed (AC1.11.3, NFR1.1, NFR1.2) and stored week size (NFR1.10).
// Generated data from makeData: 20 active doctors, 25 duties per week, five rules incl. fair share.
// The targets are fixed by the NFR requirements and must not be relaxed.
import { describe, expect, it } from "vitest";
import type { Rule } from "../../src/shared/tables.js";
import { Deadline } from "../../src/features/roster/deadline.js";
import { generate, type GeneratorInputs } from "../../src/features/roster/generator.js";
import { EARLY_NOW, makeData } from "./fixtures.js";

function speedInputs(weeks: number): GeneratorInputs {
  const data = makeData(20, weeks);
  return {
    ...data,
    weeks,
    windowDuties: data.duties,
    approvedLeave: data.leave,
    publishedWeeks: [],
  };
}

function timed(inputs: GeneratorInputs) {
  const started = performance.now();
  const result = generate(inputs, EARLY_NOW, new Deadline());
  return { result, ms: performance.now() - started };
}

describe("generation speed", () => {
  it("generates 20 doctors and 100 duties (4 weeks) in under 5 s", () => {
    const inputs = speedInputs(4);
    expect(inputs.duties).toHaveLength(100);
    const { result, ms } = timed(inputs);
    expect(result.weeks).toHaveLength(4);
    expect(result.stats.placements).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5_000);
  });

  it("generates 20 doctors and 200 duties (8 weeks) in under 10 s", () => {
    const inputs = speedInputs(8);
    expect(inputs.duties).toHaveLength(200);
    const { result, ms } = timed(inputs);
    expect(result.weeks).toHaveLength(8);
    expect(ms).toBeLessThan(10_000);
  });
});

describe("stored week size (NFR1.10)", () => {
  it("keeps the largest allowed week, every place a gap with a suggestion, under 100 kB", () => {
    const inputs = speedInputs(1);
    inputs.duties = inputs.duties.map((d) => ({ ...d, doctorsNeeded: 3 }));
    const blockEveryType: Rule[] = (["AM", "PM", "CALL"] as const).map((dutyType) => ({
      id: `rule-block-${dutyType.toLowerCase()}`,
      type: "duty_limit",
      strength: "hard",
      enabled: true,
      settings: { dutyType, max: 0, per: "week" },
    }));
    inputs.rules = [...inputs.rules, ...blockEveryType];
    const [week] = generate(inputs, EARLY_NOW, new Deadline()).weeks;
    expect(week.placements).toHaveLength(0);
    expect(week.gaps).toHaveLength(75);
    expect(week.gaps.every((g) => g.suggested !== null)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(week), "utf8")).toBeLessThan(100 * 1024);
  });
});
