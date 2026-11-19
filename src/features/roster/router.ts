/**
 * RosterRouter (u6-roster): the five C9 routes under /api, mounted by src/app.ts.
 *
 *   POST /roster/generate                  coordinator  {weekStart, weeks = 4, now?} -> RosterWeekView[]
 *   POST /roster/publish                   coordinator  {weekStart, weeks = 4, now?} -> RosterWeekView[]
 *   GET  /roster/weeks/:weekStart          any          ?version=published|draft (draft: coordinator)
 *   GET  /roster/mine                      any          ?from&to -> MyDuty[] for req.user.id
 *   GET  /roster/weeks/:weekStart/coverage coordinator  -> CoverageReport
 *
 * Rules: BR1.1 (coordinator-only routes, 403), BR1.2, BR1.4, BR1.5 (strict zod schemas, 400),
 * BR1.3 and NFR2.3 (the test clock), BR8.2 (drafts are coordinator-only). Each request creates
 * its Deadline on arrival (NFR1.3); a cut-off answers 409 through the shared error middleware
 * (C4). The `leave.approved` subscription (C3, BR7.1) is registered once when this module loads.
 */
import { Router } from "express";
import { requireRole } from "../../shared/auth.js";
import { ForbiddenError } from "../../shared/errors.js";
import { Deadline } from "./deadline.js";
import {
  CoverageQuery,
  GenerateBody,
  MineQuery,
  PublishBody,
  WeekParams,
  WeekQuery,
} from "./schemas.js";
import {
  coverage,
  generateRun,
  myDuties,
  publishRun,
  readWeek,
  subscribeToLeaveApproved,
  toInstant,
  toViews,
} from "./service.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * True when a request may set `now`: the test sign-in is on and this is not Lambda. This copies
 * the condition in src/shared/auth.ts (isTestBypass), which does not export it; if it changes
 * there, change it here (or the lead can export one shared helper).
 */
export function testClockAllowed(env: Env = process.env): boolean {
  return env.AUTH_TEST_BYPASS === "1" && !env.AWS_LAMBDA_FUNCTION_NAME;
}

/** The run's `now` (BR1.3): the request's value with the test sign-in, otherwise the server clock. */
export function pickNow(requested: string | undefined, env: Env = process.env): string {
  return requested !== undefined && testClockAllowed(env)
    ? toInstant(requested)
    : new Date().toISOString();
}

export const router = Router();

subscribeToLeaveApproved();

router.post("/roster/generate", requireRole("coordinator"), async (req, res) => {
  const deadline = new Deadline();
  const body = GenerateBody.parse(req.body);
  const weeks = await generateRun({
    weekStart: body.weekStart,
    weeks: body.weeks,
    now: pickNow(body.now),
    deadline,
    trigger: "generate",
  });
  res.json(await toViews(weeks, req.user));
});

router.post("/roster/publish", requireRole("coordinator"), async (req, res) => {
  const deadline = new Deadline();
  const body = PublishBody.parse(req.body);
  const weeks = await publishRun({
    weekStart: body.weekStart,
    weeks: body.weeks,
    now: pickNow(body.now),
    deadline,
    trigger: "publish",
  });
  res.json(await toViews(weeks, req.user));
});

router.get("/roster/mine", async (req, res) => {
  const query = MineQuery.parse(req.query);
  res.json(await myDuties(req.user, query.from, query.to));
});

router.get("/roster/weeks/:weekStart/coverage", requireRole("coordinator"), async (req, res) => {
  const { weekStart } = WeekParams.parse(req.params);
  CoverageQuery.parse(req.query);
  res.json(await coverage(weekStart, new Date().toISOString()));
});

router.get("/roster/weeks/:weekStart", async (req, res) => {
  const { weekStart } = WeekParams.parse(req.params);
  const { version } = WeekQuery.parse(req.query);
  if (version === "draft" && req.user.role !== "coordinator") {
    throw new ForbiddenError("Doctors can only see published rosters");
  }
  res.json(await readWeek(req.user, weekStart, version));
});
