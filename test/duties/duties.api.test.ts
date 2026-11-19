/**
 * Duties API tests (u3-duties): TC-DUT-A01 to A40 from quality/duties-test-cases.md, through
 * Supertest against buildApp(), plus the NFR design's extra checks (NFR2.3, NFR3.2, NFR3.3).
 * Contract C6 `/api/duties` and the C4 ErrorBody; rules BR1-BR4. The open points P1-P11 are
 * settled by Q1-Q4 (answer A), so every case runs. TC-DUT-A40 is checked by `expectError` in
 * every failing case.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../../src/app.js";
import {
  COORD,
  DOCTOR,
  DUTY_FIELDS,
  VALID_BODY,
  EXAMPLE_DUTIES,
  EXAMPLE_ORDER,
  seedDuty,
  seedExampleWeek,
  expectError,
} from "./helpers.js";

const app = buildApp();
const WEEK = "/api/duties?from=2026-12-07&to=2026-12-09";
const ids = (body: { id: string }[]) => body.map((d) => d.id);
const post = (headers: Record<string, string>, body: unknown) =>
  request(app)
    .post("/api/duties")
    .set(headers)
    .send(body as object);
const list = (headers: Record<string, string>, url = WEEK) => request(app).get(url).set(headers);
const cancel = (headers: Record<string, string>, id: string) =>
  request(app).post(`/api/duties/${id}/cancel`).set(headers);
const countStored = async () =>
  (await list(COORD, "/api/duties?from=2000-01-01&to=2100-12-31&includeCancelled=true")).body
    .length;

describe("sign-in", () => {
  it("TC-DUT-A01 refuses every route with no test headers (401)", async () => {
    expectError(await request(app).get(WEEK), 401);
    expectError(await request(app).post("/api/duties").send(VALID_BODY), 401);
    expectError(await request(app).post("/api/duties/x/cancel"), 401);
  });

  it("TC-DUT-A02 refuses an unknown role header (401)", async () => {
    expectError(await list({ "X-User-Id": "x", "X-User-Role": "admin" }), 401);
  });
});

describe("POST /api/duties", () => {
  it("TC-DUT-A03 creates a duty for the coordinator (AC1.4.1)", async () => {
    const res = await post(COORD, VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ...VALID_BODY, cancelled: false });
    expect(typeof res.body.id).toBe("string");
    expect(res.body.id.length).toBeGreaterThan(0);
    expect(Object.keys(res.body).sort()).toEqual(DUTY_FIELDS);
    const day = await list(COORD, "/api/duties?from=2026-12-07&to=2026-12-07");
    expect(ids(day.body)).toEqual([res.body.id]);
  });

  it("TC-DUT-A04 accepts every type and modality", async () => {
    for (const type of ["AM", "PM", "CALL"]) {
      for (const modality of ["CT", "MRI", "US", "XR"]) {
        const res = await post(COORD, { ...VALID_BODY, type, modality });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ type, modality });
      }
    }
    expect(await countStored()).toBe(12);
  });

  it("TC-DUT-A05 accepts 1 and 3 doctors needed", async () => {
    expect((await post(COORD, { ...VALID_BODY, doctorsNeeded: 1 })).status).toBe(201);
    expect((await post(COORD, { ...VALID_BODY, doctorsNeeded: 3 })).status).toBe(201);
  });

  it("TC-DUT-A06 refuses 0 doctors needed and stores nothing (AC1.4.2)", async () => {
    expectError(await post(COORD, { ...VALID_BODY, doctorsNeeded: 0 }), 400, "doctorsNeeded");
    expect(await countStored()).toBe(0);
  });

  it("TC-DUT-A07 refuses 4 doctors needed (AC1.4.2)", async () => {
    expectError(await post(COORD, { ...VALID_BODY, doctorsNeeded: 4 }), 400, "doctorsNeeded");
  });

  it("TC-DUT-A08 refuses type NIGHT (AC1.4.2)", async () => {
    expectError(await post(COORD, { ...VALID_BODY, type: "NIGHT" }), 400, "type");
  });

  it("TC-DUT-A09 refuses a fraction or a string for doctors needed", async () => {
    expectError(await post(COORD, { ...VALID_BODY, doctorsNeeded: 1.5 }), 400, "doctorsNeeded");
    expectError(await post(COORD, { ...VALID_BODY, doctorsNeeded: "2" }), 400, "doctorsNeeded");
  });

  it("TC-DUT-A10 refuses an unknown or lower-case modality", async () => {
    expectError(await post(COORD, { ...VALID_BODY, modality: "PET" }), 400, "modality");
    expectError(await post(COORD, { ...VALID_BODY, modality: "ct" }), 400, "modality");
  });

  it("TC-DUT-A11 refuses dates that are not real YYYY-MM-DD dates", async () => {
    for (const date of ["2026-02-30", "07/12/2026", "2026-12-7", ""]) {
      expectError(await post(COORD, { ...VALID_BODY, date }), 400, "date");
    }
    expect(await countStored()).toBe(0);
  });

  it("TC-DUT-A12 refuses a body missing a required field", async () => {
    for (const field of ["date", "type", "modality", "doctorsNeeded"] as const) {
      const body: Record<string, unknown> = { ...VALID_BODY };
      delete body[field];
      expectError(await post(COORD, body), 400, field);
    }
  });

  it("TC-DUT-A13 refuses a body without needsConsultant", async () => {
    const body: Record<string, unknown> = { ...VALID_BODY };
    delete body.needsConsultant;
    expectError(await post(COORD, body), 400, "needsConsultant");
  });

  it("TC-DUT-A14 refuses a non-boolean needsConsultant", async () => {
    expectError(
      await post(COORD, { ...VALID_BODY, needsConsultant: "yes" }),
      400,
      "needsConsultant",
    );
  });

  it("TC-DUT-A15 refuses unknown fields, including cancelled and id", async () => {
    for (const [field, extra] of [
      ["cancelled", { cancelled: true }],
      ["id", { id: "d-1" }],
      ["foo", { foo: 1 }],
    ] as const) {
      expectError(await post(COORD, { ...VALID_BODY, ...extra }), 400, field);
    }
    expect(await countStored()).toBe(0);
  });

  it("TC-DUT-A16 refuses malformed JSON and stores nothing", async () => {
    // The shared handler sends no details for a body-parser error, so only the status is checked.
    const res = await request(app)
      .post("/api/duties")
      .set(COORD)
      .set("Content-Type", "application/json")
      .send('{"date":');
    expect(res.status).toBe(400);
    expect(await countStored()).toBe(0);
  });

  it("TC-DUT-A17 refuses a doctor (AC1.4.3) and stores nothing", async () => {
    expectError(await post(DOCTOR, VALID_BODY), 403);
    expect(await countStored()).toBe(0);
  });

  it("TC-DUT-A18 a doctor's invalid body still gets 403 (role checked first)", async () => {
    expectError(await post(DOCTOR, { ...VALID_BODY, doctorsNeeded: 0 }), 403);
  });

  it("NFR2.3 a doctor's well-formed body with extra fields gets 403 and stores nothing", async () => {
    expectError(await post(DOCTOR, { ...VALID_BODY, cancelled: true, id: "d-1" }), 403);
    expectError(await post(DOCTOR, {}), 403);
    expect(await countStored()).toBe(0);
  });

  it("TC-DUT-A19 allows two identical duties", async () => {
    const a = await post(COORD, VALID_BODY);
    const b = await post(COORD, VALID_BODY);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).not.toBe(b.body.id);
    expect(await countStored()).toBe(2);
  });

  it("TC-DUT-A20 allows a duty in the past", async () => {
    const res = await post(COORD, { ...VALID_BODY, date: "2020-01-06" });
    expect(res.status).toBe(201);
    expect(res.body.date).toBe("2020-01-06");
  });

  it("TC-DUT-A21 refuses a body over 100 kB (413)", async () => {
    const res = await post(COORD, { ...VALID_BODY, padding: "x".repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expect(await countStored()).toBe(0);
  });
});

describe("GET /api/duties", () => {
  it("TC-DUT-A22 lists the example week in order (AC1.5.1)", async () => {
    await seedExampleWeek();
    const res = await list(COORD);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(EXAMPLE_ORDER);
  });

  it("TC-DUT-A23 lets a doctor list the same duties", async () => {
    await seedExampleWeek();
    const res = await list(DOCTOR);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(EXAMPLE_ORDER);
  });

  it("TC-DUT-A24 includes both ends of the range and nothing outside", async () => {
    const one = { ...EXAMPLE_DUTIES[0] };
    await seedDuty({ ...one, id: "before", date: "2026-12-06" });
    await seedDuty({ ...one, id: "inside", date: "2026-12-07" });
    await seedDuty({ ...one, id: "after", date: "2026-12-10" });
    expect(ids((await list(COORD)).body)).toEqual(["inside"]);
    const single = await list(COORD, "/api/duties?from=2026-12-07&to=2026-12-07");
    expect(ids(single.body)).toEqual(["inside"]);
  });

  it("TC-DUT-A25 includes a CALL starting on the last day", async () => {
    await seedDuty({ ...EXAMPLE_DUTIES[1], id: "late-call", date: "2026-12-09" });
    expect(ids((await list(COORD)).body)).toEqual(["late-call"]);
  });

  it("TC-DUT-A26 refuses a range whose start is after its end (AC1.5.3)", async () => {
    for (const who of [COORD, DOCTOR]) {
      expectError(await list(who, "/api/duties?from=2026-12-09&to=2026-12-07"), 400, "from");
    }
  });

  it("TC-DUT-A27 refuses dates that are not real", async () => {
    expectError(await list(COORD, "/api/duties?from=2026-13-01&to=2026-13-05"), 400, "from");
    expectError(await list(COORD, "/api/duties?from=abc&to=2026-12-09"), 400, "from");
  });

  it("TC-DUT-A28 requires both from and to", async () => {
    expectError(await list(COORD, "/api/duties"), 400);
    expectError(await list(COORD, "/api/duties?from=2026-12-07"), 400, "to");
    expectError(await list(COORD, "/api/duties?to=2026-12-09"), 400, "from");
  });

  it("TC-DUT-A29 returns an empty list for a range with no duties", async () => {
    await seedExampleWeek();
    const res = await list(COORD, "/api/duties?from=2026-12-14&to=2026-12-20");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("TC-DUT-A30 leaves out a cancelled duty by default (AC1.5.2, Duties half)", async () => {
    await seedExampleWeek();
    await seedDuty({ ...EXAMPLE_DUTIES[5], cancelled: true });
    for (const who of [COORD, DOCTOR]) {
      const res = await list(who);
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual(EXAMPLE_ORDER.slice(0, 5));
    }
  });

  it("TC-DUT-A31 shows cancelled duties to the coordinator with includeCancelled=true", async () => {
    await seedExampleWeek();
    await seedDuty({ ...EXAMPLE_DUTIES[5], cancelled: true });
    const res = await list(COORD, `${WEEK}&includeCancelled=true`);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(EXAMPLE_ORDER);
    expect(res.body[5].cancelled).toBe(true);
    const off = await list(COORD, `${WEEK}&includeCancelled=false`);
    expect(ids(off.body)).toEqual(EXAMPLE_ORDER.slice(0, 5));
  });

  it("TC-DUT-A32 ignores includeCancelled for a doctor", async () => {
    await seedExampleWeek();
    await seedDuty({ ...EXAMPLE_DUTIES[5], cancelled: true });
    const res = await list(DOCTOR, `${WEEK}&includeCancelled=true`);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(EXAMPLE_ORDER.slice(0, 5));
  });

  it("TC-DUT-A33 refuses an includeCancelled value other than true or false", async () => {
    expectError(await list(COORD, `${WEEK}&includeCancelled=maybe`), 400, "includeCancelled");
    expectError(await list(COORD, `${WEEK}&includeCancelled=1`), 400, "includeCancelled");
  });

  it("NFR3.2 refuses an unknown or repeated query parameter", async () => {
    expectError(await list(COORD, `${WEEK}&status=x`), 400, "status");
    expectError(await list(DOCTOR, `${WEEK}&status=x`), 400, "status");
    expectError(await list(COORD, `${WEEK}&from=2026-12-08`), 400, "from");
  });

  it("TC-DUT-A34 returns exactly the seven Duty fields", async () => {
    await seedExampleWeek();
    const res = await list(COORD);
    expect(res.body).toHaveLength(6);
    for (const d of res.body) {
      expect(Object.keys(d).sort()).toEqual(DUTY_FIELDS);
    }
  });
});

describe("POST /api/duties/{id}/cancel", () => {
  const target = EXAMPLE_DUTIES[5].id;

  it("TC-DUT-A35 cancels a duty for the coordinator (AC1.5.2, Duties half)", async () => {
    await seedExampleWeek();
    const res = await cancel(COORD, target);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...EXAMPLE_DUTIES[5], cancelled: true });
    expect(ids((await list(COORD)).body)).not.toContain(target);
    const all = await list(COORD, `${WEEK}&includeCancelled=true`);
    expect(all.body.find((d: { id: string }) => d.id === target).cancelled).toBe(true);
  });

  it("TC-DUT-A36 refuses to cancel a duty twice (409)", async () => {
    await seedExampleWeek();
    expect((await cancel(COORD, target)).status).toBe(200);
    expectError(await cancel(COORD, target), 409);
  });

  it("TC-DUT-A37 refuses an unknown id (404)", async () => {
    expectError(await cancel(COORD, "does-not-exist"), 404);
  });

  it("TC-DUT-A38 refuses a doctor and leaves the duty open (403)", async () => {
    await seedExampleWeek();
    expectError(await cancel(DOCTOR, target), 403);
    expect(ids((await list(COORD)).body)).toContain(target);
  });

  it("TC-DUT-A39 a doctor gets 403 even for an unknown id", async () => {
    expectError(await cancel(DOCTOR, "does-not-exist"), 403);
  });

  it("NFR3.3 answers an id no duty could have with 404, never 500", async () => {
    expectError(await cancel(COORD, "a".repeat(101)), 404);
    expectError(await cancel(COORD, "bad_id"), 404);
    expectError(await cancel(COORD, "bad.id"), 404);
    // 100 letters is a well-formed id that matches no duty: still 404.
    expectError(await cancel(COORD, "a".repeat(100)), 404);
    // The role is checked before the id (NFR2.3).
    expectError(await cancel(DOCTOR, "a".repeat(101)), 403);
  });
});
