// Doctors Unit (u2-doctors), service layer tests: the lifecycle rules BR2.1-BR2.4, the list rules
// BR3.2-BR3.3 and the lifecycle log line (NFR6.6, NFR6.7). Runs on the in-memory tables.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/shared/errors.js";
import { findDoctor } from "../../src/features/doctors/repository.js";
import type { NewDoctor } from "../../src/features/doctors/schemas.js";
import {
  addDoctor,
  editDoctor,
  listDoctors,
  setActive,
} from "../../src/features/doctors/service.js";

const newDoctor = (id: string, overrides: Partial<NewDoctor> = {}): NewDoctor => ({
  id,
  name: `Dr ${id}`,
  grade: "resident",
  modalities: ["XR"],
  maxHoursPerWeek: 40,
  ...overrides,
});

const asha: NewDoctor = {
  id: "asha.rao",
  name: "Asha Rao",
  grade: "consultant",
  modalities: ["CT", "MRI"],
  maxHoursPerWeek: 40,
};

async function seedFour(): Promise<void> {
  for (const id of ["asha.rao", "ben.ochieng", "chen.li", "dana.novak"]) {
    await addDoctor(newDoctor(id), "coord1");
  }
  await setActive("dana.novak", false, "coord1");
}

describe("addDoctor", () => {
  it("stores an active doctor (AC1.2.1)", async () => {
    const added = await addDoctor(asha, "coord1");

    expect(added).toEqual({ ...asha, active: true });
    expect(await findDoctor("asha.rao")).toEqual({ ...asha, active: true });
  });

  it("refuses a duplicate id with a ConflictError naming the id (AC1.2.3)", async () => {
    await addDoctor(asha, "coord1");

    const attempt = addDoctor({ ...asha, name: "Other" }, "coord1");

    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toThrow('"asha.rao"');
  });

  it("refuses an id that belongs to a deactivated doctor", async () => {
    await addDoctor(asha, "coord1");
    await setActive("asha.rao", false, "coord1");

    await expect(addDoctor(asha, "coord1")).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("editDoctor", () => {
  it("changes only the sent fields (AC1.3.1)", async () => {
    const ben = newDoctor("ben.ochieng", { name: "Ben Ochieng", maxHoursPerWeek: 36 });
    await addDoctor(ben, "coord1");

    const edited = await editDoctor("ben.ochieng", { modalities: ["XR", "US"] });

    expect(edited).toEqual({ ...ben, modalities: ["XR", "US"], active: true });
    expect(await findDoctor("ben.ochieng")).toEqual(edited);
  });

  it("keeps an inactive doctor inactive", async () => {
    await addDoctor(asha, "coord1");
    await setActive("asha.rao", false, "coord1");

    const edited = await editDoctor("asha.rao", { name: "Asha R." });

    expect(edited).toMatchObject({ name: "Asha R.", active: false });
  });

  it("gives NotFoundError for an unknown id (AC1.3.3)", async () => {
    await expect(editDoctor("nobody", { name: "X" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("setActive", () => {
  it("deactivates and keeps the record (AC1.3.2); a repeat changes nothing", async () => {
    await addDoctor(asha, "coord1");

    const first = await setActive("asha.rao", false, "coord1");
    const second = await setActive("asha.rao", false, "coord1");

    expect(first).toEqual({ ...asha, active: false });
    expect(second).toEqual(first);
    expect(await findDoctor("asha.rao")).toEqual(first);
  });

  it("activate restores active: true", async () => {
    await addDoctor(asha, "coord1");
    await setActive("asha.rao", false, "coord1");

    expect(await setActive("asha.rao", true, "coord1")).toEqual({ ...asha, active: true });
    expect((await findDoctor("asha.rao"))?.active).toBe(true);
  });

  it("gives NotFoundError for an unknown id", async () => {
    await expect(setActive("nobody", true, "coord1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(setActive("nobody", false, "coord1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listDoctors", () => {
  it("returns the 3 active doctors of 4, in id order (AC2.2.1)", async () => {
    await seedFour();

    const list = await listDoctors({ all: false, role: "doctor" });

    expect(list.map((d) => d.id)).toEqual(["asha.rao", "ben.ochieng", "chen.li"]);
  });

  it("returns all 4 for a coordinator asking for all", async () => {
    await seedFour();

    const list = await listDoctors({ all: true, role: "coordinator" });

    expect(list.map((d) => d.id)).toEqual(["asha.rao", "ben.ochieng", "chen.li", "dana.novak"]);
  });

  it("gives ForbiddenError to a doctor asking for all", async () => {
    await seedFour();

    await expect(listDoctors({ all: true, role: "doctor" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("lifecycle logging", () => {
  afterEach(() => {
    process.env.LOG_LEVEL = "silent";
    vi.restoreAllMocks();
  });

  it("logs one doctor.deactivated line with the doctor id and caller id only", async () => {
    await addDoctor(asha, "coord1");
    process.env.LOG_LEVEL = "info";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await setActive("asha.rao", false, "coord1");
    await setActive("asha.rao", false, "coord1"); // repeat: no write, no log

    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0][0]))).toEqual({
      level: "info",
      msg: "doctor.deactivated",
      doctorId: "asha.rao",
      by: "coord1",
    });
  });
});
