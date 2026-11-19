// u6-roster service on the in-memory tables (US1.13, US1.15, US2.6, US2.7; BR5, BR6, BR8, BR9;
// NFR5.2, NFR6.1). Real checkPlacement, DutyCalendar and table helpers; time is injected.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../src/shared/auth.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/shared/errors.js";
import type { RosterWeek, Rule } from "../../src/shared/tables.js";
import { Deadline } from "../../src/features/roster/deadline.js";
import {
  getWeek,
  publishedWeeksBetween,
  putWeek,
  rosterRepository,
  type RosterRepository,
} from "../../src/features/roster/repository.js";
import {
  RELOCK_REASON,
  coverage,
  generateRun,
  myDuties,
  publishRun,
  readWeek,
} from "../../src/features/roster/service.js";
import { EARLY_NOW, EXAMPLE_WEEK, leaveRequest, seedExample, seedTables } from "./fixtures.js";

const coordinator: AuthUser = { id: "coord1", role: "coordinator" };
const ben: AuthUser = { id: "ben.ochieng", role: "doctor" };

/** 04:00 on 2026-12-07 in Singapore: the 08:00 AM CT duty is locked, the 18:00 CALL is not. */
const BEFORE_CT = "2026-12-06T20:00:00.000Z";
/** 04:00 on 2026-12-08 in Singapore: every 08:00 duty that day is locked. */
const BEFORE_DEC_8 = "2026-12-07T20:00:00.000Z";

const run = (weekStart: string, weeks: number, now: string) => ({
  weekStart,
  weeks,
  now,
  deadline: new Deadline(),
});

const who = (week: Pick<RosterWeek, "placements">) =>
  week.placements.map((p) => [p.dutyId, p.place, p.doctorId]);

async function generateAndPublishExample(now = EARLY_NOW) {
  await generateRun(run(EXAMPLE_WEEK, 1, now));
  return publishRun(run(EXAMPLE_WEEK, 1, now));
}

/** A repository whose `name` function throws on its Nth call. */
function failingOn(name: "putWeek" | "deleteDraft", nth: number): RosterRepository {
  let calls = 0;
  const original = rosterRepository[name];
  return {
    ...rosterRepository,
    [name]: async (arg: never) => {
      calls += 1;
      if (calls === nth) throw new Error(`rosters ${name} failed: injected`);
      return original(arg);
    },
  };
}

describe("publish (BR6)", () => {
  it("makes the example draft the published roster and deletes the draft (AC1.13.1)", async () => {
    await seedExample();
    const [draft] = await generateRun(run(EXAMPLE_WEEK, 1, EARLY_NOW));
    const [published] = await publishRun(run(EXAMPLE_WEEK, 1, "2026-12-02T00:00:00.000Z"));
    expect(who(published)).toEqual(who(draft));
    expect(published).toMatchObject({
      version: "published",
      publishedAt: "2026-12-02T00:00:00.000Z",
      now: "2026-12-02T00:00:00.000Z",
      generatedAt: EARLY_NOW,
    });
    expect(published.gaps).toEqual(draft.gaps);
    expect(await getWeek("draft", EXAMPLE_WEEK)).toBeUndefined();
    const seenByBen = await readWeek(ben, EXAMPLE_WEEK, "published");
    expect(who(seenByBen)).toEqual(who(draft));
  });

  it("keeps a locked duty's published doctors and moves the others (AC1.13.2)", async () => {
    await seedExample();
    await generateAndPublishExample();
    await seedTables({ leave: [leaveRequest("asha.rao", "2026-12-07", "2026-12-08")] });
    const [draft] = await generateRun(run(EXAMPLE_WEEK, 1, EARLY_NOW));
    expect(draft.placements.some((p) => p.dutyId === "d-2026-12-07-am-ct")).toBe(false);

    const [published] = await publishRun(run(EXAMPLE_WEEK, 1, BEFORE_CT));
    expect(published.placements.filter((p) => p.dutyId === "d-2026-12-07-am-ct")).toEqual([
      { dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "asha.rao", locked: true },
      { dutyId: "d-2026-12-07-am-ct", place: 2, doctorId: "ben.ochieng", locked: true },
    ]);
    expect(published.gaps.some((g) => g.dutyId === "d-2026-12-07-am-ct")).toBe(false);
    expect(published.placements.find((p) => p.dutyId === "d-2026-12-08-am-mri")).toEqual({
      dutyId: "d-2026-12-08-am-mri",
      place: 1,
      doctorId: "dana.novak",
      locked: false,
    });
  });

  it("gives 409 and writes nothing when a week has no draft (AC1.13.3, BR6.1)", async () => {
    await seedExample();
    await expect(publishRun(run(EXAMPLE_WEEK, 1, EARLY_NOW))).rejects.toBeInstanceOf(ConflictError);
    await generateRun(run(EXAMPLE_WEEK, 1, EARLY_NOW));
    await expect(publishRun(run(EXAMPLE_WEEK, 2, EARLY_NOW))).rejects.toThrow(
      "No draft for the week of 2026-12-14",
    );
    expect(await publishedWeeksBetween("2026-11-30", "2026-12-28")).toEqual([]);
    expect(await getWeek("draft", EXAMPLE_WEEK)).toBeDefined();
  });

  it("turns a merged place that breaks an always-on check into a gap (review R-02)", async () => {
    await seedExample();
    const base = {
      weekStart: EXAMPLE_WEEK,
      periodStart: EXAMPLE_WEEK,
      periodWeeks: 1,
      generatedAt: EARLY_NOW,
      now: EARLY_NOW,
      brokenSoftRules: [],
    };
    await putWeek({
      ...base,
      version: "published",
      publishedAt: EARLY_NOW,
      placements: [{ dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "asha.rao", locked: false }],
      gaps: [{ dutyId: "d-2026-12-07-am-ct", place: 2, reason: "earlier gap", suggested: null }],
    });
    await putWeek({
      ...base,
      version: "draft",
      publishedAt: null,
      placements: [
        { dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "ben.ochieng", locked: false },
        { dutyId: "d-2026-12-07-am-ct", place: 2, doctorId: "asha.rao", locked: false },
      ],
      gaps: [],
    });
    const [published] = await publishRun(run(EXAMPLE_WEEK, 1, BEFORE_CT));
    expect(published.placements).toEqual([
      { dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "asha.rao", locked: true },
    ]);
    expect(published.gaps).toEqual([
      { dutyId: "d-2026-12-07-am-ct", place: 2, reason: RELOCK_REASON, suggested: null },
    ]);
  });

  it("records a 1-week run when 1 week of a 4-week draft is published (review R-01)", async () => {
    await seedExample();
    await generateRun(run(EXAMPLE_WEEK, 4, EARLY_NOW));
    const [published] = await publishRun(run(EXAMPLE_WEEK, 1, EARLY_NOW));
    expect(published).toMatchObject({ periodStart: EXAMPLE_WEEK, periodWeeks: 1 });
    expect(await getWeek("draft", EXAMPLE_WEEK)).toBeUndefined();
    expect(await getWeek("draft", "2026-12-14")).toMatchObject({ periodWeeks: 4 });
  });

  it("leaves published weeks correct when a write or a delete fails part-way (NFR5.2)", async () => {
    await seedExample();
    await seedTables({
      duties: [
        {
          id: "d-2026-12-14-am-us",
          date: "2026-12-14",
          type: "AM",
          modality: "US",
          doctorsNeeded: 1,
          needsConsultant: false,
          cancelled: false,
        },
      ],
    });
    await generateRun(run(EXAMPLE_WEEK, 2, EARLY_NOW));

    const writeFails = publishRun(run(EXAMPLE_WEEK, 2, EARLY_NOW), {
      repo: failingOn("putWeek", 2),
    });
    await expect(writeFails).rejects.toThrow("injected");
    expect(await getWeek("published", EXAMPLE_WEEK)).toBeDefined();
    expect(await getWeek("published", "2026-12-14")).toBeUndefined();
    expect(await getWeek("draft", EXAMPLE_WEEK)).toBeDefined();
    expect(await getWeek("draft", "2026-12-14")).toBeDefined();

    const deleteFails = publishRun(run(EXAMPLE_WEEK, 2, EARLY_NOW), {
      repo: failingOn("deleteDraft", 1),
    });
    await expect(deleteFails).rejects.toThrow("injected");
    const published = await publishedWeeksBetween(EXAMPLE_WEEK, "2026-12-14");
    expect(published.map((w) => [w.weekStart, w.periodWeeks])).toEqual([
      [EXAMPLE_WEEK, 2],
      ["2026-12-14", 2],
    ]);
    expect(published[1].placements).toHaveLength(1);
    expect(await getWeek("draft", EXAMPLE_WEEK)).toBeDefined();

    await publishRun(run(EXAMPLE_WEEK, 2, EARLY_NOW));
    expect(await getWeek("draft", EXAMPLE_WEEK)).toBeUndefined();
    expect(await getWeek("draft", "2026-12-14")).toBeUndefined();
  });
});

describe("coverage (BR9, US1.15)", () => {
  it("lists the gap with its suggestion and each doctor's hours, CALL = 14 h (AC1.15.1, AC1.15.2)", async () => {
    await seedExample();
    await generateRun(run(EXAMPLE_WEEK, 1, EARLY_NOW));
    const report = await coverage(EXAMPLE_WEEK, EARLY_NOW);
    expect(report.version).toBe("draft");
    expect(report.unfilled).toEqual([
      expect.objectContaining({
        dutyId: "d-2026-12-08-am-xr",
        reason: expect.stringContaining("rest after call (hard) blocks Dr Ben Ochieng"),
        suggested: { doctorId: "ben.ochieng", brokenHardRules: ["rule-1-rest-after-call"] },
      }),
    ]);
    expect(report.hours).toEqual([
      { doctorId: "asha.rao", hours: 10, max: 40 },
      { doctorId: "ben.ochieng", hours: 24, max: 40 },
      { doctorId: "chen.li", hours: 0, max: 40 },
      { doctorId: "dana.novak", hours: 5, max: 40 },
    ]);
  });

  it("lists broken soft rules and locked clashes with doctor and duty (AC1.15.3)", async () => {
    await seedExample();
    const softNoCalls: Rule = {
      id: "rule-9-no-calls",
      type: "duty_limit",
      strength: "soft",
      enabled: true,
      settings: { dutyType: "CALL", max: 0, per: "week" },
    };
    await seedTables({ rules: [softNoCalls] });
    await generateAndPublishExample();
    await seedTables({ leave: [leaveRequest("dana.novak", "2026-12-08", "2026-12-08")] });

    const report = await coverage(EXAMPLE_WEEK, BEFORE_DEC_8);
    expect(report.version).toBe("published");
    expect(report.brokenSoftRules).toEqual([
      {
        dutyId: "d-2026-12-07-call-xr",
        doctorId: "ben.ochieng",
        ruleId: "rule-9-no-calls",
        reason: expect.stringContaining("CALL"),
      },
    ]);
    expect(report.lockedClashes).toEqual([
      {
        dutyId: "d-2026-12-08-am-us",
        place: 1,
        doctorId: "dana.novak",
        reason: "Dr Dana Novak has approved leave on 2026-12-08",
      },
    ]);
    // Before the lock, the same leave is no clash.
    expect((await coverage(EXAMPLE_WEEK, EARLY_NOW)).lockedClashes).toEqual([]);
  });

  it("gives 404 when the week has neither a draft nor a published roster", async () => {
    await expect(coverage(EXAMPLE_WEEK, EARLY_NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("reads (BR8, US2.6, US2.7)", () => {
  it("gives Ben his 3 duties and not the suggestion (AC2.7.1)", async () => {
    await seedExample();
    await generateAndPublishExample();
    const mine = await myDuties(ben, "2026-12-07", "2026-12-13");
    expect(mine.map((m) => [m.duty.id, m.place, m.locked])).toEqual([
      ["d-2026-12-07-am-ct", 2, false],
      ["d-2026-12-07-call-xr", 1, false],
      ["d-2026-12-09-pm-xr", 1, false],
    ]);
  });

  it("gives an empty list when no week is published (AC2.7.2)", async () => {
    await seedExample();
    await generateRun(run(EXAMPLE_WEEK, 1, EARLY_NOW));
    expect(await myDuties(ben, "2026-12-07", "2026-12-13")).toEqual([]);
  });

  it("hides suggestions, soft rules and drafts from doctors, and cancelled duties from everyone", async () => {
    await seedExample();
    await generateAndPublishExample();
    const forBen = await readWeek(ben, EXAMPLE_WEEK, "published");
    expect(forBen.gaps).toEqual([expect.objectContaining({ suggested: null })]);
    expect(forBen.brokenSoftRules).toEqual([]);
    expect(forBen.doctors.map((d) => d.name)).toContain("Dr Ben Ochieng");
    const forCoordinator = await readWeek(coordinator, EXAMPLE_WEEK, "published");
    expect(forCoordinator.gaps[0].suggested?.doctorId).toBe("ben.ochieng");
    await expect(readWeek(ben, EXAMPLE_WEEK, "draft")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(readWeek(coordinator, EXAMPLE_WEEK, "draft")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    await seedTables({
      duties: [
        {
          id: "d-2026-12-09-pm-xr",
          date: "2026-12-09",
          type: "PM",
          modality: "XR",
          doctorsNeeded: 1,
          needsConsultant: false,
          cancelled: true,
        },
      ],
    });
    const afterCancel = await readWeek(coordinator, EXAMPLE_WEEK, "published");
    expect(afterCancel.duties.map((d) => d.id)).not.toContain("d-2026-12-09-pm-xr");
    expect(afterCancel.placements.map((p) => p.dutyId)).not.toContain("d-2026-12-09-pm-xr");
  });
});

describe("logging (NFR6.1)", () => {
  afterEach(() => {
    process.env.LOG_LEVEL = "silent";
    vi.restoreAllMocks();
  });

  it("writes one roster run line with counts and no names", async () => {
    await seedExample();
    process.env.LOG_LEVEL = "info";
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    await generateRun(run(EXAMPLE_WEEK, 1, EARLY_NOW));
    const runLines = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === "roster run");
    expect(runLines).toEqual([
      expect.objectContaining({
        level: "info",
        trigger: "generate",
        weekStart: EXAMPLE_WEEK,
        weeks: 1,
        duties: 6,
        places: 7,
        placements: 6,
        gaps: 1,
        durationMs: expect.any(Number),
      }),
    ]);
    expect(lines.join("\n")).not.toContain("Dr ");
  });
});
