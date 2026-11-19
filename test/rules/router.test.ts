// HTTP tests (u5-rules, contract C8) through buildApp() and Supertest: status codes, role checks
// (BR2.5, NFR2.3), zod validation (NFR3.1), the path id check (NFR3.3) and the shared error body.
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { putRosterWeek, seedExample } from "./seed.js";

const app = buildApp();

const as = (role: "coordinator" | "doctor") => {
  const id = role === "coordinator" ? "coord1" : "ben.ochieng";
  return {
    get: (path: string) => request(app).get(path).set("X-User-Id", id).set("X-User-Role", role),
    post: (path: string) => request(app).post(path).set("X-User-Id", id).set("X-User-Role", role),
    put: (path: string) => request(app).put(path).set("X-User-Id", id).set("X-User-Role", role),
    delete: (path: string) =>
      request(app).delete(path).set("X-User-Id", id).set("X-User-Role", role),
  };
};
const coordinator = as("coordinator");
const doctorUser = as("doctor");

const dutyLimitBody = {
  type: "duty_limit",
  strength: "hard",
  settings: { dutyType: "AM", max: 3, per: "week" },
};

beforeEach(async () => {
  await seedExample();
});

describe("POST /api/rules", () => {
  it("creates a valid rule (201) and lists it (AC1.7.1)", async () => {
    const res = await coordinator.post("/api/rules").send(dutyLimitBody);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "rule-4-duty-limit", enabled: true, strength: "hard" });
    const list = await coordinator.get("/api/rules");
    expect(list.body.map((r: { id: string }) => r.id)).toContain("rule-4-duty-limit");
  });

  it.each([
    ["an unknown type", { ...dutyLimitBody, type: "night_limit" }],
    ["an extra body key", { ...dutyLimitBody, colour: "red" }],
    ["missing settings", { type: "duty_limit", strength: "hard" }],
    ["an extra settings key", { ...dutyLimitBody, settings: { ...dutyLimitBody.settings, x: 1 } }],
    ["a bad strength", { ...dutyLimitBody, strength: "medium" }],
  ])("refuses %s with 400 and the shared error body (AC1.7.4)", async (_case, body) => {
    const res = await coordinator.post("/api/rules").send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation" });
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("refuses a contradiction with 409, naming the other rule (AC1.7.3)", async () => {
    const only = (modality: string) => ({
      type: "modality_assignment",
      strength: "hard",
      settings: { who: { doctorIds: ["asha.rao"] }, modalities: [modality], mode: "only" },
    });
    expect((await coordinator.post("/api/rules").send(only("MRI"))).status).toBe(201);
    const res = await coordinator.post("/api/rules").send(only("CT"));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "conflict" });
    expect(res.body.message).toContain("rule-4-modality-assignment");
  });
});

describe("GET /api/rules and switching (AC1.8.1, AC1.8.2)", () => {
  it("lists two rules for a doctor and three with enabled for the coordinator, one off", async () => {
    const off = await coordinator.post("/api/rules/rule-2-residents-on-xr/disable");
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    const forDoctor = await doctorUser.get("/api/rules");
    const forCoordinator = await coordinator.get("/api/rules");
    expect(forDoctor.status).toBe(200);
    expect(forDoctor.body).toHaveLength(2);
    expect(
      forCoordinator.body.map((r: { id: string; enabled: boolean }) => [r.id, r.enabled]),
    ).toEqual([
      ["rule-1-rest-after-call", true],
      ["rule-2-residents-on-xr", false],
      ["rule-3-one-call-per-week", true],
    ]);
  });

  it("saves 'rest after call' switched off, and on again", async () => {
    await coordinator.post("/api/rules/rule-1-rest-after-call/disable").expect(200);
    const list = await coordinator.get("/api/rules");
    expect(list.body[0]).toMatchObject({ id: "rule-1-rest-after-call", enabled: false });
    const on = await coordinator.post("/api/rules/rule-1-rest-after-call/enable");
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
  });

  it("edits strength with PUT, and refuses an empty edit (400) or an unknown rule (404)", async () => {
    const edited = await coordinator
      .put("/api/rules/rule-3-one-call-per-week")
      .send({ strength: "soft" });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ strength: "soft", type: "duty_limit" });
    expect((await coordinator.put("/api/rules/rule-3-one-call-per-week").send({})).status).toBe(
      400,
    );
    const typeChange = await coordinator
      .put("/api/rules/rule-3-one-call-per-week")
      .send({ type: "fair_share" });
    expect(typeChange.status).toBe(400);
    expect(
      (await coordinator.put("/api/rules/rule-9-duty-limit").send({ strength: "soft" })).status,
    ).toBe(404);
  });
});

describe("DELETE /api/rules/:id (AC1.8.3)", () => {
  it("deletes with 204, then the rule is gone and a second delete is 404", async () => {
    const res = await coordinator.delete("/api/rules/rule-2-residents-on-xr");
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    const list = await coordinator.get("/api/rules");
    expect(list.body.map((r: { id: string }) => r.id)).not.toContain("rule-2-residents-on-xr");
    const again = await coordinator.delete("/api/rules/rule-2-residents-on-xr");
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ error: "not_found" });
  });

  it("answers 404 for a malformed path id, without reading the table", async () => {
    for (const id of ["RULE-1", "rule-x-duty", "rule-1-", `rule-1-${"a".repeat(100)}`]) {
      const res = await coordinator.delete(`/api/rules/${id}`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "not_found", message: "Rule not found" });
    }
  });
});

describe("who may call (BR2.5, NFR2.1-NFR2.3)", () => {
  it.each([
    ["POST", "/api/rules", dutyLimitBody],
    ["PUT", "/api/rules/rule-1-rest-after-call", { strength: "soft" }],
    ["DELETE", "/api/rules/rule-1-rest-after-call", undefined],
    ["POST", "/api/rules/rule-1-rest-after-call/enable", undefined],
    ["POST", "/api/rules/rule-1-rest-after-call/disable", undefined],
    ["GET", "/api/rules/check?doctorId=ben.ochieng&dutyId=d-2026-12-08-am-xr", undefined],
  ])("refuses a doctor on %s %s with 403 and a well-formed body", async (method, path, body) => {
    const call = {
      POST: doctorUser.post,
      PUT: doctorUser.put,
      DELETE: doctorUser.delete,
      GET: doctorUser.get,
    }[method]!(path);
    const res = body === undefined ? await call : await call.send(body);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", message: expect.any(String), details: [] });
    const rules = await coordinator.get("/api/rules");
    expect(rules.body).toHaveLength(3);
    expect(rules.body[0].enabled).toBe(true);
  });

  it("refuses a call with no sign-in headers (401)", async () => {
    const res = await request(app).get("/api/rules");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "unauthorized" });
  });
});

describe("GET /api/rules/check (AC1.9.1)", () => {
  it("refuses a missing, empty or over-long id with 400", async () => {
    for (const query of [
      "",
      "?doctorId=ben.ochieng",
      "?doctorId=&dutyId=d-2026-12-08-am-xr",
      `?doctorId=${"b".repeat(101)}&dutyId=d-2026-12-08-am-xr`,
      "?doctorId=ben.ochieng&dutyId=d-2026-12-08-am-xr&extra=1",
    ]) {
      const res = await coordinator.get(`/api/rules/check${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.error).toBe("validation");
    }
  });

  it("answers 200 with the AC1.9.1 answer, and 404 for an unknown duty", async () => {
    await putRosterWeek("draft", "2026-12-07", [["ben.ochieng", "d-2026-12-07-call-xr"]]);
    const res = await coordinator.get(
      "/api/rules/check?doctorId=ben.ochieng&dutyId=d-2026-12-08-am-xr",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      doctorId: "ben.ochieng",
      dutyId: "d-2026-12-08-am-xr",
      allowed: false,
      source: "draft",
      broken: [{ ruleId: "rule-1-rest-after-call", strength: "hard" }],
    });
    const missing = await coordinator.get("/api/rules/check?doctorId=ben.ochieng&dutyId=d-none");
    expect(missing.status).toBe(404);
  });
});
