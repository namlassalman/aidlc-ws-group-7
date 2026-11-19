/**
 * Rules panel module (owned by the rules Unit, u5-rules; US1.10, functional-spec W8).
 *
 * The shell (web/app.js) calls mount(rootElement, { user, api, events, weekStart }) once after
 * sign-in, for coordinators only, with rootElement = #rules (the Rules tab panel).
 *
 * - BR4.1: draws nothing unless context.user.role is "coordinator" (read from the mount context,
 *   never a global).
 * - BR4.2: loads GET /api/rules and shows a "Rules (N)" heading, then one row per rule in id
 *   order: a labelled checkbox (data-testid "rule-toggle-<id>"), the type name, HARD or SOFT and
 *   the plain description the API sends; "No rules yet" when there are none. Reloads after each
 *   roster:generated.
 * - BR4.3: a toggle calls .../enable or .../disable at once, with the checkbox disabled while it
 *   saves; on an error the checkbox goes back and the message is shown.
 * - BR4.4: "Generate with these rules" emits events.REGENERATE ("roster:regenerate") with the
 *   week last received in roster:week-changed (at first: weekStart). It never calls the roster API.
 *
 * Every element is built with createElement and every text set with textContent (NFR2.6).
 * mount returns a promise that settles once the first list is drawn.
 */

const TYPE_NAMES = Object.freeze({
  modality_assignment: "Modality assignment",
  duty_limit: "Duty limit",
  rest_after_call: "Rest after call",
  weekly_hours: "Weekly hours",
  consultant_cover: "Consultant cover",
  fair_share: "Fair share",
});

function element(tag, { text, testId, className } = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (testId) node.dataset.testid = testId;
  if (className) node.className = className;
  return node;
}

function messageOf(error) {
  return error && typeof error.message === "string" && error.message !== ""
    ? error.message
    : "Something went wrong";
}

export function mount(rootElement, context) {
  const { user, api, events, weekStart } = context ?? {};
  if (!rootElement || user?.role !== "coordinator") return Promise.resolve();

  let currentWeek = weekStart;
  const heading = element("h2", { text: "Rules", testId: "rules-heading" });
  const list = element("ul", { testId: "rules-list", className: "rules-list" });
  const message = element("p", { testId: "rules-message", className: "rules-message" });
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const note = element("p", { text: "Changes apply at the next Generate", testId: "rules-note" });
  const generate = element("button", {
    text: "Generate with these rules",
    testId: "rules-generate",
  });
  generate.type = "button";

  const showMessage = (text) => {
    message.textContent = text;
    globalThis.RosterApp?.showError?.(text);
  };

  async function toggle(rule, checkbox) {
    const wanted = checkbox.checked;
    checkbox.disabled = true;
    message.textContent = "";
    try {
      const action = wanted ? "enable" : "disable";
      const saved = await api(`/rules/${encodeURIComponent(rule.id)}/${action}`, {
        method: "POST",
      });
      rule.enabled = saved?.enabled ?? wanted;
      checkbox.checked = rule.enabled;
    } catch (error) {
      checkbox.checked = !wanted;
      showMessage(messageOf(error));
    } finally {
      checkbox.disabled = false;
    }
  }

  function ruleRow(rule) {
    const row = element("li", { testId: `rule-row-${rule.id}`, className: "rules-row" });
    const label = element("label");
    const checkbox = element("input", { testId: `rule-toggle-${rule.id}` });
    checkbox.type = "checkbox";
    checkbox.checked = rule.enabled === true;
    checkbox.addEventListener("change", () => toggle(rule, checkbox));
    const typeName = TYPE_NAMES[rule.type] ?? String(rule.type);
    label.append(
      checkbox,
      element("span", { text: typeName, className: "rules-type" }),
      element("span", {
        text: rule.strength === "hard" ? "HARD" : "SOFT",
        className: "rules-strength",
      }),
      element("span", { text: rule.description ?? "", className: "rules-description" }),
    );
    row.append(label);
    return row;
  }

  function draw(rules) {
    heading.textContent = `Rules (${rules.length})`;
    list.replaceChildren(...rules.map(ruleRow));
    if (rules.length === 0)
      list.append(element("li", { text: "No rules yet", testId: "rules-empty" }));
  }

  async function load() {
    try {
      const rules = await api("/rules");
      draw(Array.isArray(rules) ? rules : []);
    } catch (error) {
      draw([]);
      showMessage(`The rules could not be loaded: ${messageOf(error)}`);
    }
  }

  generate.addEventListener("click", () => {
    events.emit(events.REGENERATE, { weekStart: currentWeek });
  });
  events.on(events.WEEK_CHANGED, (detail) => {
    if (detail?.weekStart) currentWeek = detail.weekStart;
  });
  events.on(events.GENERATED, () => {
    load();
  });

  rootElement.replaceChildren(heading, message, list, note, generate);
  return load();
}
