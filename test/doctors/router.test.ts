// Doctors Unit (u2-doctors), API layer tests: contract C5 through buildApp() with Supertest.
// Covers every acceptance criterion of US1.2, US1.3 and US2.2, the validation rules BR1.1-BR1.7
// (400), the role rules BR3.1-BR3.3 (403), unknown and malformed path ids (404) and BR2.1 (409).
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { putItem } from "../../src/shared/db.js";
import { TABLES, doctorItem, type Doctor } from "../../src/shared/tables.js";

const app = buildApp();

const coordinator = { "X-User-Id": "coord1", "X-User-Role": "coordinator" };
const doctor = { "X-User-Id": "ben.ochieng", "X-User-Role": "doctor" };

/** The AC1.2.1 body. */
const ashaBody = {
  id: "asha.rao",
  name: "Asha Rao",
  grade: "consultant",
  modalities: ["CT", "MRI"],
  maxHoursPerWeek: 40,
};

const stored = (id: string, overrides: Partial<Doctor> = {}): Doctor => ({
  id,
  name: `Dr ${id}`,
  grade: "resident",
  modalities: ["XR"],
  maxHoursPerWeek: 40,
  active: true,
  ...overrides,
});

/** Four example doctors; dana.novak is deactivated. */
async function seedFour(): Promise<void> {
  for (const id of ["asha.rao", "ben.ochieng", "chen.li", "dana.novak"]) {
    await putItem(TABLES.doctors, doctorItem(stored(id, { active: id !== "dana.novak" })));
  }
}

type Issue = { path?: unknown[]; keys?: string[] };

/** The field names a 400 ErrorBody's zod issues point at. */
const issueFields = (body: { details: Issue[] }): string[] =>
  body.details.flatMap((issue) => [...(issue.path ?? []).map(String), ...(issue.keys ?? [])]);

const ids = (body: Doctor[]) => body.map((d) => d.id);

describe("POST /api/doctors", () => {
  it("adds an active doctor that then appears in the list (AC1.2.1)", async () => {
    const res = await request(app).post("/api/doctors").set(coordinator).send(ashaBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ...ashaBody, active: true });

    const list = await request(app).get("/api/doctors").set(coordinator);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([{ ...ashaBody, active: true }]);
  });

  it("trims the name", async () => {
    const res = await request(app)
      .post("/api/doctors")
      .set(coordinator)
      .send({ ...ashaBody, name: "  Asha Rao  " });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Asha Rao");
  });

  it("gives 400 naming grade for an intern and modalities for an empty list (AC1.2.2)", async () => {
    const intern = await request(app)
      .post("/api/doctors")
      .set(coordinator)
      .send({ ...ashaBody, grade: "intern" });
    expect(intern.status).toBe(400);
    expect(intern.body.error).toBe("validation");
    expect(issueFields(intern.body)).toEqual(["grade"]);

    const none = await request(app)
      .post("/api/doctors")
      .set(coordinator)
      .send({ ...ashaBody, modalities: [] });
    expect(none.status).toBe(400);
    expect(issueFields(none.body)).toEqual(["modalities"]);
  });

  it.each([
    ["a repeated modality", { modalities: ["CT", "CT"] }, "modalities"],
    ["maxHoursPerWeek 0", { maxHoursPerWeek: 0 }, "maxHoursPerWeek"],
    ["fractional hours", { maxHoursPerWeek: 37.5 }, "maxHoursPerWeek"],
    ["an id with upper case", { id: "Asha.Rao" }, "id"],
    ["an empty name", { name: "   " }, "name"],
    ["an unknown key", { active: false }, "active"],
  ])("gives 400 for %s", async (_label, change, field) => {
    const res = await request(app)
      .post("/api/doctors")
      .set(coordinator)
      .send({ ...ashaBody, ...change });

    expect(res.status).toBe(400);
    expect(issueFields(res.body)).toContain(field);
  });

  it("gives 409 when the id exists, even for a deactivated doctor (AC1.2.3)", async () => {
    await putItem(TABLES.doctors, doctorItem(stored("asha.rao", { active: false })));

    const res = await request(app).post("/api/doctors").set(coordinator).send(ashaBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
    expect(res.body.message).toContain("asha.rao");
  });
});

describe("PUT /api/doctors/:id", () => {
  it("edits only the sent fields (AC1.3.1)", async () => {
    await putItem(TABLES.doctors, doctorItem(stored("ben.ochieng", { name: "Ben Ochieng" })));

    const res = await request(app)
      .put("/api/doctors/ben.ochieng")
      .set(coordinator)
      .send({ modalities: ["XR", "US"] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      stored("ben.ochieng", { name: "Ben Ochieng", modalities: ["XR", "US"] }),
    );
  });

  it("gives 400 for an empty body and for id or active in the body", async () => {
    await putItem(TABLES.doctors, doctorItem(stored("ben.ochieng")));

    for (const body of [{}, { id: "other" }, { active: false }]) {
      const res = await request(app).put("/api/doctors/ben.ochieng").set(coordinator).send(body);
      expect(res.status).toBe(400);
    }
  });

  it("gives 404 for an unknown id (AC1.3.3) and for a 200-character id", async () => {
    const unknown = await request(app)
      .put("/api/doctors/nobody")
      .set(coordinator)
      .send({ name: "X" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("not_found");

    const long = await request(app)
      .put(`/api/doctors/${"a".repeat(200)}`)
      .set(coordinator)
      .send({ name: "X" });
    expect(long.status).toBe(404);
  });
});

describe("POST /api/doctors/:id/deactivate and /activate", () => {
  it("deactivate removes the doctor from the list (AC1.3.2); activate brings them back", async () => {
    await seedFour();

    const off = await request(app).post("/api/doctors/asha.rao/deactivate").set(coordinator);
    expect(off.status).toBe(200);
    expect(off.body).toEqual(stored("asha.rao", { active: false }));

    const without = await request(app).get("/api/doctors").set(coordinator);
    expect(ids(without.body)).toEqual(["ben.ochieng", "chen.li"]);

    const on = await request(app).post("/api/doctors/asha.rao/activate").set(coordinator);
    expect(on.status).toBe(200);
    expect(on.body.active).toBe(true);

    const back = await request(app).get("/api/doctors").set(coordinator);
    expect(ids(back.body)).toEqual(["asha.rao", "ben.ochieng", "chen.li"]);
  });

  it("gives 200 when repeated and 404 for an unknown or malformed id", async () => {
    await seedFour();

    const again = await request(app).post("/api/doctors/dana.novak/deactivate").set(coordinator);
    expect(again.status).toBe(200);
    expect(again.body.active).toBe(false);

    expect((await request(app).post("/api/doctors/nobody/activate").set(coordinator)).status).toBe(
      404,
    );
    expect(
      (await request(app).post("/api/doctors/BAD%20ID/deactivate").set(coordinator)).status,
    ).toBe(404);
  });
});

describe("as a doctor", () => {
  it("lists the 3 active doctors of 4 (AC2.2.1)", async () => {
    await seedFour();

    const res = await request(app).get("/api/doctors").set(doctor);

    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(["asha.rao", "ben.ochieng", "chen.li"]);
    expect(res.body[0]).not.toHaveProperty("pk");
  });

  it("gets 403 on every change route, even with an invalid body (AC2.2.2)", async () => {
    await seedFour();
    const invalid = { grade: "intern" };

    const responses = [
      await request(app).post("/api/doctors").set(doctor).send(invalid),
      await request(app).put("/api/doctors/asha.rao").set(doctor).send(invalid),
      await request(app).post("/api/doctors/asha.rao/deactivate").set(doctor),
      await request(app).post("/api/doctors/dana.novak/activate").set(doctor),
    ];

    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(responses.every((r) => r.body.error === "forbidden")).toBe(true);
    const all = await request(app).get("/api/doctors?all=true").set(coordinator);
    expect(all.body.find((d: Doctor) => d.id === "dana.novak").active).toBe(false);
  });

  it("gets 403 for ?all=true", async () => {
    const res = await request(app).get("/api/doctors?all=true").set(doctor);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/doctors as a coordinator", () => {
  it("returns all 4 with ?all=true, in id order", async () => {
    await seedFour();

    const res = await request(app).get("/api/doctors?all=true").set(coordinator);

    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(["asha.rao", "ben.ochieng", "chen.li", "dana.novak"]);
  });

  it("gives 400 for ?all=yes and for an unknown key", async () => {
    const yes = await request(app).get("/api/doctors?all=yes").set(coordinator);
    expect(yes.status).toBe(400);
    expect(issueFields(yes.body)).toContain("all");

    const foo = await request(app).get("/api/doctors?foo=1").set(coordinator);
    expect(foo.status).toBe(400);
    expect(issueFields(foo.body)).toContain("foo");
  });
});
