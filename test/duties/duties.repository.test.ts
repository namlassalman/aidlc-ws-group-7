/**
 * Duties repository tests (u3-duties): TC-DUT-R01 to R08 from quality/duties-test-cases.md.
 * Contract C1 keys and the byDate range; rules BR1.7, BR1.9, BR2.3, BR3.3, BR4.4.
 */
import { describe, it, expect } from "vitest";
import { getItem } from "../../src/shared/db.js";
import { TABLES, dutyKey, type Duty } from "../../src/shared/tables.js";
import { ConflictError, NotFoundError } from "../../src/shared/errors.js";
import {
  saveDuty,
  getDuty,
  findDutiesBetween,
  markCancelled,
} from "../../src/features/duties/repository.js";
import { DUTY_FIELDS, EXAMPLE_DUTIES } from "./helpers.js";

const base: Omit<Duty, "id" | "type"> = {
  date: "2026-12-07",
  modality: "CT",
  doctorsNeeded: 1,
  needsConsultant: false,
  cancelled: false,
};

describe("duties repository", () => {
  it("TC-DUT-R01 stores the C1 keys for AM, PM and CALL", async () => {
    await saveDuty({ ...base, id: "a", type: "AM" });
    await saveDuty({ ...base, id: "p", type: "PM" });
    await saveDuty({ ...base, id: "c", type: "CALL" });
    const expected = [
      ["a", "AM", "08"],
      ["p", "PM", "13"],
      ["c", "CALL", "18"],
    ] as const;
    for (const [id, type, hh] of expected) {
      const item = await getItem(TABLES.duties, dutyKey(id));
      expect(item).toEqual({
        pk: "DUTY",
        sk: id,
        gsi1pk: "DUTY",
        gsi1sk: `2026-12-07#${hh}#${id}`,
        ...base,
        id,
        type,
      });
    }
  });

  it("TC-DUT-R02 refuses a second duty with the same id", async () => {
    await saveDuty({ ...base, id: "x", type: "AM" });
    await expect(saveDuty({ ...base, id: "x", type: "PM" })).rejects.toBeInstanceOf(ConflictError);
    expect(await getDuty("x")).toMatchObject({ type: "AM" });
  });

  it("TC-DUT-R03 returns undefined for an unknown id", async () => {
    expect(await getDuty("missing")).toBeUndefined();
  });

  it("TC-DUT-R04 keeps only duties inside the range, AM before CALL", async () => {
    await saveDuty({ ...base, id: "before", date: "2026-12-06", type: "AM" });
    await saveDuty({ ...base, id: "call", date: "2026-12-07", type: "CALL" });
    await saveDuty({ ...base, id: "am", date: "2026-12-07", type: "AM" });
    await saveDuty({ ...base, id: "after", date: "2026-12-10", type: "AM" });
    const ids = (await findDutiesBetween("2026-12-07", "2026-12-09")).map((d) => d.id);
    expect(ids).toEqual(["am", "call"]);
  });

  it("TC-DUT-R05 includes a CALL that starts on the last day", async () => {
    await saveDuty({ ...base, id: "call", date: "2026-12-09", type: "CALL" });
    const ids = (await findDutiesBetween("2026-12-07", "2026-12-09")).map((d) => d.id);
    expect(ids).toEqual(["call"]);
  });

  it("TC-DUT-R06 works for a single day (from = to)", async () => {
    for (const d of EXAMPLE_DUTIES) await saveDuty(d);
    const ids = (await findDutiesBetween("2026-12-08", "2026-12-08")).map((d) => d.id);
    expect(ids).toEqual(["d-2026-12-08-am-mri", "d-2026-12-08-am-us", "d-2026-12-08-am-xr"]);
  });

  it("TC-DUT-R07 returns an empty list for a range with no duties", async () => {
    for (const d of EXAMPLE_DUTIES) await saveDuty(d);
    expect(await findDutiesBetween("2026-12-14", "2026-12-20")).toEqual([]);
  });

  it("TC-DUT-R08 keeps a cancelled duty stored with the same keys", async () => {
    const open: Duty = { ...base, id: "x", type: "AM" };
    await saveDuty(open);
    await markCancelled("x");
    const item = await getItem(TABLES.duties, dutyKey("x"));
    expect(item).toMatchObject({ pk: "DUTY", sk: "x", gsi1pk: "DUTY", gsi1sk: "2026-12-07#08#x" });
    const duty = await getDuty("x");
    expect(duty).toEqual({ ...open, cancelled: true });
    expect(Object.keys(duty ?? {}).sort()).toEqual(DUTY_FIELDS);
  });

  it("markCancelled refuses an unknown id with NotFoundError and stores nothing", async () => {
    await expect(markCancelled("missing")).rejects.toBeInstanceOf(NotFoundError);
    expect(await getDuty("missing")).toBeUndefined();
  });
});
