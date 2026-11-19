import { afterEach, describe, expect, it } from "vitest";
import {
  clearSubscriptions,
  publish,
  subscribe,
  type EventName,
  type LeaveApprovedPayload,
} from "../../src/shared/events.js";

const payload: LeaveApprovedPayload = {
  leaveId: "leave-chen-li-2026-12-07",
  doctorId: "chen.li",
  startDate: "2026-12-07",
  endDate: "2026-12-09",
  approvedBy: "coord1",
  at: "2026-11-18T09:00:00.000Z",
};

afterEach(() => {
  clearSubscriptions();
});

describe("DomainEvents", () => {
  it("awaits subscribers in registration order and reports each one", async () => {
    const calls: string[] = [];
    subscribe(
      "leave.approved",
      async (p) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push(`first:${p.leaveId}`);
      },
      "first",
    );
    subscribe("leave.approved", () => void calls.push("second"), "second");
    const results = await publish("leave.approved", payload);
    expect(calls).toEqual(["first:leave-chen-li-2026-12-07", "second"]);
    expect(results).toEqual([
      { subscriber: "first", ok: true },
      { subscriber: "second", ok: true },
    ]);
  });

  it("reports a failing subscriber without rethrowing, and still runs the next one", async () => {
    let laterRan = false;
    subscribe(
      "leave.approved",
      () => {
        throw new Error("roster regenerate failed");
      },
      "roster",
    );
    subscribe(
      "leave.approved",
      () => {
        laterRan = true;
      },
      "audit",
    );
    const results = await publish("leave.approved", payload);
    expect(results).toEqual([
      { subscriber: "roster", ok: false, message: "roster regenerate failed" },
      { subscriber: "audit", ok: true },
    ]);
    expect(laterRan).toBe(true);
  });

  it("returns an empty list when nobody subscribes", async () => {
    expect(await publish("leave.approved", payload)).toEqual([]);
  });

  it("unsubscribes, and refuses an unknown event name", async () => {
    const unsubscribe = subscribe("leave.approved", () => undefined, "once");
    unsubscribe();
    expect(await publish("leave.approved", payload)).toEqual([]);
    expect(() => subscribe("leave.rejected" as EventName, () => undefined)).toThrow(
      /Unknown event/,
    );
  });
});
