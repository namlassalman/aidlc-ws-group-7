import { describe, expect, it } from "vitest";

describe("test setup", () => {
  it("runs every test in memory with the test sign-in and the default time zone", () => {
    expect(process.env.DB_MODE).toBe("memory");
    expect(process.env.AUTH_TEST_BYPASS).toBe("1");
    expect(process.env.ROSTER_TIME_ZONE).toBe("Asia/Singapore");
    expect(process.env.LOG_LEVEL).toBe("silent");
  });

  it("is never running inside Lambda", () => {
    expect(process.env.AWS_LAMBDA_FUNCTION_NAME).toBeUndefined();
  });
});
