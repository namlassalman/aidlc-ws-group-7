// Test setup, loaded before every test file (vitest.config.ts setupFiles).
// No test needs AWS: the tables are in memory and sign-in uses the X-User-* test headers.
// The tables are emptied before each test, so each test seeds only what it needs.
import { beforeEach } from "vitest";
import { resetMemoryTables } from "../src/shared/db.js";

process.env.DB_MODE = "memory";
process.env.AUTH_TEST_BYPASS = "1";
process.env.ROSTER_TIME_ZONE = "Asia/Singapore";
process.env.LOG_LEVEL = "silent";

beforeEach(() => {
  resetMemoryTables();
});
