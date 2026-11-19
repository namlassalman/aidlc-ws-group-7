// @vitest-environment jsdom
// Leave section tests (u4-leave, web/features/leave.js; leave-form FR1.1-FR4.4, NFR1-NFR4) with a
// fake api and the shell's real page events (createEvents from web/app.js).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, EVENTS, createEvents } from "../../web/app.js";
import { mount } from "../../web/features/leave.js";

type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

/** LeaveRequest as the API returns it (api-documentation.md, contract C7). */
type LeaveRow = {
  id: string;
  doctorId: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: LeaveStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
};

type FollowUp = { subscriber: string; ok: boolean; message?: string };

const leave = (
  id: string,
  doctorId: string,
  startDate: string,
  endDate: string,
  status: LeaveStatus,
  reason: string | null = null,
): LeaveRow => ({
  id,
  doctorId,
  startDate,
  endDate,
  reason,
  status,
  createdAt: "2026-11-01T09:00:00.000Z",
  decidedAt: status === "pending" ? null : "2026-11-02T09:00:00.000Z",
  decidedBy: status === "approved" || status === "rejected" ? "coord1" : null,
});

/** Ben's four requests (two share a start date), Chen's approved leave, Dana's pending request. */
const exampleRows = (): LeaveRow[] => [
  leave("leave-ben-3", "ben.ochieng", "2026-12-28", "2026-12-28", "rejected", "Family"),
  leave("leave-chen-li-2026-12-07", "chen.li", "2026-12-07", "2026-12-11", "approved", "Holiday"),
  leave("leave-ben-4", "ben.ochieng", "2026-12-21", "2026-12-21", "cancelled"),
  leave("leave-dana-1", "dana.kim", "2026-12-14", "2026-12-15", "pending", "Course"),
  leave("leave-ben-1", "ben.ochieng", "2026-12-21", "2026-12-22", "pending", "Conference"),
  leave("leave-ben-2", "ben.ochieng", "2026-12-01", "2026-12-03", "approved"),
];

type Failures = Partial<Record<"load" | "create" | "approve" | "reject" | "cancel", ApiError>>;

/** A fake shell api over a list of leave rows; `fail` makes the named call throw. */
function fakeApi(rows: LeaveRow[], fail: Failures = {}, followUps: FollowUp[] = []) {
  return vi.fn(
    async (path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) => {
      if (method === "GET" && path === "/leave") {
        if (fail.load) throw fail.load;
        return structuredClone(rows);
      }
      if (method === "POST" && path === "/leave") {
        if (fail.create) throw fail.create;
        const input = body as { startDate: string; endDate: string; reason?: string };
        const created = leave(
          "leave-new",
          "ben.ochieng",
          input.startDate,
          input.endDate,
          "pending",
        );
        created.reason = input.reason ?? null;
        rows.push(created);
        return structuredClone(created);
      }
      const match = /^\/leave\/([^/]+)\/(approve|reject|cancel)$/.exec(path);
      if (method === "POST" && match) {
        const action = match[2] as "approve" | "reject" | "cancel";
        if (fail[action]) throw fail[action];
        const row = rows.find((r) => r.id === decodeURIComponent(match[1]))!;
        row.status = ({ approve: "approved", reject: "rejected", cancel: "cancelled" } as const)[
          action
        ];
        if (action === "approve") return { leave: structuredClone(row), followUps };
        return structuredClone(row);
      }
      throw new ApiError(404, "not_found", `No route for ${method} ${path}`);
    },
  );
}

const doctor = { id: "ben.ochieng", role: "doctor" };
const coordinator = { id: "coord1", role: "coordinator" };
const globals = globalThis as unknown as { RosterApp?: unknown };

let root: HTMLElement;
let events: ReturnType<typeof createEvents>;
let showError: ReturnType<typeof vi.fn>;

const byTestId = (id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const inputOf = (id: string) => byTestId(id) as HTMLInputElement;
const buttonOf = (id: string) => byTestId(id) as HTMLButtonElement;
const rowIds = (tableId: string) =>
  [...root.querySelectorAll<HTMLElement>(`[data-testid="${tableId}"] tbody tr`)].map(
    (row) => row.dataset.testid,
  );
const message = () => byTestId("leave-message")?.textContent;

/** Lets the pending api promise and its follow-up settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fillForm(startDate: string, endDate: string, reason = "") {
  inputOf("leave-start").value = startDate;
  inputOf("leave-end").value = endDate;
  inputOf("leave-reason").value = reason;
}

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("section");
  root.id = "leave";
  document.body.append(root);
  // A fresh target per test, so no listener of an earlier mount hears this test's events.
  events = createEvents(new EventTarget() as unknown as typeof globalThis);
  showError = vi.fn();
  globals.RosterApp = { weekStart: "2026-12-14", showError };
});

afterEach(() => {
  delete globals.RosterApp;
});

describe("the leave section for a doctor", () => {
  it("shows the form and only the doctor's own requests, every state, by start date then id (FR1.1, FR2.1, FR2.2)", async () => {
    const api = fakeApi(exampleRows());
    await mount(root, { user: doctor, api, events, weekStart: "2026-12-07" });
    expect(api).toHaveBeenCalledWith("/leave");
    expect(inputOf("leave-start").type).toBe("date");
    expect(inputOf("leave-end").type).toBe("date");
    expect(inputOf("leave-reason").maxLength).toBe(200);
    expect(inputOf("leave-start").closest("label")?.textContent).toBe("Start date");
    expect(buttonOf("leave-submit").type).toBe("submit");
    expect(byTestId("leave-message")?.getAttribute("role")).toBe("status");
    expect(rowIds("leave-mine")).toEqual([
      "leave-row-leave-ben-2",
      "leave-row-leave-ben-1",
      "leave-row-leave-ben-4",
      "leave-row-leave-ben-3",
    ]);
    expect(byTestId("leave-row-leave-chen-li-2026-12-07")).toBeNull();
    expect(byTestId("leave-row-leave-dana-1")).toBeNull();
    const pendingRow = byTestId("leave-row-leave-ben-1")!;
    expect(pendingRow.textContent).toBe("2026-12-21 to 2026-12-22ConferencependingCancel");
    expect(pendingRow.classList.contains("leave-pending")).toBe(true);
    expect(byTestId("leave-row-leave-ben-2")?.textContent).toBe("2026-12-01 to 2026-12-03approved");
    expect(byTestId("leave-row-leave-ben-4")?.textContent).toBe("2026-12-21cancelled");
  });

  it("says 'No leave requests yet' when the doctor has none (FR2.4)", async () => {
    const others = exampleRows().filter((row) => row.doctorId !== "ben.ochieng");
    await mount(root, { user: doctor, api: fakeApi(others), events, weekStart: "2026-12-07" });
    expect(rowIds("leave-mine")).toEqual([undefined]);
    expect(byTestId("leave-empty")?.textContent).toBe("No leave requests yet");
  });

  it("sends a valid request, adds the pending row and clears the form (FR1.3)", async () => {
    const api = fakeApi(exampleRows());
    await mount(root, { user: doctor, api, events, weekStart: "2026-12-07" });
    fillForm("2026-12-08", "2026-12-09", "  Exam  ");
    buttonOf("leave-submit").click();
    await settle();
    expect(api).toHaveBeenCalledWith("/leave", {
      method: "POST",
      body: { startDate: "2026-12-08", endDate: "2026-12-09", reason: "Exam" },
    });
    expect(rowIds("leave-mine")[1]).toBe("leave-row-leave-new");
    expect(byTestId("leave-row-leave-new")?.textContent).toBe(
      "2026-12-08 to 2026-12-09ExampendingCancel",
    );
    expect(inputOf("leave-start").value).toBe("");
    expect(inputOf("leave-end").value).toBe("");
    expect(inputOf("leave-reason").value).toBe("");
    expect(message()).toBe("Leave requested: 2026-12-08 to 2026-12-09");
  });

  it("does not send an empty reason", async () => {
    const api = fakeApi([]);
    await mount(root, { user: doctor, api, events, weekStart: "2026-12-07" });
    fillForm("2026-12-08", "2026-12-08", "   ");
    buttonOf("leave-submit").click();
    await settle();
    expect(api).toHaveBeenLastCalledWith("/leave", {
      method: "POST",
      body: { startDate: "2026-12-08", endDate: "2026-12-08" },
    });
  });

  it("refuses a start date after the end date and calls nothing (FR1.2)", async () => {
    const api = fakeApi(exampleRows());
    await mount(root, { user: doctor, api, events, weekStart: "2026-12-07" });
    api.mockClear();
    fillForm("2026-12-10", "2026-12-09");
    buttonOf("leave-submit").click();
    await settle();
    expect(api).not.toHaveBeenCalled();
    expect(message()).toBe("The start date must be on or before the end date");
    expect(showError).toHaveBeenCalledWith("The start date must be on or before the end date");
  });

  it("refuses a 201-character reason or a missing date and calls nothing (FR1.2)", async () => {
    const api = fakeApi(exampleRows());
    await mount(root, { user: doctor, api, events, weekStart: "2026-12-07" });
    api.mockClear();
    fillForm("2026-12-08", "2026-12-09", "x".repeat(201));
    buttonOf("leave-submit").click();
    await settle();
    expect(message()).toBe("The reason can be at most 200 characters");
    fillForm("2026-12-08", "");
    buttonOf("leave-submit").click();
    await settle();
    expect(message()).toBe("Enter a start date and an end date");
    expect(api).not.toHaveBeenCalled();
  });

  it("shows the server's 409 overlap message and keeps the typed values (FR1.4)", async () => {
    const overlap = new ApiError(
      409,
      "conflict",
      "overlaps pending leave leave-ben-1 (2026-12-21 to 2026-12-22)",
    );
    const api = fakeApi(exampleRows(), { create: overlap });
    await mount(root, { user: doctor, api, events, weekStart: "2026-12-07" });
    fillForm("2026-12-22", "2026-12-23", "Trip");
    buttonOf("leave-submit").click();
    await settle();
    expect(message()).toBe("overlaps pending leave leave-ben-1 (2026-12-21 to 2026-12-22)");
    expect(showError).toHaveBeenCalledWith(
      "overlaps pending leave leave-ben-1 (2026-12-21 to 2026-12-22)",
    );
    expect(inputOf("leave-start").value).toBe("2026-12-22");
    expect(inputOf("leave-end").value).toBe("2026-12-23");
    expect(inputOf("leave-reason").value).toBe("Trip");
    expect(rowIds("leave-mine")).toHaveLength(4);
    expect(buttonOf("leave-submit").disabled).toBe(false);
  });

  it("cancels a pending request; only pending rows have Cancel (FR2.3)", async () => {
    const api = fakeApi(exampleRows());
    await mount(root, { user: doctor, api, events, weekStart: "2026-12-07" });
    expect(byTestId("leave-cancel-leave-ben-2")).toBeNull();
    expect(byTestId("leave-cancel-leave-ben-3")).toBeNull();
    expect(byTestId("leave-cancel-leave-ben-4")).toBeNull();
    buttonOf("leave-cancel-leave-ben-1").click();
    await settle();
    expect(api).toHaveBeenCalledWith("/leave/leave-ben-1/cancel", { method: "POST" });
    const row = byTestId("leave-row-leave-ben-1")!;
    expect(row.textContent).toBe("2026-12-21 to 2026-12-22Conferencecancelled");
    expect(row.classList.contains("leave-pending")).toBe(false);
    expect(byTestId("leave-cancel-leave-ben-1")).toBeNull();
  });

  it("keeps the row as it was and shows the message when a cancel fails (FR2.3, FR4.2)", async () => {
    const decided = new ApiError(409, "conflict", "Leave request leave-ben-1 is already approved");
    const api = fakeApi(exampleRows(), { cancel: decided });
    await mount(root, { user: doctor, api, events, weekStart: "2026-12-07" });
    buttonOf("leave-cancel-leave-ben-1").click();
    await settle();
    expect(message()).toBe("Leave request leave-ben-1 is already approved");
    expect(showError).toHaveBeenCalledWith("Leave request leave-ben-1 is already approved");
    expect(byTestId("leave-row-leave-ben-1")?.textContent).toContain("pending");
    expect(buttonOf("leave-cancel-leave-ben-1").disabled).toBe(false);
  });
});

describe("the leave section for a coordinator", () => {
  it("lists every doctor's pending requests only, with Approve and Reject, and no form (FR3.1, FR3.5)", async () => {
    const api = fakeApi(exampleRows());
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    expect(api).toHaveBeenCalledWith("/leave");
    expect(byTestId("leave-heading")?.textContent).toBe("Pending leave requests");
    expect(rowIds("leave-pending-list")).toEqual([
      "leave-row-leave-dana-1",
      "leave-row-leave-ben-1",
    ]);
    expect(byTestId("leave-row-leave-dana-1")?.textContent).toBe(
      "dana.kim2026-12-14 to 2026-12-15CourseApproveReject",
    );
    expect(byTestId("leave-approve-leave-ben-1")).not.toBeNull();
    expect(byTestId("leave-reject-leave-ben-1")).not.toBeNull();
    expect(byTestId("leave-form")).toBeNull();
    expect(byTestId("leave-mine")).toBeNull();
  });

  it("says 'No pending leave requests' when there are none (FR3.6)", async () => {
    const decided = exampleRows().filter((row) => row.status !== "pending");
    await mount(root, {
      user: coordinator,
      api: fakeApi(decided),
      events,
      weekStart: "2026-12-07",
    });
    expect(byTestId("leave-empty")?.textContent).toBe("No pending leave requests");
  });

  it("approves a request, removes the row and fires roster:week-changed with the current week (FR3.2, FR3.3)", async () => {
    const api = fakeApi(exampleRows(), {}, [{ subscriber: "roster", ok: true }]);
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    const fired: unknown[] = [];
    events.on(EVENTS.WEEK_CHANGED, (detail: unknown) => fired.push(detail));
    buttonOf("leave-approve-leave-dana-1").click();
    await settle();
    expect(api).toHaveBeenCalledWith("/leave/leave-dana-1/approve", { method: "POST" });
    expect(rowIds("leave-pending-list")).toEqual(["leave-row-leave-ben-1"]);
    expect(fired).toEqual([{ weekStart: "2026-12-14" }]);
    expect(message()).toBe("Approved leave for dana.kim: 2026-12-14 to 2026-12-15");
    expect(showError).not.toHaveBeenCalled();
  });

  it("falls back to the mount week when the shell has no current week (FR3.3)", async () => {
    delete globals.RosterApp;
    const api = fakeApi(exampleRows());
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    const fired: unknown[] = [];
    events.on(EVENTS.WEEK_CHANGED, (detail: unknown) => fired.push(detail));
    buttonOf("leave-approve-leave-ben-1").click();
    await settle();
    expect(fired).toEqual([{ weekStart: "2026-12-07" }]);
  });

  it("warns when the approval's roster follow-up failed (FR3.4)", async () => {
    const followUps = [
      { subscriber: "roster", ok: false, message: "Roster for 2026-12-14 locked" },
    ];
    const api = fakeApi(exampleRows(), {}, followUps);
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    buttonOf("leave-approve-leave-dana-1").click();
    await settle();
    expect(rowIds("leave-pending-list")).toEqual(["leave-row-leave-ben-1"]);
    expect(message()).toBe(
      "Approved, but the roster could not be updated: Roster for 2026-12-14 locked",
    );
    expect(showError).toHaveBeenCalledWith(
      "Approved, but the roster could not be updated: Roster for 2026-12-14 locked",
    );
  });

  it("rejects without firing an event; a 409 on approve keeps the row and shows the message (FR3.2)", async () => {
    const decided = new ApiError(409, "conflict", "Leave request leave-ben-1 is already cancelled");
    const api = fakeApi(exampleRows(), { approve: decided });
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    const fired: unknown[] = [];
    events.on(EVENTS.WEEK_CHANGED, (detail: unknown) => fired.push(detail));

    buttonOf("leave-reject-leave-dana-1").click();
    await settle();
    expect(api).toHaveBeenCalledWith("/leave/leave-dana-1/reject", { method: "POST" });
    expect(rowIds("leave-pending-list")).toEqual(["leave-row-leave-ben-1"]);

    buttonOf("leave-approve-leave-ben-1").click();
    await settle();
    expect(rowIds("leave-pending-list")).toEqual(["leave-row-leave-ben-1"]);
    expect(message()).toBe("Leave request leave-ben-1 is already cancelled");
    expect(buttonOf("leave-approve-leave-ben-1").disabled).toBe(false);
    expect(fired).toEqual([]);
  });
});

describe("the leave section for both roles", () => {
  it("disables the button while its call is in flight and enables it after (FR4.1)", async () => {
    let finish: (value: unknown) => void = () => {};
    const api = vi.fn(async (path: string, { method = "GET" }: { method?: string } = {}) => {
      if (method === "GET") return exampleRows();
      if (path.endsWith("/approve")) throw new ApiError(409, "conflict", "Already decided");
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await mount(root, { user: doctor, api, events, weekStart: "2026-12-07" });
    fillForm("2026-12-08", "2026-12-09");
    buttonOf("leave-submit").click();
    expect(buttonOf("leave-submit").disabled).toBe(true);
    finish(leave("leave-new", "ben.ochieng", "2026-12-08", "2026-12-09", "pending"));
    await settle();
    expect(buttonOf("leave-submit").disabled).toBe(false);

    root.replaceChildren();
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    const approve = buttonOf("leave-approve-leave-ben-1");
    approve.click();
    expect(approve.disabled).toBe(true);
    await settle();
    expect(approve.disabled).toBe(false);
  });

  it("shows the error and an empty list when the first load fails (FR4.2)", async () => {
    const api = fakeApi(exampleRows(), {
      load: new ApiError(500, "internal", "Internal server error"),
    });
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    expect(message()).toBe("Leave could not be loaded: Internal server error");
    expect(showError).toHaveBeenCalledWith("Leave could not be loaded: Internal server error");
    expect(byTestId("leave-empty")?.textContent).toBe("No pending leave requests");
  });

  it("draws nothing and calls nothing with no role or no root (FR4.3)", async () => {
    const api = fakeApi(exampleRows());
    await mount(root, { user: { id: "x", role: "visitor" }, api, events, weekStart: "2026-12-07" });
    await mount(null, { user: doctor, api, events, weekStart: "2026-12-07" });
    expect(root.childElementCount).toBe(0);
    expect(api).not.toHaveBeenCalled();
  });

  it("shows a reason containing <script> as text, never as markup (NFR1)", async () => {
    const rows = exampleRows();
    rows.find((row) => row.id === "leave-ben-1")!.reason = "Away <script>alert(1)</script>";
    await mount(root, { user: doctor, api: fakeApi(rows), events, weekStart: "2026-12-07" });
    expect(root.querySelector("script")).toBeNull();
    expect(byTestId("leave-row-leave-ben-1")?.textContent).toContain("<script>alert(1)</script>");
  });

  it("escapes the request id in the path (NFR1)", async () => {
    const rows = [leave("leave/odd id", "dana.kim", "2026-12-14", "2026-12-14", "pending")];
    const api = fakeApi(rows);
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    buttonOf("leave-reject-leave/odd id").click();
    await settle();
    expect(api).toHaveBeenCalledWith("/leave/leave%2Fodd%20id/reject", { method: "POST" });
  });
});
