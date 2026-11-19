// @vitest-environment jsdom
// u6-roster page module (US1.16, US2.6; BR10; NFR2.6) with a fake api and the shell's events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createEvents, EVENTS, showError } from "../../web/app.js";
import { mount, periodOf, rosterStatus } from "../../web/features/roster.js";

const WEEK = "2026-12-07";

type Week = Record<string, unknown> & { weekStart: string; version: string };

const duties = [
  {
    id: "d-2026-12-07-am-ct",
    date: "2026-12-07",
    type: "AM",
    modality: "CT",
    doctorsNeeded: 2,
    needsConsultant: true,
    cancelled: false,
  },
  {
    id: "d-2026-12-08-am-xr",
    date: "2026-12-08",
    type: "AM",
    modality: "XR",
    doctorsNeeded: 1,
    needsConsultant: false,
    cancelled: false,
  },
];

const GAP_REASON =
  "Dr Ben Ochieng is the only XR-trained doctor free; rest after call (hard) blocks Dr Ben Ochieng";
const CUT_OFF = "Generation took longer than 15 seconds; generate fewer weeks";
const suggestion = { doctorId: "ben.ochieng", brokenHardRules: ["rule-1-rest-after-call"] };

function week(version: "draft" | "published", overrides: Partial<Week> = {}): Week {
  return {
    weekStart: WEEK,
    version,
    periodStart: WEEK,
    periodWeeks: 1,
    generatedAt: "2026-12-01T00:00:00.000Z",
    publishedAt: version === "published" ? "2026-12-01T00:00:00.000Z" : null,
    now: "2026-12-01T00:00:00.000Z",
    placements: [
      { dutyId: "d-2026-12-07-am-ct", place: 1, doctorId: "asha.rao", locked: false },
      { dutyId: "d-2026-12-07-am-ct", place: 2, doctorId: "ben.ochieng", locked: false },
    ],
    gaps: [
      {
        dutyId: "d-2026-12-08-am-xr",
        place: 1,
        reason: GAP_REASON,
        suggested: version === "draft" ? suggestion : null,
      },
    ],
    brokenSoftRules: [],
    duties,
    doctors: [
      { id: "asha.rao", name: "Dr Asha Rao" },
      { id: "ben.ochieng", name: "Dr Ben Ochieng" },
    ],
    ...overrides,
  };
}

const coverageReport = {
  weekStart: WEEK,
  version: "draft",
  unfilled: [],
  brokenSoftRules: [],
  lockedClashes: [],
  hours: [{ doctorId: "asha.rao", hours: 5, max: 40 }],
};

type Routes = Record<string, unknown>;

/** A fake shell api: GET answers from `routes` (404 when absent), POST from `posts`. */
function fakeApi(routes: Routes, posts: Record<string, unknown | ApiError> = {}) {
  return vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    if (options.method === "POST") {
      const answer = posts[path];
      if (answer instanceof ApiError) throw answer;
      return answer;
    }
    if (path in routes) {
      const answer = routes[path];
      if (answer instanceof ApiError) throw answer;
      return answer;
    }
    throw new ApiError(404, "not_found", "none");
  });
}

function shellDom() {
  document.body.innerHTML = `
    <div id="error-banner" hidden><p id="error-message"></p></div>
    <div id="status"></div>
    <section id="roster"></section>
    <aside id="panel">
      <div id="panel-tabs" role="tablist">
        <button type="button" role="tab" id="tab-rules" aria-controls="rules" aria-selected="true">Rules</button>
      </div>
      <section id="rules" role="tabpanel"></section>
    </aside>`;
}

const byTestId = (id: string) =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const root = () => document.getElementById("roster") as HTMLElement;

async function mountAs(role: "coordinator" | "doctor", api: ReturnType<typeof fakeApi>) {
  // A fresh target per test, so no earlier mount hears this test's events.
  const events = createEvents(new EventTarget() as unknown as typeof globalThis);
  const user = role === "coordinator" ? { id: "coord1", role } : { id: "ben.ochieng", role };
  const page = mount(root(), { user, api, events, weekStart: WEEK, showError });
  events.emit(EVENTS.WEEK_CHANGED, { weekStart: WEEK });
  await page.settled();
  return { page, events };
}

beforeEach(() => {
  shellDom();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("helpers", () => {
  it("works out the status and the period", () => {
    expect(rosterStatus(null, null)).toBe("none");
    expect(rosterStatus(null, {})).toBe("draft");
    expect(rosterStatus({}, null)).toBe("published");
    expect(rosterStatus({}, {})).toBe("published-newer-draft");
    expect(periodOf({ weekStart: WEEK, periodStart: WEEK, periodWeeks: 2 })).toEqual({
      start: WEEK,
      end: "2026-12-20",
      weeks: 2,
    });
  });
});

describe("coordinator and doctor controls (AC2.1.1, roster part)", () => {
  it("shows the coordinator Generate, Publish, the selector and the two tabs", async () => {
    await mountAs("coordinator", fakeApi({}));
    expect(byTestId("roster-generate-button")).not.toBeNull();
    expect(byTestId("roster-publish-button")).not.toBeNull();
    const select = byTestId("roster-weeks-select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value).join(",")).toBe("1,2,3,4,5,6,7,8");
    expect(select.value).toBe("1");
    expect(byTestId("panel-tab-gaps")).not.toBeNull();
    expect(byTestId("panel-tab-coverage")).not.toBeNull();
    expect((byTestId("roster-publish-button") as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId("roster-message")?.textContent).toBe("No roster yet");
  });

  it("shows a doctor none of them, and 'not published yet' with no draft doctors", async () => {
    const api = fakeApi({});
    await mountAs("doctor", api);
    const coordinatorOnly = [
      "roster-generate-button",
      "roster-publish-button",
      "roster-weeks-select",
      "panel-tab-gaps",
      "panel-tab-coverage",
    ];
    for (const id of coordinatorOnly) {
      expect(byTestId(id)).toBeNull();
    }
    expect(byTestId("roster-message")?.textContent).toContain("not published yet");
    expect(byTestId("roster-grid")).toBeNull();
    expect(api.mock.calls.map(([path]) => path)).toEqual([`/roster/weeks/${WEEK}`]);
  });
});

describe("Generate and Publish (AC1.16.1, AC1.16.2)", () => {
  it("sends weeks from the selector and shows the draft with the gap and its reason", async () => {
    const api = fakeApi({}, { "/roster/generate": [week("draft")] });
    const { page, events } = await mountAs("coordinator", api);
    const generated: unknown[] = [];
    events.on(EVENTS.GENERATED, (detail: unknown) => generated.push(detail));
    (byTestId("roster-weeks-select") as HTMLSelectElement).value = "3";
    byTestId("roster-generate-button")!.click();
    await Promise.resolve(); // queued actions start on the next microtask, before any paint
    expect(byTestId("roster-generate-button")!.textContent).toBe("Generating...");
    expect((byTestId("roster-publish-button") as HTMLButtonElement).disabled).toBe(true);
    await page.settled();

    const post = api.mock.calls.find(([, options]) => options?.method === "POST");
    expect(post?.[1]).toEqual({ method: "POST", body: { weekStart: WEEK, weeks: 3 } });
    const grid = byTestId("roster-grid")!;
    expect(grid.querySelector("caption")?.textContent).toContain("(draft)");
    const unfilled = grid.querySelector('[data-state="unfilled"]')!;
    expect(unfilled.textContent).toContain("[!] UNFILLED");
    expect(unfilled.textContent).toContain("suggested: Dr Ben Ochieng");
    expect(unfilled.textContent).toContain("rest after call (hard) blocks Dr Ben Ochieng");
    expect(byTestId("roster-status")?.textContent).toBe("DRAFT");
    expect(byTestId("panel-tab-gaps")?.textContent).toBe("Gaps (1)");
    expect(generated).toEqual([{ weekStart: WEEK }]);
    expect((byTestId("roster-publish-button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs the same Generate on roster:regenerate", async () => {
    const api = fakeApi({}, { "/roster/generate": [week("draft")] });
    const { page, events } = await mountAs("coordinator", api);
    events.emit(EVENTS.REGENERATE, { weekStart: WEEK });
    await page.settled();
    expect(api.mock.calls.some(([path]) => path === "/roster/generate")).toBe(true);
  });

  it("publishes after confirming and shows PUBLISHED", async () => {
    const api = fakeApi(
      {
        [`/roster/weeks/${WEEK}?version=draft`]: week("draft"),
        [`/roster/weeks/${WEEK}/coverage`]: coverageReport,
      },
      { "/roster/publish": [week("published")] },
    );
    const { page } = await mountAs("coordinator", api);
    byTestId("roster-publish-button")!.click();
    const dialog = byTestId("roster-publish-dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(byTestId("roster-publish-dialog-text")?.textContent).toBe(
      "Publish this draft for 2026-12-07 to 2026-12-13? Duties starting within 12 hours keep their current doctors.",
    );
    expect(api.mock.calls.some(([path]) => path === "/roster/publish")).toBe(false);
    byTestId("roster-publish-confirm-button")!.click();
    await page.settled();

    expect(api.mock.calls.find(([path]) => path === "/roster/publish")?.[1]).toEqual({
      method: "POST",
      body: { weekStart: WEEK, weeks: 1 },
    });
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(byTestId("roster-status")?.textContent).toBe("PUBLISHED");
    expect(byTestId("roster-grid")?.querySelector("caption")?.textContent).toContain("(published)");
    expect((byTestId("roster-publish-button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("errors (AC1.16.3, BR10.6)", () => {
  it("shows the API message and keeps the grid as it was", async () => {
    const api = fakeApi(
      { [`/roster/weeks/${WEEK}?version=draft`]: week("draft") },
      { "/roster/generate": new ApiError(409, "conflict", CUT_OFF) },
    );
    const { page } = await mountAs("coordinator", api);
    const before = byTestId("roster-grid")!.outerHTML;
    byTestId("roster-generate-button")!.click();
    await page.settled();
    expect(document.getElementById("error-banner")!.hidden).toBe(false);
    expect(document.getElementById("error-message")!.textContent).toBe(
      `Generate failed: ${CUT_OFF}`,
    );
    expect(byTestId("roster-grid")!.outerHTML).toBe(before);
    expect((byTestId("roster-generate-button") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the doctor's view (US2.6, BR10.4)", () => {
  it("marks unfilled places with no suggestion, bolds their own places and filters to them", async () => {
    const api = fakeApi({ [`/roster/weeks/${WEEK}`]: week("published") });
    await mountAs("doctor", api);
    const grid = byTestId("roster-grid")!;
    const unfilled = grid.querySelector('[data-state="unfilled"]')!;
    expect(unfilled.textContent).toBe("[!] UNFILLED");
    expect(grid.textContent).not.toContain("suggested");
    const own = [...grid.querySelectorAll("strong")].map((s) => s.textContent);
    expect(own).toEqual(["Dr Ben Ochieng (you)"]);
    expect(byTestId("roster-status")?.textContent).toBe("PUBLISHED");

    const onlyMine = byTestId("roster-only-mine-checkbox") as HTMLInputElement;
    onlyMine.checked = true;
    onlyMine.dispatchEvent(new Event("change"));
    const places = [...byTestId("roster-grid")!.querySelectorAll('[data-testid="roster-place"]')];
    expect(places.map((p) => p.textContent)).toEqual(["Dr Ben Ochieng (you)"]);
  });

  it("shows a name containing <b> as text", async () => {
    const published = week("published", {
      doctors: [
        { id: "asha.rao", name: "<b>Asha</b>" },
        { id: "ben.ochieng", name: "Dr Ben Ochieng" },
      ],
    });
    await mountAs("doctor", fakeApi({ [`/roster/weeks/${WEEK}`]: published }));
    const grid = byTestId("roster-grid")!;
    expect(grid.textContent).toContain("<b>Asha</b>");
    expect(grid.querySelector("b")).toBeNull();
  });
});
