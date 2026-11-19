/**
 * Duties service tests (u3-duties): TC-DUT-S01 to S09 from quality/duties-test-cases.md.
 * Rules BR1.7, BR1.8, BR2.4-BR2.6, BR3.1-BR3.4, BR4.4. P6, P7 and P9 are settled by Q2 and Q4
 * (answer A), so every case runs.
 */
import { describe, it, expect } from "vitest";
import { ConflictError, NotFoundError } from "../../src/shared/errors.js";
import {
  createDuty,
  listDuties,
  cancelDuty,
  type NewDuty,
} from "../../src/features/duties/service.js";
import { getDuty } from "../../src/features/duties/repository.js";
import {
  DUTY_FIELDS,
  EXAMPLE_DUTIES,
  EXAMPLE_ORDER,
  seedDuty,
  seedExampleWeek,
} from "./helpers.js";

const input: NewDuty = {
  date: "2026-12-07",
  type: "AM",
  modality: "CT",
  doctorsNeeded: 2,
  needsConsultant: true,
};
const range = { from: "2026-12-07", to: "2026-12-09" };
const open = EXAMPLE_DUTIES[0];
const lastPm = EXAMPLE_DUTIES[5];

describe("duties service", () => {
  it("TC-DUT-S01 creates an open duty with an id", async () => {
    const duty = await createDuty(input);
    expect(duty).toMatchObject({ ...input, cancelled: false });
    expect(typeof duty.id).toBe("string");
    expect(duty.id.length).toBeGreaterThan(0);
    expect(await getDuty(duty.id)).toEqual(duty);
  });

  it("TC-DUT-S02 gives each duty its own id", async () => {
    const a = await createDuty(input);
    const b = await createDuty(input);
    expect(a.id).not.toBe(b.id);
    expect((await listDuties(range, "coordinator")).map((d) => d.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });

  it("TC-DUT-S03 leaves cancelled duties out by default", async () => {
    await seedDuty(open);
    await seedDuty({ ...lastPm, cancelled: true });
    expect((await listDuties(range, "coordinator")).map((d) => d.id)).toEqual([open.id]);
  });

  it("TC-DUT-S04 includes cancelled duties when a coordinator asks", async () => {
    await seedDuty(open);
    await seedDuty({ ...lastPm, cancelled: true });
    const all = await listDuties({ ...range, includeCancelled: true }, "coordinator");
    expect(all.map((d) => [d.id, d.cancelled])).toEqual([
      [open.id, false],
      [lastPm.id, true],
    ]);
  });

  it("TC-DUT-S04b ignores includeCancelled for a doctor (BR2.6)", async () => {
    await seedDuty(open);
    await seedDuty({ ...lastPm, cancelled: true });
    const seen = await listDuties({ ...range, includeCancelled: true }, "doctor");
    expect(seen.map((d) => d.id)).toEqual([open.id]);
  });

  it("TC-DUT-S05 orders by start date, start time, then id", async () => {
    await seedExampleWeek();
    expect((await listDuties(range, "doctor")).map((d) => d.id)).toEqual(EXAMPLE_ORDER);
  });

  it("TC-DUT-S06 cancels an open duty and returns it whole", async () => {
    await seedDuty(lastPm);
    const result = await cancelDuty(lastPm.id);
    expect(result).toEqual({ ...lastPm, cancelled: true });
    expect(await getDuty(lastPm.id)).toEqual({ ...lastPm, cancelled: true });
  });

  it("TC-DUT-S07 refuses an unknown id", async () => {
    await expect(cancelDuty("missing")).rejects.toBeInstanceOf(NotFoundError);
    expect(await getDuty("missing")).toBeUndefined();
  });

  it("TC-DUT-S08 refuses a duty that is already cancelled and changes nothing", async () => {
    const cancelled = { ...lastPm, cancelled: true };
    await seedDuty(cancelled);
    await expect(cancelDuty(lastPm.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await getDuty(lastPm.id)).toEqual(cancelled);
  });

  it("TC-DUT-S09 returns no storage keys", async () => {
    await seedExampleWeek();
    const created = await createDuty(input);
    const cancelled = await cancelDuty(lastPm.id);
    const listed = await listDuties({ ...range, includeCancelled: true }, "coordinator");
    for (const d of [...listed, created, cancelled]) {
      expect(Object.keys(d).sort()).toEqual(DUTY_FIELDS);
    }
  });
});
