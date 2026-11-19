// RPA (browser robot) tests for the Radiology Roster page. Cases: quality/rpa-test-cases.md.
//
//   local     the real page from web/, the real API on a local server (port 3100) loaded with the
//             four-week UAT dataset, and a stand-in for Cognito sign-in. No AWS needed.
//   deployed  the real site: SITE_URL plus Cognito users (see support/users.ts). Run by Wafi or
//             anyone with the test passwords, after a deploy and `npm run seed`.
import { defineConfig, devices } from "@playwright/test";
import { LOCAL_API_PORT, LOCAL_ORIGIN } from "./support/local-site";

const repoRoot = new URL("../..", import.meta.url).pathname;

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  // The cases change the roster (generate, publish, rule switches), so they run in order.
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { outputFolder: "./playwright-report", open: "never" }]],
  use: {
    screenshot: "on",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "local",
      use: { ...devices["Desktop Chrome"], baseURL: LOCAL_ORIGIN },
      grepInvert: /@deployed-only/,
    },
    {
      name: "deployed",
      use: { ...devices["Desktop Chrome"], baseURL: process.env.SITE_URL },
      grepInvert: /@local-only/,
    },
  ],
  // Local mode: a fresh API server with empty in-memory tables, then the UAT dataset is loaded.
  webServer:
    process.env.RPA_MODE === "deployed"
      ? undefined
      : {
          command: `PORT=${LOCAL_API_PORT} LOG_LEVEL=warn npm start`,
          cwd: repoRoot,
          url: `http://127.0.0.1:${LOCAL_API_PORT}/api/me`,
          reuseExistingServer: false,
          timeout: 60_000,
        },
  globalSetup: process.env.RPA_MODE === "deployed" ? undefined : "./support/load-data.ts",
});
