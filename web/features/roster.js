/**
 * Roster page module (owned by the roster Unit, u6-roster): the week grid, the coordinator's
 * Weeks selector, Generate and Publish, and the Gaps and Coverage tabs.
 *
 * The shell (web/app.js) calls mount(rootElement, { user, api, events, weekStart }) once after
 * sign-in, with rootElement = #roster, for every signed-in user, then fires
 * events.WEEK_CHANGED ("roster:week-changed", detail {weekStart}); this module loads a week on
 * that event. events.REGENERATE ("roster:regenerate") from the rules panel runs the same
 * Generate; events.GENERATED is emitted after a generate (contract C10). Errors go to the
 * shell's showError (window.RosterApp, or `showError` in the context) and the grid keeps its
 * last good state.
 *
 * Rules: BR10.1 (status none, draft, published, published-newer-draft), BR10.2 (Generate sends
 * weekStart and the Weeks selector, 1-8, default 1, Q3: C), BR10.3 (Publish confirms in a
 * <dialog> naming the period and the 12-hour lock; disabled with no draft), BR10.4 (days as
 * columns, AM/PM/CALL rows, "[!] UNFILLED", suggestions for the coordinator only, own places
 * bold with "(you)", "Only my duties" for doctors), BR10.5 ("not published yet"), BR10.6 (errors),
 * BR10.7 (Gaps and Coverage tabs added at mount to #panel-tabs and #panel, coordinators only,
 * Functional Design R-03). Contracts: C9 (the API), C10 (page events).
 * Every API string is written with textContent; nothing uses innerHTML (NFR2.6). Every
 * interactive element has a data-testid. Styles, if any, are scoped under #roster.
 */

const EVENT_NAMES = {
  WEEK_CHANGED: "roster:week-changed",
  REGENERATE: "roster:regenerate",
  GENERATED: "roster:generated",
};

const SLOTS = ["AM", "PM", "CALL"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_WEEKS = 8;

const STATUS_TEXT = {
  none: "No roster yet",
  draft: "DRAFT",
  published: "PUBLISHED",
  "published-newer-draft": "PUBLISHED, with a newer DRAFT",
};

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for test/roster/roster-page.test.ts)
// ---------------------------------------------------------------------------------------------

/** The date `days` days after a "YYYY-MM-DD" date. */
export function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** BR10.1: the status of the shown week. */
export function rosterStatus(published, draft) {
  if (published && draft) return "published-newer-draft";
  if (published) return "published";
  if (draft) return "draft";
  return "none";
}

/** The first and last date of a run, for the Publish confirmation. */
export function periodOf(week) {
  const start = week.periodStart ?? week.weekStart;
  const weeks = week.periodWeeks ?? 1;
  return { start, end: addDays(start, 7 * weeks - 1), weeks };
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "text") node.textContent = String(value);
    else if (key === "testid") node.setAttribute("data-testid", value);
    else if (key === "className") node.className = value;
    else if (key === "hidden" || key === "disabled" || key === "checked") {
      node[key] = Boolean(value);
    } else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

async function fetchOptional(api, path) {
  try {
    return await api(path);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

const dutyLabel = (duty) => `${duty.date} ${duty.type} ${duty.modality}`;

// ---------------------------------------------------------------------------------------------
// The week grid (BR10.4)
// ---------------------------------------------------------------------------------------------

function placeItem(week, duty, place, ctx) {
  const placement = week.placements.find((p) => p.dutyId === duty.id && p.place === place);
  const item = el("li", { testid: "roster-place", "data-duty-id": duty.id, "data-place": place });
  if (placement) {
    const name = ctx.nameOf(placement.doctorId);
    const mine = placement.doctorId === ctx.user?.id;
    if (ctx.onlyMine && !mine) return null;
    item.setAttribute("data-state", "filled");
    item.append(mine ? el("strong", { text: `${name} (you)` }) : document.createTextNode(name));
    if (placement.locked) {
      item.append(el("span", { className: "roster-locked", text: " (locked)" }));
    }
    return item;
  }
  if (ctx.onlyMine) return null;
  item.setAttribute("data-state", "unfilled");
  item.append(el("span", { className: "roster-unfilled", text: "[!] UNFILLED" }));
  if (ctx.isCoordinator) {
    const gap = week.gaps.find((g) => g.dutyId === duty.id && g.place === place);
    const suggestion = gap?.suggested
      ? ` suggested: ${ctx.nameOf(gap.suggested.doctorId)}`
      : " no suggestion";
    item.append(el("span", { className: "roster-suggestion", text: suggestion }));
    if (gap?.reason) {
      item.append(el("span", { className: "roster-reason", text: ` (${gap.reason})` }));
    }
  }
  return item;
}

function dutyItem(week, duty, ctx) {
  const places = new Set(Array.from({ length: duty.doctorsNeeded }, (_, i) => i + 1));
  for (const p of week.placements) if (p.dutyId === duty.id) places.add(p.place);
  const items = [...places]
    .sort((a, b) => a - b)
    .map((place) => placeItem(week, duty, place, ctx))
    .filter(Boolean);
  if (items.length === 0) return null;
  return el("li", { testid: "roster-duty", "data-duty-id": duty.id }, [
    el("span", { className: "roster-modality", text: duty.modality }),
    el("ul", {}, items),
  ]);
}

function cellFor(week, date, slot, ctx) {
  const duties = (week.duties ?? [])
    .filter((d) => d.date === date && d.type === slot)
    .sort((a, b) => (a.modality < b.modality ? -1 : a.modality > b.modality ? 1 : 0));
  const items = duties.map((duty) => dutyItem(week, duty, ctx)).filter(Boolean);
  return el("td", {}, items.length ? [el("ul", {}, items)] : []);
}

function buildGrid(week, ctx) {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(week.weekStart, i));
  const head = el("tr", {}, [
    el("th", { scope: "col", text: "" }),
    ...dates.map((date, i) => el("th", { scope: "col", text: `${DAY_NAMES[i]} ${date.slice(5)}` })),
  ]);
  const rows = SLOTS.map((slot) =>
    el("tr", {}, [
      el("th", { scope: "row", text: slot }),
      ...dates.map((date) => cellFor(week, date, slot, ctx)),
    ]),
  );
  return el("table", { testid: "roster-grid", className: "roster-grid" }, [
    el("caption", { text: `Roster for week of Mon ${week.weekStart} (${week.version})` }),
    el("thead", {}, [head]),
    el("tbody", {}, rows),
  ]);
}

// ---------------------------------------------------------------------------------------------
// The coordinator's side panel tabs (BR10.7)
// ---------------------------------------------------------------------------------------------

function addPanelTabs() {
  const tablist = document.getElementById("panel-tabs");
  const panel = document.getElementById("panel");
  if (!tablist || !panel) return null;
  const tab = (id, panelId, text) =>
    el("button", {
      type: "button",
      role: "tab",
      id,
      "aria-controls": panelId,
      "aria-selected": "false",
      tabindex: "-1",
      testid: `panel-${id}`,
      text,
    });
  const tabPanel = (id, tabId) =>
    el("section", {
      id,
      role: "tabpanel",
      "aria-labelledby": tabId,
      hidden: true,
      testid: `${id}-panel`,
    });
  const tabs = {
    gapsTab: tab("tab-gaps", "roster-gaps", "Gaps"),
    coverageTab: tab("tab-coverage", "roster-coverage", "Coverage"),
    gapsPanel: tabPanel("roster-gaps", "tab-gaps"),
    coveragePanel: tabPanel("roster-coverage", "tab-coverage"),
    chosen: false,
  };
  tablist.prepend(tabs.gapsTab, tabs.coverageTab);
  panel.append(tabs.gapsPanel, tabs.coveragePanel);
  tabs.select = (selected) => {
    for (const other of tablist.querySelectorAll('[role="tab"]')) {
      const isSelected = other === selected;
      other.setAttribute("aria-selected", String(isSelected));
      other.tabIndex = isSelected ? 0 : -1;
      const controlled = document.getElementById(other.getAttribute("aria-controls"));
      if (controlled) controlled.hidden = !isSelected;
    }
  };
  return tabs;
}

function renderGaps(tabs, week, ctx) {
  const gaps = week?.gaps ?? [];
  tabs.gapsTab.textContent = `Gaps (${gaps.length})`;
  if (gaps.length === 0) {
    tabs.gapsPanel.replaceChildren(el("p", { text: "No unfilled places." }));
    return;
  }
  const dutyById = new Map((week.duties ?? []).map((d) => [d.id, d]));
  const items = gaps.map((gap) => {
    const duty = dutyById.get(gap.dutyId);
    const where = duty ? dutyLabel(duty) : gap.dutyId;
    const suggestion = gap.suggested
      ? `suggested: ${ctx.nameOf(gap.suggested.doctorId)}, breaking ${gap.suggested.brokenHardRules.join(", ")}`
      : "no suggestion";
    return el("li", { testid: "roster-gap" }, [
      el("strong", { text: `${where}, place ${gap.place}` }),
      el("p", { text: gap.reason }),
      el("p", { text: suggestion }),
    ]);
  });
  tabs.gapsPanel.replaceChildren(el("ul", {}, items));
}

function listSection(title, entries) {
  const body = entries.length
    ? el(
        "ul",
        {},
        entries.map((text) => el("li", { text })),
      )
    : el("p", { text: "None." });
  return el("div", {}, [el("h3", { text: title }), body]);
}

function renderCoverage(tabs, report, week, ctx) {
  if (!report) {
    tabs.coveragePanel.replaceChildren(el("p", { text: "No roster yet for this week." }));
    return;
  }
  const dutyById = new Map((week?.duties ?? []).map((d) => [d.id, d]));
  const where = (id) => (dutyById.has(id) ? dutyLabel(dutyById.get(id)) : id);
  const hours = el("table", { testid: "roster-coverage-hours" }, [
    el("thead", {}, [
      el(
        "tr",
        {},
        ["Doctor", "Hours", "Max"].map((h) => el("th", { scope: "col", text: h })),
      ),
    ]),
    el(
      "tbody",
      {},
      report.hours.map((h) =>
        el("tr", {}, [
          el("td", { text: ctx.nameOf(h.doctorId) }),
          el("td", { text: h.hours }),
          el("td", { text: h.max ?? "-" }),
        ]),
      ),
    ),
  ]);
  tabs.coveragePanel.replaceChildren(
    el("p", {
      text: `From the ${report.version} roster. Unfilled places: ${report.unfilled.length}.`,
    }),
    listSection(
      "Broken soft rules",
      report.brokenSoftRules.map(
        (s) => `${where(s.dutyId)}: ${ctx.nameOf(s.doctorId)}, ${s.ruleId}`,
      ),
    ),
    listSection(
      "Clashes on locked duties",
      report.lockedClashes.map((c) => `${where(c.dutyId)}, place ${c.place}: ${c.reason}`),
    ),
    el("div", {}, [el("h3", { text: "Hours this week" }), hours]),
  );
}

// ---------------------------------------------------------------------------------------------
// Toolbar and layout
// ---------------------------------------------------------------------------------------------

function buildToolbar(isCoordinator) {
  const status = el("p", { testid: "roster-status", className: "roster-status", tabindex: "-1" });
  if (!isCoordinator) {
    const onlyMine = el("input", {
      type: "checkbox",
      id: "roster-only-mine",
      testid: "roster-only-mine-checkbox",
    });
    const label = el("label", { for: "roster-only-mine", text: " Only my duties" });
    const root = el("div", { className: "roster-toolbar", testid: "roster-toolbar" }, [
      status,
      onlyMine,
      label,
    ]);
    return { root, status, onlyMine };
  }
  const weeksSelect = el(
    "select",
    { id: "roster-weeks", testid: "roster-weeks-select" },
    Array.from({ length: MAX_WEEKS }, (_, i) =>
      el("option", { value: i + 1, text: String(i + 1) }),
    ),
  );
  weeksSelect.value = "1";
  const generate = el("button", {
    type: "button",
    testid: "roster-generate-button",
    text: "Generate",
  });
  const publish = el("button", {
    type: "button",
    testid: "roster-publish-button",
    text: "Publish",
  });
  const root = el("div", { className: "roster-toolbar", testid: "roster-toolbar" }, [
    el("label", { for: "roster-weeks", text: "Weeks " }),
    weeksSelect,
    generate,
    publish,
    status,
  ]);
  return { root, status, weeksSelect, generate, publish };
}

function buildDialog() {
  const text = el("p", { id: "roster-publish-text", testid: "roster-publish-dialog-text" });
  const confirm = el("button", {
    type: "button",
    testid: "roster-publish-confirm-button",
    text: "Publish",
  });
  const cancel = el("button", {
    type: "button",
    testid: "roster-publish-cancel-button",
    text: "Cancel",
  });
  const dialog = el(
    "dialog",
    {
      testid: "roster-publish-dialog",
      "aria-modal": "true",
      "aria-labelledby": "roster-publish-text",
    },
    [text, el("div", {}, [confirm, cancel])],
  );
  const open = () => {
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
        return;
      } catch {
        // jsdom and older browsers: fall back to the open attribute.
      }
    }
    dialog.setAttribute("open", "");
  };
  const close = () => {
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    dialog.removeAttribute("open");
  };
  return { dialog, text, confirm, cancel, open, close };
}

// ---------------------------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------------------------

export function mount(rootElement, context) {
  const { user, api } = context;
  const events = context.events;
  const names = { ...EVENT_NAMES, ...(events ?? {}) };
  const isCoordinator = user?.role === "coordinator";
  const showError =
    context.showError ??
    globalThis.RosterApp?.showError ??
    ((message) => {
      fallbackError.textContent = message;
      fallbackError.hidden = false;
    });
  const announce = context.announce ?? globalThis.RosterApp?.announce ?? (() => {});

  const state = {
    weekStart: context.weekStart,
    published: null,
    draft: null,
    coverage: null,
    busy: null,
    onlyMine: false,
  };
  const toolbar = buildToolbar(isCoordinator);
  const dialog = isCoordinator ? buildDialog() : null;
  const message = el("p", { testid: "roster-message", className: "roster-message" });
  const gridHolder = el("div", { testid: "roster-grid-holder" });
  const fallbackError = el("p", { role: "alert", testid: "roster-error", hidden: true });
  rootElement.replaceChildren(
    ...[toolbar.root, dialog?.dialog, fallbackError, message, gridHolder].filter(Boolean),
  );
  const tabs = isCoordinator ? addPanelTabs() : null;

  const shownWeek = () => (isCoordinator ? (state.draft ?? state.published) : state.published);
  const nameOf = (id) => {
    for (const week of [state.draft, state.published]) {
      const found = week?.doctors?.find((d) => d.id === id);
      if (found) return found.name;
    }
    return id;
  };

  function updateToolbar() {
    const status = rosterStatus(state.published, state.draft);
    toolbar.status.textContent = isCoordinator
      ? STATUS_TEXT[status]
      : state.published
        ? STATUS_TEXT.published
        : "";
    if (!isCoordinator) return;
    toolbar.generate.disabled = state.busy !== null;
    toolbar.publish.disabled = state.busy !== null || !state.draft;
    toolbar.publish.title = state.draft ? "" : "Generate a draft first";
    toolbar.generate.textContent = state.busy === "generate" ? "Generating..." : "Generate";
    toolbar.publish.textContent = state.busy === "publish" ? "Publishing..." : "Publish";
  }

  function render() {
    updateToolbar();
    const week = shownWeek();
    const ctx = { user, isCoordinator, onlyMine: state.onlyMine, nameOf };
    if (week) {
      message.textContent = "";
      gridHolder.replaceChildren(buildGrid(week, ctx));
    } else {
      message.textContent = isCoordinator ? "No roster yet" : "This week is not published yet.";
      gridHolder.replaceChildren();
    }
    if (tabs) {
      renderGaps(tabs, week, ctx);
      renderCoverage(tabs, state.coverage, week, ctx);
      if (!tabs.chosen) {
        tabs.chosen = true;
        tabs.select((week?.gaps?.length ?? 0) > 0 ? tabs.gapsTab : tabs.coverageTab);
      }
    }
  }

  async function loadCoverage(weekStart) {
    if (!isCoordinator) return null;
    return fetchOptional(api, `/roster/weeks/${encodeURIComponent(weekStart)}/coverage`);
  }

  async function load(weekStart) {
    state.weekStart = weekStart;
    const path = `/roster/weeks/${encodeURIComponent(weekStart)}`;
    try {
      const published = await fetchOptional(api, path);
      const draft = isCoordinator ? await fetchOptional(api, `${path}?version=draft`) : null;
      const coverage = published || draft ? await loadCoverage(weekStart) : null;
      Object.assign(state, { published, draft, coverage });
      render();
    } catch (error) {
      showError(`The roster could not be loaded: ${error.message}`);
    }
  }

  async function refreshCoverage() {
    try {
      state.coverage = await loadCoverage(state.weekStart);
    } catch (error) {
      showError(`The coverage report could not be loaded: ${error.message}`);
    }
  }

  function setBusy(action) {
    state.busy = action;
    updateToolbar();
  }

  async function generate() {
    if (!isCoordinator || state.busy) return;
    const weeks = Number(toolbar.weeksSelect.value) || 1;
    setBusy("generate");
    try {
      const result = await api("/roster/generate", {
        method: "POST",
        body: { weekStart: state.weekStart, weeks },
      });
      state.draft = result.find((w) => w.weekStart === state.weekStart) ?? result[0] ?? null;
      await refreshCoverage();
      state.busy = null;
      render();
      events?.emit(names.GENERATED, { weekStart: state.weekStart });
      const gaps = state.draft?.gaps?.length ?? 0;
      announce(`Draft generated: ${gaps} unfilled place${gaps === 1 ? "" : "s"}`);
      toolbar.status.focus?.();
    } catch (error) {
      showError(`Generate failed: ${error.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    const draft = state.draft;
    if (!isCoordinator || state.busy || !draft) return;
    const period = periodOf(draft);
    setBusy("publish");
    try {
      const result = await api("/roster/publish", {
        method: "POST",
        body: { weekStart: period.start, weeks: period.weeks },
      });
      state.published = result.find((w) => w.weekStart === state.weekStart) ?? state.published;
      state.draft = null;
      await refreshCoverage();
      state.busy = null;
      render();
      announce("Roster published");
    } catch (error) {
      showError(`Publish failed: ${error.message}`);
    } finally {
      setBusy(null);
    }
  }

  let pending = Promise.resolve();
  const queue = (task) => {
    pending = pending.then(task);
    return pending;
  };

  if (isCoordinator) {
    toolbar.generate.addEventListener("click", () => queue(generate));
    toolbar.publish.addEventListener("click", () => {
      if (!state.draft) return;
      const period = periodOf(state.draft);
      dialog.text.textContent = `Publish this draft for ${period.start} to ${period.end}? Duties starting within 12 hours keep their current doctors.`;
      dialog.open();
      dialog.confirm.focus?.();
    });
    dialog.confirm.addEventListener("click", () => {
      dialog.close();
      toolbar.publish.focus?.();
      queue(publish);
    });
    dialog.cancel.addEventListener("click", () => {
      dialog.close();
      toolbar.publish.focus?.();
    });
  } else {
    toolbar.onlyMine.addEventListener("change", () => {
      state.onlyMine = toolbar.onlyMine.checked;
      render();
    });
  }

  events?.on(names.WEEK_CHANGED, (detail) =>
    queue(() => load(detail?.weekStart ?? state.weekStart)),
  );
  events?.on(names.REGENERATE, () => queue(generate));
  updateToolbar();

  return {
    /** Resolves when every queued load, generate and publish has finished. */
    settled: () => pending,
    load: (weekStart) => queue(() => load(weekStart ?? state.weekStart)),
  };
}
