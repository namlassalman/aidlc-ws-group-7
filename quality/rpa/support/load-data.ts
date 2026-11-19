// Local mode only: loads the four-week UAT dataset (quality/uat-data.md) into the fresh API
// server that playwright.config.ts started, through the real API.
import { execFileSync } from "node:child_process";
import { LOCAL_API } from "./local-site";

export default function loadData(): void {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  execFileSync("bash", ["quality/uat/load-uat-data.sh"], {
    cwd: repoRoot,
    env: { ...process.env, BASE: LOCAL_API },
    stdio: ["ignore", "ignore", "inherit"],
  });
}
