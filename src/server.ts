/**
 * Local server for `npm start`: the API on http://127.0.0.1:<PORT or 3000>, never 0.0.0.0.
 * Uses the in-memory tables and the X-User-Id / X-User-Role test sign-in unless DB_MODE or
 * AUTH_TEST_BYPASS are set otherwise. Never runs inside Lambda. No AWS account is needed.
 *
 *   curl -H "X-User-Id: coord1" -H "X-User-Role: coordinator" http://127.0.0.1:3000/api/me
 */
import { buildApp } from "./app.js";
import { log } from "./shared/log.js";

export const HOST = "127.0.0.1";

if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  throw new Error("src/server.ts is the local server and must not run inside Lambda");
}

// Both are read on each request, so setting them after the imports is enough.
process.env.DB_MODE ??= "memory";
process.env.AUTH_TEST_BYPASS ??= "1";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`PORT must be a port number, got "${process.env.PORT}"`);
}

const server = buildApp().listen(port, HOST, () => {
  log("info", "listening", { url: `http://${HOST}:${port}`, dbMode: process.env.DB_MODE });
});

server.on("error", (error) => {
  log("error", "server failed to start", { message: error.message });
  process.exit(1);
});
