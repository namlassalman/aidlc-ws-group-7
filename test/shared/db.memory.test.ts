import { describe, expect, it, vi } from "vitest";
import { getItem, putItem, query, resetMemoryTables } from "../../src/shared/db.js";
import { runDbContract } from "./db.contract.js";

runDbContract("memory");

describe("in-memory mode", () => {
  it("returns copies, so changing a returned item does not change the table", async () => {
    await putItem("t", { pk: "A", sk: "1", list: [1] });
    const item = await getItem<{ pk: string; sk: string; list: number[] }>("t", {
      pk: "A",
      sk: "1",
    });
    item!.list.push(2);
    expect(await getItem("t", { pk: "A", sk: "1" })).toMatchObject({ list: [1] });
    const [row] = await query<{ pk: string; sk: string; list: number[] }>("t", { pk: "A" });
    row.list.push(3);
    expect(await getItem("t", { pk: "A", sk: "1" })).toMatchObject({ list: [1] });
  });

  it("resetMemoryTables empties every table", async () => {
    await putItem("t", { pk: "A", sk: "1" });
    resetMemoryTables();
    expect(await query("t", { pk: "A" })).toEqual([]);
  });

  it("logs a warning for an item over 300 KB", async () => {
    process.env.LOG_LEVEL = "warn";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await putItem("t", { pk: "A", sk: "big", blob: "x".repeat(310 * 1024) });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
        level: "warn",
        msg: "large item",
        table: "t",
      });
    } finally {
      warn.mockRestore();
      process.env.LOG_LEVEL = "silent";
    }
  });
});
