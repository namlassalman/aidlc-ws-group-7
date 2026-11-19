// Doctors Unit (u2-doctors), repository layer tests: the doctors table (contract C1) through the
// in-memory table helpers. Covers BR2.1 (conditional add) and BR4.1 (no keys, id order).
import { describe, expect, it } from "vitest";
import { getItem } from "../../src/shared/db.js";
import { ConflictError } from "../../src/shared/errors.js";
import { TABLES, doctorKey, type Doctor } from "../../src/shared/tables.js";
import {
  findDoctor,
  insertDoctor,
  listDoctors,
  saveDoctor,
} from "../../src/features/doctors/repository.js";

const doctor = (id: string, overrides: Partial<Doctor> = {}): Doctor => ({
  id,
  name: `Dr ${id}`,
  grade: "consultant",
  modalities: ["CT", "MRI"],
  maxHoursPerWeek: 40,
  active: true,
  ...overrides,
});

describe("doctors repository", () => {
  it("inserts then finds the doctor, without pk or sk", async () => {
    const asha = doctor("asha.rao", { name: "Asha Rao" });
    await insertDoctor(asha);

    const found = await findDoctor("asha.rao");

    expect(found).toEqual(asha);
    expect(found).not.toHaveProperty("pk");
    expect(found).not.toHaveProperty("sk");
    // The stored item does carry the C1 keys.
    expect(await getItem(TABLES.doctors, doctorKey("asha.rao"))).toMatchObject({
      pk: "DOCTOR",
      sk: "asha.rao",
    });
  });

  it("throws ConflictError when the id already exists", async () => {
    await insertDoctor(doctor("asha.rao"));

    await expect(insertDoctor(doctor("asha.rao", { name: "Someone Else" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await findDoctor("asha.rao"))?.name).toBe("Dr asha.rao");
  });

  it("returns undefined for an unknown id", async () => {
    expect(await findDoctor("nobody")).toBeUndefined();
  });

  it("saves changes over an existing doctor", async () => {
    await insertDoctor(doctor("ben.ochieng"));
    await saveDoctor(doctor("ben.ochieng", { active: false }));

    expect((await findDoctor("ben.ochieng"))?.active).toBe(false);
  });

  it("lists every doctor in id order, without keys", async () => {
    for (const id of ["dana.novak", "asha.rao", "chen.li", "ben.ochieng"]) {
      await insertDoctor(doctor(id, { active: id !== "dana.novak" }));
    }

    const list = await listDoctors();

    expect(list.map((d) => d.id)).toEqual(["asha.rao", "ben.ochieng", "chen.li", "dana.novak"]);
    expect(list.every((d) => !("pk" in d) && !("sk" in d))).toBe(true);
  });
});
