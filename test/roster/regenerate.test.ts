// u6-roster regeneration after late leave (US1.14 roster half; BR7; NFR1.5, NFR5.3, NFR6.3).
// Events go through the real DomainEvents: publish("leave.approved", payload).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSubscriptions, publish, type LeaveApprovedPayload } from "../../src/shared/events.js";
import { Deadline } from "../../src/features/roster/deadline.js";
import {
  getWeek,
  rosterRepository,
  type RosterRepository,
} from "../../src/features/roster/repository.js";
import {
  LEAVE_SUBSCRIBER,
  coverage,
  generateRun,
  publishRun,
  subscribeToLeaveApproved,
  type ServiceDeps,
} from "../../src/features/roster/service.js";
import {
  EARLY_NOW,
  EXAMPLE_WEEK,
  FakeClock,
  leaveRequest,
  seedExample,
  seedTables,
} from "./fixtures.js";

/** More than 12 hours before 08:00 on 2026-12-08 in Singapore. */
const EARLY_APPROVAL = "2026-12-02T00:00:00.000Z";
/** 04:00 on 2026-12-08 in Singapore: the 08:00 duties that day start within 12 hours. */
const LATE_APPROVAL = "2026-12-07T20:00:00.000Z";

const novakLeave = (overrides: Partial<LeaveApprovedPayload> = {}): LeaveApprovedPayload => ({
  leaveId: "leave-dana.novak-2026-12-08",
  doctorId: "dana.novak",
  startDate: "2026-12-08",
  endDate: "2026-12-08",
  approvedBy: "coord1",
  at: EARLY_APPROVAL,
  ...overrides,
});

const run = (weekStart: string, weeks: number) => ({
  weekStart,
  weeks,
  now: EARLY_NOW,
  deadline: new Deadline(),
});

async function publishRunOf(weekStart: string, weeks: number) {
  await generateRun(run(weekStart, weeks));
  await publishRun(run(weekStart, weeks));
}

/** The leave Unit saves the approval before it publishes the event. */
async function approve(payload: LeaveApprovedPayload) {
  await seedTables({ leave: [leaveRequest(payload.doctorId, payload.startDate, payload.endDate)] });
  return publish("leave.approved", payload);
}

let unsubscribe: (() => void) | undefined;

function listen(deps: ServiceDeps = {}) {
  unsubscribe?.();
  unsubscribe = subscribeToLeaveApproved(deps);
}

beforeEach(() => {
  clearSubscriptions();
  listen();
});

afterEach(() => {
  unsubscribe?.();
  clearSubscriptions();
  process.env.LOG_LEVEL = "silent";
  vi.restoreAllMocks();
});

const dec8Duties = (
  week: { placements: { dutyId: string; doctorId: string }[] },
  doctorId: string,
) => week.placements.filter((p) => p.dutyId.startsWith("d-2026-12-08") && p.doctorId === doctorId);

describe("leave.approved", () => {
  it("moves Novak off a duty more than 12 hours away and republishes (AC1.14.1)", async () => {
    await seedExample();
    await publishRunOf(EXAMPLE_WEEK, 1);
    const results = await approve(novakLeave());
    expect(results).toEqual([{ subscriber: LEAVE_SUBSCRIBER, ok: true }]);
    const week = (await getWeek("published", EXAMPLE_WEEK))!;
    expect(dec8Duties(week, "dana.novak")).toEqual([]);
    expect(week).toMatchObject({ publishedAt: EARLY_APPROVAL, now: EARLY_APPROVAL });
    expect(week.gaps.map((g) => g.dutyId)).toContain("d-2026-12-08-am-us");
    expect(await getWeek("draft", EXAMPLE_WEEK)).toBeUndefined();
  });

  it("keeps Novak on a locked duty and coverage shows the clash (AC1.14.2)", async () => {
    await seedExample();
    await publishRunOf(EXAMPLE_WEEK, 1);
    await approve(novakLeave({ at: LATE_APPROVAL }));
    const week = (await getWeek("published", EXAMPLE_WEEK))!;
    expect(week.placements.find((p) => p.dutyId === "d-2026-12-08-am-us")).toEqual({
      dutyId: "d-2026-12-08-am-us",
      place: 1,
      doctorId: "dana.novak",
      locked: true,
    });
    const report = await coverage(EXAMPLE_WEEK, LATE_APPROVAL);
    expect(report.lockedClashes).toEqual([
      expect.objectContaining({ dutyId: "d-2026-12-08-am-us", doctorId: "dana.novak" }),
    ]);
  });

  it("changes nothing when no week is published (AC1.14.3)", async () => {
    await seedExample();
    await generateRun(run(EXAMPLE_WEEK, 1));
    const draftBefore = await getWeek("draft", EXAMPLE_WEEK);
    const results = await approve(novakLeave());
    expect(results).toEqual([{ subscriber: LEAVE_SUBSCRIBER, ok: true }]);
    expect(await getWeek("published", EXAMPLE_WEEK)).toBeUndefined();
    expect(await getWeek("draft", EXAMPLE_WEEK)).toEqual(draftBefore);
  });

  it("regenerates the whole published run the leave touches (Q2: B)", async () => {
    await seedExample();
    await publishRunOf(EXAMPLE_WEEK, 2);
    await approve(novakLeave());
    const second = (await getWeek("published", "2026-12-14"))!;
    expect(second).toMatchObject({
      periodStart: EXAMPLE_WEEK,
      periodWeeks: 2,
      publishedAt: EARLY_APPROVAL,
    });
  });

  it("keeps the first run and names the second when the cut-off passes between them (R-05)", async () => {
    await seedExample();
    await publishRunOf(EXAMPLE_WEEK, 1);
    await publishRunOf("2026-12-14", 1);
    const clock = new FakeClock(0);
    const repo: RosterRepository = {
      ...rosterRepository,
      deleteDraft: async (weekStart) => {
        await rosterRepository.deleteDraft(weekStart);
        clock.advance(16_000); // the first run's publish ends past the 15 s cut-off
      },
    };
    listen({ clock: clock.now, repo });
    process.env.LOG_LEVEL = "info";
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = await approve(novakLeave({ endDate: "2026-12-15" }));
    expect(results).toEqual([
      {
        subscriber: LEAVE_SUBSCRIBER,
        ok: false,
        message: "Regeneration stopped at the 15 s cut-off; not regenerated: 2026-12-14 (1 week)",
      },
    ]);
    expect((await getWeek("published", EXAMPLE_WEEK))?.publishedAt).toBe(EARLY_APPROVAL);
    expect((await getWeek("published", "2026-12-14"))?.publishedAt).toBe(EARLY_NOW);
    const summary = lines
      .map((l) => JSON.parse(l))
      .find((l) => l.msg === "roster regenerated after leave");
    expect(summary).toMatchObject({
      leaveId: "leave-dana.novak-2026-12-08",
      runs: [{ periodStart: EXAMPLE_WEEK, periodWeeks: 1 }],
      skipped: [{ periodStart: "2026-12-14", periodWeeks: 1 }],
    });
  });

  it("ignores an extra payload field", async () => {
    await seedExample();
    await publishRunOf(EXAMPLE_WEEK, 1);
    const withExtra = { ...novakLeave(), comment: "late leave" } as LeaveApprovedPayload;
    const results = await approve(withExtra);
    expect(results).toEqual([{ subscriber: LEAVE_SUBSCRIBER, ok: true }]);
    expect((await getWeek("published", EXAMPLE_WEEK))?.publishedAt).toBe(EARLY_APPROVAL);
  });

  it("reports a failing roster read or a bad payload as a follow-up, never a throw (NFR5.3)", async () => {
    await seedExample();
    await publishRunOf(EXAMPLE_WEEK, 1);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo: RosterRepository = {
      ...rosterRepository,
      publishedWeeksBetween: async () => {
        throw new Error("rosters query failed: injected");
      },
    };
    listen({ repo });
    const failedRead = await approve(novakLeave());
    expect(failedRead).toEqual([
      { subscriber: LEAVE_SUBSCRIBER, ok: false, message: "rosters query failed: injected" },
    ]);
    listen();
    const withoutAt: Partial<LeaveApprovedPayload> = novakLeave();
    delete withoutAt.at;
    const badPayload = await publish("leave.approved", withoutAt as LeaveApprovedPayload);
    expect(badPayload[0]).toMatchObject({ subscriber: LEAVE_SUBSCRIBER, ok: false });
    expect((await getWeek("published", EXAMPLE_WEEK))?.publishedAt).toBe(EARLY_NOW);
  });
});
