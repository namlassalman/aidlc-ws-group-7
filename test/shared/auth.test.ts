import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticate,
  parseGroups,
  requireRole,
  userFromClaims,
  userFromTestHeaders,
} from "../../src/shared/auth.js";
import { errorHandler, ForbiddenError, UnauthorizedError } from "../../src/shared/errors.js";

/** Runs `authenticate` on a fake request the way serverless-http shapes it. */
function authenticateWith(
  claims: Record<string, unknown> | undefined,
  headers: Record<string, string> = {},
) {
  const req = {
    requestContext: claims ? { authorizer: { jwt: { claims } } } : {},
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as express.Request;
  let passed: unknown;
  authenticate(req, {} as express.Response, (error?: unknown) => {
    passed = error;
  });
  return { user: req.user, error: passed };
}

describe("cognito:groups parsing (the HTTP API string form)", () => {
  it('reads "[coordinator doctor]" as coordinator (coordinator wins)', () => {
    expect(parseGroups("[coordinator doctor]")).toEqual(["coordinator", "doctor"]);
    expect(
      userFromClaims({ username: "coord1", "cognito:groups": "[coordinator doctor]" }),
    ).toEqual({
      id: "coord1",
      role: "coordinator",
    });
  });

  it('reads "[doctor]" as doctor, with the username as the id', () => {
    expect(userFromClaims({ username: "asha.rao", "cognito:groups": "[doctor]" })).toEqual({
      id: "asha.rao",
      role: "doctor",
    });
  });

  it('refuses "" and a missing groups claim with 403', () => {
    expect(() => userFromClaims({ username: "x", "cognito:groups": "" })).toThrow(ForbiddenError);
    expect(() => userFromClaims({ username: "x" })).toThrow(ForbiddenError);
    expect(() => userFromClaims({ username: "x", "cognito:groups": "[admins]" })).toThrow(
      ForbiddenError,
    );
  });

  it("refuses missing claims or a missing username with 401", () => {
    expect(() => userFromClaims(undefined)).toThrow(UnauthorizedError);
    expect(() => userFromClaims({ "cognito:groups": "[doctor]" })).toThrow(UnauthorizedError);
  });
});

describe("authenticate", () => {
  afterEach(() => {
    process.env.AUTH_TEST_BYPASS = "1";
  });

  it("uses the test headers when AUTH_TEST_BYPASS=1", () => {
    const { user, error } = authenticateWith(undefined, {
      "x-user-id": "ben.ochieng",
      "x-user-role": "doctor",
    });
    expect(error).toBeUndefined();
    expect(user).toEqual({ id: "ben.ochieng", role: "doctor" });
  });

  it("refuses missing or invalid test headers with 401", () => {
    expect(authenticateWith(undefined, {}).error).toBeInstanceOf(UnauthorizedError);
    expect(() =>
      userFromTestHeaders({
        get: (n: string) => ({ "x-user-id": "a", "x-user-role": "admin" })[n],
      } as never),
    ).toThrow(UnauthorizedError);
  });

  it("ignores the test headers and reads the claims when the bypass is off", () => {
    process.env.AUTH_TEST_BYPASS = "0";
    const headers = { "x-user-id": "coord1", "x-user-role": "coordinator" };
    const fromClaims = authenticateWith(
      { username: "chen.li", "cognito:groups": "[doctor]" },
      headers,
    );
    expect(fromClaims.user).toEqual({ id: "chen.li", role: "doctor" });
    expect(authenticateWith(undefined, headers).error).toBeInstanceOf(UnauthorizedError);
  });
});

describe("the Lambda guard", () => {
  afterEach(() => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.AUTH_TEST_BYPASS = "1";
    vi.resetModules();
  });

  it("throws at module load when AUTH_TEST_BYPASS is set inside Lambda", async () => {
    vi.resetModules();
    process.env.AWS_LAMBDA_FUNCTION_NAME = "RosterApp-ApiFunction";
    await expect(import("../../src/shared/auth.js")).rejects.toThrow(
      /AUTH_TEST_BYPASS is set inside Lambda/,
    );
  });

  it("loads inside Lambda when AUTH_TEST_BYPASS is not set", async () => {
    vi.resetModules();
    process.env.AWS_LAMBDA_FUNCTION_NAME = "RosterApp-ApiFunction";
    delete process.env.AUTH_TEST_BYPASS;
    const auth = await import("../../src/shared/auth.js");
    expect(typeof auth.authenticate).toBe("function");
  });
});

describe("requireRole", () => {
  const app = express();
  app.post("/coordinator-only", authenticate, requireRole("coordinator"), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  it("gives 403 forbidden to a doctor", async () => {
    const res = await request(app)
      .post("/coordinator-only")
      .set("X-User-Id", "asha.rao")
      .set("X-User-Role", "doctor");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden", details: [] });
  });

  it("lets a coordinator through", async () => {
    const res = await request(app)
      .post("/coordinator-only")
      .set("X-User-Id", "coord1")
      .set("X-User-Role", "coordinator");
    expect(res.status).toBe(200);
  });

  it("refuses to be built with no role", () => {
    expect(() => requireRole()).toThrow(/at least one role/);
  });
});
