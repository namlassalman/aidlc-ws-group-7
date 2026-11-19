// Vitest runner for the whole repository. Every test runs in memory with no AWS account:
// test/setup.ts sets DB_MODE=memory and AUTH_TEST_BYPASS=1 before each test file.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
  },
});
