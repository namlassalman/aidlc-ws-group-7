/**
 * AuthGuard (contract C4): who is calling, and their role. Owned by the walking skeleton.
 *
 * - On AWS, API Gateway's JWT authorizer has already verified the Cognito access token before
 *   Lambda runs (no token: 401 from API Gateway). `authenticate` reads the verified claims from
 *   `req.requestContext.authorizer.jwt.claims` (set by serverless-http): `username` is the user id
 *   (a doctor's username is their Doctor.id) and `cognito:groups` arrives as ONE string such as
 *   "[coordinator doctor]". Brackets are stripped and the string split on spaces; coordinator wins
 *   over doctor; a user in neither group gets 403. This module never checks tokens itself.
 * - Test sign-in: only when AUTH_TEST_BYPASS=1, the user comes from the `X-User-Id` and
 *   `X-User-Role` headers instead (missing or invalid: 401). Otherwise those headers are ignored.
 * - Guard: loading this module inside Lambda (AWS_LAMBDA_FUNCTION_NAME set) with AUTH_TEST_BYPASS
 *   set throws, so the function refuses to start. app.ts and lambda.ts both import this module.
 * - `requireRole("coordinator")` refuses every other role with 403. A coordinator is never also
 *   treated as a doctor.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ForbiddenError, UnauthorizedError } from "./errors.js";

export const ROLES = ["coordinator", "doctor"] as const;
export type Role = (typeof ROLES)[number];

export type AuthUser = { id: string; role: Role };

/** The part of the API Gateway HTTP API (payload 2.0) request context this module reads. */
export type RequestContext = {
  requestId?: string;
  authorizer?: { jwt?: { claims?: Record<string, unknown> } };
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `authenticate` on every /api route, so feature routers can rely on it. */
      user: AuthUser;
      /** Set by serverless-http from the Lambda event; absent locally and in tests. */
      requestContext?: RequestContext;
    }
  }
}

const isInLambda = () => Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

/** Throws when the test sign-in is switched on inside Lambda (BR1.6). Runs at module load. */
export function assertNoTestBypassInLambda(): void {
  if (process.env.AUTH_TEST_BYPASS && isInLambda()) {
    throw new Error(
      "AUTH_TEST_BYPASS is set inside Lambda: refusing to start. The test sign-in is for tests and the local server only.",
    );
  }
}

assertNoTestBypassInLambda();

const isTestBypass = () => process.env.AUTH_TEST_BYPASS === "1" && !isInLambda();

/** Parses the cognito:groups claim: "[a b]" (HTTP API string form), or an array. */
export function parseGroups(claim: unknown): string[] {
  if (Array.isArray(claim))
    return claim.filter((g): g is string => typeof g === "string" && g !== "");
  if (typeof claim !== "string") return [];
  return claim
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[\s,]+/)
    .filter((g) => g !== "");
}

/** The role for a list of groups: coordinator wins, then doctor, else undefined. */
export function roleOf(groups: readonly string[]): Role | undefined {
  if (groups.includes("coordinator")) return "coordinator";
  if (groups.includes("doctor")) return "doctor";
  return undefined;
}

/** Builds the user from verified access-token claims; throws 401 or 403. */
export function userFromClaims(claims: Record<string, unknown> | undefined): AuthUser {
  const id = claims?.username ?? claims?.["cognito:username"];
  if (typeof id !== "string" || id === "") throw new UnauthorizedError("Sign-in required");
  const role = roleOf(parseGroups(claims?.["cognito:groups"]));
  if (!role) throw new ForbiddenError("Your account has no roster role");
  return { id, role };
}

/** Builds the user from the X-User-Id and X-User-Role test headers; throws 401. */
export function userFromTestHeaders(req: Pick<Request, "get">): AuthUser {
  const id = req.get("x-user-id")?.trim();
  const role = req.get("x-user-role")?.trim();
  if (!id) throw new UnauthorizedError("Sign-in required (X-User-Id test header missing)");
  if (!ROLES.includes(role as Role)) {
    throw new UnauthorizedError("Sign-in required (X-User-Role must be coordinator or doctor)");
  }
  return { id, role: role as Role };
}

/** Express middleware for every /api route: sets req.user or passes a 401/403 error on. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  try {
    req.user = isTestBypass()
      ? userFromTestHeaders(req)
      : userFromClaims(req.requestContext?.authorizer?.jwt?.claims);
    next();
  } catch (error) {
    next(error);
  }
}

/** Route guard: `router.post("/duties", requireRole("coordinator"), handler)`. */
export function requireRole(...roles: Role[]): RequestHandler {
  if (roles.length === 0) throw new Error("requireRole needs at least one role");
  return (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError("Sign-in required"));
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError(`This needs the ${roles.join(" or ")} role`));
    }
    next();
  };
}
