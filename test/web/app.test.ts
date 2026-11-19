// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  EVENTS,
  authorizeUrl,
  createApi,
  createEvents,
  createPkcePair,
  featuresToMount,
  mondayOf,
  pkceChallenge,
  weekFromSearch,
} from "../../web/app.js";

const cryptoImpl = webcrypto as unknown as Crypto;

describe("PKCE", () => {
  it("gives the RFC 7636 S256 challenge for its example verifier", async () => {
    const challenge = await pkceChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      cryptoImpl,
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates a fresh 43-character base64url verifier with its matching challenge", async () => {
    const first = await createPkcePair(cryptoImpl);
    const second = await createPkcePair(cryptoImpl);
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).toBe(await pkceChallenge(first.verifier, cryptoImpl));
  });

  it("builds the managed login authorize URL with S256 and the state", () => {
    const config = {
      authDomain: "https://roster-123456789012.auth.us-west-2.amazoncognito.com",
      clientId: "client123",
      redirectUri: "https://d111.cloudfront.net/",
    };
    const url = new URL(authorizeUrl(config, { challenge: "abc", state: "xyz" }));
    expect(url.origin + url.pathname).toBe(`${config.authDomain}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client123",
      redirect_uri: config.redirectUri,
      code_challenge_method: "S256",
      code_challenge: "abc",
      state: "xyz",
    });
  });
});

describe("?week= parsing", () => {
  const now = new Date(2026, 11, 10, 12, 0); // Thursday 2026-12-10, local time

  it("snaps ?week= to the Monday of its week", () => {
    expect(weekFromSearch("?week=2026-12-07", now)).toBe("2026-12-07");
    expect(weekFromSearch("?week=2026-12-13", now)).toBe("2026-12-07");
    expect(weekFromSearch("?week=2027-01-01", now)).toBe("2026-12-28");
  });

  it("falls back to this week for a missing or invalid ?week=", () => {
    expect(weekFromSearch("", now)).toBe("2026-12-07");
    expect(weekFromSearch("?week=2026-02-30", now)).toBe("2026-12-07");
    expect(weekFromSearch("?week=<script>", now)).toBe("2026-12-07");
  });

  it("refuses an invalid date in mondayOf", () => {
    expect(() => mondayOf("2026-13-01")).toThrow(/Invalid date/);
  });
});

describe("mount decision", () => {
  it("loads leave.js for every role and rules.js only for a coordinator", () => {
    expect(featuresToMount({ id: "coord1", role: "coordinator" }).map((f) => f.name)).toEqual([
      "roster",
      "leave",
      "rules",
    ]);
    expect(featuresToMount({ id: "ben.ochieng", role: "doctor" }).map((f) => f.name)).toEqual([
      "roster",
      "leave",
    ]);
  });

  it("loads only the roster without a signed-in role", () => {
    expect(featuresToMount(undefined).map((f) => f.name)).toEqual(["roster"]);
    expect(featuresToMount({ id: "x", role: "visitor" }).map((f) => f.name)).toEqual(["roster"]);
  });

  it("mounts each feature into its own element", () => {
    expect(featuresToMount({ id: "coord1", role: "coordinator" })).toEqual([
      { name: "roster", src: "./features/roster.js", target: "roster" },
      { name: "leave", src: "./features/leave.js", target: "leave" },
      { name: "rules", src: "./features/rules.js", target: "rules" },
    ]);
  });

  it("has a #leave element outside the coordinator panel, so doctors keep it", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const html = await readFile(join(process.cwd(), "web", "index.html"), "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const leave = doc.getElementById("leave");
    expect(leave).not.toBeNull();
    expect(leave?.closest("#panel")).toBeNull();
  });

  it("loads a leave module that exports mount", async () => {
    const leave = await import("../../web/features/leave.js");
    expect(typeof leave.mount).toBe("function");
  });
});

describe("API client and page events", () => {
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("sends the Bearer token and JSON body below /api", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { ok: true }));
    const api = createApi({ getToken: () => "token-1", fetchImpl });
    expect(await api("/doctors", { method: "POST", body: { id: "x" } })).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/doctors");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token-1",
      "Content-Type": "application/json",
    });
    expect(init.body).toBe('{"id":"x"}');
  });

  it("throws {status, error, message} and calls onUnauthorized on a 401", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse(401, { message: "Unauthorized" }));
    const api = createApi({ getToken: () => null, onUnauthorized, fetchImpl });
    const failure = await api("/api/me").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 401, error: "unauthorized", message: "Unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("passes the ErrorBody of a 409 through without signing in again", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: "conflict", message: "no draft", details: [] }),
    );
    const api = createApi({ getToken: () => "t", onUnauthorized, fetchImpl });
    await expect(api("/roster/publish", { method: "POST", body: {} })).rejects.toMatchObject({
      status: 409,
      error: "conflict",
      message: "no draft",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("fires the C10 events as CustomEvents on window", () => {
    const events = createEvents(window);
    const seen: unknown[] = [];
    const off = events.on(EVENTS.WEEK_CHANGED, (detail: unknown) => seen.push(detail));
    events.emit(EVENTS.WEEK_CHANGED, { weekStart: "2026-12-07" });
    off();
    events.emit(EVENTS.WEEK_CHANGED, { weekStart: "2026-12-14" });
    expect(seen).toEqual([{ weekStart: "2026-12-07" }]);
    expect(EVENTS).toEqual({
      WEEK_CHANGED: "roster:week-changed",
      REGENERATE: "roster:regenerate",
      GENERATED: "roster:generated",
    });
  });
});
