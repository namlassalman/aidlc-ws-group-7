/**
 * Roster page shell (walking skeleton; contracts C10 and BR7). Plain ES module, no build step.
 *
 * On page load:
 * 1. Loads config.json (written at deploy: authDomain, clientId, redirectUri, logoutUri).
 * 2. Signs in with Cognito managed login, authorization code flow with PKCE (crypto.subtle).
 *    The access token is kept in memory only; the PKCE verifier, state and the ?week= to return
 *    to are kept in sessionStorage until the code is exchanged.
 * 3. Calls GET /api/me, shows "Signed in: <id> (<Role>)", then mounts
 *    web/features/roster.js into #roster for everyone and web/features/rules.js into #rules
 *    (the Rules tab) for coordinators only.
 * 4. On a 401 it signs in again once per page load and returns to the same week; a second
 *    failure shows an error instead of looping. A 403 shows "Your account has no roster role".
 *
 * window.RosterApp = { api, events, user, weekStart, showError, announce }
 *   api(path, { method, body }) -> parsed JSON (null for 204), or throws ApiError
 *     { status, error, message }. `path` is below /api ("/me") or the full "/api/me".
 *   events: EVENTS names plus emit(name, detail) and on(name, handler) -> off(); CustomEvents
 *     on window: roster:week-changed {weekStart}, roster:regenerate {weekStart},
 *     roster:generated {weekStart}.
 * Feature modules export mount(rootElement, { user, api, events, weekStart }).
 * Everything is written to the page with textContent only (never innerHTML).
 */

export const EVENTS = Object.freeze({
  WEEK_CHANGED: "roster:week-changed",
  REGENERATE: "roster:regenerate",
  GENERATED: "roster:generated",
});

const PKCE_KEY = "roster.pkce";
const ATTEMPT_KEY = "roster.signInAttempt";
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for test/web/app.test.ts)
// ---------------------------------------------------------------------------------------------

/** Base64url without padding (RFC 7636). */
export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLength = 32, cryptoImpl = globalThis.crypto) {
  return base64UrlEncode(cryptoImpl.getRandomValues(new Uint8Array(byteLength)));
}

/** The S256 code challenge for a PKCE verifier. */
export async function pkceChallenge(verifier, cryptoImpl = globalThis.crypto) {
  const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** A new PKCE verifier (43 characters) and its S256 challenge. */
export async function createPkcePair(cryptoImpl = globalThis.crypto) {
  const verifier = randomString(32, cryptoImpl);
  return { verifier, challenge: await pkceChallenge(verifier, cryptoImpl) };
}

function parseDate(date) {
  const match = DATE_PATTERN.exec(date ?? "");
  if (!match) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : undefined;
}

/** The Monday of the week (Monday to Sunday) a "YYYY-MM-DD" date falls in. */
export function mondayOf(date) {
  const ms = parseDate(date);
  if (ms === undefined) throw new Error(`Invalid date "${date}"`);
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return new Date(ms - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

export function addWeeks(monday, weeks) {
  return new Date(parseDate(monday) + weeks * 7 * DAY_MS).toISOString().slice(0, 10);
}

/** Today's local date as "YYYY-MM-DD". */
export function todayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The week to show: the Monday of ?week=<date> when it is a valid date, else this week. */
export function weekFromSearch(search, now = new Date()) {
  const week = new URLSearchParams(search).get("week");
  return parseDate(week) === undefined ? mondayOf(todayIso(now)) : mondayOf(week);
}

/** Which page modules to load for a user: roster for everyone, rules for coordinators only. */
export function featuresToMount(user) {
  const features = [{ name: "roster", src: "./features/roster.js", target: "roster" }];
  if (user?.role === "coordinator") {
    features.push({ name: "rules", src: "./features/rules.js", target: "rules" });
  }
  return features;
}

export function authorizeUrl(config, { challenge, state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid profile",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });
  return `${config.authDomain}/oauth2/authorize?${params}`;
}

export function tokenRequestBody(config, code, verifier) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
}

export class ApiError extends Error {
  constructor(status, error, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.error = error;
  }
}

/** The shell API client. `onUnauthorized` runs on a 401 before the ApiError is thrown. */
export function createApi({ getToken, onUnauthorized = () => {}, fetchImpl = globalThis.fetch }) {
  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown }} [options]
   */
  return async function api(path, { method = "GET", body } = {}) {
    const url =
      path === "/api" || path.startsWith("/api/")
        ? path
        : `/api${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = { Accept: "application/json" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) onUnauthorized();
      const code = data?.error ?? (response.status === 401 ? "unauthorized" : "internal");
      throw new ApiError(
        response.status,
        code,
        data?.message ?? `Request failed (${response.status})`,
      );
    }
    return data;
  };
}

/** Page events as CustomEvents on `target` (window). */
export function createEvents(target = globalThis) {
  return Object.freeze({
    ...EVENTS,
    emit(name, detail) {
      target.dispatchEvent(new CustomEvent(name, { detail }));
    },
    on(name, handler) {
      const listener = (event) => handler(event.detail, event);
      target.addEventListener(name, listener);
      return () => target.removeEventListener(name, listener);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The shell (runs only on the real page: <body data-roster-shell>)
// ---------------------------------------------------------------------------------------------

const byId = (id) => document.getElementById(id);

export function showError(message) {
  byId("error-message").textContent = message;
  byId("error-banner").hidden = false;
}

function hideError() {
  byId("error-banner").hidden = true;
  byId("error-message").textContent = "";
}

export function announce(message) {
  byId("status").textContent = message;
}

async function loadConfig() {
  const response = await fetch("config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`config.json: ${response.status}`);
  const config = await response.json();
  for (const key of ["authDomain", "clientId", "redirectUri"]) {
    if (typeof config[key] !== "string" || config[key] === "")
      throw new Error(`config.json: ${key} missing`);
  }
  return config;
}

/** Redirects to managed login, at most once per page load without a successful sign-in. */
async function signIn(config, weekStart) {
  if (sessionStorage.getItem(ATTEMPT_KEY) === "1") {
    sessionStorage.removeItem(ATTEMPT_KEY);
    showError("Sign-in did not work. Reload the page to try again.");
    return;
  }
  sessionStorage.setItem(ATTEMPT_KEY, "1");
  const { verifier, challenge } = await createPkcePair();
  const state = randomString(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, weekStart }));
  location.assign(authorizeUrl(config, { challenge, state }));
}

/** Exchanges ?code= for an access token. Returns { token, weekStart }. */
async function exchangeCode(config, params) {
  const stored = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? "null");
  sessionStorage.removeItem(PKCE_KEY);
  if (!stored || stored.state !== params.get("state")) {
    throw new Error(
      "Sign-in failed: the sign-in response does not match this page. Reload to try again.",
    );
  }
  const response = await fetch(`${config.authDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody(config, params.get("code"), stored.verifier),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== "string") {
    throw new Error(`Sign-in failed: ${data.error ?? response.status}`);
  }
  return { token: data.access_token, weekStart: stored.weekStart };
}

function setWeek(weekStart) {
  byId("week-label").textContent = `Week of Mon ${weekStart}`;
  document.title = `Radiology Roster - week of ${weekStart}`;
  history.replaceState(null, "", `${location.pathname}?week=${weekStart}`);
}

function wireTabs() {
  const tablist = byId("panel-tabs");
  const tabs = () => [...tablist.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const other of tabs()) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      const panel = byId(other.getAttribute("aria-controls"));
      if (panel) panel.hidden = !selected;
    }
    tab.focus();
  };
  tablist.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) select(tab);
  });
  tablist.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const all = tabs();
    const index = all.indexOf(document.activeElement);
    if (index < 0) return;
    const step = event.key === "ArrowRight" ? 1 : -1;
    select(all[(index + step + all.length) % all.length]);
    event.preventDefault();
  });
}

async function mountFeatures(user, context) {
  if (user.role !== "coordinator") byId("panel").remove();
  else byId("panel").hidden = false;
  for (const feature of featuresToMount(user)) {
    try {
      const module = await import(feature.src);
      await module.mount(byId(feature.target), context);
    } catch (error) {
      showError(`The ${feature.name} part of the page failed to load: ${error.message}`);
    }
  }
}

async function boot() {
  byId("error-dismiss").addEventListener("click", hideError);
  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    showError(`The page could not load its settings. ${error.message}`);
    return;
  }
  const params = new URLSearchParams(location.search);
  let token = null;
  let weekStart = weekFromSearch(location.search);
  if (params.has("error")) {
    sessionStorage.removeItem(ATTEMPT_KEY);
    showError(`Sign-in failed: ${params.get("error_description") ?? params.get("error")}`);
    return;
  }
  if (params.has("code")) {
    try {
      const result = await exchangeCode(config, params);
      token = result.token;
      if (result.weekStart) weekStart = mondayOf(result.weekStart);
    } catch (error) {
      sessionStorage.removeItem(ATTEMPT_KEY);
      showError(error.message);
      return;
    }
  }
  setWeek(weekStart);
  if (!token) return signIn(config, weekStart);

  const api = createApi({ getToken: () => token, onUnauthorized: () => signIn(config, weekStart) });
  let user;
  try {
    user = await api("/me");
  } catch (error) {
    if (error.status === 403) showError("Your account has no roster role. Ask the coordinator.");
    else if (error.status !== 401) showError(`Sign-in check failed: ${error.message}`);
    return;
  }
  sessionStorage.removeItem(ATTEMPT_KEY);
  const roleName = user.role === "coordinator" ? "Coordinator" : "Doctor";
  byId("signed-in").textContent = `Signed in: ${user.id} (${roleName})`;
  const signOut = byId("sign-out");
  signOut.hidden = false;
  signOut.addEventListener("click", () => {
    token = null;
    const logoutParams = new URLSearchParams({
      client_id: config.clientId,
      logout_uri: config.logoutUri ?? config.redirectUri,
    });
    location.assign(`${config.authDomain}/logout?${logoutParams}`);
  });

  const events = createEvents(window);
  const app = { api, events, user, weekStart, showError, announce };
  window.RosterApp = app;
  const changeWeek = (weeks) => {
    app.weekStart = addWeeks(app.weekStart, weeks);
    setWeek(app.weekStart);
    events.emit(EVENTS.WEEK_CHANGED, { weekStart: app.weekStart });
  };
  byId("prev-week").addEventListener("click", () => changeWeek(-1));
  byId("next-week").addEventListener("click", () => changeWeek(1));
  wireTabs();
  await mountFeatures(user, { user, api, events, weekStart });
  events.emit(EVENTS.WEEK_CHANGED, { weekStart: app.weekStart });
}

if (typeof document !== "undefined" && document.body?.hasAttribute("data-roster-shell")) {
  boot().catch((error) => showError(`The page failed to start: ${error.message}`));
}
