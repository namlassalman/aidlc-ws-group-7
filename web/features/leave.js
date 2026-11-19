/**
 * Leave module (owned by the leave Unit, u4-leave). Empty until the leave Unit fills it in.
 *
 * The shell (web/app.js) calls mount(rootElement, { user, api, events, weekStart }) once after
 * sign-in, for every signed-in user, with rootElement = #leave (a full-width section below the
 * roster). Doctors: a leave request form (date range, optional reason) and "My leave" with
 * Cancel for pending requests. Coordinators: the pending requests with Approve and Reject.
 * Call only the existing /api/leave routes through context.api; the server checks every role.
 * Write text with textContent only (no innerHTML, no inline styles: the page CSP blocks them);
 * use the classes styled under #leave in web/styles.css.
 */
export function mount(_rootElement, _context) {
  // The leave Unit fills this in.
}
