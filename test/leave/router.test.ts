// Leave router tests (u4-leave): Supertest on buildApp() with the X-User-Id / X-User-Role test
// sign-in, in-memory tables (emptied by test/setup.ts) and the real event hook.
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { approvedLeave } from "../../src/features/leave/repository.js";
import { putItem } from "../../src/shared/db.js";
import { clearSubscriptions } from "../../src/shared/events.js";
import {
  TABLES,
  doctorItem,
  leaveItem,
  type Doctor,
  type LeaveRequest,
} from "../../src/shared/tables.js";

const app = buildApp();

const asBen = { "X-User-Id": "ben.ochieng", "X-User-Role": "doctor" };
const asChen = { "X-User-Id": "chen.li", "X-User-Role": "doctor" };
const asRiya = { "X-User-Id": "riya.coord", "X-User-Role": "coordinator" };

const doctor = (id: string): Doctor => ({
  id,
  name: id,
  grade: "consultant",
  modalities: ["MRI"],
  maxHoursPerWeek: 40,
  active: true,
});

const chenPending: LeaveRequest = {
  id: "leave-chen-li-2026-12-07",
  doctorId: "chen.li",
  startDate: "2026-12-07",
  endDate: "2026-12-09",
  reason: null,
  status: "pending",
  createdAt: "2026-11-20T09:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
};

const validBody = { startDate: "2026-12-14", endDate: "2026-12-16", reason: "course" };

beforeEach(async () => {
  clearSubscriptions();
  await putItem(TABLES.doctors, doctorItem(doctor("ben.ochieng")));
  await putItem(TABLES.doctors, doctorItem(doctor("chen.li")));
});

describe("POST /api/leave", () => {
  it("creates a pending request for the signed-in doctor (AC2.3.1)", async () => {
    const res = await request(app).post("/api/leave").set(asBen).send(validBody);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      doctorId: "ben.ochieng",
      status: "pending",
      reason: "course",
      decidedAt: null,
    });
  });

  it.each([
    ["start after end", { startDate: "2026-12-16", endDate: "2026-12-14" }],
    ["an impossible date", { startDate: "2026-02-30", endDate: "2026-03-01" }],
    ["an unknown doctorId field", { ...validBody, doctorId: "chen.li" }],
    ["a 201-character reason", { ...validBody, reason: "x".repeat(201) }],
  ])("refuses %s with 400 (AC2.3.2)", async (_case, body) => {
    const res = await request(app).post("/api/leave").set(asBen).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation");
  });

  it("refuses a coordinator with 403", async () => {
    const res = await request(app).post("/api/leave").set(asRiya).send(validBody);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/leave/:id/approve and /reject", () => {
  it("refuses a doctor with 403 (AC1.6.3)", async () => {
    await putItem(TABLES.leave, leaveItem(chenPending));

    const approve = await request(app).post(`/api/leave/${chenPending.id}/approve`).set(asBen);
    const reject = await request(app).post(`/api/leave/${chenPending.id}/reject`).set(asBen);

    expect(approve.status).toBe(403);
    expect(reject.status).toBe(403);
  });

  it("approves a seeded non-UUID id with 200 {leave, followUps}, then 409 on a second try", async () => {
    await putItem(TABLES.leave, leaveItem(chenPending));
    const path = `/api/leave/${chenPending.id}/approve`;

    const first = await request(app).post(path).set(asRiya);
    expect(first.status).toBe(200);
    expect(first.body.leave).toMatchObject({ id: chenPending.id, status: "approved" });
    expect(first.body.followUps).toEqual([]);

    const second = await request(app).post(path).set(asRiya);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("conflict");
  });

  it("rejects with 200 and the request", async () => {
    await putItem(TABLES.leave, leaveItem(chenPending));

    const res = await request(app).post(`/api/leave/${chenPending.id}/reject`).set(asRiya);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: chenPending.id, status: "rejected" });
  });

  it("answers 404 for an over-long id and for an unknown id", async () => {
    const longId = await request(app)
      .post(`/api/leave/${"a".repeat(200)}/approve`)
      .set(asRiya);
    const unknown = await request(app).post("/api/leave/no-such-leave/approve").set(asRiya);

    expect(longId.status).toBe(404);
    expect(unknown.status).toBe(404);
  });
});

describe("POST /api/leave/:id/cancel", () => {
  it("lets the owner cancel (200) and refuses another doctor (403)", async () => {
    await putItem(TABLES.leave, leaveItem(chenPending));

    const other = await request(app).post(`/api/leave/${chenPending.id}/cancel`).set(asBen);
    const owner = await request(app).post(`/api/leave/${chenPending.id}/cancel`).set(asChen);

    expect(other.status).toBe(403);
    expect(owner.status).toBe(200);
    expect(owner.body.status).toBe("cancelled");
  });
});

describe("GET /api/leave", () => {
  it("refuses from after to, an unknown status and an unknown parameter with 400", async () => {
    const reversed = await request(app).get("/api/leave?from=2026-12-09&to=2026-12-07").set(asRiya);
    const badStatus = await request(app).get("/api/leave?status=maybe").set(asRiya);
    const unknown = await request(app).get("/api/leave?doctorId=chen.li").set(asRiya);

    expect(reversed.status).toBe(400);
    expect(badStatus.status).toBe(400);
    expect(unknown.status).toBe(400);
  });

  it("does not count a pending request as approved leave (AC2.3.3)", async () => {
    const created = await request(app).post("/api/leave").set(asBen).send(validBody);
    expect(created.status).toBe(201);

    const approved = await request(app).get("/api/leave?status=approved").set(asRiya);
    const pending = await request(app).get("/api/leave?status=pending").set(asRiya);

    expect(approved.status).toBe(200);
    expect(approved.body).toEqual([]);
    expect(pending.body.map((l: LeaveRequest) => l.id)).toEqual([created.body.id]);
    // The approved partition that rules and roster generation read (C1) does not hold it.
    expect(await approvedLeave()).toEqual([]);
  });

  it("hides another doctor's pending request from a doctor (AC2.5.1)", async () => {
    await putItem(TABLES.leave, leaveItem(chenPending));

    const res = await request(app).get("/api/leave").set(asBen);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
