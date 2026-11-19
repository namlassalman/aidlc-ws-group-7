/**
 * `npm run smoke`: checks the deployed stack after each deploy (NFR6.1, BR8.2).
 *
 *   1. GET SiteUrl (the root) returns 200 with the page title "Radiology Roster".
 *   2. GET /api/me with no token returns 401 (the JWT authorizer refuses it).
 *   3. POST /api/me with no token returns 401 from API Gateway, not a CloudFront 403, which proves
 *      CloudFront forwards every method on /api/*.
 *
 * Prints one line per check and exits 1 naming the first check that failed.
 *
 *   AWS_PROFILE=deploy AWS_REGION=us-west-2 npm run smoke
 */
import { readStackOutputs, requireOutput } from "./stack-outputs.js";

type Check = { name: string; run: (siteUrl: string) => Promise<void> };

const TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function expectStatus(response: Response, expected: number, what: string): void {
  if (response.status !== expected) {
    const via = response.headers.get("x-cache") ?? "unknown origin";
    throw new Error(`${what}: expected ${expected}, got ${response.status} (${via})`);
  }
}

const CHECKS: Check[] = [
  {
    name: "page loads",
    run: async (siteUrl) => {
      const response = await fetchWithTimeout(siteUrl);
      expectStatus(response, 200, `GET ${siteUrl}`);
      const html = await response.text();
      if (!/<title>\s*Radiology Roster/.test(html))
        throw new Error(`GET ${siteUrl}: the page title is missing`);
    },
  },
  {
    name: "GET /api/me without a token is refused",
    run: async (siteUrl) => {
      expectStatus(
        await fetchWithTimeout(new URL("api/me", siteUrl).toString()),
        401,
        "GET /api/me",
      );
    },
  },
  {
    name: "POST /api/me without a token reaches API Gateway and is refused",
    run: async (siteUrl) => {
      const response = await fetchWithTimeout(new URL("api/me", siteUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expectStatus(response, 401, "POST /api/me");
    },
  },
];

async function main(): Promise<void> {
  const siteUrl = requireOutput(await readStackOutputs(), "SiteUrl");
  console.log(`Smoke checks against ${siteUrl}`);
  for (const check of CHECKS) {
    try {
      await check.run(siteUrl);
      console.log(`  ok    ${check.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FAIL  ${check.name}: ${message}`);
      process.exit(1);
    }
  }
  console.log("All smoke checks passed.");
}

main().catch((error: unknown) => {
  console.error(`Smoke check could not run: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
