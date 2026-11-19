// @vitest-environment jsdom
// Rules tab tests (u5-rules, web/features/rules.js; US1.10, BR4.1-BR4.4, AC1.10.1-AC1.10.3,
// NFR2.6) with a fake api and the shell's real page events (createEvents from web/app.js).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, EVENTS, createEvents } from "../../web/app.js";
import { mount } from "../../web/features/rules.js";

type RuleRow = {
  id: string;
  type: string;
  strength: "hard" | "soft";
  enabled: boolean;
  settings: Record<string, unknown>;
  description: string;
};

const exampleRows = (): RuleRow[] => [
  {
    id: "rule-1-rest-after-call",
    type: "rest_after_call",
    strength: "hard",
    enabled: true,
    settings: {},
    description: "No AM duty the morning after a CALL",
  },
  {
    id: "rule-2-residents-on-xr",
    type: "modality_assignment",
    strength: "soft",
    enabled: true,
    settings: { who: { grade: "resident" }, modalities: ["XR"], mode: "preferOn" },
    description: "Prefer residents on XR",
  },
  {
    id: "rule-3-one-call-per-week",
    type: "duty_limit",
    strength: "hard",
    enabled: false,
    settings: { dutyType: "CALL", max: 1, per: "week" },
    description: "At most 1 CALL per doctor per week",
  },
];

/** A fake shell api over a list of rules; `failWith` makes switch calls throw. */
function fakeApi(rows: RuleRow[], failWith?: ApiError) {
  return vi.fn(async (path: string, { method = "GET" }: { method?: string } = {}) => {
    if (method === "GET" && path === "/rules") return structuredClone(rows);
    const match = /^\/rules\/([^/]+)\/(enable|disable)$/.exec(path);
    if (method === "POST" && match) {
      if (failWith) throw failWith;
      const rule = rows.find((r) => r.id === decodeURIComponent(match[1]))!;
      rule.enabled = match[2] === "enable";
      return structuredClone(rule);
    }
    throw new ApiError(404, "not_found", `No route for ${method} ${path}`);
  });
}

const coordinator = { id: "coord1", role: "coordinator" };
let root: HTMLElement;
let events: ReturnType<typeof createEvents>;

const byTestId = (id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const toggleOf = (ruleId: string) => byTestId(`rule-toggle-${ruleId}`) as HTMLInputElement;

/** Lets the pending api promise and its follow-up settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("section");
  root.id = "rules";
  document.body.append(root);
  // A fresh target per test, so no listener of an earlier mount hears this test's events.
  // (createEvents' parameter type is inferred from its `globalThis` default.)
  events = createEvents(new EventTarget() as unknown as typeof globalThis);
});

describe("the Rules tab", () => {
  it("lists every rule with its switch, type, strength and description (AC1.10.1)", async () => {
    const api = fakeApi(exampleRows());
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    expect(api).toHaveBeenCalledWith("/rules");
    expect(byTestId("rules-heading")?.textContent).toBe("Rules (3)");
    const rows = [...root.querySelectorAll("li")];
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      "rule-row-rule-1-rest-after-call",
      "rule-row-rule-2-residents-on-xr",
      "rule-row-rule-3-one-call-per-week",
    ]);
    expect(rows[0].textContent).toBe("Rest after callHARDNo AM duty the morning after a CALL");
    expect(rows[1].textContent).toContain("SOFT");
    expect(rows[2].textContent).toContain("Duty limit");
    expect(toggleOf("rule-1-rest-after-call").checked).toBe(true);
    expect(toggleOf("rule-3-one-call-per-week").checked).toBe(false);
    expect(toggleOf("rule-1-rest-after-call").closest("label")).not.toBeNull();
    expect(byTestId("rules-note")?.textContent).toBe("Changes apply at the next Generate");
  });

  it("shows 'No rules yet' when there are none", async () => {
    await mount(root, { user: coordinator, api: fakeApi([]), events, weekStart: "2026-12-07" });
    expect(byTestId("rules-heading")?.textContent).toBe("Rules (0)");
    expect(byTestId("rules-empty")?.textContent).toBe("No rules yet");
  });

  it("switches 'rest after call' off, then Generate fires roster:regenerate with the week (AC1.10.2)", async () => {
    const rows = exampleRows();
    const api = fakeApi(rows);
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    const fired: unknown[] = [];
    events.on(EVENTS.REGENERATE, (detail: unknown) => fired.push(detail));

    const toggle = toggleOf("rule-1-rest-after-call");
    toggle.click();
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    await settle();
    expect(api).toHaveBeenCalledWith("/rules/rule-1-rest-after-call/disable", { method: "POST" });
    expect(toggle.disabled).toBe(false);
    expect(rows[0].enabled).toBe(false);

    events.emit(EVENTS.WEEK_CHANGED, { weekStart: "2026-12-14" });
    byTestId("rules-generate")!.click();
    expect(fired).toEqual([{ weekStart: "2026-12-14" }]);
  });

  it("fires the mount week before any week change, and reloads after roster:generated", async () => {
    const rows = exampleRows();
    const api = fakeApi(rows);
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    const fired: unknown[] = [];
    events.on(EVENTS.REGENERATE, (detail: unknown) => fired.push(detail));
    byTestId("rules-generate")!.click();
    expect(fired).toEqual([{ weekStart: "2026-12-07" }]);

    rows.pop();
    events.emit(EVENTS.GENERATED, { weekStart: "2026-12-07" });
    await settle();
    expect(byTestId("rules-heading")?.textContent).toBe("Rules (2)");
  });

  it("puts the switch back and shows the message when the save fails (BR4.3)", async () => {
    const conflict = new ApiError(409, "conflict", "Contradicts rule-4-modality-assignment");
    const api = fakeApi(exampleRows(), conflict);
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    const toggle = toggleOf("rule-3-one-call-per-week");
    toggle.click();
    expect(toggle.checked).toBe(true);
    await settle();
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(byTestId("rules-message")?.textContent).toBe("Contradicts rule-4-modality-assignment");
  });

  it("shows the error and an empty list when the rules cannot be loaded", async () => {
    const api = vi.fn(async () => {
      throw new ApiError(500, "internal", "Internal server error");
    });
    await mount(root, { user: coordinator, api, events, weekStart: "2026-12-07" });
    expect(byTestId("rules-heading")?.textContent).toBe("Rules (0)");
    expect(byTestId("rules-message")?.textContent).toBe(
      "The rules could not be loaded: Internal server error",
    );
  });

  it("draws nothing and calls nothing for a doctor (AC1.10.3)", async () => {
    const api = fakeApi(exampleRows());
    await mount(root, {
      user: { id: "ben.ochieng", role: "doctor" },
      api,
      events,
      weekStart: "2026-12-07",
    });
    expect(root.childElementCount).toBe(0);
    expect(api).not.toHaveBeenCalled();
  });

  it("shows rule text containing <script> as text, never as markup (NFR2.6)", async () => {
    const rows = exampleRows();
    rows[1].description = "Prefer <script>alert(1)</script> on XR";
    await mount(root, { user: coordinator, api: fakeApi(rows), events, weekStart: "2026-12-07" });
    expect(root.querySelector("script")).toBeNull();
    expect(byTestId("rule-row-rule-2-residents-on-xr")?.textContent).toContain(
      "<script>alert(1)</script>",
    );
  });
});
