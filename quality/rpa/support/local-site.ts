// Local mode: serves the real page from web/ and stands in for the two things that only exist on
// AWS. Nothing in web/ is changed.
//
// 1. Cognito managed login. The page redirects to <authDomain>/oauth2/authorize and later posts
//    the code to <authDomain>/oauth2/token. Here the authorize step redirects straight back with
//    the user's id as the code, and the token step returns a fake access token naming the user.
// 2. API Gateway's JWT check. /api/* calls are forwarded to the local API server (npm start),
//    with the fake token turned into the X-User-Id / X-User-Role test sign-in headers that the
//    local server accepts. The real API runs every request.
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { BrowserContext } from "@playwright/test";
import type { RpaUser } from "./users";

export const LOCAL_ORIGIN = "https://roster.test";
export const AUTH_ORIGIN = "https://auth.test";
export const LOCAL_API_PORT = 3100;
export const LOCAL_API = `http://127.0.0.1:${LOCAL_API_PORT}`;

const WEB_DIR = new URL("../../../web/", import.meta.url).pathname;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** Wires the local stand-ins into a browser context, signed in as `user` on the next sign-in. */
export async function useLocalSite(context: BrowserContext, user: RpaUser): Promise<void> {
  await context.route(`${AUTH_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/oauth2/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? `${LOCAL_ORIGIN}/`);
      back.searchParams.set("code", `${user.id}|${user.role}`);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      // A served 302 is not routed again by Playwright, so navigate back with a tiny page instead.
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(back.toString())})</script>`,
      });
    }
    if (url.pathname === "/oauth2/token") {
      const code = new URLSearchParams(route.request().postData() ?? "").get("code") ?? "";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ access_token: code, token_type: "Bearer", expires_in: 3600 }),
      });
    }
    if (url.pathname === "/logout") {
      return route.fulfill({ status: 200, contentType: "text/html", body: "<p>Signed out</p>" });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });

  await context.route(`${LOCAL_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.startsWith("/api/")) {
      const token = (request.headers()["authorization"] ?? "").replace(/^Bearer /, "");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token.includes("|")) {
        const [id, role] = token.split("|");
        headers["x-user-id"] = id;
        headers["x-user-role"] = role;
      }
      const response = await route.fetch({
        url: `${LOCAL_API}${url.pathname}${url.search}`,
        headers,
      });
      return route.fulfill({ response });
    }

    if (url.pathname === "/config.json") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          authDomain: AUTH_ORIGIN,
          clientId: "rpa-local",
          redirectUri: `${LOCAL_ORIGIN}/`,
          logoutUri: `${LOCAL_ORIGIN}/`,
        }),
      });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = normalize(join(WEB_DIR, path));
    if (!file.startsWith(WEB_DIR)) return route.fulfill({ status: 403, body: "forbidden" });
    try {
      const body = await readFile(file);
      return route.fulfill({
        status: 200,
        contentType: TYPES[extname(file)] ?? "application/octet-stream",
        body,
      });
    } catch {
      return route.fulfill({ status: 404, body: "not found" });
    }
  });
}

/** Looks a duty up on the local API (local duty ids are random). */
export async function localDutyId(date: string, type: string, modality: string): Promise<string> {
  const res = await fetch(`${LOCAL_API}/api/duties?from=${date}&to=${date}`, {
    headers: { "x-user-id": "coord1", "x-user-role": "coordinator" },
  });
  const duties = (await res.json()) as { id: string; type: string; modality: string }[];
  const duty = duties.find((d) => d.type === type && d.modality === modality);
  if (!duty) throw new Error(`no local duty ${date} ${type} ${modality}`);
  return duty.id;
}
