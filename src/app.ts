/**
 * The Express app (walking skeleton). `buildApp()` is used by src/lambda.ts, src/server.ts and
 * the Supertest tests.
 *
 * Pipeline: request log -> /api: authenticate (req.user) -> express.json (100 kB) -> GET /api/me
 * -> the five feature routers -> 404 -> the error middleware (ErrorBody).
 *
 * Each feature router is mounted once, from src/features/<feature>/router.ts, so feature Units
 * add routes in their own folder and never edit this file. Routes inside a feature router use
 * the full path below /api, e.g. `router.get("/doctors", ...)`.
 */
import { randomUUID } from "node:crypto";
import express, { type Express, type RequestHandler } from "express";
import { router as doctorsRouter } from "./features/doctors/router.js";
import { router as dutiesRouter } from "./features/duties/router.js";
import { router as leaveRouter } from "./features/leave/router.js";
import { router as rosterRouter } from "./features/roster/router.js";
import { router as rulesRouter } from "./features/rules/router.js";
import { authenticate } from "./shared/auth.js";
import { errorHandler, notFoundHandler } from "./shared/errors.js";
import { log } from "./shared/log.js";

export const FEATURE_ROUTERS = {
  doctors: doctorsRouter,
  duties: dutiesRouter,
  leave: leaveRouter,
  rules: rulesRouter,
  roster: rosterRouter,
} as const;

export const BODY_LIMIT = "100kb";

/** One JSON line per request when the response finishes. Never logs bodies, queries or headers. */
const requestLog: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  const requestId = req.requestContext?.requestId ?? randomUUID();
  res.locals.requestId = requestId;
  res.on("finish", () => {
    log("info", "request", {
      method: req.method,
      // originalUrl keeps the /api mount path; the query string is dropped (never logged).
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      userId: req.user?.id,
      role: req.user?.role,
      requestId,
    });
  });
  next();
};

export function buildApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestLog);

  const api = express.Router();
  api.use(authenticate);
  api.use(express.json({ limit: BODY_LIMIT }));
  api.get("/me", (req, res) => {
    res.json(req.user);
  });
  for (const router of Object.values(FEATURE_ROUTERS)) api.use(router);

  app.use("/api", api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
