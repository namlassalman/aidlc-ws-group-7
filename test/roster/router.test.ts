// u6-roster routes over HTTP (C9; BR1, BR8; NFR2.1-NFR2.4, NFR3.1, NFR3.2). Supertest with
// buildApp(), signed in with the X-User-* test headers that test/setup.ts allows.
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { pickNow, testClockAllowed } from "../../src/features/roster/router.js";
import { RUN_TOO_LONG_MESSAGE } from "../../src/features/roster/schemas.js";
import { EARLY_NOW, EXAMPLE_WEEK, seedExample } from "./fixtures.js";

const app = buildApp();

const asCoordinator = (req: request.Test) =>
  req.set("X-User-Id", "coord1").set("X-User-Role", "coordinator");
const asBen = (req: request.Test) =>
  req.set("X-User-Id", "ben.ochieng").set("X-User-Role", "doctor");

const generate = (body: object) =>
  asCoordinator(request(app).post("/api/roster/generate")).send(body);
const publishWeek = (body: object) =>
  asCoordinator(request(app).post("/api/roster/publish")).send(body);
const exampleRun = { weekStart: EXAMPLE_WEEK, weeks: 1, now: EARLY_NOW };
const weekPath = `/api/roster/weeks/${EXAMPLE_WEEK}`;

async function publishExample() {
  await seedExample();
  expect((await generate(exampleRun)).status).toBe(200);
  expect((await publishWeek(exampleRun)).status).toBe(200);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("role checks (BR1.1, BR8.2, NFR2.1)", () => {
  it("gives a doctor 403 on generate (AC1.11.4), publish, coverage and a draft read", async () => {
    await seedExample();
    const body = { weekStart: EXAMPLE_WEEK, weeks: 1 };
    const responses = await Promise.all([
      asBen(request(app).post("/api/roster/generate")).send(body),
      asBen(request(app).post("/api/roster/publish")).send(body),
      asBen(request(app).get(`/api/roster/weeks/${EXAMPLE_WEEK}/coverage`)),
      asBen(request(app).get(`/api/roster/weeks/${EXAMPLE_WEEK}?version=draft`)),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    }
  });
});

describe("validation (BR1.2, BR1.4, BR1.5, NFR3.1)", () => {
  it.each([
    ["a Tuesday", { weekStart: "2026-12-08" }],
    ["weeks: 9", { weekStart: EXAMPLE_WEEK, weeks: 9 }],
    ["an unknown field", { weekStart: EXAMPLE_WEEK, doctorId: "asha.rao" }],
  ])("refuses %s on generate with 400", async (_label, body) => {
    const res = await generate(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation" });
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("refuses a doctorId, from after to, and a span over 8 weeks on /mine", async () => {
    const mine = (query: string) => asBen(request(app).get(`/api/roster/mine?${query}`));
    expect((await mine("from=2026-12-07&to=2026-12-13&doctorId=chen.li")).status).toBe(400);
    expect((await mine("from=2026-12-13&to=2026-12-07")).status).toBe(400);
    expect((await mine("from=2026-12-07&to=2027-02-01")).status).toBe(400);
  });

  it("refuses a week read on a Tuesday or with an unknown version", async () => {
    const tuesday = await asBen(request(app).get("/api/roster/weeks/2026-12-08"));
    const badVersion = await asBen(request(app).get(`${weekPath}?version=old`));
    expect([tuesday.status, badVersion.status]).toEqual([400, 400]);
  });
});

describe("reads (BR8, US2.6, US2.7)", () => {
  it("shows a published week to a doctor without suggestions (AC1.12.3, AC2.6.1)", async () => {
    await publishExample();
    const forBen = await asBen(request(app).get(`/api/roster/weeks/${EXAMPLE_WEEK}`));
    expect(forBen.status).toBe(200);
    expect(forBen.body.version).toBe("published");
    expect(forBen.body.gaps).toEqual([
      expect.objectContaining({ dutyId: "d-2026-12-08-am-xr", suggested: null }),
    ]);
    expect(forBen.body.brokenSoftRules).toEqual([]);
    expect(forBen.body.duties).toHaveLength(6);
    expect(JSON.stringify(forBen.body)).not.toContain("rule-1-rest-after-call");

    const forCoordinator = await asCoordinator(request(app).get(weekPath));
    expect(forCoordinator.body.gaps[0].suggested.doctorId).toBe("ben.ochieng");
  });

  it("gives a doctor 404 for a week that has only a draft (AC2.6.2)", async () => {
    await seedExample();
    expect((await generate(exampleRun)).status).toBe(200);
    const forBen = await asBen(request(app).get(weekPath));
    expect(forBen.status).toBe(404);
    expect(forBen.body.error).toBe("not_found");
    const draft = await asCoordinator(request(app).get(`${weekPath}?version=draft`));
    expect(draft.status).toBe(200);
  });

  it("gives a doctor only their own duties on /mine (AC2.7.1, NFR2.4)", async () => {
    await publishExample();
    const res = await asBen(request(app).get("/api/roster/mine?from=2026-12-07&to=2026-12-13"));
    expect(res.status).toBe(200);
    expect(res.body.map((m: { duty: { id: string } }) => m.duty.id)).toEqual([
      "d-2026-12-07-am-ct",
      "d-2026-12-07-call-xr",
      "d-2026-12-09-pm-xr",
    ]);
  });

  it("gives the coordinator the coverage report, and 404 with no roster", async () => {
    await publishExample();
    const res = await asCoordinator(request(app).get(`/api/roster/weeks/${EXAMPLE_WEEK}/coverage`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ weekStart: EXAMPLE_WEEK, version: "published" });
    expect(res.body.unfilled).toHaveLength(1);
    const none = await asCoordinator(request(app).get("/api/roster/weeks/2027-01-04/coverage"));
    expect(none.status).toBe(404);
  });
});

describe("generate and publish", () => {
  it("returns the draft weeks as views, and publish gives 409 without a draft (AC1.13.3)", async () => {
    await seedExample();
    const res = await generate({ weekStart: EXAMPLE_WEEK, weeks: 2, now: EARLY_NOW });
    expect(res.status).toBe(200);
    const mondays = res.body.map((w: { weekStart: string }) => w.weekStart);
    expect(mondays).toEqual([EXAMPLE_WEEK, "2026-12-14"]);
    expect(res.body[0].doctors).toContainEqual({ id: "ben.ochieng", name: "Dr Ben Ochieng" });
    const conflict = await publishWeek({ weekStart: EXAMPLE_WEEK, weeks: 3 });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: "conflict" });
  });

  it("gives 409 with the cut-off message when a generate reaches 15 s", async () => {
    await seedExample();
    let reads = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (reads++ === 0 ? 0 : 20_000));
    const res = await generate({ weekStart: EXAMPLE_WEEK, weeks: 1, now: EARLY_NOW });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "conflict", message: RUN_TOO_LONG_MESSAGE, details: [] });
    vi.restoreAllMocks();
    const draft = await asCoordinator(request(app).get(`${weekPath}?version=draft`));
    expect(draft.status).toBe(404); // nothing was written
  });

  it("honours now in a test request", async () => {
    await seedExample();
    const res = await generate({ ...exampleRun, now: "2026-12-01T08:00:00+08:00" });
    expect(res.body[0].generatedAt).toBe(EARLY_NOW);
  });
});

describe("the test clock (BR1.3, NFR2.3)", () => {
  const requested = "2026-12-01T00:00:00.000Z";
  const combinations = [
    { AUTH_TEST_BYPASS: "1", AWS_LAMBDA_FUNCTION_NAME: undefined, honoured: true },
    { AUTH_TEST_BYPASS: "1", AWS_LAMBDA_FUNCTION_NAME: "RosterApp-Api", honoured: false },
    { AUTH_TEST_BYPASS: undefined, AWS_LAMBDA_FUNCTION_NAME: undefined, honoured: false },
    { AUTH_TEST_BYPASS: undefined, AWS_LAMBDA_FUNCTION_NAME: "RosterApp-Api", honoured: false },
  ];

  it.each(combinations)(
    "bypass $AUTH_TEST_BYPASS, Lambda $AWS_LAMBDA_FUNCTION_NAME: honoured $honoured",
    ({ honoured, ...env }) => {
      expect(testClockAllowed(env)).toBe(honoured);
      const now = pickNow(requested, env);
      if (honoured) expect(now).toBe(requested);
      else expect(now).not.toBe(requested);
    },
  );

  it("uses the server clock when the request has no now", () => {
    const before = Date.now();
    const now = Date.parse(pickNow(undefined, { AUTH_TEST_BYPASS: "1" }));
    expect(now).toBeGreaterThanOrEqual(before);
  });
});
