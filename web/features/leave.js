/**
 * Leave module (owned by the leave Unit, u4-leave; leave-form requirements FR1.1-FR4.4, NFR1-NFR4).
 *
 * The shell (web/app.js) calls mount(rootElement, { user, api, events, weekStart }) once after
 * sign-in, for every signed-in user, with rootElement = #leave (a full-width section below the
 * roster). Doctors: a leave request form (date range, optional reason) and "My leave" with
 * Cancel for pending requests. Coordinators: the pending requests with Approve and Reject.
 * Call only the existing /api/leave routes through context.api; the server checks every role.
 * Write text with textContent only (no innerHTML, no inline styles: the page CSP blocks them);
 * use the classes styled under #leave in web/styles.css.
 *
 * - FR1.1-FR1.4: the doctor's form (labelled start and end dates, a reason of at most 200
 *   characters). It is checked before sending (both dates, start not after end, reason length)
 *   and sends POST /leave with { startDate, endDate, reason? }. On success the new row joins
 *   "My leave" and the form clears; on a refusal the server's message shows and the typed values
 *   stay.
 * - FR2.1-FR2.4: "My leave" lists the doctor's own requests only (doctorId === user.id), every
 *   state and every date, ordered by start date then id. Pending rows carry the leave-pending
 *   class and a Cancel button (POST /leave/{id}/cancel). With none: "No leave requests yet".
 * - FR3.1-FR3.6: the coordinator sees every pending request, ordered by start date then id, with
 *   Approve and Reject (POST /leave/{id}/approve|reject), and no form. After an approval it emits
 *   roster:week-changed with the shell's current week (RosterApp.weekStart, else the mount
 *   week) so the roster grid reloads; a follow-up with ok: false shows a warning.
 * - FR4.1-FR4.4: the button that started a call is disabled until the call ends; every error
 *   shows in the role="status" message and goes to RosterApp.showError; nothing is drawn without
 *   a root or a known role; the list is loaded once, from GET /leave, at mount.
 *
 * mount returns a promise that settles once the first list is drawn.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REASON_MAX = 200;

function element(tag, { text, testId, className } = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (testId) node.dataset.testid = testId;
  if (className) node.className = className;
  return node;
}

function button(text, testId, onClick) {
  const node = element("button", { text, testId });
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function messageOf(error) {
  return error && typeof error.message === "string" && error.message !== ""
    ? error.message
    : "Something went wrong";
}

function isRealDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

/** The problem with a request form's values (FR1.2), or undefined when it can be sent. */
function checkRequest({ startDate, endDate, reason }) {
  if (!startDate || !endDate) return "Enter a start date and an end date";
  if (!isRealDate(startDate) || !isRealDate(endDate)) return "Enter the dates as YYYY-MM-DD";
  if (startDate > endDate) return "The start date must be on or before the end date";
  if (reason.length > REASON_MAX) return `The reason can be at most ${REASON_MAX} characters`;
  return undefined;
}

function byStartThenId(a, b) {
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function datesText(leave) {
  return leave.startDate === leave.endDate
    ? String(leave.startDate)
    : `${leave.startDate} to ${leave.endDate}`;
}

function makeTable(testId, headings) {
  const table = element("table", { testId });
  const headRow = element("tr");
  headRow.append(...headings.map((heading) => element("th", { text: heading })));
  const head = element("thead");
  head.append(headRow);
  const body = element("tbody");
  table.append(head, body);
  return { table, body, columns: headings.length };
}

/** Draws rows into a table body, or one row with `emptyText` when there are none. */
function drawRows({ body, columns }, rows, toRow, emptyText) {
  body.replaceChildren(...rows.map(toRow));
  if (rows.length > 0) return;
  const row = element("tr");
  const cell = element("td", { text: emptyText, testId: "leave-empty" });
  cell.colSpan = columns;
  row.append(cell);
  body.append(row);
}

function cells(row, texts) {
  row.append(...texts.map((text) => element("td", { text: text ?? "" })));
}

async function loadRows(ui) {
  try {
    const rows = await ui.api("/leave");
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    ui.fail(`Leave could not be loaded: ${messageOf(error)}`);
    return [];
  }
}

function labelled(text, input) {
  const label = element("label");
  label.append(element("span", { text }), input);
  return label;
}

function requestForm() {
  const form = element("form", { testId: "leave-form" });
  form.noValidate = true;
  const start = element("input", { testId: "leave-start" });
  start.type = "date";
  start.name = "startDate";
  const end = element("input", { testId: "leave-end" });
  end.type = "date";
  end.name = "endDate";
  const reason = element("input", { testId: "leave-reason" });
  reason.type = "text";
  reason.name = "reason";
  reason.maxLength = REASON_MAX;
  const submit = element("button", { text: "Request", testId: "leave-submit" });
  submit.type = "submit";
  form.append(
    labelled("Start date", start),
    labelled("End date", end),
    labelled("Reason (optional)", reason),
    submit,
  );
  return { form, start, end, reason, submit };
}

function doctorView(ui) {
  let mine = [];
  const fields = requestForm();
  const list = makeTable("leave-mine", ["Dates", "Reason", "Status", "Action"]);
  const draw = () => drawRows(list, mine, myRow, "No leave requests yet");
  const keep = (leave) => {
    mine = [...mine.filter((row) => row.id !== leave.id), leave].sort(byStartThenId);
    draw();
  };

  async function cancel(leave, control) {
    control.disabled = true;
    ui.say("");
    try {
      const path = `/leave/${encodeURIComponent(leave.id)}/cancel`;
      const saved = await ui.api(path, { method: "POST" });
      keep(saved?.id === leave.id ? saved : { ...leave, status: "cancelled" });
      ui.say(`Leave cancelled: ${datesText(leave)}`);
    } catch (error) {
      ui.fail(messageOf(error));
    } finally {
      control.disabled = false;
    }
  }

  function myRow(leave) {
    const row = element("tr", { testId: `leave-row-${leave.id}` });
    cells(row, [datesText(leave), leave.reason, leave.status]);
    const action = element("td");
    if (leave.status === "pending") {
      row.className = "leave-pending";
      const control = button("Cancel", `leave-cancel-${leave.id}`, () => cancel(leave, control));
      action.append(control);
    }
    row.append(action);
    return row;
  }

  async function submit(event) {
    event.preventDefault();
    const values = {
      startDate: fields.start.value,
      endDate: fields.end.value,
      reason: fields.reason.value,
    };
    const problem = checkRequest(values);
    if (problem) return ui.fail(problem);
    const body = { startDate: values.startDate, endDate: values.endDate };
    if (values.reason.trim() !== "") body.reason = values.reason.trim();
    fields.submit.disabled = true;
    ui.say("");
    try {
      const created = await ui.api("/leave", { method: "POST", body });
      if (created?.id) keep(created);
      fields.form.reset();
      ui.say(`Leave requested: ${datesText(body)}`);
    } catch (error) {
      ui.fail(messageOf(error));
    } finally {
      fields.submit.disabled = false;
    }
  }

  fields.form.addEventListener("submit", submit);
  const nodes = [
    element("h2", { text: "Request leave", testId: "leave-heading" }),
    fields.form,
    ui.message,
    element("h3", { text: "My leave", testId: "leave-mine-heading" }),
    list.table,
  ];
  const load = async () => {
    const rows = await loadRows(ui);
    mine = rows.filter((row) => row?.doctorId === ui.user.id).sort(byStartThenId);
    draw();
  };
  return { nodes, load };
}

/** After a successful approval: reload the roster week (FR3.3) and report the follow-ups (FR3.4). */
function afterApproval(ui, leave, result) {
  const week = globalThis.RosterApp?.weekStart ?? ui.weekStart;
  if (week) ui.events?.emit(ui.events.WEEK_CHANGED, { weekStart: week });
  const followUps = Array.isArray(result?.followUps) ? result.followUps : [];
  const failed = followUps.find((followUp) => followUp?.ok === false);
  if (failed) {
    const reason = failed.message || "no reason given";
    ui.fail(`Approved, but the roster could not be updated: ${reason}`);
  } else {
    ui.say(`Approved leave for ${leave.doctorId}: ${datesText(leave)}`);
  }
}

function coordinatorView(ui) {
  let pending = [];
  const list = makeTable("leave-pending-list", ["Doctor", "Dates", "Reason", "Actions"]);
  const draw = () => drawRows(list, pending, pendingRow, "No pending leave requests");

  async function decide(leave, action, controls) {
    for (const control of controls) control.disabled = true;
    ui.say("");
    try {
      const path = `/leave/${encodeURIComponent(leave.id)}/${action}`;
      const result = await ui.api(path, { method: "POST" });
      pending = pending.filter((row) => row.id !== leave.id);
      draw();
      if (action === "approve") afterApproval(ui, leave, result);
      else ui.say(`Rejected leave for ${leave.doctorId}: ${datesText(leave)}`);
    } catch (error) {
      ui.fail(messageOf(error));
    } finally {
      for (const control of controls) control.disabled = false;
    }
  }

  function pendingRow(leave) {
    const row = element("tr", { testId: `leave-row-${leave.id}` });
    cells(row, [leave.doctorId, datesText(leave), leave.reason]);
    const controls = [];
    const approve = button("Approve", `leave-approve-${leave.id}`, () =>
      decide(leave, "approve", controls),
    );
    const reject = button("Reject", `leave-reject-${leave.id}`, () =>
      decide(leave, "reject", controls),
    );
    controls.push(approve, reject);
    const actions = element("td");
    actions.append(approve, reject);
    row.append(actions);
    return row;
  }

  const nodes = [
    element("h2", { text: "Pending leave requests", testId: "leave-heading" }),
    ui.message,
    list.table,
  ];
  const load = async () => {
    const rows = await loadRows(ui);
    pending = rows.filter((row) => row?.status === "pending").sort(byStartThenId);
    draw();
  };
  return { nodes, load };
}

export function mount(rootElement, context) {
  const { user, api, events, weekStart } = context ?? {};
  const role = user?.role;
  if (!rootElement || (role !== "doctor" && role !== "coordinator")) return Promise.resolve();

  const message = element("p", { testId: "leave-message", className: "leave-message" });
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const ui = {
    user,
    api,
    events,
    weekStart,
    message,
    say: (text) => {
      message.textContent = text;
    },
    fail: (text) => {
      message.textContent = text;
      globalThis.RosterApp?.showError?.(text);
    },
  };

  const view = role === "doctor" ? doctorView(ui) : coordinatorView(ui);
  rootElement.replaceChildren(...view.nodes);
  return view.load();
}
