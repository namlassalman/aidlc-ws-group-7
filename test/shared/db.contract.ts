// The table-helper contract (NFR4.2): one suite, run against the in-memory mode
// (db.memory.test.ts) and the DynamoDB mode with aws-sdk-client-mock (db.dynamo.test.ts).
import { describe, expect, it } from "vitest";
import { deleteItem, getItem, putItem, query } from "../../src/shared/db.js";
import { ConflictError } from "../../src/shared/errors.js";
import {
  dutiesBetween,
  dutyItem,
  leaveItem,
  type Duty,
  type LeaveRequest,
} from "../../src/shared/tables.js";

const TABLE = "contract-table";

function duty(id: string, date: string, type: Duty["type"]): Duty {
  return {
    id,
    date,
    type,
    modality: "XR",
    doctorsNeeded: 1,
    needsConsultant: false,
    cancelled: false,
  };
}

function leave(
  id: string,
  doctorId: string,
  startDate: string,
  status: LeaveRequest["status"],
): LeaveRequest {
  return {
    id,
    doctorId,
    startDate,
    endDate: startDate,
    reason: null,
    status,
    createdAt: "2026-11-18T00:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
  };
}

export function runDbContract(mode: string): void {
  describe(`table helpers contract (${mode})`, () => {
    it("puts and gets an item; a missing item is undefined", async () => {
      await putItem(TABLE, { pk: "DOCTOR", sk: "asha.rao", name: "Asha Rao" });
      expect(await getItem(TABLE, { pk: "DOCTOR", sk: "asha.rao" })).toEqual({
        pk: "DOCTOR",
        sk: "asha.rao",
        name: "Asha Rao",
      });
      expect(await getItem(TABLE, { pk: "DOCTOR", sk: "nobody" })).toBeUndefined();
    });

    it("overwrites on a plain put", async () => {
      await putItem(TABLE, { pk: "RULE", sk: "r1", enabled: true });
      await putItem(TABLE, { pk: "RULE", sk: "r1", enabled: false });
      expect(await getItem(TABLE, { pk: "RULE", sk: "r1" })).toMatchObject({ enabled: false });
    });

    it("refuses an existing key with ifNotExists and keeps the first item", async () => {
      await putItem(TABLE, { pk: "DOCTOR", sk: "d1", name: "First" }, { ifNotExists: true });
      await expect(
        putItem(TABLE, { pk: "DOCTOR", sk: "d1", name: "Second" }, { ifNotExists: true }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await getItem(TABLE, { pk: "DOCTOR", sk: "d1" })).toMatchObject({ name: "First" });
    });

    it("deletes an item, and deleting a missing item is not an error", async () => {
      await putItem(TABLE, { pk: "DUTY", sk: "x" });
      await deleteItem(TABLE, { pk: "DUTY", sk: "x" });
      expect(await getItem(TABLE, { pk: "DUTY", sk: "x" })).toBeUndefined();
      await expect(deleteItem(TABLE, { pk: "DUTY", sk: "x" })).resolves.toBeUndefined();
    });

    it("queries a partition ordered by sort key, with begins-with and between", async () => {
      for (const sk of ["2026-12-09", "2026-12-07", "2026-12-08", "2027-01-04"]) {
        await putItem(TABLE, { pk: "published", sk });
      }
      await putItem(TABLE, { pk: "draft", sk: "2026-12-07" });
      const all = await query(TABLE, { pk: "published" });
      expect(all.map((i) => i.sk)).toEqual([
        "2026-12-07",
        "2026-12-08",
        "2026-12-09",
        "2027-01-04",
      ]);
      const december = await query(TABLE, { pk: "published", skBeginsWith: "2026-12" });
      expect(december).toHaveLength(3);
      const range = await query(TABLE, {
        pk: "published",
        skBetween: ["2026-12-08", "2026-12-09"],
      });
      expect(range.map((i) => i.sk)).toEqual(["2026-12-08", "2026-12-09"]);
      expect(await query(TABLE, { pk: "nothing" })).toEqual([]);
    });

    it("queries an index: duties by date range in start order, leave by status", async () => {
      await putItem(TABLE, dutyItem(duty("b", "2026-12-07", "CALL")));
      await putItem(TABLE, dutyItem(duty("a", "2026-12-07", "AM")));
      await putItem(TABLE, dutyItem(duty("c", "2026-12-08", "PM")));
      await putItem(TABLE, dutyItem(duty("d", "2026-12-14", "AM")));
      const week = await query(TABLE, dutiesBetween("2026-12-07", "2026-12-13"));
      expect(week.map((i) => i.id)).toEqual(["a", "b", "c"]);

      await putItem(TABLE, leaveItem(leave("l1", "chen.li", "2026-12-07", "approved")));
      await putItem(TABLE, leaveItem(leave("l2", "ben.ochieng", "2026-12-01", "pending")));
      const approved = await query(TABLE, { index: "byStatus", pk: "approved" });
      expect(approved.map((i) => i.id)).toEqual(["l1"]);
      const bens = await query(TABLE, { index: "byDoctor", pk: "ben.ochieng" });
      expect(bens.map((i) => i.id)).toEqual(["l2"]);
    });

    it("rejects an item or key without pk and sk", async () => {
      await expect(putItem(TABLE, { pk: "DOCTOR" })).rejects.toThrow(/pk and sk/);
      await expect(getItem(TABLE, { pk: "", sk: "x" })).rejects.toThrow(/pk and sk/);
      await expect(query(TABLE, { pk: "" })).rejects.toThrow(/pk must be/);
    });
  });
}
