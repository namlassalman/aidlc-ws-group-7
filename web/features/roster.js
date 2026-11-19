/**
 * Roster page module (owned by the roster Unit, u6-roster). Empty in the walking skeleton.
 *
 * The shell (web/app.js) calls mount(rootElement, { user, api, events, weekStart }) once after
 * sign-in, with rootElement = #roster, for every signed-in user. Listen for
 * events.WEEK_CHANGED ("roster:week-changed", detail {weekStart}) to load a week, and
 * events.REGENERATE ("roster:regenerate") from the rules panel; emit events.GENERATED after a
 * generate. Write text with textContent only; scope any styles under #roster.
 */
export function mount(_rootElement, _context) {
  // The roster Unit fills this in: the week grid, Generate, Publish, gaps and coverage.
}
