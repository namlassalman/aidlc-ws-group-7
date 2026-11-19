import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";

// Replaces the doctors placeholder with test routes, to prove feature routers are mounted under
// /api behind the auth middleware and that their errors reach the error middleware.
vi.mock("../../src/features/doctors/router.js", async () => {
  const { Router } = await import("express");
  const { z } = await import("zod");
  const { requireRole } = await import("../../src/shared/auth.js");
  const router = Router();
  router.get("/doctors/ping", (req, res) => {
    res.json({ mounted: true, user: req.user });
  });
  router.get("/doctors/boom", () => {
    throw new Error("internal detail that must not leak");
  });
  router.post("/doctors/check", requireRole("coordinator"), (req, res) => {
    res.status(201).json(z.object({ name: z.string().min(1) }).parse(req.body));
  });
  return { router };
});

const coordinator = { "X-User-Id": "coord1", "X-User-Role": "coordinator" };
const doctor = { "X-User-Id": "asha.rao", "X-User-Role": "doctor" };

describe("GET /api/me", () => {
  const app = buildApp();

  it("returns the coordinator", async () => {
    const res = await request(app).get("/api/me").set(coordinator);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "coord1", role: "coordinator" });
  });

  it("returns a doctor", async () => {
    const res = await request(app).get("/api/me").set(doctor);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "asha.rao", role: "doctor" });
  });

  it("gives 401 ErrorBody with no sign-in headers", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized", message: expect.any(String), details: [] });
  });
});

describe("routing and errors", () => {
  const app = buildApp();

  afterEach(() => {
    process.env.LOG_LEVEL = "silent";
    vi.restoreAllMocks();
  });

  it("mounts the feature routers under /api", async () => {
    const res = await request(app).get("/api/doctors/ping").set(doctor);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mounted: true, user: { id: "asha.rao", role: "doctor" } });
  });

  it("gives 404 ErrorBody for an unknown route", async () => {
    const res = await request(app).get("/api/nothing-here").set(coordinator);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "not_found",
      message: "No route for GET /api/nothing-here",
      details: [],
    });
    expect((await request(app).get("/index.html")).status).toBe(404);
  });

  it("gives 400 for malformed JSON", async () => {
    const res = await request(app)
      .post("/api/doctors/check")
      .set(coordinator)
      .set("Content-Type", "application/json")
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "validation",
      message: "Request body is not valid JSON",
    });
  });

  it("gives 413 for a body over 100 kB", async () => {
    const res = await request(app)
      .post("/api/doctors/check")
      .set(coordinator)
      .send({ name: "x".repeat(110 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("validation");
  });

  it("gives 400 with the zod issues for an invalid body, and 403 for a doctor", async () => {
    const invalid = await request(app)
      .post("/api/doctors/check")
      .set(coordinator)
      .send({ name: "" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("validation");
    expect(invalid.body.details[0]).toMatchObject({ path: ["name"] });
    const forbidden = await request(app)
      .post("/api/doctors/check")
      .set(doctor)
      .send({ name: "Rao" });
    expect(forbidden.status).toBe(403);
    const created = await request(app)
      .post("/api/doctors/check")
      .set(coordinator)
      .send({ name: "Rao" });
    expect(created.status).toBe(201);
  });

  it("gives a generic 500 for a thrown error and logs it with its stack", async () => {
    process.env.LOG_LEVEL = "error";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request(app).get("/api/doctors/boom").set(doctor);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal", message: "Internal server error", details: [] });
    expect(JSON.stringify(res.body)).not.toContain("must not leak");
    const logged = JSON.parse(String(errorLog.mock.calls[0][0]));
    expect(logged).toMatchObject({ level: "error", message: "internal detail that must not leak" });
    expect(logged.stack).toContain("Error");
    expect(logged.requestId).toEqual(expect.any(String));
  });

  it("logs one request line without the body or headers", async () => {
    process.env.LOG_LEVEL = "info";
    const infoLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await request(app).get("/api/me?secret=1").set(doctor);
    const line = JSON.parse(String(infoLog.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({
      msg: "request",
      method: "GET",
      path: "/api/me",
      status: 200,
      userId: "asha.rao",
      role: "doctor",
    });
    expect(JSON.stringify(line)).not.toContain("secret");
  });
});
