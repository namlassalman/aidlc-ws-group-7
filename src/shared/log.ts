/**
 * Structured logging: one JSON line per call, written with console (no logging library).
 * LOG_LEVEL=silent (set by test/setup.ts) turns every line off; LOG_LEVEL=warn keeps warn and
 * error only. Never pass request bodies, query values, headers or tokens.
 */
export type LogLevel = "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { info: 1, warn: 2, error: 3 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (configured === "silent") return Number.POSITIVE_INFINITY;
  return ORDER[configured as LogLevel] ?? ORDER.info;
}

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
